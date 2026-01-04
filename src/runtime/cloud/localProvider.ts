import { mkdir, writeFile, chmod, cp, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Logger } from "../log.js";
import type { CloudProvider, CloudUploadFile, CloudWorkspace } from "./provider.js";

async function runCommand(opts: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  logger: Logger;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => opts.logger.debug(`[cloud][cmd] ${String(chunk)}`));
    child.stderr.on("data", (chunk) => opts.logger.debug(`[cloud][cmd] ${String(chunk)}`));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${code}): ${opts.command}`));
    });
  });
}

export class LocalCloudProvider implements CloudProvider {
  id = "local";

  constructor(private readonly rootDir: string, private readonly logger: Logger) {}

  async createWorkspace(opts: { prefix?: string }): Promise<CloudWorkspace> {
    const id = `${opts.prefix ?? "ws"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rootPath = path.join(this.rootDir, id);
    await mkdir(rootPath, { recursive: true });
    return { id, rootPath };
  }

  async uploadFiles(workspace: CloudWorkspace, files: CloudUploadFile[]): Promise<void> {
    for (const file of files) {
      const target = path.join(workspace.rootPath, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      const data = typeof file.content === "string" ? file.content : file.content;
      await writeFile(target, data);
      if (file.mode) {
        const mode = Number.parseInt(file.mode, 8);
        if (Number.isFinite(mode)) await chmod(target, mode);
      }
    }
  }

  async runCommands(opts: {
    workspace: CloudWorkspace;
    cwd: string;
    commands: string[];
    env?: Record<string, string>;
  }): Promise<void> {
    for (const cmd of opts.commands) {
      if (!cmd.trim()) continue;
      await runCommand({ command: cmd, cwd: opts.cwd, env: opts.env, logger: this.logger });
    }
  }

  async snapshotWorkspace(workspace: CloudWorkspace, label: string): Promise<string> {
    const snapshotId = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const snapshotsDir = path.join(this.rootDir, "snapshots");
    const target = path.join(snapshotsDir, snapshotId);
    await mkdir(snapshotsDir, { recursive: true });
    await cp(workspace.rootPath, target, { recursive: true });
    return snapshotId;
  }

  async pullDiff(opts: { workspace: CloudWorkspace; cwd: string }): Promise<{ diff: string; summary: string }> {
    const runGit = async (args: string[]): Promise<string> =>
      await new Promise((resolve) => {
        const child = spawn("git", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
        child.on("exit", () => resolve(Buffer.concat(chunks).toString("utf8")));
        child.on("error", () => resolve(""));
      });

    let diff = await runGit(["diff"]);
    const untracked = await runGit(["ls-files", "--others", "--exclude-standard"]);
    for (const file of untracked.split("\n").map((line) => line.trim()).filter(Boolean)) {
      diff += await runGit(["diff", "--no-index", "/dev/null", file]);
    }
    const summary = diff.length > 0 ? diff.split("\n").slice(0, 20).join("\n") : "";
    return { diff, summary };
  }

  async terminateWorkspace(workspace: CloudWorkspace): Promise<void> {
    await rm(workspace.rootPath, { recursive: true, force: true }).catch(() => {});
  }
}
