import path from "node:path";
import { appendFile } from "node:fs/promises";
import { CommandExitError, FileType, Sandbox } from "e2b";
import picomatch from "picomatch";
import type { Logger } from "../log.js";
import { sleep } from "../util.js";

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

export async function getRemoteFileSize(opts: { sandbox: Sandbox; remotePath: string; timeoutMs: number }): Promise<number> {
  const cmd = `wc -c < ${shellQuote(opts.remotePath)}`;
  try {
    const result = await opts.sandbox.commands.run(cmd, { timeoutMs: opts.timeoutMs });
    const raw = String(result.stdout ?? "").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
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
    const files = await listRemoteFiles(opts.sandbox, opts.sessionsRoot);
    const matches = files.filter((file) => {
      const rel = path.posix.relative(opts.sessionsRoot, file);
      return matchers.some((m) => m(rel));
    });
    if (matches.length > 0) return matches;
    await sleep(opts.pollMs);
  }
  return [];
}

async function listRemoteFiles(sandbox: Sandbox, root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await sandbox.files.list(dir).catch(() => []);
    for (const entry of entries) {
      if (entry.type === FileType.DIR) {
        stack.push(entry.path);
      } else if (entry.type === FileType.FILE) {
        out.push(entry.path);
      }
    }
  }
  return out;
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
      const result = await this.sandbox.commands.run(cmd, { timeoutMs: this.commandTimeoutMs });
      const chunk = result.stdout ?? "";
      if (!chunk) return;
      await appendFile(this.localPath, chunk);
      this.offset += Buffer.byteLength(chunk);
    } catch (e) {
      if (e instanceof CommandExitError) return;
      this.logger.debug(`[cloud][e2b] log sync error: ${String(e)}`);
    }
  }
}
