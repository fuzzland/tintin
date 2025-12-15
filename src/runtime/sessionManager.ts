import type { ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import type { AppConfig } from "./config.js";
import type { Db, SessionStatus } from "./db.js";
import type { Logger } from "./log.js";
import type { SpawnedCodexProcess } from "./codex.js";
import { ensureSessionsRootExists, findSessionJsonlFiles, resolveCodexHomeFromSessionsRoot, resolveSessionsRoot, spawnCodexExec, spawnCodexResume } from "./codex.js";
import type { SendToSessionFn } from "./messaging.js";
import { redactText } from "./redact.js";
import { nowMs, sleep } from "./util.js";
import {
  consumePendingMessages,
  countConcurrentSessionsForChat,
  countSessionsForChat,
  createSession,
  listPendingMessages,
  listSessionOffsets,
  upsertSessionOffset,
  updateSession,
} from "./store.js";
import type { SessionRow } from "./store.js";

interface RunningProcess {
  child: ChildProcessWithoutNullStreams;
  timeout: ReturnType<typeof setTimeout>;
  kind: "exec" | "resume";
  codex: SpawnedCodexProcess["debug"];
}

export class SessionManager {
  private readonly processes = new Map<string, RunningProcess>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly sendToSession: SendToSessionFn,
    private readonly onProcessExitDrain: (sessionId: string) => Promise<void>,
  ) {}

  async reconcileStaleSessions(): Promise<number> {
    const candidates = await this.db
      .selectFrom("sessions")
      .select(["id", "status", "pid", "platform", "chat_id"])
      .where("status", "in", ["starting", "running"])
      .execute();

    let cleaned = 0;
    for (const s of candidates) {
      const pid = typeof s.pid === "number" ? s.pid : null;
      const alive = pid !== null && pid > 0 && isPidAlive(pid);
      if (alive) continue;

      if (s.status === "running") {
        try {
          await this.onProcessExitDrain(s.id);
        } catch (e) {
          this.logger.debug(`[session] reconcile drain failed session=${s.id}: ${String(e)}`);
        }
      }

      cleaned++;
      await updateSession(this.db, s.id, { status: "error", finished_at: nowMs(), pid: null });
    }

    if (cleaned > 0) {
      this.logger.info(`[session] reconciled ${cleaned} stale session(s) on startup`);
    }
    return cleaned;
  }

  async assertCanStartNewSession(opts: { platform: string; chatId: string }): Promise<void> {
    await this.reconcileStaleSessionsForChat(opts.platform, opts.chatId);

    const total = await countSessionsForChat(this.db, opts.platform, opts.chatId);
    if (total >= this.config.security.max_sessions_per_chat) {
      throw new Error("This chat has reached the max sessions limit");
    }
    const conc = await countConcurrentSessionsForChat(this.db, opts.platform, opts.chatId);
    if (conc >= this.config.security.max_concurrent_sessions_per_chat) {
      throw new Error("This chat has reached the max concurrent sessions limit");
    }
  }

  async startNewSession(opts: {
    platform: string;
    workspaceId: string | null;
    chatId: string;
    spaceId: string;
    spaceEmoji?: string | null;
    userId: string;
    projectId: string;
    projectPathResolved: string;
    initialPrompt: string;
  }): Promise<string> {
    await this.assertCanStartNewSession({ platform: opts.platform, chatId: opts.chatId });

    const id = crypto.randomUUID();
    const now = nowMs();
    const session: SessionRow = {
      id,
      platform: opts.platform,
      workspace_id: opts.workspaceId,
      chat_id: opts.chatId,
      space_id: opts.spaceId,
      space_emoji: opts.spaceEmoji ?? null,
      created_by_user_id: opts.userId,
      project_id: opts.projectId,
      project_path_resolved: opts.projectPathResolved,
      codex_session_id: null,
      codex_cwd: opts.projectPathResolved,
      status: "starting",
      pid: null,
      exit_code: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
      last_user_message_at: now,
    };

    await createSession(this.db, session);

    const sessionsRoot = resolveSessionsRoot(session.codex_cwd, this.config.codex.sessions_dir);
    const codexHome = resolveCodexHomeFromSessionsRoot(sessionsRoot);
    await ensureSessionsRootExists(sessionsRoot);

    this.logger.debug(
      `[session] spawn codex kind=exec session=${id} project=${opts.projectId} cwd=${session.codex_cwd} sessionsRoot=${sessionsRoot} codexHome=${codexHome}`,
    );
    const spawned = spawnCodexExec({
      config: this.config,
      logger: this.logger,
      cwd: session.codex_cwd,
      prompt: opts.initialPrompt,
      extraEnv: { CODEX_HOME: codexHome },
    });

    await updateSession(this.db, id, { pid: spawned.child.pid ?? null, started_at: nowMs(), status: "starting" });

    const timeout = setTimeout(() => {
      void this.killSession(id, "timed out, terminating…");
    }, this.config.codex.timeout_seconds * 1000);

    this.processes.set(id, { child: spawned.child, timeout, kind: "exec", codex: spawned.debug });

    void this.finalizeNewSession(id, spawned.threadId, sessionsRoot).catch(async (e) => {
      this.logger.error("session start error", e);
      await updateSession(this.db, id, { status: "error", finished_at: nowMs() });
      await this.sendToSession(id, { text: `Session error: ${String(e)}`, priority: "user" });
    });

    spawned.child.on("exit", (code, signal) => {
      void this.handleExit(id, code, signal);
    });

    return id;
  }

  async resumeSession(session: SessionRow, prompt: string): Promise<void> {
    if (!session.codex_session_id) throw new Error("Session missing codex_session_id");
    if (this.processes.has(session.id)) throw new Error("Session already running");

    await updateSession(this.db, session.id, { status: "starting", exit_code: null, finished_at: null });

    const sessionsRoot = resolveSessionsRoot(session.codex_cwd, this.config.codex.sessions_dir);
    const codexHome = resolveCodexHomeFromSessionsRoot(sessionsRoot);
    await ensureSessionsRootExists(sessionsRoot);

    // Ensure offsets exist.
    const existingOffsets = await listSessionOffsets(this.db, session.id);
    if (existingOffsets.length === 0) {
      const files = await findSessionJsonlFiles({
        sessionsRoot,
        codexSessionId: session.codex_session_id,
        timeoutMs: 10_000,
        pollMs: 200,
      });
      for (const f of files) {
        await upsertSessionOffset(this.db, {
          id: crypto.randomUUID(),
          session_id: session.id,
          jsonl_path: f,
          byte_offset: 0,
          updated_at: nowMs(),
        });
      }
    }

    const spawned = spawnCodexResume({
      config: this.config,
      logger: this.logger,
      cwd: session.codex_cwd,
      sessionId: session.codex_session_id,
      prompt,
      extraEnv: { CODEX_HOME: codexHome },
    });
    void spawned.threadId.catch(() => {});

    const timeout = setTimeout(() => {
      void this.killSession(session.id, "timed out, terminating…");
    }, this.config.codex.timeout_seconds * 1000);
    this.processes.set(session.id, { child: spawned.child, timeout, kind: "resume", codex: spawned.debug });

    await updateSession(this.db, session.id, { pid: spawned.child.pid ?? null, status: "running" });

    spawned.child.on("exit", (code, signal) => {
      void this.handleExit(session.id, code, signal);
    });
  }

  private async reconcileStaleSessionsForChat(platform: string, chatId: string): Promise<number> {
    const candidates = await this.db
      .selectFrom("sessions")
      .select(["id", "status", "pid"])
      .where("platform", "=", platform)
      .where("chat_id", "=", chatId)
      .where("status", "in", ["starting", "running"])
      .execute();

    let cleaned = 0;
    for (const s of candidates) {
      const pid = typeof s.pid === "number" ? s.pid : null;
      const alive = pid !== null && pid > 0 && isPidAlive(pid);
      if (alive) continue;

      if (s.status === "running") {
        try {
          await this.onProcessExitDrain(s.id);
        } catch (e) {
          this.logger.debug(`[session] reconcile drain failed session=${s.id}: ${String(e)}`);
        }
      }

      cleaned++;
      await updateSession(this.db, s.id, { status: "error", finished_at: nowMs(), pid: null });
    }

    if (cleaned > 0) {
      this.logger.info(`[session] reconciled ${cleaned} stale session(s) platform=${platform} chat=${chatId}`);
    }
    return cleaned;
  }

  private async finalizeNewSession(sessionId: string, threadIdPromise: Promise<string>, sessionsRoot: string) {
    const threadId = await threadIdPromise;
    await updateSession(this.db, sessionId, { codex_session_id: threadId, status: "running" });

    const files = await findSessionJsonlFiles({
      sessionsRoot,
      codexSessionId: threadId,
      timeoutMs: 10_000,
      pollMs: 200,
    });
    if (files.length === 0) {
      await this.sendToSession(sessionId, { text: "Warning: could not locate Codex JSONL logs for streaming yet.", priority: "user" });
      return;
    }
    for (const f of files) {
      await upsertSessionOffset(this.db, {
        id: crypto.randomUUID(),
        session_id: sessionId,
        jsonl_path: f,
        byte_offset: 0,
        updated_at: nowMs(),
      });
    }
  }

  async killSession(sessionId: string, reason: string) {
    const proc = this.processes.get(sessionId);
    if (!proc) return;
    await this.sendToSession(sessionId, { text: reason, priority: "user" });
    proc.child.kill("SIGTERM");
    await sleep(5_000);
    if (!proc.child.killed) proc.child.kill("SIGKILL");
    await updateSession(this.db, sessionId, { status: "killed", finished_at: nowMs() });
  }

  private async handleExit(sessionId: string, code: number | null, signal: NodeJS.Signals | null) {
    const proc = this.processes.get(sessionId);
    const procKind = proc?.kind ?? "?";
    const procPid = proc?.child.pid ?? null;
    const codex = proc?.codex ?? null;
    if (proc) {
      clearTimeout(proc.timeout);
      this.processes.delete(sessionId);
    }

    this.logger.debug(
      `[session] exit session=${sessionId} kind=${procKind} pid=${String(procPid ?? "-")} code=${String(
        code ?? "-",
      )} signal=${String(signal ?? "-")}`,
    );

    // Drain JSONL one last time before closing out.
    try {
      await this.onProcessExitDrain(sessionId);
    } catch (e) {
      this.logger.warn("final drain error", e);
    }

    const status: SessionStatus = code === 0 ? "finished" : signal ? "killed" : "error";
    await updateSession(this.db, sessionId, {
      status,
      exit_code: code,
      finished_at: nowMs(),
      pid: null,
    });

    if (status === "error" && codex) {
      const stderrTail = redactText(codex.stderrTail()).trim();
      const stdoutTail = redactText(codex.stdoutTail()).trim();

      const maxLogChars = 3000;
      const stderrLog = stderrTail.length > maxLogChars ? `${stderrTail.slice(0, maxLogChars)}…` : stderrTail;
      const stdoutLog = stdoutTail.length > maxLogChars ? `${stdoutTail.slice(0, maxLogChars)}…` : stdoutTail;

      this.logger.warn(
        `[session] codex exited nonzero session=${sessionId} kind=${procKind} pid=${String(procPid ?? "-")} code=${String(
          code ?? "-",
        )}`,
      );
      if (stderrLog) this.logger.warn(`[session] codex stderr tail:\n${stderrLog}`);
      else if (stdoutLog) this.logger.warn(`[session] codex stdout tail:\n${stdoutLog}`);
    }

    // If users queued messages while we were running, resume one-by-one.
    const pending = await listPendingMessages(this.db, sessionId, 100);
    if (pending.length > 0) {
      const next = pending[0]!;
      await this.sendToSession(sessionId, { text: `Processing 1 queued message…`, priority: "user" });
      await consumePendingMessages(this.db, [next.id]);

      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (session && session.codex_session_id) {
        await this.resumeSession(session as SessionRow, next.message_text);
        return;
      }
    }

    if (status === "killed") await this.sendToSession(sessionId, { text: "Session stopped.", priority: "user" });
    else if (status === "finished") {
      // Keep the chat quiet on successful completion.
    } else {
      if (this.config.bot.log_level === "debug" && codex) {
        const tail = redactText(codex.stderrTail()).trim();
        if (tail) {
          const maxChars = 1500;
          const snippet = tail.length > maxChars ? `${tail.slice(0, maxChars)}…` : tail;
          await this.sendToSession(sessionId, {
            text: `Session exited with code ${code ?? "?"}.\n\ncodex stderr (tail):\n${snippet}`,
            priority: "user",
          });
        } else {
          await this.sendToSession(sessionId, { text: `Session exited with code ${code ?? "?"}.`, priority: "user" });
        }
      } else {
        await this.sendToSession(sessionId, { text: `Session exited with code ${code ?? "?"}.`, priority: "user" });
      }
    }

    // Ensure a Review button is present on the last session message.
    await this.sendToSession(sessionId, { text: "", final: true, priority: "user" });
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? (e as any).code : null;
    return code === "EPERM";
  }
}
