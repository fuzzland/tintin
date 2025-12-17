import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ClaudeCodeSection } from "./config.js";
import type { Logger } from "./log.js";
import { redactText } from "./redact.js";
import { sleep } from "./util.js";

export interface SpawnedClaudeProcess {
  child: ChildProcessWithoutNullStreams;
  sessionId: Promise<string>;
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

function ensureNoProxyForLocalhost(env: Record<string, string>) {
  const additions = ["127.0.0.1", "localhost", "::1"];
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const raw = env[key] ?? "";
    const cur = raw.trim();
    if (cur === "*") continue;

    const parts = cur
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const set = new Set(parts);
    let changed = false;
    for (const a of additions) {
      if (set.has(a)) continue;
      set.add(a);
      changed = true;
    }
    if (!changed) continue;
    env[key] = Array.from(set).join(",");
  }
}

function buildBaseArgs(cfg: ClaudeCodeSection): string[] {
  // Non-interactive run.
  const args = ["--print"];

  // Stream-json output is easiest to debug and does not require a TTY, but it
  // requires --verbose (enforced by Claude Code).
  args.push("--output-format", "stream-json", "--verbose");

  // Permissions: Claude Code has its own permission gating; this flag is the
  // closest equivalent to Codex's "dangerously_bypass_approvals_and_sandbox".
  if (cfg.dangerously_bypass_approvals_and_sandbox) args.push("--dangerously-skip-permissions");

  return args;
}

export function resolveClaudeConfigDirFromSessionsRoot(sessionsRoot: string): string {
  // We treat the parent of sessionsRoot as CLAUDE_CONFIG_DIR (which Claude Code uses as its ~/.claude root).
  return path.dirname(sessionsRoot);
}

export function sanitizeClaudeProjectKey(cwd: string): string {
  // Claude Code uses a sanitized project key derived from the cwd.
  // Implementation matches @anthropic-ai/claude-code: `cwd.replace(/[^a-zA-Z0-9]/g, "-")`.
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function resolveClaudeSessionJsonlPath(configDir: string, cwd: string, sessionId: string): string {
  const projectDir = path.join(configDir, "projects", sanitizeClaudeProjectKey(cwd));
  return path.join(projectDir, `${sessionId}.jsonl`);
}

export async function findClaudeSessionJsonlFiles(opts: {
  configDir: string;
  cwd: string;
  sessionId: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<string[]> {
  const deadline = Date.now() + opts.timeoutMs;
  const file = resolveClaudeSessionJsonlPath(opts.configDir, opts.cwd, opts.sessionId);
  while (Date.now() < deadline) {
    const st = await stat(file).catch(() => null);
    if (st?.isFile()) return [file];
    await sleep(opts.pollMs);
  }
  return [];
}

function resolveDefaultClaudeConfigDir(): string {
  const home = os.homedir();
  return path.join(home, ".claude");
}

export async function ensureClaudeConfigDirExists(configDir: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
}

export function spawnClaudeExec(opts: {
  claude: ClaudeCodeSection;
  logger: Logger;
  cwd: string;
  sessionId: string;
  prompt: string;
  extraEnv?: Record<string, string>;
  extraArgs?: string[];
}): SpawnedClaudeProcess {
  const configDir = opts.extraEnv?.CLAUDE_CONFIG_DIR ?? resolveDefaultClaudeConfigDir();
  const args = [...buildBaseArgs(opts.claude), "--session-id", opts.sessionId, ...(opts.extraArgs ?? [])];

  const envOverrides: Record<string, string> = {
    ...opts.claude.env,
    // Ensure session persistence lives under a predictable directory (not the daemon user's real home dir).
    CLAUDE_CONFIG_DIR: configDir,
    ...(opts.extraEnv ?? {}),
  };
  const env: Record<string, string> = {
    ...process.env,
    ...envOverrides,
  } as Record<string, string>;
  ensureNoProxyForLocalhost(env);

  opts.logger.debug(
    `[claude] spawn kind=exec bin=${opts.claude.binary} cwd=${opts.cwd} args=${JSON.stringify(args)} env_overrides=${JSON.stringify(
      Object.keys(envOverrides),
    )} prompt_chars=${String(opts.prompt.length)}`,
  );

  const child = spawn(opts.claude.binary, args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutTail = new TailBuffer(8_000);
  const stderrTail = new TailBuffer(8_000);
  child.stdout.on("data", (buf) => stdoutTail.push(buf));
  child.stderr.on("data", (buf) => stderrTail.push(buf));

  child.stdin.write(opts.prompt);
  if (!opts.prompt.endsWith("\n")) child.stdin.write("\n");
  child.stdin.end();

  child.on("error", (e) => {
    opts.logger.error(`claude exec process error`, e);
  });

  child.stderr.on("data", (buf) => {
    const s = redactText(String(buf)).trim();
    if (s) opts.logger.warn(`claude exec stderr: ${s}`);
  });

  return {
    child,
    sessionId: Promise.resolve(opts.sessionId),
    debug: {
      kind: "exec",
      binary: opts.claude.binary,
      cwd: opts.cwd,
      args,
      envOverrides: Object.keys(envOverrides),
      stdoutTail: () => stdoutTail.get(),
      stderrTail: () => stderrTail.get(),
    },
  };
}

export function spawnClaudeResume(opts: {
  claude: ClaudeCodeSection;
  logger: Logger;
  cwd: string;
  sessionId: string;
  prompt: string;
  extraEnv?: Record<string, string>;
  extraArgs?: string[];
}): SpawnedClaudeProcess {
  const configDir = opts.extraEnv?.CLAUDE_CONFIG_DIR ?? resolveDefaultClaudeConfigDir();
  const args = [...buildBaseArgs(opts.claude), "--resume", opts.sessionId, ...(opts.extraArgs ?? [])];

  const envOverrides: Record<string, string> = {
    ...opts.claude.env,
    CLAUDE_CONFIG_DIR: configDir,
    ...(opts.extraEnv ?? {}),
  };
  const env: Record<string, string> = {
    ...process.env,
    ...envOverrides,
  } as Record<string, string>;
  ensureNoProxyForLocalhost(env);

  opts.logger.debug(
    `[claude] spawn kind=resume bin=${opts.claude.binary} cwd=${opts.cwd} args=${JSON.stringify(args)} env_overrides=${JSON.stringify(
      Object.keys(envOverrides),
    )} prompt_chars=${String(opts.prompt.length)}`,
  );

  const child = spawn(opts.claude.binary, args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutTail = new TailBuffer(8_000);
  const stderrTail = new TailBuffer(8_000);
  child.stdout.on("data", (buf) => stdoutTail.push(buf));
  child.stderr.on("data", (buf) => stderrTail.push(buf));

  child.stdin.write(opts.prompt);
  if (!opts.prompt.endsWith("\n")) child.stdin.write("\n");
  child.stdin.end();

  child.on("error", (e) => {
    opts.logger.error(`claude resume process error`, e);
  });

  child.stderr.on("data", (buf) => {
    const s = redactText(String(buf)).trim();
    if (s) opts.logger.warn(`claude resume stderr: ${s}`);
  });

  return {
    child,
    sessionId: Promise.resolve(opts.sessionId),
    debug: {
      kind: "resume",
      binary: opts.claude.binary,
      cwd: opts.cwd,
      args,
      envOverrides: Object.keys(envOverrides),
      stdoutTail: () => stdoutTail.get(),
      stderrTail: () => stderrTail.get(),
    },
  };
}

export async function generateClaudeTitle(opts: {
  claude: ClaudeCodeSection;
  logger: Logger;
  cwd: string;
  projectName: string;
  initialPrompt: string;
  maxTitleChars: number;
  configDir: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const maxTitleChars = Math.max(16, Math.min(256, Math.floor(opts.maxTitleChars)));
  const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1_000, opts.timeoutMs) : 20_000;

  const titlePrompt = buildTitlePrompt({
    projectName: opts.projectName,
    initialPrompt: opts.initialPrompt,
    maxTitleChars,
  });

  await ensureClaudeConfigDirExists(opts.configDir);

  const args = ["--print", "--output-format", "json", "--no-session-persistence"];
  if (opts.claude.dangerously_bypass_approvals_and_sandbox) args.push("--dangerously-skip-permissions");

  const envOverrides: Record<string, string> = {
    ...opts.claude.env,
    CLAUDE_CONFIG_DIR: opts.configDir,
  };
  const env: Record<string, string> = {
    ...process.env,
    ...envOverrides,
  } as Record<string, string>;
  ensureNoProxyForLocalhost(env);

  opts.logger.debug(
    `[claude] title spawn bin=${opts.claude.binary} cwd=${opts.cwd} args=${JSON.stringify(args)} env_overrides=${JSON.stringify(
      Object.keys(envOverrides),
    )} prompt_chars=${String(titlePrompt.length)}`,
  );

  const child = spawn(opts.claude.binary, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

  const stdoutTail = new TailBuffer(8_000);
  const stderrTail = new TailBuffer(8_000);
  child.stdout.on("data", (buf) => stdoutTail.push(buf));
  child.stderr.on("data", (buf) => stderrTail.push(buf));

  child.stdin.write(titlePrompt);
  if (!titlePrompt.endsWith("\n")) child.stdin.write("\n");
  child.stdin.end();

  const exited = await waitForExitWithTimeout(child, timeoutMs);
  if (!exited.exited) {
    opts.logger.warn(`[claude] title generation timed out after ${String(timeoutMs)}ms, killing pid=${String(child.pid ?? "?")}`);
    await killChildBestEffort(child);
  }

  const stdout = stdoutTail.get();
  const stderr = stderrTail.get();
  const parsed = extractResultFromClaudeJson(stdout);
  if (parsed) return clipOneLine(parsed, maxTitleChars);

  // Fallback: best-effort from stderr/stdout.
  const fallback = firstNonEmptyLine(redactText(stderr)) ?? firstNonEmptyLine(redactText(stdout));
  if (fallback) return clipOneLine(fallback, maxTitleChars);
  return null;
}

function extractResultFromClaudeJson(stdout: string): string | null {
  const t = stdout.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t) as { type?: unknown; subtype?: unknown; result?: unknown };
    if (obj?.type === "result" && typeof obj.result === "string") {
      const s = obj.result.trim();
      return s.length > 0 ? s : null;
    }
  } catch {
    return null;
  }
  return null;
}

function buildTitlePrompt(opts: { projectName: string; initialPrompt: string; maxTitleChars: number }): string {
  const max = Math.max(16, Math.min(256, Math.floor(opts.maxTitleChars)));
  const prompt = opts.initialPrompt.trim();
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > 800 ? `${oneLine.slice(0, 800)}…` : oneLine;
  return [
    "Generate a short Telegram forum topic title for this Claude Code session.",
    `Return ONLY the title as plain text (no quotes, no markdown, no code block).`,
    "Do NOT include any leading emoji.",
    `Max ${max} characters.`,
    "",
    `Project: ${opts.projectName}`,
    `User prompt: ${clipped}`,
    "",
  ].join("\n");
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
