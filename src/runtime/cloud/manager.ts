import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import type { Db, SessionAgent, SessionStatus } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionManager } from "../sessionManager.js";
import { nowMs } from "../util.js";
import { redactText } from "../redact.js";
import type { Sandbox } from "modal";
import type { PlaywrightServerInfo } from "../playwrightMcp.js";
import { resolveCodexHomeFromSessionsRoot, resolveSessionsRoot } from "../codex.js";
import { resolveClaudeConfigDirFromSessionsRoot, resolveClaudeSessionJsonlPath } from "../claudeCode.js";
import { LocalCloudProvider } from "./localProvider.js";
import type { CloudProvider, CloudWorkspace } from "./provider.js";
import { ModalCloudProvider } from "./modalProvider.js";
import { hashSetupSpec, parseSetupSpec } from "./setupSpec.js";
import { decryptSecret, interpolateSecrets } from "./secrets.js";
import { buildCloneUrl } from "./git.js";
import { ensureGithubAppToken } from "./githubApp.js";
import { findRemoteJsonlFiles, getRemoteFileSize, RemoteLogSync } from "./modalLogs.js";
import { createProxyToken } from "./proxy.js";
import { getAgentAdapter } from "../agents.js";
import {
  addRunRepo,
  createCloudRun,
  getCloudRunBySession,
  getLatestSetupSpec,
  listSecrets,
  putSetupSpec,
  updateCloudRun,
} from "./store.js";
import { createSession, updateSession, upsertSessionOffset, type SessionRow } from "../store.js";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

type RemoteHandle = {
  wait(): Promise<number>;
  pid: number | null;
};
type RemoteDebug = {
  sandbox: Sandbox;
  errPath: string;
};

export class CloudManager {
  private readonly provider: CloudProvider;
  private sessionManager: SessionManager | null;
  private readonly workspaceTerminateTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    sessionManager: SessionManager | null,
  ) {
    const root = this.config.cloud?.workspaces_dir ?? path.resolve(this.config.config_dir, "./data/cloud/workspaces");
    if (this.config.cloud?.provider === "modal") {
      if (!this.config.cloud.modal) throw new Error("cloud.modal is required when provider is modal.");
      this.provider = new ModalCloudProvider(this.config.cloud.modal, logger);
    } else {
      this.provider = new LocalCloudProvider(root, logger);
    }
    this.sessionManager = sessionManager;
  }

  attachSessionManager(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  private ensureEnabled() {
    if (!this.config.cloud?.enabled) throw new Error("Cloud mode is not enabled.");
  }

  private workspaceFromId(workspaceId: string): CloudWorkspace {
    if (this.provider.id === "modal") {
      const rootPath = (this.provider as ModalCloudProvider).workspaceRoot;
      return { id: workspaceId, rootPath };
    }
    const rootPath = path.join(this.config.cloud!.workspaces_dir, workspaceId);
    return { id: workspaceId, rootPath };
  }

  private async keepaliveMs(identityId: string | null): Promise<number> {
    let minutes = this.config.cloud?.keepalive_minutes ?? 10;
    if (identityId) {
      const row = await this.db
        .selectFrom("identities")
        .select(["keepalive_minutes"])
        .where("id", "=", identityId)
        .executeTakeFirst();
      if (row && typeof row.keepalive_minutes === "number") minutes = row.keepalive_minutes;
    }
    const clamped = Math.max(0, Math.floor(minutes));
    const keepalive = clamped * 60_000;
    const modalTimeout = this.config.cloud?.modal?.timeout_ms;
    if (typeof modalTimeout === "number" && Number.isFinite(modalTimeout) && modalTimeout > 0) {
      return Math.min(keepalive, modalTimeout);
    }
    return keepalive;
  }

  private clearWorkspaceTermination(workspaceId: string) {
    const existing = this.workspaceTerminateTimers.get(workspaceId);
    if (existing) clearTimeout(existing);
    this.workspaceTerminateTimers.delete(workspaceId);
  }

  private async scheduleWorkspaceTermination(workspaceId: string, identityId: string | null) {
    const delay = await this.keepaliveMs(identityId);
    if (delay <= 0) {
      void this.provider.terminateWorkspace({ id: workspaceId, rootPath: this.workspaceFromId(workspaceId).rootPath }).catch(() => {});
      return;
    }
    this.clearWorkspaceTermination(workspaceId);
    const timer = setTimeout(() => {
      this.workspaceTerminateTimers.delete(workspaceId);
      void this.provider.terminateWorkspace({ id: workspaceId, rootPath: this.workspaceFromId(workspaceId).rootPath }).catch(() => {});
    }, delay);
    this.workspaceTerminateTimers.set(workspaceId, timer);
  }

  async startRun(opts: {
    identityId: string;
    platform: string;
    workspaceId: string | null;
    chatId: string;
    spaceId: string;
    userId: string;
    prompt: string;
    repoIds: string[];
    agent: SessionAgent;
  }): Promise<{ runId: string; sessionId: string }> {
    this.ensureEnabled();
    if (opts.repoIds.length === 0) throw new Error("No repo selected.");
    const primaryRepoId = opts.repoIds[0]!;

    const workspace = await this.provider.createWorkspace({ prefix: "cloud" });
    this.logger.info(`[cloud] workspace created id=${workspace.id} root=${workspace.rootPath}`);
    if (this.provider.id === "modal") {
      await this.injectModalSecretsBashrc(opts.identityId, workspace).catch((e) => {
        this.logger.warn(`[cloud][modal] failed to inject secrets into .bashrc: ${String(e)}`);
      });
    }
    const run = await createCloudRun(this.db, {
      identityId: opts.identityId,
      primaryRepoId,
      provider: this.provider.id,
      workspaceId: workspace.id,
      status: "queued",
    });

    try {
      this.logger.info(
        `[cloud] run start id=${run.id} agent=${opts.agent} repos=${opts.repoIds.length} workspace=${workspace.id}`,
      );
      const repoMounts: Array<{ repoId: string; mountPath: string; absPath: string }> = [];
      for (let i = 0; i < opts.repoIds.length; i++) {
        const repoId = opts.repoIds[i]!;
        const mountPath = i === 0 ? path.posix.join("repo", "main") : path.posix.join("repo", `dep${i}`);
        const absPath = this.joinWorkspacePath(workspace.rootPath, mountPath);
        repoMounts.push({ repoId, mountPath, absPath });
        await addRunRepo(this.db, { runId: run.id, repoId, mountPath });

        const repo = await this.db.selectFrom("repos").selectAll().where("id", "=", repoId).executeTakeFirstOrThrow();
        const conn = await this.db
          .selectFrom("connections")
          .selectAll()
          .where("id", "=", repo.connection_id)
          .executeTakeFirstOrThrow();
        let cloneToken = conn.access_token;
        let cloneUser: string | undefined;
        if (conn.type === "github" && this.config.cloud?.github_app) {
          const token = await ensureGithubAppToken({ db: this.db, config: this.config.cloud.github_app, connection: conn });
          cloneToken = token.token;
          cloneUser = "x-access-token";
        }
        const clone = buildCloneUrl(repo.url, cloneToken, cloneUser ? { username: cloneUser } : undefined);
        this.logger.info(`[cloud] clone repo=${repo.name} url=${clone.redacted}`);
        const parentDir = path.dirname(absPath);
        await this.provider.runCommands({
          workspace,
          cwd: workspace.rootPath,
          commands: [`mkdir -p ${shellQuote(parentDir)}`],
        });
        await this.provider.runCommands({
          workspace,
          cwd: workspace.rootPath,
          commands: [`git clone --depth 1 ${shellQuote(clone.url)} ${shellQuote(absPath)}`],
          env: { GIT_TERMINAL_PROMPT: "0" },
        });
      }

      // Apply setup spec if present (DB or repo file).
      let setupSpec = await getLatestSetupSpec(this.db, primaryRepoId);
      if (!setupSpec) {
        const specPath = path.join(repoMounts[0]!.absPath, "tintin-setup.yml");
        const specText = await readFile(specPath, "utf8").catch(() => null);
        if (specText) {
          const hash = hashSetupSpec(specText);
          await putSetupSpec(this.db, { repoId: primaryRepoId, ymlBlob: specText, hash });
          setupSpec = { id: "file", repo_id: primaryRepoId, yml_blob: specText, hash, created_at: nowMs(), updated_at: nowMs() } as any;
        }
      }
      let setupSnapshotId: string | null = null;
      if (setupSpec) {
        const spec = parseSetupSpec(setupSpec.yml_blob);
        const secrets = await this.loadSecretsMap(opts.identityId);
        const envVars: Record<string, string> = {};
        for (const entry of spec.env ?? []) {
          if (!entry.value) continue;
          envVars[entry.name] = interpolateSecrets(entry.value, (name) => secrets.get(name) ?? null);
        }

        if (spec.files && spec.files.length > 0) {
          const files = spec.files
            .filter((f) => f.content !== undefined)
            .map((f) => ({ path: f.path, content: f.content ?? "", mode: f.mode }));
          if (files.length > 0) await this.provider.uploadFiles(workspace, files);
        }

        const mainRepoPath = repoMounts[0]!.absPath;
        if (spec.commands && spec.commands.length > 0) {
          this.logger.info(`[cloud] applying setup spec commands count=${spec.commands.length}`);
          await this.provider.runCommands({ workspace, cwd: mainRepoPath, commands: spec.commands, env: envVars });
        }
        setupSnapshotId = await this.provider.snapshotWorkspace(workspace, "setup");
        await updateCloudRun(this.db, run.id, { snapshot_id: setupSnapshotId });
      }

      const mainRepoPath = repoMounts[0]!.absPath;
      const projectId = `cloud:${primaryRepoId}`;
      let sessionId: string;
      if (this.provider.id !== "local") {
        this.logger.info(`[cloud] starting remote session run=${run.id} workspace=${workspace.id}`);
        sessionId = await this.startRemoteSession({
          identityId: opts.identityId,
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
          spaceId: opts.spaceId,
          userId: opts.userId,
          projectId,
          projectPath: mainRepoPath,
          prompt: opts.prompt,
          agent: opts.agent,
          workspace,
        });
      } else {
        if (!this.sessionManager) throw new Error("Cloud manager is not attached to session manager.");
        sessionId = await this.sessionManager.startNewSession({
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
          spaceId: opts.spaceId,
          userId: opts.userId,
          projectId,
          projectPathResolved: mainRepoPath,
          initialPrompt: opts.prompt,
          agent: opts.agent,
          envOverrides: await this.buildAgentEnv(opts.identityId),
        });
      }

      await updateCloudRun(this.db, run.id, {
        status: "running",
        session_id: sessionId,
        started_at: nowMs(),
        snapshot_id: setupSnapshotId ?? null,
      });

      return { runId: run.id, sessionId };
    } catch (e) {
      this.logger.warn(`[cloud] run failed id=${run.id}: ${String(e)}`);
      await updateCloudRun(this.db, run.id, { status: "error", finished_at: nowMs() });
      if (this.provider.id !== "local") {
        await this.provider.terminateWorkspace(workspace).catch(() => {});
      }
      throw e;
    }
  }

  private async loadSecretsMap(identityId: string): Promise<Map<string, string>> {
    const key = this.config.cloud?.secrets_key ?? "";
    const rows = await listSecrets(this.db, identityId);
    const out = new Map<string, string>();
    for (const row of rows) {
      const full = await this.db.selectFrom("secrets").selectAll().where("id", "=", row.id).executeTakeFirst();
      if (!full) continue;
      try {
        out.set(full.name, decryptSecret(full.encrypted_value, key));
      } catch (e) {
        this.logger.warn(`[cloud] failed to decrypt secret ${full.name}: ${String(e)}`);
      }
    }
    return out;
  }

  private async buildAgentEnv(identityId: string): Promise<Record<string, string>> {
    const key = this.config.cloud?.secrets_key ?? "";
    const secrets = await this.db.selectFrom("secrets").selectAll().where("identity_id", "=", identityId).execute();
    const env: Record<string, string> = {};
    for (const s of secrets) {
      try {
        env[s.name] = decryptSecret(s.encrypted_value, key);
      } catch {
        continue;
      }
    }
    return env;
  }

  private ensureModalEnv(env: Record<string, string>): Record<string, string> {
    if (this.provider.id !== "modal") return env;
    const base: Record<string, string> = {
      HOME: "/home/ubuntu",
      USER: "ubuntu",
      LOGNAME: "ubuntu",
      SHELL: "/bin/bash",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    for (const [key, value] of Object.entries(base)) {
      if (!(key in env)) env[key] = value;
    }
    return env;
  }

  private async injectModalSecretsBashrc(identityId: string, workspace: CloudWorkspace): Promise<void> {
    if (this.provider.id !== "modal") return;
    const modal = this.getModalProvider();
    const sandbox = modal.getSandbox(workspace.id);
    const env = await this.buildAgentEnv(identityId);
    const names = Object.keys(env);
    const startMarker = "# tintin:secrets:start";
    const endMarker = "# tintin:secrets:end";
    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let current = "";
    try {
      const handle = await sandbox.open("/home/ubuntu/.bashrc", "r");
      const bytes = await handle.read();
      await handle.close();
      current = Buffer.from(bytes).toString("utf8");
    } catch {
      current = "";
    }

    const blockPattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, "g");
    const stripped = current.replace(blockPattern, "").trimEnd();

    if (names.length === 0) {
      if (stripped !== current.trimEnd()) {
        const handle = await sandbox.open("/home/ubuntu/.bashrc", "w");
        await handle.write(Buffer.from(stripped + (stripped ? "\n" : ""), "utf8"));
        await handle.flush();
        await handle.close();
      }
      this.logger.info("[cloud][modal] no secrets to inject into .bashrc");
      return;
    }

    const lines = [
      startMarker,
      ...names.sort().map((name) => `export ${name}=${shellQuote(env[name] ?? "")}`),
      endMarker,
      "",
    ];
    const block = lines.join("\n");
    const next = stripped ? `${stripped}\n\n${block}` : block;
    const handle = await sandbox.open("/home/ubuntu/.bashrc", "w");
    await handle.write(Buffer.from(next, "utf8"));
    await handle.flush();
    await handle.close();
    this.logger.info(`[cloud][modal] injected ${names.length} secrets into .bashrc`);
  }

  private joinWorkspacePath(root: string, rel: string): string {
    if (this.provider.id !== "local") return path.posix.join(root, toPosix(rel));
    return path.join(root, rel);
  }

  private getModalProvider(): ModalCloudProvider {
    if (this.provider.id !== "modal") throw new Error("Modal provider is not configured.");
    return this.provider as ModalCloudProvider;
  }

  private buildCodexArgs(cwd: string): string[] {
    const args: string[] = ["exec", "--json", "--color", "never", "-C", cwd];
    if (this.config.codex.dangerously_bypass_approvals_and_sandbox) args.push("--dangerously-bypass-approvals-and-sandbox");
    else if (this.config.codex.full_auto) args.push("--full-auto");
    if (this.config.codex.skip_git_repo_check) args.push("--skip-git-repo-check");
    return args;
  }

  private buildClaudeArgs(sessionId: string): string[] {
    if (!this.config.claude_code) throw new Error("Claude Code is not configured.");
    const args = ["--print", "--output-format", "stream-json", "--verbose", "--session-id", sessionId];
    if (this.config.claude_code.dangerously_bypass_approvals_and_sandbox) args.push("--dangerously-skip-permissions");
    return args;
  }

  private buildClaudeResumeArgs(sessionId: string): string[] {
    if (!this.config.claude_code) throw new Error("Claude Code is not configured.");
    const args = ["--print", "--output-format", "stream-json", "--verbose", "--resume", sessionId];
    if (this.config.claude_code.dangerously_bypass_approvals_and_sandbox) args.push("--dangerously-skip-permissions");
    return args;
  }

  private buildRemotePlaywrightArgs(agent: SessionAgent): string[] {
    if (this.provider.id === "local") return [];
    const cfg = this.config.playwright_mcp;
    if (!cfg?.enabled) return [];
    const port = cfg.port_start;
    const server: PlaywrightServerInfo = {
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      userDataDir: "",
      outputDir: "",
    };
    const startupSec = Math.ceil(cfg.timeout_ms / 1000);
    const adapter = getAgentAdapter(agent);
    return adapter.buildPlaywrightCliArgs({ server, playwrightStartupTimeoutSec: startupSec });
  }

  private async startRemoteSession(opts: {
    identityId: string;
    platform: string;
    workspaceId: string | null;
    chatId: string;
    spaceId: string;
    userId: string;
    projectId: string;
    projectPath: string;
    prompt: string;
    agent: SessionAgent;
    workspace: CloudWorkspace;
  }): Promise<string> {
    if (this.sessionManager) {
      await this.sessionManager.assertCanStartNewSession({ platform: opts.platform, chatId: opts.chatId });
    }

    const sessionId = crypto.randomUUID();
    const now = nowMs();
    await createSession(this.db, {
      id: sessionId,
      agent: opts.agent,
      platform: opts.platform,
      workspace_id: opts.workspaceId,
      chat_id: opts.chatId,
      space_id: opts.spaceId,
      space_emoji: null,
      created_by_user_id: opts.userId,
      project_id: opts.projectId,
      project_path_resolved: opts.projectPath,
      codex_session_id: null,
      codex_cwd: opts.projectPath,
      status: "starting",
      pid: null,
      exit_code: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
      last_user_message_at: now,
    });

    try {
      let envOverrides = await this.buildAgentEnv(opts.identityId);
      envOverrides = this.applyProxyEnv(envOverrides, opts.identityId, opts.agent);
      this.logger.info(
        `[cloud] spawn agent=${opts.agent} session=${sessionId} cwd=${opts.projectPath} env_keys=${Object.keys(envOverrides).length}`,
      );
      const { handle, agentSessionId, logSyncers, debug } = await this.spawnRemoteAgent({
        sessionId,
        prompt: opts.prompt,
        cwd: opts.projectPath,
        agent: opts.agent,
        workspace: opts.workspace,
        envOverrides,
      });

      await updateSession(this.db, sessionId, {
        pid: handle.pid ?? null,
        codex_session_id: agentSessionId,
        status: "running",
        started_at: nowMs(),
      });

      void this.monitorRemoteSession({
        sessionId,
        handle,
        logSyncers,
        workspace: opts.workspace,
        debug,
      });
    } catch (e) {
      this.logger.warn(`[cloud] failed to spawn agent session=${sessionId}: ${String(e)}`);
      await updateSession(this.db, sessionId, { status: "error", finished_at: nowMs() });
      throw e;
    }

    return sessionId;
  }

  private applyProxyEnv(env: Record<string, string>, identityId: string, agent: SessionAgent): Record<string, string> {
    if (this.provider.id === "local") return env;
    const cloud = this.config.cloud;
    const proxy = cloud?.proxy;
    if (!cloud || !proxy?.enabled) return env;
    if (!cloud.public_base_url || !proxy.shared_secret) return env;
    const out = { ...env };
    const baseUrl = cloud.public_base_url.endsWith("/")
      ? cloud.public_base_url.slice(0, -1)
      : cloud.public_base_url;

    const token = createProxyToken(proxy.shared_secret, identityId, proxy.token_ttl_ms);
    const hasOpenAIKey = "OPENAI_API_KEY" in out || "OPENAI_API_KEY" in this.config.codex.env;
    const hasOpenAIBase = "OPENAI_BASE_URL" in out || "OPENAI_API_BASE" in out;
    if (agent === "codex" && !hasOpenAIKey && !hasOpenAIBase && proxy.openai_api_key) {
      out.OPENAI_API_KEY = token;
      const openaiBase = `${baseUrl}${proxy.openai_path}`;
      out.OPENAI_BASE_URL = openaiBase;
      out.OPENAI_API_BASE = openaiBase;
    }
    const hasAnthropicKey =
      "ANTHROPIC_API_KEY" in out || (this.config.claude_code?.env && "ANTHROPIC_API_KEY" in this.config.claude_code.env);
    const hasAnthropicBase = "ANTHROPIC_BASE_URL" in out;
    if (agent === "claude_code" && !hasAnthropicKey && !hasAnthropicBase && proxy.anthropic_api_key) {
      out.ANTHROPIC_API_KEY = token;
      out.ANTHROPIC_BASE_URL = `${baseUrl}${proxy.anthropic_path}`;
    }
    return out;
  }

  private async writeRemoteText(sandbox: Sandbox, targetPath: string, text: string): Promise<void> {
    const file = await sandbox.open(targetPath, "w");
    await file.write(Buffer.from(text, "utf8"));
    await file.flush();
    await file.close();
  }

  private async runRemoteCommand(
    sandbox: Sandbox,
    command: string,
    opts: { cwd: string; env?: Record<string, string>; timeoutMs: number; stdout?: "pipe" | "ignore"; stderr?: "pipe" | "ignore" },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = await sandbox.exec(["/bin/sh", "-lc", command], {
      workdir: toPosix(opts.cwd),
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      stdout: opts.stdout,
      stderr: opts.stderr,
      mode: "text",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
    return { stdout, stderr, exitCode };
  }

  private async ensureRemoteDir(sandbox: Sandbox, dir: string, timeoutMs: number): Promise<void> {
    const result = await this.runRemoteCommand(sandbox, `mkdir -p ${shellQuote(dir)}`, {
      cwd: "/",
      timeoutMs,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create remote dir ${dir}`);
    }
  }

  private async spawnRemoteAgent(opts: {
    sessionId: string;
    prompt: string;
    cwd: string;
    agent: SessionAgent;
    workspace: CloudWorkspace;
    envOverrides: Record<string, string>;
  }): Promise<{ handle: RemoteHandle; agentSessionId: string; logSyncers: RemoteLogSync[]; debug: RemoteDebug }> {
    const modal = this.getModalProvider();
    const sandbox = modal.getSandbox(opts.workspace.id);
    const modalCfg = this.config.cloud?.modal;
    if (!modalCfg) throw new Error("cloud.modal is required for remote runs.");

    const promptFile = `/tmp/tintin-prompt-${opts.sessionId}.txt`;
    const promptText = opts.prompt.endsWith("\n") ? opts.prompt : `${opts.prompt}\n`;
    await this.writeRemoteText(sandbox, promptFile, promptText);

    let agentSessionId = crypto.randomUUID();
    let sessionsRoot = "";
    let configDir: string | null = null;
    let cmd = "";
    let env: Record<string, string> = {};
    const playwrightArgs = this.buildRemotePlaywrightArgs(opts.agent);

    if (opts.agent === "claude_code") {
      if (!this.config.claude_code) throw new Error("Claude Code is not configured.");
      sessionsRoot = resolveSessionsRoot(opts.cwd, this.config.claude_code.sessions_dir);
      configDir = resolveClaudeConfigDirFromSessionsRoot(sessionsRoot);
      await this.ensureRemoteDir(sandbox, toPosix(sessionsRoot), modalCfg.command_timeout_ms);
      await this.ensureRemoteDir(sandbox, toPosix(configDir), modalCfg.command_timeout_ms);
      await this.ensureRemoteDir(sandbox, path.posix.join(toPosix(configDir), "projects"), modalCfg.command_timeout_ms);
      const args = this.buildClaudeArgs(agentSessionId);
      args.push(...playwrightArgs);
      cmd = `${modalCfg.claude_binary} ${args.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
      env = {
        ...this.config.claude_code.env,
        ...opts.envOverrides,
        CLAUDE_CONFIG_DIR: toPosix(configDir),
      };
    } else {
      sessionsRoot = resolveSessionsRoot(opts.cwd, this.config.codex.sessions_dir);
      const homeDir = resolveCodexHomeFromSessionsRoot(sessionsRoot);
      await this.ensureRemoteDir(sandbox, toPosix(sessionsRoot), modalCfg.command_timeout_ms);
      await this.ensureRemoteDir(sandbox, toPosix(homeDir), modalCfg.command_timeout_ms);
      const args = this.buildCodexArgs(opts.cwd);
      args.push(...playwrightArgs);
      cmd = `${modalCfg.codex_binary} ${args.map(shellQuote).join(" ")} - < ${shellQuote(promptFile)}`;
      env = {
        ...this.config.codex.env,
        ...opts.envOverrides,
        CODEX_HOME: toPosix(homeDir),
      };
    }

    env = this.ensureModalEnv(env);

    const errPath = `/tmp/tintin-agent-${opts.sessionId}.err`;
    cmd = `${cmd} 2> ${shellQuote(errPath)}`;

    if (this.provider.id === "modal" && this.config.playwright_mcp?.enabled) {
      const port = this.config.playwright_mcp.port_start;
      const check = await this.runRemoteDebugCommand(
        sandbox,
        `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/mcp`,
        modalCfg.command_timeout_ms,
      );
      this.logger.info(
        `[cloud] playwright mcp check status=${check.stdout.trim() || "?"} exit=${check.exitCode} port=${port}`,
      );
    }

    if (this.provider.id === "modal") {
      const binary = opts.agent === "claude_code" ? modalCfg.claude_binary : modalCfg.codex_binary;
      const check = await this.runRemoteDebugCommand(sandbox, `command -v ${shellQuote(binary)}`, modalCfg.command_timeout_ms);
      const stdout = check.stdout.trim();
      const stderr = check.stderr.trim();
      this.logger.info(
        `[cloud] binary check agent=${opts.agent} cmd=${binary} exit=${check.exitCode} path=${stdout || "(not found)"}`,
      );
      if (stderr) {
        this.logger.info(`[cloud] binary check stderr: ${stderr.slice(0, 500)}`);
      }
    }

    this.logger.info(
      `[cloud] exec agent=${opts.agent} session=${opts.sessionId} agent_session=${agentSessionId} cmd=${cmd} env_keys=${Object.keys(env).length}`,
    );

    const proc = await sandbox.exec(["/bin/sh", "-lc", cmd], {
      workdir: toPosix(opts.cwd),
      env,
      stdout: "ignore",
      stderr: "ignore",
      mode: "text",
    });
    const handle: RemoteHandle = { pid: null, wait: () => proc.wait() };

    let remoteFiles: string[] = [];
    if (opts.agent === "claude_code") {
      if (!configDir) throw new Error("Claude config dir not resolved.");
      remoteFiles = [toPosix(resolveClaudeSessionJsonlPath(configDir, opts.cwd, agentSessionId))];
    } else {
      remoteFiles = await findRemoteJsonlFiles({
        sandbox,
        sessionsRoot: toPosix(sessionsRoot),
        sessionId: null,
        timeoutMs: 10_000,
        pollMs: 200,
      });
    }

    if (remoteFiles.length === 0) {
      this.logger.warn(`[cloud] could not locate remote JSONL logs for session ${opts.sessionId}.`);
    } else {
      this.logger.info(`[cloud] located ${remoteFiles.length} remote log file(s) for session ${opts.sessionId}.`);
    }

    const logsDir = path.join(this.config.cloud!.workspaces_dir, "logs", opts.sessionId);
    await mkdir(logsDir, { recursive: true });
    const logSyncers: RemoteLogSync[] = [];
    for (let i = 0; i < remoteFiles.length; i++) {
      const remotePath = remoteFiles[i]!;
      const base = path.posix.basename(remotePath);
      const localPath = path.join(logsDir, `${i}-${base}`);
      await writeFile(localPath, "", "utf8");
      await upsertSessionOffset(this.db, {
        id: crypto.randomUUID(),
        session_id: opts.sessionId,
        jsonl_path: localPath,
        byte_offset: 0,
        updated_at: nowMs(),
      });
      const syncer = new RemoteLogSync(sandbox, remotePath, localPath, this.logger, 500, modalCfg.command_timeout_ms, 0);
      syncer.start();
      logSyncers.push(syncer);
    }

    return { handle, agentSessionId, logSyncers, debug: { sandbox, errPath } };
  }

  private async runRemoteDebugCommand(
    sandbox: Sandbox,
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = await sandbox.exec(["/bin/sh", "-lc", command], {
      workdir: "/",
      timeoutMs,
      mode: "text",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode };
  }

  private async spawnRemoteResume(opts: {
    sessionId: string;
    agentSessionId: string;
    prompt: string;
    cwd: string;
    agent: SessionAgent;
    workspace: CloudWorkspace;
    envOverrides: Record<string, string>;
  }): Promise<{ handle: RemoteHandle; logSyncers: RemoteLogSync[]; debug: RemoteDebug }> {
    const modal = this.getModalProvider();
    const sandbox = modal.getSandbox(opts.workspace.id);
    const modalCfg = this.config.cloud?.modal;
    if (!modalCfg) throw new Error("cloud.modal is required for remote runs.");

    const promptFile = `/tmp/tintin-prompt-${opts.sessionId}.txt`;
    const promptText = opts.prompt.endsWith("\n") ? opts.prompt : `${opts.prompt}\n`;
    await this.writeRemoteText(sandbox, promptFile, promptText);

    let sessionsRoot = "";
    let configDir: string | null = null;
    let cmd = "";
    let env: Record<string, string> = {};
    const playwrightArgs = this.buildRemotePlaywrightArgs(opts.agent);

    if (opts.agent === "claude_code") {
      if (!this.config.claude_code) throw new Error("Claude Code is not configured.");
      sessionsRoot = resolveSessionsRoot(opts.cwd, this.config.claude_code.sessions_dir);
      configDir = resolveClaudeConfigDirFromSessionsRoot(sessionsRoot);
      await this.ensureRemoteDir(sandbox, toPosix(sessionsRoot), modalCfg.command_timeout_ms);
      await this.ensureRemoteDir(sandbox, toPosix(configDir), modalCfg.command_timeout_ms);
      await this.ensureRemoteDir(sandbox, path.posix.join(toPosix(configDir), "projects"), modalCfg.command_timeout_ms);
      const args = this.buildClaudeResumeArgs(opts.agentSessionId);
      args.push(...playwrightArgs);
      cmd = `${modalCfg.claude_binary} ${args.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
      env = {
        ...this.config.claude_code.env,
        ...opts.envOverrides,
        CLAUDE_CONFIG_DIR: toPosix(configDir),
      };
    } else {
      sessionsRoot = resolveSessionsRoot(opts.cwd, this.config.codex.sessions_dir);
      const homeDir = resolveCodexHomeFromSessionsRoot(sessionsRoot);
      await this.ensureRemoteDir(sandbox, toPosix(sessionsRoot), modalCfg.command_timeout_ms);
      await this.ensureRemoteDir(sandbox, toPosix(homeDir), modalCfg.command_timeout_ms);
      const args = this.buildCodexArgs(opts.cwd);
      args.push(...playwrightArgs);
      args.push("resume", opts.agentSessionId);
      cmd = `${modalCfg.codex_binary} ${args.map(shellQuote).join(" ")} - < ${shellQuote(promptFile)}`;
      env = {
        ...this.config.codex.env,
        ...opts.envOverrides,
        CODEX_HOME: toPosix(homeDir),
      };
    }

    env = this.ensureModalEnv(env);

    const errPath = `/tmp/tintin-agent-${opts.sessionId}.err`;
    cmd = `${cmd} 2> ${shellQuote(errPath)}`;

    let remoteFiles: string[] = [];
    if (opts.agent === "claude_code") {
      if (!configDir) throw new Error("Claude config dir not resolved.");
      remoteFiles = [toPosix(resolveClaudeSessionJsonlPath(configDir, opts.cwd, opts.agentSessionId))];
    } else {
      remoteFiles = await findRemoteJsonlFiles({
        sandbox,
        sessionsRoot: toPosix(sessionsRoot),
        sessionId: opts.agentSessionId,
        timeoutMs: 10_000,
        pollMs: 200,
      });
    }

    if (remoteFiles.length === 0) {
      this.logger.warn(`[cloud] could not locate remote JSONL logs for session ${opts.sessionId}.`);
    }

    const initialOffsets: number[] = [];
    for (const remotePath of remoteFiles) {
      initialOffsets.push(
        await getRemoteFileSize({
          sandbox,
          remotePath,
          timeoutMs: modalCfg.command_timeout_ms,
        }),
      );
    }

    const proc = await sandbox.exec(["/bin/sh", "-lc", cmd], {
      workdir: toPosix(opts.cwd),
      env,
      stdout: "ignore",
      stderr: "ignore",
      mode: "text",
    });
    const handle: RemoteHandle = { pid: null, wait: () => proc.wait() };

    const logsDir = path.join(this.config.cloud!.workspaces_dir, "logs", opts.sessionId);
    await mkdir(logsDir, { recursive: true });
    const logSyncers: RemoteLogSync[] = [];
    for (let i = 0; i < remoteFiles.length; i++) {
      const remotePath = remoteFiles[i]!;
      const base = path.posix.basename(remotePath);
      const localPath = path.join(logsDir, `${Date.now()}-${i}-${base}`);
      await writeFile(localPath, "", "utf8");
      await upsertSessionOffset(this.db, {
        id: crypto.randomUUID(),
        session_id: opts.sessionId,
        jsonl_path: localPath,
        byte_offset: 0,
        updated_at: nowMs(),
      });
      const initialOffset = initialOffsets[i] ?? 0;
      const syncer = new RemoteLogSync(sandbox, remotePath, localPath, this.logger, 500, modalCfg.command_timeout_ms, initialOffset);
      syncer.start();
      logSyncers.push(syncer);
    }

    return { handle, logSyncers, debug: { sandbox, errPath } };
  }

  private async monitorRemoteSession(opts: {
    sessionId: string;
    handle: RemoteHandle;
    logSyncers: RemoteLogSync[];
    workspace: CloudWorkspace;
    debug?: RemoteDebug;
  }) {
    let status: SessionStatus = "error";
    let exitCode: number | null = null;
    try {
      const result = await opts.handle.wait();
      exitCode = result;
      status = result === 0 ? "finished" : "error";
      this.logger.info(`[cloud] agent exit session=${opts.sessionId} code=${String(exitCode)}`);
    } catch (e) {
      exitCode = e && typeof e === "object" && "exitCode" in e ? (e as any).exitCode : null;
      status = "error";
      this.logger.warn(`[cloud] remote agent failed session=${opts.sessionId}: ${String(e)}`);
    } finally {
      if (opts.debug) {
        await this.logRemoteAgentError(opts.debug).catch((e) => {
          this.logger.warn(`[cloud] failed to read agent stderr: ${String(e)}`);
        });
      }
      for (const syncer of opts.logSyncers) syncer.stop();
      for (const syncer of opts.logSyncers) await syncer.drain().catch(() => {});
      await updateSession(this.db, opts.sessionId, {
        status,
        exit_code: exitCode,
        finished_at: nowMs(),
        pid: null,
      });
      await this.handleSessionFinished(opts.sessionId, status);
    }
  }

  private async logRemoteAgentError(debug: RemoteDebug): Promise<void> {
    const tail = await this.runRemoteDebugCommand(
      debug.sandbox,
      `tail -c 4000 ${shellQuote(debug.errPath)} 2>/dev/null || true`,
      10_000,
    );
    const raw = tail.stdout.trim();
    if (!raw) return;
    this.logger.warn(`[cloud] agent stderr tail:\n${redactText(raw)}`);
  }

  async resumeCloudSession(session: SessionRow, prompt: string): Promise<"resumed" | "expired" | "not_cloud"> {
    if (this.provider.id !== "modal") return "not_cloud";
    const run = await getCloudRunBySession(this.db, session.id);
    if (!run || run.provider !== "modal") return "not_cloud";
    if (!session.codex_session_id) throw new Error("Session missing codex_session_id");

    try {
      this.getModalProvider().getSandbox(run.workspace_id);
    } catch {
      return "expired";
    }

    this.clearWorkspaceTermination(run.workspace_id);

    await updateSession(this.db, session.id, { status: "starting", exit_code: null, finished_at: null });
    await updateCloudRun(this.db, run.id, { status: "running", finished_at: null, diff_patch: null, diff_summary: null });

    const workspace = this.workspaceFromId(run.workspace_id);
    const envOverrides = this.applyProxyEnv(await this.buildAgentEnv(run.identity_id), run.identity_id, session.agent);
    const { handle, logSyncers, debug } = await this.spawnRemoteResume({
      sessionId: session.id,
      agentSessionId: session.codex_session_id,
      prompt,
      cwd: session.codex_cwd,
      agent: session.agent,
      workspace,
      envOverrides,
    });

    await updateSession(this.db, session.id, { pid: handle.pid ?? null, status: "running", started_at: nowMs() });

    void this.monitorRemoteSession({
      sessionId: session.id,
      handle,
      logSyncers,
      workspace,
      debug,
    });

    return "resumed";
  }

  async handleSessionFinished(sessionId: string, status: SessionStatus): Promise<void> {
    const run = await getCloudRunBySession(this.db, sessionId);
    if (!run) return;
    const workspace = this.workspaceFromId(run.workspace_id);
    const mount = await this.db
      .selectFrom("cloud_run_repos")
      .selectAll()
      .where("run_id", "=", run.id)
      .where("repo_id", "=", run.primary_repo_id ?? "")
      .executeTakeFirst();
    const cwd = mount ? path.join(workspace.rootPath, mount.mount_path) : workspace.rootPath;
    const diff = await this.provider.pullDiff({ workspace, cwd });
    const maxPatch = 200_000;
    const patch = diff.diff.length > maxPatch ? null : diff.diff;
    const summary = diff.diff.length > maxPatch ? diff.summary : diff.summary;
    const cloudStatus = status === "finished" ? "finished" : status === "killed" ? "killed" : "error";
    await updateCloudRun(this.db, run.id, {
      status: cloudStatus,
      diff_patch: patch,
      diff_summary: summary,
      finished_at: nowMs(),
    });
    if (this.provider.id !== "local") {
      void this.scheduleWorkspaceTermination(run.workspace_id, run.identity_id);
    }
  }
}
