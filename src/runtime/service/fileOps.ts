import { open, readdir, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type http from "node:http";

export async function writeRequestToFile(req: http.IncomingMessage, targetPath: string, maxBytes: number): Promise<number> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const out = createWriteStream(targetPath);
  let total = 0;
  return await new Promise<number>((resolve, reject) => {
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        req.destroy();
        out.destroy();
        reject(new Error("payload too large"));
      }
    });
    out.on("error", reject);
    out.on("finish", () => resolve(total));
    pipeline(req, out).catch(reject);
  });
}

export async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    child.on("error", (err) => resolve({ stdout, stderr: String(err), exitCode: 1 }));
  });
}

function isSafeTarEntry(entry: string): boolean {
  if (!entry) return true;
  if (entry.startsWith("/") || entry.startsWith("\\")) return false;
  const parts = entry.split("/").filter(Boolean);
  return !parts.some((part) => part === "..");
}

export async function safeExtractTar(archivePath: string, destDir: string): Promise<void> {
  const list = await runCommand("tar", ["-tvzf", archivePath]);
  if (list.exitCode !== 0) throw new Error(`tar list failed: ${list.stderr || list.stdout}`);
  const entries = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).slice(5).join(" "));
  if (!entries.every(isSafeTarEntry)) throw new Error("unsafe tar entry detected");
  await runCommand("tar", ["-xvzf", archivePath, "-C", destDir]);
}

export async function readNewJsonlLines(filePath: string, offset: number): Promise<{ lines: string[]; newOffset: number }> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (offset >= stat.size) return { lines: [], newOffset: offset };

    const maxBytes = 2_000_000;
    const remaining = stat.size - offset;
    const toRead = Math.min(remaining, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, offset);
    const slice = buf.subarray(0, bytesRead);

    const lastNewline = slice.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], newOffset: offset };

    const complete = slice.subarray(0, lastNewline);
    const text = complete.toString("utf8");
    const lines = text.split("\n");
    const newOffset = offset + lastNewline + 1;
    return { lines, newOffset };
  } finally {
    await handle.close();
  }
}

export async function listJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path.join(dir, e.name));
  files.sort();
  return files;
}
