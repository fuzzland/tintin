import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(String(stdout ?? "").trim());
    });
  });
}

export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim();
  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1]!.toLowerCase();
    let repo = sshMatch[2]!.replace(/\.git$/, "");
    return `https://${host}/${repo}`;
  }
  const httpsMatch = trimmed.match(/^https?:\/\/(.+)$/i);
  if (httpsMatch) {
    let rest = httpsMatch[1]!.replace(/\.git$/, "");
    return `https://${rest}`;
  }
  return trimmed.replace(/\.git$/, "");
}

export async function computeRepoFingerprint(repoPath: string): Promise<{ fingerprint: string; remoteUrl: string | null }> {
  const gitDirRaw = await execGit(["rev-parse", "--git-dir"], repoPath).catch(() => null);
  const gitDirResolved = gitDirRaw ? await realpath(path.resolve(repoPath, gitDirRaw)).catch(() => gitDirRaw) : null;
  const remoteRaw = await execGit(["config", "--get", "remote.origin.url"], repoPath).catch(() => null);
  const normalizedRemote = remoteRaw ? normalizeGitUrl(remoteRaw) : null;
  const base = `${gitDirResolved ?? repoPath}|${normalizedRemote ?? ""}`.toLowerCase();
  const fingerprint = crypto.createHash("sha256").update(base, "utf8").digest("hex");
  return { fingerprint, remoteUrl: normalizedRemote };
}
