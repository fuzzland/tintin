import { spawn } from "node:child_process";
import type { Logger } from "../log.js";

export function buildCloneUrl(
  repoUrl: string,
  token: string | null,
  _opts?: { username?: string },
): { url: string; redacted: string } {
  const redacted = repoUrl.replace(/^https?:\/\//, "https://***@");
  return { url: repoUrl, redacted: token ? redacted : repoUrl };
}

export function buildGitAuthHeader(token: string | null, username?: string | null): string | null {
  if (!token) return null;
  const user = (username ?? "").trim() || "x-access-token";
  const basic = Buffer.from(`${user}:${token}`).toString("base64");
  return `Authorization: Basic ${basic}`;
}

export async function runGitClone(opts: {
  url: string;
  cwd: string;
  targetDir: string;
  logger: Logger;
  authHeader?: string | null;
}) {
  await new Promise<void>((resolve, reject) => {
    const args = ["clone", "--depth", "1", opts.url, opts.targetDir];
    if (opts.authHeader) {
      args.unshift(`http.extraheader=${opts.authHeader}`);
      args.unshift("-c");
    }
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => opts.logger.debug(`[cloud][git] ${String(chunk)}`));
    child.stderr.on("data", (chunk) => opts.logger.debug(`[cloud][git] ${String(chunk)}`));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed (${code})`));
    });
  });
}
