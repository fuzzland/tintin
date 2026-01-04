import path from "node:path";
import { appendFile } from "node:fs/promises";
import type { Sandbox } from "modal";
import picomatch from "picomatch";
import type { Logger } from "../log.js";
import { sleep } from "../util.js";

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

async function runShell(
  sandbox: Sandbox,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = await sandbox.exec(["/bin/sh", "-lc", command], {
      workdir: "/",
      timeoutMs,
      mode: "text",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
    return { stdout, stderr, exitCode };
  } catch (e) {
    return { stdout: "", stderr: String(e), exitCode: 1 };
  }
}

export async function getRemoteFileSize(opts: { sandbox: Sandbox; remotePath: string; timeoutMs: number }): Promise<number> {
  const cmd = `wc -c < ${shellQuote(opts.remotePath)}`;
  const result = await runShell(opts.sandbox, cmd, opts.timeoutMs);
  const raw = String(result.stdout ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function findRemoteJsonlFiles(opts: {
  sandbox: Sandbox;
  sessionsRoot: string;
  sessionId?: string | null;
  timeoutMs: number;
  pollMs: number;
}): Promise<string[]> {
  const deadline = Date.now() + opts.timeoutMs;
  const patterns = opts.sessionId
    ? [`**/*-${opts.sessionId}.jsonl`, `**/*${opts.sessionId}*.jsonl`]
    : ["**/*.jsonl"];

  const matchers = patterns.map((pat) => picomatch(pat, { dot: true }));

  while (Date.now() < deadline) {
    const files = await listRemoteFiles(opts.sandbox, opts.sessionsRoot, opts.timeoutMs);
    const matches = files.filter((file) => {
      const rel = path.posix.relative(opts.sessionsRoot, file);
      return matchers.some((m) => m(rel));
    });
    if (matches.length > 0) return matches;
    await sleep(opts.pollMs);
  }
  return [];
}

async function listRemoteFiles(sandbox: Sandbox, root: string, timeoutMs: number): Promise<string[]> {
  const cmd = `find ${shellQuote(root)} -type f -print`;
  const result = await runShell(sandbox, cmd, timeoutMs);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export class RemoteLogSync {
  private running = false;
  private offset = 0;
  private readonly initialOffset: number;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly remotePath: string,
    private readonly localPath: string,
    private readonly logger: Logger,
    private readonly pollMs: number,
    private readonly commandTimeoutMs: number,
    initialOffset = 0,
  ) {
    this.initialOffset = initialOffset;
  }

  start() {
    if (this.running) return;
    this.offset = Math.max(0, Math.floor(this.initialOffset));
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  async drain(attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      await this.tick();
      await sleep(200);
    }
  }

  private async loop() {
    while (this.running) {
      await this.tick();
      await sleep(this.pollMs);
    }
  }

  private async tick() {
    const start = this.offset + 1;
    const cmd = `tail -c +${start} ${shellQuote(this.remotePath)}`;
    try {
      const result = await runShell(this.sandbox, cmd, this.commandTimeoutMs);
      if (result.exitCode !== 0) {
        const err = String(result.stderr ?? "").trim();
        if (err) {
          this.logger.debug(`[cloud][modal] log sync error: exit=${result.exitCode} stderr=${err}`);
        } else {
          this.logger.debug(`[cloud][modal] log sync error: exit=${result.exitCode}`);
        }
        return;
      }
      const chunk = result.stdout ?? "";
      if (!chunk) return;
      await appendFile(this.localPath, chunk);
      this.offset += Buffer.byteLength(chunk);
    } catch (e) {
      this.logger.debug(`[cloud][modal] log sync error: ${String(e)}`);
    }
  }
}
