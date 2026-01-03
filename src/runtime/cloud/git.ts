import { spawn } from "node:child_process";
import type { Logger } from "../log.js";

export function buildCloneUrl(
  repoUrl: string,
  token: string | null,
  opts?: { username?: string },
): { url: string; redacted: string } {
  const redacted = repoUrl.replace(/^https?:\/\//, "https://***@");
  if (!token) return { url: repoUrl, redacted: repoUrl };
  const encodedToken = encodeURIComponent(token.trim());
  const encodedUser = opts?.username ? encodeURIComponent(opts.username.trim()) : null;
  if (repoUrl.startsWith("https://")) {
    if (encodedUser) {
      return { url: repoUrl.replace(/^https:\/\//, `https://${encodedUser}:${encodedToken}@`), redacted };
    }
    return { url: repoUrl.replace(/^https:\/\//, `https://${encodedToken}@`), redacted };
  }
  if (repoUrl.startsWith("http://")) {
    if (encodedUser) {
      return { url: repoUrl.replace(/^http:\/\//, `http://${encodedUser}:${encodedToken}@`), redacted };
    }
    return { url: repoUrl.replace(/^http:\/\//, `http://${encodedToken}@`), redacted };
  }
  return { url: repoUrl, redacted: repoUrl };
}

export async function runGitClone(opts: { url: string; cwd: string; targetDir: string; logger: Logger }) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", "--depth", "1", opts.url, opts.targetDir], {
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
