import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import type { Db, SessionAgent, SessionStatus } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionManager } from "../sessionManager.js";
import { nowMs } from "../util.js";
import type { CommandHandle } from "e2b";
import { resolveCodexHomeFromSessionsRoot, resolveSessionsRoot } from "../codex.js";
import { resolveClaudeConfigDirFromSessionsRoot, resolveClaudeSessionJsonlPath } from "../claudeCode.js";
import { LocalCloudProvider } from "./localProvider.js";
import type { CloudProvider, CloudWorkspace } from "./provider.js";
import { E2BCloudProvider } from "./e2bProvider.js";
import { hashSetupSpec, parseSetupSpec } from "./setupSpec.js";
import { decryptSecret, interpolateSecrets } from "./secrets.js";
import { buildCloneUrl } from "./git.js";
import { ensureGithubAppToken } from "./githubApp.js";
import { findRemoteJsonlFiles, RemoteLogSync } from "./e2bLogs.js";
import { createProxyToken } from "./proxy.js";
import {
  addRunRepo,
  createCloudRun,
  getCloudRunBySession,
  getLatestSetupSpec,
  listSecrets,
  putSetupSpec,
  updateCloudRun,
} from "./store.js";
import { createSession, updateSession, upsertSessionOffset } from "../store.js";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}


export class CloudManager {
  private readonly provider: CloudProvider;
  private sessionManager: SessionManager | null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    sessionManager: SessionManager | null,
  ) {
    const root = this.config.cloud?.workspaces_dir ?? path.resolve(this.config.config_dir, "./data/cloud/workspaces");
    if (this.config.cloud?.provider === "e2b") {
      if (!this.config.cloud.e2b) throw new Error("cloud.e2b is required when provider is e2b.");
      const snapshotDir = path.join(root, "snapshots");
      this.provider = new E2BCloudProvider(this.config.cloud.e2b, logger, { snapshotDir });
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
    if (this.provider.id === "e2b") {
      const rootPath = (this.provider as E2BCloudProvider).workspaceRoot;
      return { id: workspaceId, rootPath };
    }
    const rootPath = path.join(this.config.cloud!.workspaces_dir, workspaceId);
    return { id: workspaceId, rootPath };
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
    const run = await createCloudRun(this.db, {
      identityId: opts.identityId,
      primaryRepoId,
      provider: this.provider.id,
      workspaceId: workspace.id,
      status: "queued",
    });

    try {
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
          await this.provider.runCommands({ workspace, cwd: mainRepoPath, commands: spec.commands, env: envVars });
        }
        setupSnapshotId = await this.provider.snapshotWorkspace(workspace, "setup");
        await updateCloudRun(this.db, run.id, { snapshot_id: setupSnapshotId });
      }

      const mainRepoPath = repoMounts[0]!.absPath;
      const projectId = `cloud:${primaryRepoId}`;
      let sessionId: string;
      if (this.provider.id === "e2b") {
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
      await updateCloudRun(this.db, run.id, { status: "error", finished_at: nowMs() });
      if (this.provider.id === "e2b") {
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

  private joinWorkspacePath(root: string, rel: string): string {
    if (this.provider.id === "e2b") return path.posix.join(root, toPosix(rel));
    return path.join(root, rel);
  }

  private getE2BProvider(): E2BCloudProvider {
    if (this.provider.id !== "e2b") throw new Error("E2B provider is not configured.");
    return this.provider as E2BCloudProvider;
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
      const { handle, agentSessionId, logSyncers } = await this.spawnRemoteAgent({
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
      });
    } catch (e) {
      await updateSession(this.db, sessionId, { status: "error", finished_at: nowMs() });
      throw e;
    }

    return sessionId;
  }

  private applyProxyEnv(env: Record<string, string>, identityId: string, agent: SessionAgent): Record<string, string> {
    if (this.provider.id !== "e2b") return env;
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

  private async spawnRemoteAgent(opts: {
    sessionId: string;
    prompt: string;
    cwd: string;
    agent: SessionAgent;
    workspace: CloudWorkspace;
    envOverrides: Record<string, string>;
  }): Promise<{ handle: CommandHandle; agentSessionId: string; logSyncers: RemoteLogSync[] }> {
    const e2b = this.getE2BProvider();
    const sandbox = e2b.getSandbox(opts.workspace.id);
    const e2bCfg = this.config.cloud?.e2b;
    if (!e2bCfg) throw new Error("cloud.e2b is required for remote runs.");

    const promptFile = `/tmp/tintin-prompt-${opts.sessionId}.txt`;
    const promptText = opts.prompt.endsWith("\n") ? opts.prompt : `${opts.prompt}\n`;
    await sandbox.files.write(promptFile, promptText, { requestTimeoutMs: e2bCfg.request_timeout_ms });

    let agentSessionId = crypto.randomUUID();
    let sessionsRoot = "";
    let configDir: string | null = null;
    let cmd = "";
    let env: Record<string, string> = {};

    if (opts.agent === "claude_code") {
      if (!this.config.claude_code) throw new Error("Claude Code is not configured.");
      sessionsRoot = resolveSessionsRoot(opts.cwd, this.config.claude_code.sessions_dir);
      configDir = resolveClaudeConfigDirFromSessionsRoot(sessionsRoot);
      await sandbox.files.makeDir(toPosix(sessionsRoot), { requestTimeoutMs: e2bCfg.request_timeout_ms }).catch(() => {});
      await sandbox.files.makeDir(toPosix(configDir), { requestTimeoutMs: e2bCfg.request_timeout_ms }).catch(() => {});
      await sandbox.files
        .makeDir(path.posix.join(toPosix(configDir), "projects"), { requestTimeoutMs: e2bCfg.request_timeout_ms })
        .catch(() => {});
      const args = this.buildClaudeArgs(agentSessionId);
      cmd = `${e2bCfg.claude_binary} ${args.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
      env = {
        ...this.config.claude_code.env,
        ...opts.envOverrides,
        CLAUDE_CONFIG_DIR: toPosix(configDir),
      };
    } else {
      sessionsRoot = resolveSessionsRoot(opts.cwd, this.config.codex.sessions_dir);
      const homeDir = resolveCodexHomeFromSessionsRoot(sessionsRoot);
      await sandbox.files.makeDir(toPosix(sessionsRoot), { requestTimeoutMs: e2bCfg.request_timeout_ms }).catch(() => {});
      await sandbox.files.makeDir(toPosix(homeDir), { requestTimeoutMs: e2bCfg.request_timeout_ms }).catch(() => {});
      const args = this.buildCodexArgs(opts.cwd);
      cmd = `${e2bCfg.codex_binary} ${args.map(shellQuote).join(" ")} - < ${shellQuote(promptFile)}`;
      env = {
        ...this.config.codex.env,
        ...opts.envOverrides,
        CODEX_HOME: toPosix(homeDir),
      };
    }

    const handle = (await sandbox.commands.run(cmd, {
      cwd: toPosix(opts.cwd),
      envs: env,
      timeoutMs: e2bCfg.command_timeout_ms,
      background: true,
      onStdout: (data) => this.logger.debug(`[cloud][agent] ${data.trimEnd()}`),
      onStderr: (data) => this.logger.debug(`[cloud][agent] ${data.trimEnd()}`),
    })) as CommandHandle;

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
      const syncer = new RemoteLogSync(sandbox, remotePath, localPath, this.logger, 500, e2bCfg.command_timeout_ms);
      syncer.start();
      logSyncers.push(syncer);
    }

    return { handle, agentSessionId, logSyncers };
  }

  private async monitorRemoteSession(opts: {
    sessionId: string;
    handle: CommandHandle;
    logSyncers: RemoteLogSync[];
    workspace: CloudWorkspace;
  }) {
    let status: SessionStatus = "error";
    let exitCode: number | null = null;
    try {
      const result = await opts.handle.wait();
      exitCode = result.exitCode;
      status = result.exitCode === 0 ? "finished" : "error";
    } catch (e) {
      exitCode = e && typeof e === "object" && "exitCode" in e ? (e as any).exitCode : null;
      status = "error";
      this.logger.warn(`[cloud] remote agent failed session=${opts.sessionId}: ${String(e)}`);
    } finally {
      for (const syncer of opts.logSyncers) syncer.stop();
      for (const syncer of opts.logSyncers) await syncer.drain().catch(() => {});
      await updateSession(this.db, opts.sessionId, {
        status,
        exit_code: exitCode,
        finished_at: nowMs(),
        pid: null,
      });
      await this.handleSessionFinished(opts.sessionId, status);
      if (this.provider.id === "e2b") {
        await this.provider.terminateWorkspace(opts.workspace).catch(() => {});
      }
    }
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
  }
}
