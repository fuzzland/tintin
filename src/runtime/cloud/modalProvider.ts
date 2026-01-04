import path from "node:path";
import { ModalClient, type App, type Image, type Sandbox, type SandboxCreateParams } from "modal";
import type { CloudModalSection } from "../config.js";
import type { Logger } from "../log.js";
import type { CloudProvider, CloudUploadFile, CloudWorkspace } from "./provider.js";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

export class ModalCloudProvider implements CloudProvider {
  id = "modal";
  readonly workspaceRoot: string;
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly client: ModalClient;
  private readonly commandTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly blockNetwork: boolean;
  private readonly cidrAllowlist: string[];
  private readonly appName: string;
  private readonly imageId: string;
  private readonly imageTag: string;
  private app: App | null = null;
  private image: Image | null = null;

  constructor(
    private readonly config: CloudModalSection,
    private readonly logger: Logger,
    opts?: { client?: ModalClient },
  ) {
    this.workspaceRoot = config.workspace_root;
    this.commandTimeoutMs = config.command_timeout_ms;
    this.requestTimeoutMs = config.request_timeout_ms;
    this.timeoutMs = config.timeout_ms;
    this.idleTimeoutMs = config.idle_timeout_ms;
    this.blockNetwork = config.block_network;
    this.cidrAllowlist = config.cidr_allowlist;
    this.appName = config.app_name;
    this.imageId = config.image_id;
    this.imageTag = config.image;
    this.client =
      opts?.client ??
      new ModalClient({
        tokenId: config.token_id || undefined,
        tokenSecret: config.token_secret || undefined,
        environment: config.environment || undefined,
        endpoint: config.endpoint || undefined,
        timeoutMs: this.requestTimeoutMs,
      });
  }

  getSandbox(workspaceId: string): Sandbox {
    const sandbox = this.sandboxes.get(workspaceId);
    if (!sandbox) throw new Error(`Missing sandbox for workspace ${workspaceId}`);
    return sandbox;
  }

  async createWorkspace(opts: { prefix?: string }): Promise<CloudWorkspace> {
    const app = await this.getApp();
    const image = await this.getImage();
    return await this.createWorkspaceWithImage(app, image, {
      source: "image",
      label: this.imageId || this.imageTag || "image",
    });
  }

  async createWorkspaceFromSnapshot(snapshotId: string): Promise<CloudWorkspace> {
    const app = await this.getApp();
    const image = await this.client.images.fromId(snapshotId);
    return await this.createWorkspaceWithImage(app, image, {
      source: "snapshot",
      label: snapshotId,
    });
  }

  async uploadFiles(workspace: CloudWorkspace, files: CloudUploadFile[]): Promise<void> {
    if (files.length === 0) return;
    const sandbox = this.getSandbox(workspace.id);
    for (const file of files) {
      const rel = toPosix(file.path);
      const target = path.posix.join(workspace.rootPath, rel);
      const dir = path.posix.dirname(target);
      await this.runCommand(sandbox, `mkdir -p ${shellQuote(dir)}`, { cwd: "/" });

      const handle = await sandbox.open(target, "w");
      const bytes = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
      await handle.write(bytes);
      await handle.flush();
      await handle.close();

      if (file.mode) {
        const mode = Number.parseInt(file.mode, 8);
        if (Number.isFinite(mode)) {
          await this.runCommand(sandbox, `chmod ${mode.toString(8)} ${shellQuote(target)}`, { cwd: "/" });
        }
      }
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
      const result = await this.runCommand(sandbox, cmd, { cwd: opts.cwd, env: opts.env });
      if (result.exitCode !== 0) {
        throw new Error(`Command failed (${result.exitCode}): ${cmd}`);
      }
    }
  }

  async snapshotWorkspace(workspace: CloudWorkspace, _label: string): Promise<string> {
    const sandbox = this.getSandbox(workspace.id);
    const image = await sandbox.snapshotFilesystem(this.commandTimeoutMs > 0 ? this.commandTimeoutMs : undefined);
    return image.imageId;
  }

  async pullDiff(opts: { workspace: CloudWorkspace; cwd: string }): Promise<{ diff: string; summary: string }> {
    const sandbox = this.getSandbox(opts.workspace.id);
    const tracked = await this.runCommand(sandbox, "git diff", { cwd: opts.cwd });
    let diff = tracked.stdout ?? "";
    const untracked = await this.runCommand(sandbox, "git ls-files --others --exclude-standard", { cwd: opts.cwd });
    const files = (untracked.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const file of files) {
      const extra = await this.runCommand(sandbox, `git diff --no-index /dev/null ${shellQuote(file)}`, {
        cwd: opts.cwd,
      });
      if (extra.stdout) diff += extra.stdout;
    }
    const summary = diff.length > 0 ? diff.split("\n").slice(0, 20).join("\n") : "";
    return { diff, summary };
  }

  async terminateWorkspace(workspace: CloudWorkspace): Promise<void> {
    const sandbox = this.sandboxes.get(workspace.id);
    if (!sandbox) return;
    await sandbox.terminate().catch(() => {});
    this.sandboxes.delete(workspace.id);
  }

  private async getApp(): Promise<App> {
    if (!this.app) {
      this.app = await this.client.apps.fromName(this.appName, {
        environment: this.config.environment || undefined,
        createIfMissing: true,
      });
    }
    return this.app;
  }

  private async getImage(): Promise<Image> {
    if (this.image) return this.image;
    if (this.imageId) {
      this.image = await this.client.images.fromId(this.imageId);
    } else {
      this.image = this.client.images.fromRegistry(this.imageTag);
    }
    return this.image;
  }

  private async createWorkspaceWithImage(
    app: App,
    image: Image,
    opts?: { source?: string; label?: string },
  ): Promise<CloudWorkspace> {
    const params: SandboxCreateParams = {
      timeoutMs: this.timeoutMs > 0 ? this.timeoutMs : undefined,
      idleTimeoutMs: this.idleTimeoutMs > 0 ? this.idleTimeoutMs : undefined,
      encryptedPorts: [8080, 9223],
    };
    if (this.blockNetwork) {
      params.blockNetwork = true;
    } else if (this.cidrAllowlist.length > 0) {
      params.cidrAllowlist = this.cidrAllowlist;
    }

    const source = opts?.source ?? "image";
    const label = opts?.label ?? "image";
    const startTs = new Date().toISOString();
    const startMs = Date.now();
    this.logger.info(`[cloud][modal] sandbox create start ts=${startTs} source=${source} label=${label}`);
    const sandbox = await this.client.sandboxes.create(app, image, params);
    const id = sandbox.sandboxId;
    this.sandboxes.set(id, sandbox);
    const endTs = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    this.logger.info(
      `[cloud][modal] sandbox create done ts=${endTs} source=${source} id=${id} ms=${durationMs}`,
    );

    const root = toPosix(this.workspaceRoot);
    void this.runCommand(
      sandbox,
      "if [ -x /home/ubuntu/start.sh ]; then sudo -u ubuntu /home/ubuntu/start.sh > /home/ubuntu/start.log 2>&1 & fi",
      { cwd: "/" },
    ).catch((e) => {
      this.logger.debug(`[cloud][modal] start.sh failed: ${String(e)}`);
    });
    void sandbox.tunnels(60_000).catch((e) => {
      this.logger.debug(`[cloud][modal] tunnel init failed: ${String(e)}`);
    });

    return { id, rootPath: root };
  }

  private async runCommand(
    sandbox: Sandbox,
    command: string,
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = await sandbox.exec(["/bin/sh", "-lc", command], {
      workdir: toPosix(opts.cwd),
      env: opts.env,
      timeoutMs: this.commandTimeoutMs,
      mode: "text",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
    if (stdout.trim()) this.logger.debug(`[cloud][modal] ${stdout.trimEnd()}`);
    if (stderr.trim()) this.logger.debug(`[cloud][modal] ${stderr.trimEnd()}`);
    return { stdout, stderr, exitCode };
  }
}
