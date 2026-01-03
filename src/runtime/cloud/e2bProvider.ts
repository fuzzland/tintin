import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { CommandExitError, Sandbox } from "e2b";
import type { CloudE2BSection } from "../config.js";
import type { Logger } from "../log.js";
import type { CloudProvider, CloudUploadFile, CloudWorkspace } from "./provider.js";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

type SandboxFactory = (templateId: string | null, opts: Record<string, unknown>) => Promise<Sandbox>;

export class E2BCloudProvider implements CloudProvider {
  id = "e2b";
  readonly workspaceRoot: string;
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly commandTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly snapshotDir: string | null;
  private readonly sandboxFactory: SandboxFactory;

  constructor(
    private readonly config: CloudE2BSection,
    private readonly logger: Logger,
    opts?: { snapshotDir?: string | null; sandboxFactory?: SandboxFactory },
  ) {
    this.workspaceRoot = config.workspace_root;
    this.commandTimeoutMs = config.command_timeout_ms;
    this.requestTimeoutMs = config.request_timeout_ms;
    this.snapshotDir = opts?.snapshotDir ?? null;
    this.sandboxFactory =
      opts?.sandboxFactory ??
      (async (templateId, options) => {
        if (templateId) return await Sandbox.create(templateId, options);
        return await Sandbox.create(options);
      });
  }

  getSandbox(workspaceId: string): Sandbox {
    const sandbox = this.sandboxes.get(workspaceId);
    if (!sandbox) throw new Error(`Missing sandbox for workspace ${workspaceId}`);
    return sandbox;
  }

  async createWorkspace(opts: { prefix?: string }): Promise<CloudWorkspace> {
    const sandboxOpts: Record<string, unknown> = {
      apiKey: this.config.api_key || undefined,
      domain: this.config.domain || undefined,
      requestTimeoutMs: this.requestTimeoutMs,
      timeoutMs: this.config.timeout_ms,
      secure: this.config.secure,
      allowInternetAccess: this.config.allow_internet_access,
    };
    const sandbox = await this.sandboxFactory(this.config.template_id || null, sandboxOpts);

    const id = sandbox.sandboxId;
    this.sandboxes.set(id, sandbox);

    const root = toPosix(this.workspaceRoot);
    await sandbox.files.makeDir(root).catch(() => {});

    return { id, rootPath: root };
  }

  async uploadFiles(workspace: CloudWorkspace, files: CloudUploadFile[]): Promise<void> {
    if (files.length === 0) return;
    const sandbox = this.getSandbox(workspace.id);
    const entries = files.map((file) => {
      const rel = toPosix(file.path);
      const data =
        typeof file.content === "string"
          ? file.content
          : new Uint8Array(file.content).slice().buffer;
      return { path: path.posix.join(workspace.rootPath, rel), data };
    });
    await sandbox.files.write(entries, { requestTimeoutMs: this.requestTimeoutMs });

    for (const file of files) {
      if (!file.mode) continue;
      const mode = Number.parseInt(file.mode, 8);
      if (!Number.isFinite(mode)) continue;
      const rel = toPosix(file.path);
      const target = path.posix.join(workspace.rootPath, rel);
      await this.runCommand(sandbox, `chmod ${mode.toString(8)} ${shellQuote(target)}`, { cwd: workspace.rootPath });
    }
  }

  async runCommands(opts: {
    workspace: CloudWorkspace;
    cwd: string;
    commands: string[];
    env?: Record<string, string>;
  }): Promise<void> {
    const sandbox = this.getSandbox(opts.workspace.id);
    for (const cmd of opts.commands) {
      if (!cmd.trim()) continue;
      await this.runCommand(sandbox, cmd, { cwd: opts.cwd, env: opts.env });
    }
  }

  async snapshotWorkspace(workspace: CloudWorkspace, label: string): Promise<string> {
    const sandbox = this.getSandbox(workspace.id);
    const snapshotId = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const remoteTar = `/tmp/tintin-snapshot-${snapshotId}.tar.gz`;
    await this.runCommand(
      sandbox,
      `tar -czf ${shellQuote(remoteTar)} -C ${shellQuote(workspace.rootPath)} .`,
      { cwd: workspace.rootPath },
    );

    if (this.snapshotDir) {
      const bytes = await sandbox.files.read(remoteTar, { format: "bytes", requestTimeoutMs: this.requestTimeoutMs });
      await mkdir(this.snapshotDir, { recursive: true });
      const target = path.join(this.snapshotDir, `${snapshotId}.tar.gz`);
      await writeFile(target, Buffer.from(bytes));
      await sandbox.files.remove(remoteTar).catch(() => {});
    }

    return snapshotId;
  }

  async pullDiff(opts: { workspace: CloudWorkspace; cwd: string }): Promise<{ diff: string; summary: string }> {
    const sandbox = this.getSandbox(opts.workspace.id);
    let diff = "";
    try {
      const result = await this.runCommand(sandbox, "git diff", { cwd: opts.cwd });
      diff = result.stdout ?? "";
    } catch (e) {
      if (e instanceof CommandExitError) {
        diff = e.stdout ?? "";
      } else {
        throw e;
      }
    }
    const summary = diff.length > 0 ? diff.split("\n").slice(0, 20).join("\n") : "";
    return { diff, summary };
  }

  async terminateWorkspace(workspace: CloudWorkspace): Promise<void> {
    const sandbox = this.sandboxes.get(workspace.id);
    if (!sandbox) return;
    await sandbox.kill({ requestTimeoutMs: this.requestTimeoutMs }).catch(() => {});
    this.sandboxes.delete(workspace.id);
  }

  private async runCommand(
    sandbox: Sandbox,
    command: string,
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }> {
    try {
      const result = await sandbox.commands.run(command, {
        cwd: toPosix(opts.cwd),
        envs: opts.env,
        timeoutMs: this.commandTimeoutMs,
        onStdout: (data) => this.logger.debug(`[cloud][e2b] ${data.trimEnd()}`),
        onStderr: (data) => this.logger.debug(`[cloud][e2b] ${data.trimEnd()}`),
      });
      return result as { stdout: string; stderr: string; exitCode: number; error?: string };
    } catch (e) {
      if (e instanceof CommandExitError) {
        this.logger.debug(`[cloud][e2b] command failed: ${e.exitCode} ${e.stderr ?? ""}`.trim());
      }
      throw e;
    }
  }
}
