import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { Logger } from "./log.js";
import { redactText } from "./redact.js";
import { sleep } from "./util.js";

export function resolveSessionsRoot(codexCwd: string, sessionsDir: string): string {
  return path.isAbsolute(sessionsDir) ? sessionsDir : path.join(codexCwd, sessionsDir);
}

export function resolveCodexHomeFromSessionsRoot(sessionsRoot: string): string {
  return path.dirname(sessionsRoot);
}

export async function ensureSessionsRootExists(sessionsRoot: string) {
  await mkdir(sessionsRoot, { recursive: true });
}

export async function findSessionJsonlFiles(opts: {
  sessionsRoot: string;
  codexSessionId: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<string[]> {
  const deadline = Date.now() + opts.timeoutMs;
  const sessionDir = path.join(opts.sessionsRoot, opts.codexSessionId);
  const patterns = [`**/*-${opts.codexSessionId}.jsonl`, `**/*${opts.codexSessionId}*.jsonl`];

  while (Date.now() < deadline) {
    // Layout A: sessions/<session_id>/*.jsonl
    const st = await stat(sessionDir).catch(() => null);
    if (st?.isDirectory()) {
      const glob = new Bun.Glob("**/*.jsonl");
      const matches: string[] = [];
      for await (const rel of glob.scan({ cwd: sessionDir })) {
        matches.push(path.join(sessionDir, rel));
      }
      if (matches.length > 0) return matches;
    }

    for (const pat of patterns) {
      const glob = new Bun.Glob(pat);
      const matches: string[] = [];
      for await (const rel of glob.scan({ cwd: opts.sessionsRoot })) {
        matches.push(path.join(opts.sessionsRoot, rel));
      }
      if (matches.length > 0) return matches;
    }
    await sleep(opts.pollMs);
  }
  return [];
}

export interface SpawnedCodexProcess {
  child: ChildProcessWithoutNullStreams;
  threadId: Promise<string>;
  debug: {
    kind: string;
    binary: string;
    cwd: string;
    args: string[];
    envOverrides: string[];
    stdoutTail: () => string;
    stderrTail: () => string;
  };
}

export async function generateCodexTitle(opts: {
  config: AppConfig;
  logger: Logger;
  cwd: string;
  projectName: string;
  initialPrompt: string;
  maxTitleChars: number;
  timeoutMs?: number;
}): Promise<string | null> {
  const maxTitleChars = Math.max(16, Math.min(256, Math.floor(opts.maxTitleChars)));
  const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1_000, opts.timeoutMs) : 20_000;

  const sessionsRoot = resolveSessionsRoot(opts.cwd, opts.config.codex.sessions_dir);
  const codexHome = resolveCodexHomeFromSessionsRoot(sessionsRoot);
  await ensureSessionsRootExists(sessionsRoot);

  const titlePrompt = buildTitlePrompt({
    projectName: opts.projectName,
    initialPrompt: opts.initialPrompt,
    maxTitleChars,
  });

  const spawned = spawnCodexExec({
    config: opts.config,
    logger: opts.logger,
    cwd: opts.cwd,
    prompt: titlePrompt,
    extraEnv: { CODEX_HOME: codexHome },
  });
  void spawned.threadId.catch(() => {});

  const exited = await waitForExitWithTimeout(spawned.child, timeoutMs);
  if (!exited.exited) {
    opts.logger.warn(`[codex] title generation timed out after ${String(timeoutMs)}ms, killing pid=${String(spawned.child.pid ?? "?")}`);
    await killChildBestEffort(spawned.child);
  }

  const stdout = spawned.debug.stdoutTail();
  const stderr = spawned.debug.stderrTail();
  const title = extractTitleFromCodexOutput(stdout);
  if (title) return clipOneLine(title, maxTitleChars);

  // If parsing fails, try a last-resort guess from stderr/stdout.
  const fallback = firstNonEmptyLine(redactText(stderr)) ?? firstNonEmptyLine(redactText(stdout));
  if (fallback) return clipOneLine(fallback, maxTitleChars);
  return null;
}

class TailBuffer {
  private buf = "";

  constructor(private readonly maxChars: number) {}

  push(chunk: Buffer) {
    const text = chunk.toString("utf8");
    if (!text) return;
    this.buf += text;
    if (this.buf.length > this.maxChars) this.buf = this.buf.slice(this.buf.length - this.maxChars);
  }

  get(): string {
    return this.buf;
  }
}

function buildBaseArgs(config: AppConfig, cwd: string): string[] {
  const args: string[] = ["exec", "--json", "--color", "never", "-C", cwd];
  if (config.codex.dangerously_bypass_approvals_and_sandbox) args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (config.codex.full_auto) args.push("--full-auto");
  if (config.codex.skip_git_repo_check) args.push("--skip-git-repo-check");
  return args;
}

export function spawnCodexExec(opts: {
  config: AppConfig;
  logger: Logger;
  cwd: string;
  prompt: string;
  extraEnv?: Record<string, string>;
}): SpawnedCodexProcess {
  const args = [...buildBaseArgs(opts.config, opts.cwd), "-"];
  return spawnCodexInternal({ ...opts, args, kind: "exec" });
}

export function spawnCodexResume(opts: {
  config: AppConfig;
  logger: Logger;
  cwd: string;
  sessionId: string;
  prompt: string;
  extraEnv?: Record<string, string>;
}): SpawnedCodexProcess {
  const args = [...buildBaseArgs(opts.config, opts.cwd), "resume", opts.sessionId, "-"];
  return spawnCodexInternal({ ...opts, args, kind: "resume" });
}

function spawnCodexInternal(opts: {
  config: AppConfig;
  logger: Logger;
  cwd: string;
  prompt: string;
  args: string[];
  kind: string;
  extraEnv?: Record<string, string>;
}): SpawnedCodexProcess {
  const envOverrides: Record<string, string> = {
    ...opts.config.codex.env,
    ...(opts.extraEnv ?? {}),
  };
  const env: Record<string, string> = {
    ...process.env,
    ...envOverrides,
  } as Record<string, string>;

  opts.logger.debug(
    `[codex] spawn kind=${opts.kind} bin=${opts.config.codex.binary} cwd=${opts.cwd} args=${JSON.stringify(opts.args)} env_overrides=${JSON.stringify(
      Object.keys(envOverrides),
    )} prompt_chars=${String(opts.prompt.length)}`,
  );

  const child = spawn(opts.config.codex.binary, opts.args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  opts.logger.debug(`[codex] spawned kind=${opts.kind} pid=${String(child.pid ?? "?")}`);

  const stdoutTail = new TailBuffer(8_000);
  const stderrTail = new TailBuffer(8_000);
  child.stdout.on("data", (buf) => stdoutTail.push(buf));
  child.stderr.on("data", (buf) => stderrTail.push(buf));

  child.stdin.write(opts.prompt);
  if (!opts.prompt.endsWith("\n")) child.stdin.write("\n");
  child.stdin.end();

  const threadId = new Promise<string>((resolve, reject) => {
    let resolved = false;
    let nonJsonLinesLogged = 0;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (resolved) return;
      try {
        const obj = JSON.parse(line) as { type?: string; thread_id?: string };
        if (obj.type === "thread.started" && typeof obj.thread_id === "string" && obj.thread_id.length > 0) {
          resolved = true;
          resolve(obj.thread_id);
        }
      } catch {
        if (nonJsonLinesLogged < 5) {
          nonJsonLinesLogged++;
          const redacted = redactText(line);
          const snippet = redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
          opts.logger.debug(`[codex] ${opts.kind} stdout non-json: ${snippet}`);
        }
      }
    });
    child.on("exit", (code, signal) => {
      if (!resolved) reject(new Error(`codex ${opts.kind} exited before thread id (code=${code}, signal=${signal})`));
      rl.close();
    });
    child.on("error", (e) => {
      if (!resolved) reject(e);
    });
  });

  child.stderr.on("data", (buf) => {
    const s = redactText(String(buf)).trim();
    if (s) opts.logger.warn(`codex ${opts.kind} stderr: ${s}`);
  });

  child.on("error", (e) => {
    opts.logger.error(`codex ${opts.kind} process error`, e);
  });

  return {
    child,
    threadId,
    debug: {
      kind: opts.kind,
      binary: opts.config.codex.binary,
      cwd: opts.cwd,
      args: opts.args,
      envOverrides: Object.keys(envOverrides),
      stdoutTail: () => stdoutTail.get(),
      stderrTail: () => stderrTail.get(),
    },
  };
}

function buildTitlePrompt(opts: { projectName: string; initialPrompt: string; maxTitleChars: number }): string {
  const max = Math.max(16, Math.min(256, Math.floor(opts.maxTitleChars)));
  const prompt = opts.initialPrompt.trim();
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > 800 ? `${oneLine.slice(0, 800)}…` : oneLine;
  return [
    "Generate a short Telegram forum topic title for this Codex session.",
    `Return ONLY the title as plain text (no quotes, no markdown, no code block).`,
    "Do NOT include any leading emoji.",
    `Max ${max} characters.`,
    "",
    `Project: ${opts.projectName}`,
    `User prompt: ${clipped}`,
    "",
  ].join("\n");
}

function extractTitleFromCodexOutput(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const type = obj?.type;
    const payload = obj?.payload;
    if (type !== "response_item" || !payload || typeof payload !== "object") continue;
    if (payload.type !== "message" || payload.role !== "assistant") continue;
    const content = payload.content;
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "output_text") continue;
      if (typeof item.text === "string") parts.push(item.text);
    }
    const text = parts.join("").trim();
    if (text) return text;
  }
  return null;
}

function clipOneLine(input: string, maxChars: number): string {
  const max = Math.max(1, Math.floor(maxChars));
  const oneLine = redactText(input).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max).trimEnd();
}

function firstNonEmptyLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;

    // Avoid using codex JSON lines as titles; but allow JSON strings (e.g. "\"My title\"").
    try {
      const parsed = JSON.parse(t) as unknown;
      if (typeof parsed === "string") {
        const s = parsed.trim();
        if (s) return s;
      }
      if (parsed && typeof parsed === "object") continue;
    } catch {
      // Not JSON; treat as plain text.
    }

    return t;
  }
  return null;
}

async function waitForExitWithTimeout(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ exited: boolean }> {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return await new Promise((resolve) => {
    const onExit = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ exited: true });
    };
    child.once("exit", onExit);
    child.once("close", onExit);
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve({ exited: false });
    }, timeoutMs);
  });
}

async function killChildBestEffort(child: ChildProcessWithoutNullStreams): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await sleep(2_000);
  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
}
