import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createConnection, createServer } from "node:net";
import process from "node:process";
import type { AppConfig } from "./config.js";
import type { Db, SessionAgent, SessionStatus } from "./db.js";
import type { Logger } from "./log.js";
import type { SpawnedAgentProcess } from "./agents.js";
import { getAgentAdapter } from "./agents.js";
import type { SendToSessionFn } from "./messaging.js";
import { redactText } from "./redact.js";
import { nowMs, sleep } from "./util.js";
import type { McpRegistry } from "./mcp/registry.js";
import { collectMcpAgentEnv, formatMcpBearerEnvVar } from "./mcp/utils.js";
import { getGithubMcpToken, getOrCreateIdentity } from "./cloud/store.js";
import { decryptSecret } from "./cloud/secrets.js";
import { buildLocalizedPrompt } from "./prompt.js";
import {
  applySearchEnv,
  buildSearchDirective,
  ensureLocalSearchGuard,
  isHyperbrowserAvailable,
  resolveSearchPolicy,
} from "./searchPolicy.js";
import {
  consumePendingMessages,
  countConcurrentSessionsForChat,
  countSessionsForChat,
  createSession,
  getUserLanguage,
  listPendingMessages,
  listSessionOffsets,
  upsertSessionOffset,
  updateSession,
} from "./store.js";
import type { SessionRow } from "./store.js";
import { getChatgptAccountForIdentity, persistChatgptProxyTokens } from "./chatgpt/oauth.js";
import { getIdentity } from "./cloud/store.js";
import { createProxyToken } from "./cloud/proxy.js";
import { isUserLanguage, t, type UserLanguage } from "../locales/index.js";

interface RunningProcess {
  child: ChildProcessWithoutNullStreams;
  timeout: ReturnType<typeof setTimeout>;
  kind: "exec" | "resume";
  agent: SessionAgent;
  debug: SpawnedAgentProcess["debug"];
}

type SessionNoticeKey = Parameters<typeof t>[0];
type KillReason = string | { key: SessionNoticeKey; params?: Record<string, string | number> };

interface CloudProxyResult {
  env: Record<string, string>;
  codexHome?: string;  // If set, the CODEX_HOME path that was configured
}

export class SessionStartError extends Error {
  constructor(
    public readonly code: "max_sessions" | "max_concurrent",
    public readonly limit: number,
  ) {
    const message =
      code === "max_sessions"
        ? "This chat has reached the max sessions limit"
        : "This chat has reached the max concurrent sessions limit";
    super(message);
    this.name = "SessionStartError";
  }
}

export class SessionManager {
  private readonly processes = new Map<string, RunningProcess>();
  private readonly chatgptProxies = new Map<string, { proc: ChildProcess; refreshPath: string; identityId: string }>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly sendToSession: SendToSessionFn,
    private readonly onProcessExitDrain: (sessionId: string) => Promise<void>,
    private readonly mcpRegistry: McpRegistry | null,
    private readonly onSessionFinished?: (
      sessionId: string,
      status: SessionStatus,
      code: number | null,
      signal: NodeJS.Signals | null,
  ) => Promise<void>,
  ) {}

  private resolveSessionLanguage(session: { language?: string | null }): UserLanguage {
    const language = session.language;
    return typeof language === "string" && isUserLanguage(language) ? language : "en";
  }

  private applyLanguageEnv(env: Record<string, string>, lang: UserLanguage): Record<string, string> {
    const out = { ...env };
    const directive = t("prompt.language_directive", lang);
    if (directive) {
      out.CHATGPT_PROXY_LANGUAGE_PROMPT = directive;
      out.CHATGPT_PROXY_LANGUAGE_PROMPT_B64 = Buffer.from(directive, "utf8").toString("base64");
    }
    out.CHATGPT_PROXY_LANGUAGE = lang;
    if (!out.CHATGPT_PROXY_LANGUAGE_STRICT) out.CHATGPT_PROXY_LANGUAGE_STRICT = "1";
    if (!out.CHATGPT_PROXY_LANGUAGE_CHECK) out.CHATGPT_PROXY_LANGUAGE_CHECK = "1";
    out.TINTIN_USER_LANGUAGE = lang;
    const locale = lang === "zh" ? "zh_CN.UTF-8" : "en_US.UTF-8";
    if (!out.LANG) out.LANG = locale;
    if (!out.LC_ALL) out.LC_ALL = locale;
    return out;
  }

  /**
   * Apply cloud proxy environment variables for local sessions.
   * This allows local/WebSocket sessions to use the centralized API key
   * configured in [cloud.proxy] without needing to set OPENAI_API_KEY in config.
   *
   * Creates a separate CODEX_HOME directory with auth.json containing the proxy token.
   * This is necessary because Codex reads credentials from ~/.codex/auth.json which
   * takes precedence over environment variables and --config overrides.
   */
  private async applyCloudProxyForLocalSession(
    env: Record<string, string>,
    identityId: string,
  ): Promise<CloudProxyResult> {
    const proxy = this.config.cloud?.proxy;
    if (!proxy?.enabled || !proxy.openai_api_key || !proxy.shared_secret) {
      return { env };
    }

    // Always override with cloud proxy (force cloud proxy mode)
    // Generate proxy token
    const token = createProxyToken(proxy.shared_secret, identityId, proxy.token_ttl_ms);

    // Build proxy URL
    const baseUrl = this.config.cloud?.public_base_url ?? `http://127.0.0.1:${this.config.bot.port}`;
    const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const proxyUrl = `${trimmedBase}${proxy.openai_path}`;

    // Create a proxy-specific CODEX_HOME directory
    // This is necessary because Codex reads stored credentials from ~/.codex/auth.json
    // which takes precedence over OPENAI_API_KEY environment variable
    const proxyCodexHome = path.join(this.config.bot.data_dir, "codex-proxy-home");
    try {
      await mkdir(proxyCodexHome, { recursive: true });
      // Also create sessions directory to maintain session paths
      await mkdir(path.join(proxyCodexHome, "sessions"), { recursive: true });
      // Write auth.json with proxy token
      const authJson = JSON.stringify({ OPENAI_API_KEY: token }, null, 2);
      await writeFile(path.join(proxyCodexHome, "auth.json"), authJson, "utf8");
    } catch (e) {
      this.logger.warn(`[session] failed to create proxy codex home: ${String(e)}`);
    }

    this.logger.info(`[session] cloud proxy applied for local session identity=${identityId}`);

    return {
      env: {
        ...env,
        OPENAI_API_KEY: token,
        OPENAI_BASE_URL: proxyUrl,
        OPENAI_API_BASE: proxyUrl,
        CODEX_HOME: proxyCodexHome,
      },
      codexHome: proxyCodexHome,
    };
  }

  /**
   * Build CLI args for cloud proxy.
   * Switches Codex to the built-in "openai" provider and passes API key via CLI config
   * to override any stored credentials in ~/.codex/.
   */
  private buildCloudProxyCliArgs(agent: SessionAgent, envOverrides: Record<string, string>): string[] {
    const proxy = this.config.cloud?.proxy;
    if (!proxy?.enabled || !proxy.openai_api_key || !proxy.shared_secret) {
      return [];
    }

    // Only codex needs CLI args override (claude code uses env vars properly)
    if (agent !== "codex") {
      return [];
    }

    const apiKey = envOverrides.OPENAI_API_KEY;
    const baseUrl = envOverrides.OPENAI_BASE_URL;

    if (!apiKey || !baseUrl) {
      return [];
    }

    // Pass both model_provider and openai.api_key via CLI config
    // This is necessary because Codex may have stored credentials (cr_...) in ~/.codex/
    // that take precedence over OPENAI_API_KEY environment variable.
    // Using --config openai.api_key=... forces Codex to use our proxy token.
    return [
      "--config", "model_provider=openai",
      "--config", `openai.api_key=${apiKey}`,
      "--config", `openai.api_base=${baseUrl}`,
    ];
  }

  private async resolveSessionLanguageById(sessionId: string): Promise<UserLanguage> {
    const row = await this.db
      .selectFrom("sessions")
      .select(["language"])
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row ? this.resolveSessionLanguage(row) : "en";
  }

  private async formatSessionText(
    sessionId: string,
    key: SessionNoticeKey,
    params?: Record<string, string | number>,
  ): Promise<string> {
    const lang = await this.resolveSessionLanguageById(sessionId);
    return t(key, lang, params);
  }

  private async sendSessionNotice(
    sessionId: string,
    key: SessionNoticeKey,
    params?: Record<string, string | number>,
  ): Promise<void> {
    const text = await this.formatSessionText(sessionId, key, params);
    await this.sendToSession(sessionId, { text, priority: "user" });
  }

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
      throw new SessionStartError("max_sessions", this.config.security.max_sessions_per_chat);
    }
    const conc = await countConcurrentSessionsForChat(this.db, opts.platform, opts.chatId);
    if (conc >= this.config.security.max_concurrent_sessions_per_chat) {
      throw new SessionStartError("max_concurrent", this.config.security.max_concurrent_sessions_per_chat);
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
    agent: SessionAgent;
    envOverrides?: Record<string, string>;
  }): Promise<string> {
    await this.assertCanStartNewSession({ platform: opts.platform, chatId: opts.chatId });

    const id = crypto.randomUUID();
    const now = nowMs();
    const language = await getUserLanguage(this.db, opts.platform, opts.userId);
    const searchPolicy = resolveSearchPolicy(this.config);
    const hyperbrowserAvailable = isHyperbrowserAvailable(this.config);
    const enforceSearch = searchPolicy.mode === "hyperbrowser_first" && hyperbrowserAvailable;
    const searchDirective = buildSearchDirective({ policy: searchPolicy, lang: language, hyperbrowserAvailable });
    const agentPrompt = buildLocalizedPrompt(opts.initialPrompt, language, { searchDirective });
    const session: SessionRow = {
      id,
      agent: opts.agent,
      platform: opts.platform,
      workspace_id: opts.workspaceId,
      chat_id: opts.chatId,
      space_id: opts.spaceId,
      space_emoji: opts.spaceEmoji ?? null,
      created_by_user_id: opts.userId,
      project_id: opts.projectId,
      project_path_resolved: opts.projectPathResolved,
      codex_session_id: null,
      browserbase_session_id: null,
      hyperbrowser_session_id: null,
      codex_cwd: opts.projectPathResolved,
      status: "starting",
      pid: null,
      exit_code: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
      last_user_message_at: now,
      language,
    };

    await createSession(this.db, session);

    let childToKill: ChildProcessWithoutNullStreams | null = null;
    try {
      const adapter = getAgentAdapter(opts.agent);
      adapter.requireConfig(this.config);

      let sessionsRoot = adapter.resolveSessionsRoot(session.codex_cwd, this.config);
      let homeDir = adapter.resolveHomeDir(sessionsRoot);
      await adapter.ensureSessionsRootExists(sessionsRoot);
      const envSeed = this.applyLanguageEnv(opts.envOverrides ?? {}, language);
      const guardDir = enforceSearch
        ? await ensureLocalSearchGuard({ rootDir: path.join(this.config.bot.data_dir, "search-guard") })
        : undefined;
      const envWithSearch = applySearchEnv(envSeed, {
        policy: searchPolicy,
        hyperbrowserAvailable,
        enforce: enforceSearch,
        guardDir,
      });
      const envWithChatgpt = await this.maybePrepareChatgptProxy(session, envWithSearch);
      const cloudProxyResult = await this.applyCloudProxyForLocalSession(envWithChatgpt, opts.userId);
      const envOverrides = cloudProxyResult.env;

      // If cloud proxy set a custom CODEX_HOME, update sessionsRoot and homeDir to match
      if (cloudProxyResult.codexHome) {
        homeDir = cloudProxyResult.codexHome;
        sessionsRoot = path.join(cloudProxyResult.codexHome, "sessions");
        await adapter.ensureSessionsRootExists(sessionsRoot);
      }

      this.logger.debug(
        `[session] spawn agent=${opts.agent} kind=exec session=${id} project=${opts.projectId} cwd=${session.codex_cwd} sessionsRoot=${sessionsRoot} home=${homeDir} search_policy=${searchPolicy.mode} search_provider=${hyperbrowserAvailable ? "hyperbrowser" : "none"} search_enforce=${enforceSearch ? "1" : "0"}`,
      );
      const identity = await getOrCreateIdentity(this.db, {
        platform: opts.platform,
        workspaceId: opts.workspaceId,
        userId: opts.userId,
      });
      const mcpConfig = await this.mcpCliArgs(opts.agent, identity.id);
      const cloudProxyArgs = this.buildCloudProxyCliArgs(opts.agent, envOverrides);
      const extraArgs = [...(mcpConfig?.args ?? []), ...cloudProxyArgs];
      const spawnedProc = adapter.spawnExec({
        config: this.config,
        logger: this.logger,
        cwd: session.codex_cwd,
        prompt: agentPrompt,
        homeDir,
        extraEnv: { ...envOverrides, ...(mcpConfig?.env ?? {}) },
        extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
      });
      childToKill = spawnedProc.child;

      await updateSession(this.db, id, { pid: spawnedProc.child.pid ?? null, started_at: nowMs(), status: "starting" });

      const timeout = setTimeout(() => {
        void this.killSession(id, { key: "session.timeout_terminating" });
      }, adapter.timeoutSeconds(this.config) * 1000);

      this.processes.set(id, {
        child: spawnedProc.child,
        timeout,
        kind: "exec",
        agent: opts.agent,
        debug: spawnedProc.debug,
      });

      void this.finalizeNewSession(id, spawnedProc.agentSessionId, {
        agent: opts.agent,
        cwd: session.codex_cwd,
        sessionsRoot,
        homeDir,
      }).catch(async (e) => {
        this.logger.error("session start error", e);
        await updateSession(this.db, id, { status: "error", finished_at: nowMs() });
        await this.sendSessionNotice(id, "session.error", { error: String(e) });
      });

      spawnedProc.child.on("exit", (code, signal) => {
        void this.handleExit(id, code, signal);
      });

      return id;
    } catch (e) {
      try {
        if (childToKill && !childToKill.killed) childToKill.kill("SIGTERM");
      } catch {
        // ignore
      }
      try {
        await this.teardownChatgptProxy(session.id, session.workspace_id, session.platform, session.created_by_user_id);
      } catch {
        /* ignore */
      }
      try {
        await updateSession(this.db, id, { status: "error", finished_at: nowMs(), pid: null });
      } catch {
        // ignore: best-effort cleanup
      }
      throw e;
    }
  }

  async resumeSession(session: SessionRow, prompt: string, envOverrides?: Record<string, string>): Promise<void> {
    if (!session.codex_session_id) throw new Error("Session missing codex_session_id");
    if (this.processes.has(session.id)) throw new Error("Session already running");

    await updateSession(this.db, session.id, { status: "starting", exit_code: null, finished_at: null });

    const adapter = getAgentAdapter(session.agent);
    adapter.requireConfig(this.config);

    let sessionsRoot = adapter.resolveSessionsRoot(session.codex_cwd, this.config);
    let homeDir = adapter.resolveHomeDir(sessionsRoot);
    await adapter.ensureSessionsRootExists(sessionsRoot);
    const language = this.resolveSessionLanguage(session);
    const searchPolicy = resolveSearchPolicy(this.config);
    const hyperbrowserAvailable = isHyperbrowserAvailable(this.config);
    const enforceSearch = searchPolicy.mode === "hyperbrowser_first" && hyperbrowserAvailable;
    const envSeed = this.applyLanguageEnv(envOverrides ?? {}, language);
    const guardDir = enforceSearch
      ? await ensureLocalSearchGuard({ rootDir: path.join(this.config.bot.data_dir, "search-guard") })
      : undefined;
    const envWithSearch = applySearchEnv(envSeed, {
      policy: searchPolicy,
      hyperbrowserAvailable,
      enforce: enforceSearch,
      guardDir,
    });
    const envWithChatgpt = await this.maybePrepareChatgptProxy(session, envWithSearch);
    const cloudProxyResult = await this.applyCloudProxyForLocalSession(envWithChatgpt, session.created_by_user_id);
    const envWithCloudProxy = cloudProxyResult.env;

    // If cloud proxy set a custom CODEX_HOME, update sessionsRoot and homeDir to match
    if (cloudProxyResult.codexHome) {
      homeDir = cloudProxyResult.codexHome;
      sessionsRoot = path.join(cloudProxyResult.codexHome, "sessions");
      await adapter.ensureSessionsRootExists(sessionsRoot);
    }

    // Ensure offsets exist.
    const existingOffsets = await listSessionOffsets(this.db, session.id);
    if (existingOffsets.length === 0) {
      const files = await adapter.findSessionJsonlFiles({
        sessionsRoot,
        homeDir,
        cwd: session.codex_cwd,
        sessionId: session.codex_session_id,
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

    const searchDirective = buildSearchDirective({ policy: searchPolicy, lang: language, hyperbrowserAvailable });
    const agentPrompt = buildLocalizedPrompt(prompt, language, { searchDirective });
    let spawned;
    const identity = await getOrCreateIdentity(this.db, {
      platform: session.platform,
      workspaceId: session.workspace_id,
      userId: session.created_by_user_id,
    });
    const mcpConfig = await this.mcpCliArgs(session.agent, identity.id);
    const cloudProxyArgs = this.buildCloudProxyCliArgs(session.agent, envWithCloudProxy);
    const extraArgs = [...(mcpConfig?.args ?? []), ...cloudProxyArgs];
    try {
      spawned = adapter.spawnResume({
        config: this.config,
        logger: this.logger,
        cwd: session.codex_cwd,
        sessionId: session.codex_session_id,
        prompt: agentPrompt,
        homeDir,
        extraEnv: { ...envWithCloudProxy, ...(mcpConfig?.env ?? {}) },
        extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
      });
    } catch (e) {
      await this.teardownChatgptProxy(session.id, session.workspace_id, session.platform, session.created_by_user_id);
      throw e;
    }
    void spawned.agentSessionId.catch(() => {});

    const timeout = setTimeout(() => {
      void this.killSession(session.id, { key: "session.timeout_terminating" });
    }, adapter.timeoutSeconds(this.config) * 1000);
    this.processes.set(session.id, {
      child: spawned.child,
      timeout,
      kind: "resume",
      agent: session.agent,
      debug: spawned.debug,
    });

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

  private async finalizeNewSession(
    sessionId: string,
    agentSessionIdPromise: Promise<string>,
    opts: { agent: SessionAgent; cwd: string; sessionsRoot: string; homeDir: string },
  ) {
    const agentSessionId = await agentSessionIdPromise;
    await updateSession(this.db, sessionId, { codex_session_id: agentSessionId, status: "running" });

    const adapter = getAgentAdapter(opts.agent);
    const files = await adapter.findSessionJsonlFiles({
      sessionsRoot: opts.sessionsRoot,
      homeDir: opts.homeDir,
      cwd: opts.cwd,
      sessionId: agentSessionId,
      timeoutMs: 10_000,
      pollMs: 200,
    });
    if (files.length === 0) {
      await this.sendSessionNotice(sessionId, "session.logs_missing");
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

  async killSession(sessionId: string, reason: KillReason) {
    const proc = this.processes.get(sessionId);
    if (!proc) return;
    const text =
      typeof reason === "string" ? reason : await this.formatSessionText(sessionId, reason.key, reason.params);
    await this.sendToSession(sessionId, { text, priority: "user" });
    const reasonLabel = typeof reason === "string" ? reason : reason.key;
    this.logger.info(`[session] killing session=${sessionId} reason=${reasonLabel}`);
    proc.child.kill("SIGTERM");
    await sleep(200);
    if (!proc.child.killed) {
      this.logger.info(`[session] force kill session=${sessionId}`);
      proc.child.kill("SIGKILL");
    }
    await updateSession(this.db, sessionId, { status: "killed", finished_at: nowMs() });
  }

  async drainSession(sessionId: string) {
    await this.onProcessExitDrain(sessionId);
  }

  async notifySessionFinished(sessionId: string) {
    await this.sendToSession(sessionId, { type: "finalize", priority: "user" });
  }

  private async handleExit(sessionId: string, code: number | null, signal: NodeJS.Signals | null) {
    const proc = this.processes.get(sessionId);
    const procKind = proc?.kind ?? "?";
    const procPid = proc?.child.pid ?? null;
    const agent = proc?.agent ?? null;
    const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
    const debug = proc?.debug ?? null;
    if (proc) {
      clearTimeout(proc.timeout);
      this.processes.delete(sessionId);
    }

    this.logger.debug(
      `[session] exit session=${sessionId} kind=${procKind} pid=${String(procPid ?? "-")} code=${String(
        code ?? "-",
      )} signal=${String(signal ?? "-")} agent=${String(agent ?? "-")}`,
    );

    // Drain JSONL one last time before closing out.
    try {
      await this.onProcessExitDrain(sessionId);
    } catch (e) {
      this.logger.warn("final drain error", e);
    }

    try {
      if (session) {
        await this.teardownChatgptProxy(session.id, session.workspace_id, session.platform, session.created_by_user_id);
      } else {
        await this.teardownChatgptProxy(sessionId, null, null, null);
      }
    } catch (e) {
      this.logger.warn(`[chatgpt][oauth] teardown failed session=${sessionId}: ${String(e)}`);
    }

    const status: SessionStatus = code === 0 ? "finished" : signal ? "killed" : "error";
    await updateSession(this.db, sessionId, {
      status,
      exit_code: code,
      finished_at: nowMs(),
      pid: null,
    });

    if (status === "error" && debug) {
      const stderrTail = redactText(debug.stderrTail()).trim();
      const stdoutTail = redactText(debug.stdoutTail()).trim();

      const maxLogChars = 3000;
      const stderrLog = stderrTail.length > maxLogChars ? `${stderrTail.slice(0, maxLogChars)}…` : stderrTail;
      const stdoutLog = stdoutTail.length > maxLogChars ? `${stdoutTail.slice(0, maxLogChars)}…` : stdoutTail;

      this.logger.warn(
        `[session] agent exited nonzero session=${sessionId} agent=${String(agent ?? "-")} kind=${procKind} pid=${String(
          procPid ?? "-",
        )} code=${String(code ?? "-")}`,
      );
      const agentLabel = String(agent ?? "agent");
      if (stderrLog) this.logger.warn(`[session] ${agentLabel} stderr tail:\n${stderrLog}`);
      else if (stdoutLog) this.logger.warn(`[session] ${agentLabel} stdout tail:\n${stdoutLog}`);
    }

    // If users queued messages while we were running, resume one-by-one.
    const pending = await listPendingMessages(this.db, sessionId, 100);
    if (pending.length > 0) {
      const next = pending[0]!;
      await this.sendSessionNotice(sessionId, "session.processing_queued");
      await consumePendingMessages(this.db, [next.id]);

      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (session && session.codex_session_id) {
        await this.resumeSession(session as SessionRow, next.message_text);
        return;
      }
    }

    if (status === "killed") await this.sendSessionNotice(sessionId, "session.stopped");
    else if (status === "finished") {
      // Keep the chat quiet on successful completion.
    } else {
      if (this.config.bot.log_level === "debug" && debug) {
        const tail = redactText(debug.stderrTail()).trim();
        if (tail) {
          const maxChars = 1500;
          const snippet = tail.length > maxChars ? `${tail.slice(0, maxChars)}…` : tail;
          await this.sendSessionNotice(sessionId, "session.exited_with_stderr", {
            code: String(code ?? "?"),
            agent: String(agent ?? "agent"),
            snippet,
          });
        } else {
          await this.sendSessionNotice(sessionId, "session.exited", { code: String(code ?? "?") });
        }
      } else {
        await this.sendSessionNotice(sessionId, "session.exited", { code: String(code ?? "?") });
      }
    }

    if (this.onSessionFinished) {
      void this.onSessionFinished(sessionId, status, code, signal).catch((e) => {
        this.logger.warn(`[session] onSessionFinished failed session=${sessionId}: ${String(e)}`);
      });
    }

    // Ensure a Review/Commit button is present on the last session message.
    await this.sendToSession(sessionId, { type: "finalize", priority: "user" });
  }

  private async mcpCliArgs(
    agent: SessionAgent,
    identityId: string,
  ): Promise<{ args: string[]; env: Record<string, string> } | null> {
    if (!this.mcpRegistry) return null;
    const servers = await this.mcpRegistry.startAll();
    const mcp = this.config.mcp;
    if (mcp) {
      for (const [name, provider] of Object.entries(mcp.providers)) {
        if (!provider.enabled) continue;
        if (provider.type !== "github") continue;
        const token = await this.requireGithubMcpToken(identityId);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
        };
        if (provider.github_host) {
          headers["X-GitHub-Host"] = provider.github_host;
        }
        if (provider.toolsets && provider.toolsets.length > 0) {
          headers["X-MCP-Toolsets"] = provider.toolsets.join(",");
        }
        servers.set(name, {
          id: name,
          transport: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers,
          bearerTokenEnvVar: formatMcpBearerEnvVar(name),
          bearerToken: token,
          status: "running",
          startupTimeoutSec: provider.startup_timeout_sec,
        });
      }
    }
    if (servers.size === 0) return null;
    const adapter = getAgentAdapter(agent);
    const globalTimeout = this.config.mcp?.global_timeout_sec ?? 60;
    const args = adapter.buildMcpCliArgs({ servers, globalTimeout });
    const env = collectMcpAgentEnv(servers);
    return { args, env };
  }

  private async requireGithubMcpToken(identityId: string): Promise<string> {
    const secretKey = this.config.cloud?.secrets_key ?? "";
    if (!secretKey) {
      throw new Error("cloud.secrets_key is required to use GitHub MCP tokens.");
    }
    const row = await getGithubMcpToken(this.db, identityId);
    if (!row?.encrypted_token) {
      throw new Error('GitHub MCP token is not set. Use "/mcp github token set <token>".');
    }
    return decryptSecret(row.encrypted_token, secretKey);
  }

  private async resolveChatgptProxyBin(): Promise<string | null> {
    const candidates = [
      "/usr/local/bin/tintin-chatgpt-proxy.js",
      path.resolve(this.config.config_dir ?? process.cwd(), "image/tintin-chatgpt-proxy.js"),
      path.resolve(process.cwd(), "image/tintin-chatgpt-proxy.js"),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async allocateLoopbackPort(): Promise<number> {
    return await new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(0));
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr && typeof addr.port === "number" ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
  }

  private async tryConnectToChatgptProxy(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return await new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const socket = createConnection({ host, port });
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  private async waitForChatgptProxyReady(
    host: string,
    port: number,
    timeoutMs: number,
    shouldAbort?: () => boolean,
  ): Promise<boolean> {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      if (shouldAbort?.()) return false;
      const ok = await this.tryConnectToChatgptProxy(host, port, 500);
      if (ok) return true;
      await sleep(200);
    }
    return false;
  }

  private async maybePrepareChatgptProxy(session: SessionRow, baseEnv: Record<string, string>): Promise<Record<string, string>> {
    if (session.agent !== "codex") return baseEnv;
    if (this.chatgptProxies.has(session.id)) return baseEnv;
    const base = { ...baseEnv };
    try {
      const identity = await getIdentity(this.db, {
        platform: session.platform,
        workspaceId: session.workspace_id ?? null,
        userId: session.created_by_user_id,
      });
      if (!identity) return base;
      const account = await getChatgptAccountForIdentity({ db: this.db, config: this.config, identityId: identity.id });
      if (!account) return base;
      const proxyBin = await this.resolveChatgptProxyBin();
      if (!proxyBin) throw new Error("ChatGPT proxy binary not found");
      const refreshPath = path.join(os.tmpdir(), `tintin-chatgpt-refresh-${session.id}.json`);
      const requestedPort = base.CHATGPT_PROXY_PORT ? Number(base.CHATGPT_PROXY_PORT) : 0;
      let port = 0;
      if (Number.isFinite(requestedPort) && requestedPort > 0) {
        port = requestedPort;
      } else {
        port = await this.allocateLoopbackPort();
        if (!port) {
          // Retry once with a different random port; if still zero, bail with clear message.
          port = await this.allocateLoopbackPort();
          if (!port) throw new Error("Failed to allocate ChatGPT proxy port (localhost). Retry or set CHATGPT_PROXY_PORT to a free port.");
        }
      }
      const host = base.CHATGPT_PROXY_HOST || "127.0.0.1";
      const languageDirective = base.CHATGPT_PROXY_LANGUAGE_PROMPT ?? t("prompt.language_directive", this.resolveSessionLanguage(session));
      const languageDirectiveB64 =
        base.CHATGPT_PROXY_LANGUAGE_PROMPT_B64 ??
        (languageDirective ? Buffer.from(languageDirective, "utf8").toString("base64") : "");
      const proxyEnv: Record<string, string> = {
        ...base,
        CHATGPT_PROXY_ENABLED: "1",
        CHATGPT_ACCESS_TOKEN: account.accessToken,
        CHATGPT_REFRESH_TOKEN: account.refreshToken,
        CHATGPT_EXPIRES_AT: String(account.expiresAt),
        CHATGPT_ACCOUNT_ID: account.chatgptUserId,
        CHATGPT_PROXY_PORT: String(port),
        CHATGPT_PROXY_HOST: host,
        CHATGPT_REFRESH_OUT: refreshPath,
        CHATGPT_PROXY_LOG_PREFIX: base.CHATGPT_PROXY_LOG_PREFIX ?? `[chatgpt][proxy][${session.id}]`,
        CHATGPT_REFRESH_PREFIX: base.CHATGPT_REFRESH_PREFIX ?? `[chatgpt][refresh][${session.id}]`,
        CHATGPT_PROXY_LANGUAGE_PROMPT: languageDirective,
        CHATGPT_PROXY_LANGUAGE_PROMPT_B64: languageDirectiveB64,
      };

      const proc = spawn(process.execPath, [proxyBin], {
        env: { ...process.env, ...proxyEnv },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let proxyReady = false;
      let exitInfo: string | null = null;
      const recordExit = (info: string) => {
        if (exitInfo) return;
        exitInfo = info;
      };
      const handleProxyExit = (info: string) => {
        const entry = this.chatgptProxies.get(session.id);
        if (!entry || entry.proc !== proc) return;
        this.chatgptProxies.delete(session.id);
        void this.persistChatgptRefreshFile(session.id, entry.refreshPath, entry.identityId);
        if (proxyReady) {
          this.logger.warn(`[chatgpt][proxy] exited session=${session.id} ${info}`);
        }
      };
      proc.once("error", (err) => {
        const info = `error=${String(err)}`;
        recordExit(info);
        handleProxyExit(info);
      });
      proc.once("exit", (code, signal) => {
        const info = `exit code=${code ?? "null"} signal=${signal ?? "none"}`;
        recordExit(info);
        handleProxyExit(info);
      });
      proc.stderr?.on("data", (buf) => {
        const line = buf.toString("utf8").trim();
        if (line) this.logger.debug(redactText(line));
      });
      this.chatgptProxies.set(session.id, { proc, refreshPath, identityId: identity.id });
      this.logger.debug(`[chatgpt][proxy] spawn session=${session.id} port=${port} account=${account.chatgptUserId}`);
      const startupTimeoutMsRaw = Number(base.CHATGPT_PROXY_STARTUP_TIMEOUT_MS ?? 5000);
      const startupTimeoutMs = Number.isFinite(startupTimeoutMsRaw) && startupTimeoutMsRaw > 0 ? startupTimeoutMsRaw : 5000;
      const ready = await this.waitForChatgptProxyReady(host, port, startupTimeoutMs, () => exitInfo !== null);
      if (!ready || exitInfo) {
        const reason = exitInfo ?? "not ready before timeout";
        this.logger.warn(`[chatgpt][proxy] startup failed session=${session.id} ${reason}`);
        this.chatgptProxies.delete(session.id);
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        await this.persistChatgptRefreshFile(session.id, refreshPath, identity.id);
        return base;
      }
      proxyReady = true;
      const envWithProxy: Record<string, string> = { ...proxyEnv };
      if (!envWithProxy.OPENAI_BASE_URL) envWithProxy.OPENAI_BASE_URL = `http://${host}:${port}`;
      if (!envWithProxy.OPENAI_API_BASE) envWithProxy.OPENAI_API_BASE = envWithProxy.OPENAI_BASE_URL;
      if (!envWithProxy.OPENAI_API_KEY) envWithProxy.OPENAI_API_KEY = "chatgpt-oauth";
      this.logger.info(
        `[chatgpt][proxy] ready session=${session.id} port=${port} account=${account.chatgptUserId} exp=${new Date(account.expiresAt).toISOString()}`,
      );
      return envWithProxy;
    } catch (e) {
      this.logger.warn(`[chatgpt][proxy] setup failed session=${session.id}: ${String(e)}`);
      return base;
    }
  }

  private async persistChatgptRefreshFile(sessionId: string, refreshPath: string, identityId: string | null): Promise<void> {
    if (!refreshPath || !identityId) return;
    let raw: string;
    try {
      raw = await readFile(refreshPath, "utf8");
    } catch {
      return;
    }
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    let updated = false;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, any>;
        const access = typeof obj.access_token === "string" ? obj.access_token : "";
        const refresh = typeof obj.refresh_token === "string" ? obj.refresh_token : "";
        const expRaw = obj.expires_at ?? obj.expiresAt;
        const exp = typeof expRaw === "number" ? expRaw : Number(expRaw);
        if (!access || !refresh || !Number.isFinite(exp)) continue;
        await persistChatgptProxyTokens({
          db: this.db,
          config: this.config,
          identityId,
          accessToken: access,
          refreshToken: refresh,
          expiresAt: exp,
          scope: typeof obj.scope === "string" ? obj.scope : null,
          expectedAccountId: typeof obj.account_id === "string" ? obj.account_id : undefined,
        });
        updated = true;
      } catch {
        continue;
      }
    }
    if (updated) {
      this.logger.info(`[chatgpt][oauth] persisted refreshed tokens session=${sessionId} identity=${identityId}`);
    }
  }

  private async teardownChatgptProxy(sessionId: string, workspaceId: string | null, platform: string | null, userId: string | null) {
    const entry = this.chatgptProxies.get(sessionId);
    if (entry) {
      try {
        entry.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.chatgptProxies.delete(sessionId);
      await this.persistChatgptRefreshFile(sessionId, entry.refreshPath, entry.identityId);
      return;
    }
    if (platform && userId) {
      const identity = await getIdentity(this.db, { platform, workspaceId, userId });
      await this.persistChatgptRefreshFile(sessionId, path.join(os.tmpdir(), `tintin-chatgpt-refresh-${sessionId}.json`), identity?.id ?? null);
    }
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

// Re-export from modular implementation for migration path.
// Consumers can import from either './sessionManager' or './session/index'.
export {
  SessionStateMachine,
  ProcessLifecycleManager,
  ChatGptProxyManager,
  EnvironmentBuilder,
  VALID_TRANSITIONS,
  isTerminalStatus,
  type ProcessContext,
  type ProcessRegisterOptions,
  type ChatGptProxyContext,
  type CloudProxyResult as ModularCloudProxyResult,
  type KillReason as ModularKillReason,
} from "./session/index.js";
