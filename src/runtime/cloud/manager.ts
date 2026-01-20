import path from "node:path";
import { mkdir, readFile, writeFile, open as openFile } from "node:fs/promises";
import type { AppConfig, PlaywrightMcpBrowserbaseSection, PlaywrightMcpHyperbrowserSection, PlaywrightMcpSection } from "../config.js";
import type { CloudRunsTable, CloudSnapshotsTable, Db, ReposTable, SessionAgent, SessionStatus } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionManager } from "../sessionManager.js";
import { nowMs, sleep } from "../util.js";
import { redactText } from "../redact.js";
import type { Sandbox } from "modal";
import type { PlaywrightServerInfo } from "../playwrightMcp.js";
import { resolveCodexHomeFromSessionsRoot, resolveSessionsRoot } from "../codex.js";
import { resolveClaudeConfigDirFromSessionsRoot, resolveClaudeSessionJsonlPath } from "../claudeCode.js";
import { LocalCloudProvider } from "./localProvider.js";
import type { CloudProvider, CloudWorkspace } from "./provider.js";
import { ModalCloudProvider } from "./modalProvider.js";
import { createBrowserbaseSession, releaseBrowserbaseSession } from "./browserbase.js";
import { createHyperbrowserSession, stopHyperbrowserSession } from "./hyperbrowser.js";
import { hashSetupSpec, parseSetupSpec } from "./setupSpec.js";
import { decryptSecret, interpolateSecrets } from "./secrets.js";
import { buildCloneUrl } from "./git.js";
import { createGithubPullRequest, ensureGithubAppToken } from "./githubApp.js";
import { findRemoteJsonlFiles, getRemoteFileSize, RemoteLogSync } from "./modalLogs.js";
import { createProxyToken } from "./proxy.js";
import { getAgentAdapter } from "../agents.js";
import { getChatgptAccountForIdentity, persistChatgptProxyTokens } from "../chatgpt/oauth.js";
import {
  addRunRepo,
  createCloudRun,
  deleteCloudSnapshot,
  getCloudRun,
  getCloudRunBySession,
  getCloudSnapshot,
  getLatestSetupSpec,
  getLatestRunForIdentity,
  listSecrets,
  listSnapshotsByIdentity,
  listSnapshotsByRun,
  listRunRepoIds,
  putSetupSpec,
  updateSetupSpecSnapshot,
  updateCloudRun,
  upsertCloudSnapshot,
} from "./store.js";
import {
  createSession,
  deleteSessionOffsets,
  listPendingMessages,
  listSessionOffsets,
  consumePendingMessages,
  updateSession,
  upsertSessionOffset,
  type SessionRow,
} from "../store.js";
import { PineconeClient, type EmbeddingConfig } from "../pinecone.js";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

type SnapshotCleanupConfig = {
  enabled: boolean;
  ttlMs: number;
  keepPerIdentity: number;
  sweepMinutes: number;
};

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeBrowserbaseMetadataValue(value: unknown): string | number | boolean | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sanitized = trimmed.replace(/[^A-Za-z0-9 .:_-]+/g, "_");
  const maxLen = 200;
  return sanitized.length > maxLen ? sanitized.slice(0, maxLen) : sanitized;
}

type RemoteHandle = {
  wait(): Promise<number>;
  pid: number | null;
};
type RemoteDebug = {
  sandbox: Sandbox;
  errPath: string;
};

type RemotePlaywrightSetup = {
  server: PlaywrightServerInfo;
  bootstrapLines: string[];
  port: number;
};

type BrowserbaseSessionState = {
  browserbaseSessionId: string;
  projectId: string;
  keepAlive: boolean;
  connectUrl: string;
  port: number;
};

type HyperbrowserSessionState = {
  hyperbrowserSessionId: string;
  wsEndpoint: string;
  port: number;
};

export class CloudManager {
  private readonly provider: CloudProvider;
  private sessionManager: SessionManager | null;
  private readonly workspaceTerminateTimers = new Map<string, NodeJS.Timeout>();
  private readonly agentTokens = new Map<string, { token: string; exp: number }>();
  private readonly agentLogPaths = new Map<string, string>();
  private readonly browserbaseSessions = new Map<string, BrowserbaseSessionState>();
  private readonly hyperbrowserSessions = new Map<string, HyperbrowserSessionState>();
  private readonly forcedStopSessions = new Set<string>();
  private readonly chatgptRefreshPaths = new Map<string, string>();
  private readonly chatgptLogPaths = new Map<string, string[]>();
  private workspaceSweepTimer: NodeJS.Timeout | null = null;
  private snapshotSweepTimer: NodeJS.Timeout | null = null;
  private readonly workspaceHeartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly pinecone: PineconeClient;
  private readonly snapshotCleanup: SnapshotCleanupConfig;

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
    this.pinecone = new PineconeClient(this.config.pinecone ?? null, logger, this.resolveEmbeddingConfig());
    this.snapshotCleanup = this.resolveSnapshotCleanup();
  }

  attachSessionManager(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  private normalizeCloudProjectId(run: CloudRunsTable): string {
    return run.primary_repo_id ? `cloud:${run.primary_repo_id}` : `cloud:playground:${run.id}`;
  }

  private resolveEmbeddingConfig(): EmbeddingConfig | null {
    const proxy = this.config.cloud?.proxy;
    const apiKey = proxy && typeof proxy.openai_api_key === "string" ? proxy.openai_api_key : "";
    if (!apiKey) return null;
    const base = proxy && typeof proxy.openai_base_url === "string" ? proxy.openai_base_url : "https://api.openai.com/v1";
    const model = "text-embedding-3-small";
    return { apiKey, baseUrl: base, model };
  }

  private resolveSnapshotCleanup(): SnapshotCleanupConfig {
    const defaults = { enabled: true, ttlMs: 30 * 24 * 60 * 60 * 1000, keepPerIdentity: 50, sweepMinutes: 360 };
    const raw = (this.config.cloud as any)?.snapshot_cleanup;
    if (!raw || typeof raw !== "object") return defaults;
    const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : defaults.enabled;
    const ttlDays = typeof raw.ttl_days === "number" && Number.isFinite(raw.ttl_days) && raw.ttl_days > 0 ? raw.ttl_days : 30;
    const keep = typeof raw.keep_per_identity === "number" && Number.isFinite(raw.keep_per_identity) && raw.keep_per_identity > 0 ? Math.floor(raw.keep_per_identity) : defaults.keepPerIdentity;
    const sweepMinutes =
      typeof raw.sweep_minutes === "number" && Number.isFinite(raw.sweep_minutes) && raw.sweep_minutes > 0
        ? Math.floor(raw.sweep_minutes)
        : defaults.sweepMinutes;
    return { enabled, ttlMs: ttlDays * 24 * 60 * 60 * 1000, keepPerIdentity: keep, sweepMinutes };
  }

  private formatRemoteCommandLog(cmd: string): string {
    const flags: string[] = [];
    if (cmd.includes("tintin-chatgpt-proxy.js")) flags.push("chatgpt_proxy");
    if (cmd.includes("@playwright/mcp")) flags.push("playwright_mcp");
    const flagText = flags.length > 0 ? flags.join(",") : "-";
    return `bootstrap+agent len=${cmd.length} flags=${flagText}`;
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
    const maxIdleMinutes = 10;
    const keepalive = Math.min(clamped, maxIdleMinutes) * 60_000;
    const modalTimeout = this.config.cloud?.modal?.timeout_ms;
    if (typeof modalTimeout === "number" && Number.isFinite(modalTimeout) && modalTimeout > 0) {
      return Math.min(keepalive, modalTimeout);
    }
    return keepalive;
  }

  private async createSnapshotForRun(opts: {
    runId: string;
    workspaceId: string;
    sourceStatus: string;
    note?: string;
    force?: boolean;
  }): Promise<{ id: string; embedText: string } | null> {
    if (this.provider.id !== "modal") return null;
    const run = await getCloudRun(this.db, opts.runId);
    if (!run) return null;
    if (!opts.force) {
      if (run.snapshot_id) return { id: run.snapshot_id, embedText: "" };
      const existing = await listSnapshotsByRun(this.db, run.id);
      if (existing.length > 0) return { id: existing[0]!.id, embedText: "" };
    }
    const workspace = this.workspaceFromId(opts.workspaceId);
    let snapshotId: string | null = null;
    try {
      snapshotId = await this.provider.snapshotWorkspace(workspace, "auto");
    } catch (e) {
      this.logger.warn(
        `[cloud][snapshot] create failed run=${opts.runId} workspace=${opts.workspaceId} source=${opts.sourceStatus}: ${String(e)}`,
      );
      return null;
    }
    if (!snapshotId) return null;
    const prompt = (run.prompt ?? "").trim() || "(no prompt)";
    const statusText = opts.sourceStatus.trim() || "unknown";
    const reasonRaw = (opts.note ?? "").trim();
    const summary = (run.diff_summary ?? "").trim();
    const title = `Prompt: ${truncate(prompt, 80)}`;
    const noteParts = [summary, reasonRaw]
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .filter((v) => !v.toLowerCase().startsWith("status:"));
    const note = noteParts.length > 0 ? truncate(noteParts.join(" | "), 500) : "";
    const embedText = [title, `status: ${statusText}`, note].filter(Boolean).join("\n");
    this.logger.info(
      `[cloud][snapshot] created id=${snapshotId} run=${run.id} workspace=${opts.workspaceId} source=${opts.sourceStatus}`,
    );
    await upsertCloudSnapshot(this.db, {
      id: snapshotId,
      identityId: run.identity_id,
      runId: run.id,
      sandboxId: opts.workspaceId,
      title,
      note,
      sourceStatus: opts.sourceStatus,
      vectorId: snapshotId,
    });
    if (!run.snapshot_id || opts.force) {
      await updateCloudRun(this.db, run.id, { snapshot_id: snapshotId });
    }
    await this.pinecone.upsertSnapshotDoc({
      snapshotId,
      identityId: run.identity_id,
      runId: run.id,
      title,
      note,
      embedText,
      createdAt: nowMs(),
    });
    return { id: snapshotId, embedText };
  }

  private async snapshotWithRetries(opts: {
    runId: string;
    workspaceId: string;
    sourceStatus: string;
    note?: string;
    retries: number;
  }): Promise<{ id: string; embedText: string } | null> {
    const attempts = Math.max(1, Math.floor(opts.retries));
    for (let i = 0; i < attempts; i++) {
      const snap = await this.createSnapshotForRun({
        runId: opts.runId,
        workspaceId: opts.workspaceId,
        sourceStatus: opts.sourceStatus,
        note: opts.note,
        force: true,
      });
      if (snap) return snap;
      this.logger.warn(
        `[cloud][snapshot] attempt ${i + 1}/${attempts} failed run=${opts.runId} workspace=${opts.workspaceId}`,
      );
    }
    return null;
  }

  async listSnapshots(identityId: string, limit?: number): Promise<CloudSnapshotsTable[]> {
    return await listSnapshotsByIdentity(this.db, { identityId, limit });
  }

  async clearSnapshots(identityId: string): Promise<number> {
    const snaps = await listSnapshotsByIdentity(this.db, { identityId });
    let deleted = 0;
    for (const snap of snaps) {
      try {
        if (snap.run_id) {
          await updateCloudRun(this.db, snap.run_id, { snapshot_id: null });
        }
        await this.deleteSnapshotArtifacts(snap.id);
        deleted++;
      } catch (e) {
        this.logger.warn(`[cloud][snapshot] clear failed id=${snap.id}: ${String(e)}`);
      }
    }
    this.logger.info(`[cloud][snapshot] cleared identity=${identityId} count=${deleted}`);
    return deleted;
  }

  async searchSnapshots(identityId: string, query: string, limit = 5): Promise<CloudSnapshotsTable[]> {
    const matches = await this.pinecone.searchSnapshots(identityId, query, limit * 2);
    const seen = new Set<string>();
    const rows: CloudSnapshotsTable[] = [];
    for (const m of matches) {
      const id = m.id;
      if (!id || seen.has(id)) continue;
      const snap = await getCloudSnapshot(this.db, id);
      if (snap && snap.identity_id === identityId) {
        rows.push(snap);
        seen.add(id);
      }
    }
    const q = query.trim().toLowerCase();
    const filtered =
      q.length === 0
        ? rows
        : rows.filter((snap) => {
            const haystack = [snap.id, snap.title ?? "", snap.note ?? ""].join(" ").toLowerCase();
            return haystack.includes(q);
          });
    if (filtered.length > 0) return filtered.slice(0, limit);
    return rows.slice(0, limit);
  }

  async saveSnapshot(opts: {
    identityId: string;
    runId?: string | null;
    note?: string;
    sourceStatus?: string;
  }): Promise<{ snapshotId: string; runId: string }> {
    if (this.provider.id !== "modal") throw new Error("Snapshots are only supported for modal provider.");
    const targetRunId = opts.runId ?? (await getLatestRunForIdentity(this.db, opts.identityId))?.id;
    if (!targetRunId) throw new Error("No run found to snapshot.");
    const run = await getCloudRun(this.db, targetRunId);
    if (!run || run.identity_id !== opts.identityId) throw new Error("Run not found.");
    if (!run.workspace_id) throw new Error("Run has no workspace.");
    const snapshot = await this.snapshotWithRetries({
      runId: run.id,
      workspaceId: run.workspace_id,
      sourceStatus: opts.sourceStatus ?? "manual",
      note: opts.note ?? "",
      retries: 2,
    });
    if (!snapshot) throw new Error("Snapshot creation failed.");
    return { snapshotId: snapshot.id, runId: run.id };
  }

  async restoreSnapshot(opts: {
    identityId: string;
    snapshotId: string;
    platform: "telegram" | "slack";
    workspaceId: string | null;
    chatId: string;
    spaceId: string;
    userId: string;
    agent: SessionAgent;
  }): Promise<{ runId: string; sessionId: string }> {
    if (this.provider.id !== "modal") throw new Error("Snapshot restore is only supported for modal provider.");
    const snap = await getCloudSnapshot(this.db, opts.snapshotId);
    if (!snap || snap.identity_id !== opts.identityId) throw new Error("Snapshot not found.");
    const repoIds = await listRunRepoIds(this.db, snap.run_id);
    return await this.startRun({
      identityId: opts.identityId,
      platform: opts.platform,
      workspaceId: opts.workspaceId,
      chatId: opts.chatId,
      spaceId: opts.spaceId,
      userId: opts.userId,
      prompt: `Continue from snapshot ${snap.id}`,
      repoIds,
      agent: opts.agent,
      playground: repoIds.length === 0,
      restoreSnapshotId: snap.id,
    });
  }

  private workspaceInitialTtlMs(): number {
    const minutes = this.config.cloud?.keepalive_minutes ?? 10;
    const keepaliveMs = Math.max(0, Math.floor(minutes)) * 60_000;
    if (this.provider.id === "modal") {
      const modalTimeout = this.config.cloud?.modal?.timeout_ms;
      if (typeof modalTimeout === "number" && Number.isFinite(modalTimeout) && modalTimeout > 0) {
        return Math.min(keepaliveMs, modalTimeout);
      }
    }
    return keepaliveMs;
  }

  private async recordWorkspaceLease(opts: {
    workspaceId: string;
    runId: string | null;
    identityId: string | null;
    ttlMs: number;
    reason: string;
  }): Promise<void> {
    if (this.provider.id === "local") return;
    const now = nowMs();
    const ttl = Math.max(0, opts.ttlMs);
    const expiresAt = now + ttl;
    await this.db
      .insertInto("cloud_workspaces")
      .values({
        id: opts.workspaceId,
        provider: this.provider.id,
        run_id: opts.runId,
        identity_id: opts.identityId,
        expires_at: expiresAt,
        last_seen_at: now,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet((eb) => ({
          provider: eb.ref("excluded.provider"),
          run_id: eb.ref("excluded.run_id"),
          identity_id: eb.ref("excluded.identity_id"),
          expires_at: eb.ref("excluded.expires_at"),
          last_seen_at: eb.ref("excluded.last_seen_at"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .execute();
    this.logger.debug(
      `[cloud][workspace] lease recorded id=${opts.workspaceId} run=${opts.runId ?? "-"} expires_in_ms=${ttl} reason=${opts.reason}`,
    );
  }

  private async startWorkspaceHeartbeat(workspaceId: string, identityId: string | null, runId: string | null): Promise<void> {
    const existing = this.workspaceHeartbeatTimers.get(workspaceId);
    if (existing) clearInterval(existing);
    const keepalive = await this.keepaliveMs(identityId);
    const interval = Math.max(30_000, Math.floor(keepalive / 2));
    const tick = async () => {
      try {
        await this.recordWorkspaceLease({
          workspaceId,
          runId,
          identityId,
          ttlMs: keepalive,
          reason: "heartbeat",
        });
      } catch (e) {
        this.logger.debug(`[cloud][workspace] heartbeat failed id=${workspaceId}: ${String(e)}`);
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, interval);
    this.workspaceHeartbeatTimers.set(workspaceId, timer);
  }

  private async deleteWorkspaceLease(workspaceId: string): Promise<void> {
    if (this.provider.id === "local") return;
    await this.db.deleteFrom("cloud_workspaces").where("id", "=", workspaceId).execute();
  }

  private async deleteWorkspaceLeaseWithRetry(workspaceId: string, reason: string): Promise<void> {
    if (this.provider.id === "local") return;
    const attempts = 3;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.deleteWorkspaceLease(workspaceId);
        return;
      } catch (e) {
        const idx = i + 1;
        const msg = String(e);
        if (idx >= attempts) {
          this.logger.warn(`[cloud][workspace] delete lease failed id=${workspaceId} reason=${reason}: ${msg}`);
          return;
        }
        this.logger.warn(
          `[cloud][workspace] delete lease retry id=${workspaceId} attempt=${idx}/${attempts} reason=${reason}: ${msg}`,
        );
        await sleep(200);
      }
    }
  }

  private async sweepExpiredWorkspaces(): Promise<void> {
    if (this.provider.id === "local") return;
    const now = nowMs();
    const all = await this.db
      .selectFrom("cloud_workspaces")
      .selectAll()
      .execute();
    const expired = all.filter((ws) => (ws.expires_at ?? 0) <= now);
    const active = all.length - expired.length;
    this.logger.info(`[cloud][workspace] sweep expired count=${expired.length} active=${active}`);
    for (const ws of expired) {
      this.logger.warn(`[cloud][workspace] terminating expired workspace id=${ws.id} provider=${ws.provider}`);
      await this.terminateWorkspaceAndCleanup(ws.id, null, ws.run_id ?? null);
    }
  }

  private async deleteSnapshotArtifacts(snapshotId: string): Promise<void> {
    if (typeof (this.provider as any).deleteSnapshotImage === "function") {
      await (this.provider as any).deleteSnapshotImage(snapshotId);
    }
    await this.pinecone.deleteSnapshotDoc(snapshotId);
    await deleteCloudSnapshot(this.db, snapshotId);
  }

  private async sweepSnapshots(): Promise<void> {
    if (!this.snapshotCleanup.enabled) return;
    const now = nowMs();
    const identities = await this.db.selectFrom("cloud_snapshots").select("identity_id").groupBy("identity_id").execute();
    let deleted = 0;
    let skippedRef = 0;
    for (const row of identities) {
      const identityId = row.identity_id;
      let offset = 0;
      const keep = this.snapshotCleanup.keepPerIdentity;
      // Process snapshots per identity in batches to avoid large memory usage.
      while (true) {
        const batch = await this.db
          .selectFrom("cloud_snapshots")
          .selectAll()
          .where("identity_id", "=", identityId)
          .orderBy("created_at", "desc")
          .offset(offset)
          .limit(keep + 100) // fetch a bit past keep to find deletable ones
          .execute();
        if (batch.length === 0) break;
        for (let idx = 0; idx < batch.length; idx++) {
          const snap = batch[idx]!;
          const overLimit = offset + idx + 1 > keep;
          const expired = now - snap.created_at > this.snapshotCleanup.ttlMs;
          if (!overLimit && !expired) continue;
          const runRef = await this.db
            .selectFrom("cloud_runs")
            .select(["id"])
            .where("snapshot_id", "=", snap.id)
            .executeTakeFirst();
          if (runRef) {
            skippedRef++;
            continue;
          }
          const setupRef = await this.db
            .selectFrom("setup_specs")
            .select(["id"])
            .where("snapshot_id", "=", snap.id)
            .executeTakeFirst();
          if (setupRef) {
            skippedRef++;
            continue;
          }
          await this.deleteSnapshotArtifacts(snap.id)
            .then(() => {
              deleted++;
              this.logger.info(
                `[cloud][snapshot] cleanup id=${snap.id} identity=${snap.identity_id} expired=${expired} over_limit=${overLimit}`,
              );
            })
            .catch((e) => {
              this.logger.warn(`[cloud][snapshot] cleanup failed id=${snap.id}: ${String(e)}`);
            });
        }
        if (batch.length < keep + 100) break;
        offset += keep + 100;
      }
    }
    if (deleted > 0 || skippedRef > 0) {
      this.logger.info(`[cloud][snapshot] sweep done deleted=${deleted} skipped_ref=${skippedRef}`);
    }
  }

  async start(): Promise<void> {
    if (this.provider.id === "local") return;
    await this.sweepExpiredWorkspaces();
    const intervalMs = 60_000;
    this.workspaceSweepTimer = setInterval(() => {
      void this.sweepExpiredWorkspaces().catch((e) => {
        this.logger.warn(`[cloud][workspace] sweep error: ${String(e)}`);
      });
    }, intervalMs);
    if (this.snapshotCleanup.enabled) {
      const snapshotIntervalMs = this.snapshotCleanup.sweepMinutes * 60_000;
      this.logger.info(
        `[cloud][snapshot] cleanup enabled ttl_days=${Math.round(this.snapshotCleanup.ttlMs / 86_400_000)} keep_per_identity=${this.snapshotCleanup.keepPerIdentity} sweep_minutes=${this.snapshotCleanup.sweepMinutes}`,
      );
      await this.sweepSnapshots();
      this.snapshotSweepTimer = setInterval(() => {
        void this.sweepSnapshots().catch((e) => {
          this.logger.warn(`[cloud][snapshot] sweep error: ${String(e)}`);
        });
      }, snapshotIntervalMs);
    } else {
      this.logger.info("[cloud][snapshot] cleanup disabled");
    }
  }

  private async time<T>(label: string, fn: () => Promise<T>, meta?: string, level: "info" | "debug" = "info"): Promise<T> {
    const start = Date.now();
    const startTs = new Date(start).toISOString();
    const suffix = meta ? ` ${meta}` : "";
    const log = level === "debug" ? this.logger.debug.bind(this.logger) : this.logger.info.bind(this.logger);
    log(`[cloud][timing] ${label} start ts=${startTs}${suffix}`);
    try {
      return await fn();
    } finally {
      const end = Date.now();
      const endTs = new Date(end).toISOString();
      log(`[cloud][timing] ${label} end ts=${endTs} ms=${end - start}${suffix}`);
    }
  }

  private issueAgentToken(sessionId: string): string {
    const token = crypto.randomUUID();
    const exp = Date.now() + 60 * 60 * 1000;
    this.agentTokens.set(sessionId, { token, exp });
    return token;
  }

  verifyAgentToken(sessionId: string, token: string): boolean {
    const entry = this.agentTokens.get(sessionId);
    if (!entry) return false;
    if (entry.exp <= Date.now()) {
      this.agentTokens.delete(sessionId);
      return false;
    }
    return entry.token === token;
  }

  private buildAgentRelayUrl(sessionId: string): string | null {
    const cloud = this.config.cloud;
    if (!cloud?.log_relay_enabled) return null;
    const base = cloud.public_base_url ?? "";
    if (!base) return null;
    const trimmed = base.replace(/\/+$/g, "");
    return `${trimmed}/api/cloud/agent/logs/${sessionId}`;
  }

  private async ensureAgentLogPath(sessionId: string, label: string): Promise<string> {
    const existing = this.agentLogPaths.get(sessionId);
    if (existing) return existing;
    const logsDir = path.join(this.config.cloud!.workspaces_dir, "logs", sessionId);
    await mkdir(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `agent-${label}-${Date.now()}.jsonl`);
    await writeFile(filePath, "", "utf8");
    await upsertSessionOffset(this.db, {
      id: crypto.randomUUID(),
      session_id: sessionId,
      jsonl_path: filePath,
      byte_offset: 0,
      updated_at: nowMs(),
    });
    this.agentLogPaths.set(sessionId, filePath);
    return filePath;
  }

  async getOrCreateAgentLogPath(sessionId: string): Promise<string | null> {
    if (!this.config.cloud?.workspaces_dir) return null;
    return await this.ensureAgentLogPath(sessionId, "ingest");
  }

  private wrapAgentRelayCommand(cmd: string, opts: { sessionId: string; agent: SessionAgent; token: string; url: string }): string {
    const fifo = `/tmp/tintin-log-${opts.sessionId}.fifo`;
    const envPrefix = [
      `TINTIN_AGENT_URL=${shellQuote(opts.url)}`,
      `TINTIN_AGENT_TOKEN=${shellQuote(opts.token)}`,
      `TINTIN_AGENT_SESSION=${shellQuote(opts.sessionId)}`,
      `TINTIN_AGENT_AGENT=${shellQuote(opts.agent)}`,
    ].join(" ");
    const agentCmd = `${envPrefix} tintin-log-agent`;
    return [
      `rm -f ${shellQuote(fifo)}`,
      `mkfifo ${shellQuote(fifo)}`,
      `${agentCmd} < ${shellQuote(fifo)} &`,
      "AGENT_PID=$!",
      `(${cmd}) > ${shellQuote(fifo)}`,
      "CODEX_EXIT=$?",
      `rm -f ${shellQuote(fifo)}`,
      "wait $AGENT_PID || true",
      "exit $CODEX_EXIT",
    ].join("\n");
  }

  private clearWorkspaceTermination(workspaceId: string) {
    const existing = this.workspaceTerminateTimers.get(workspaceId);
    if (existing) clearTimeout(existing);
    this.workspaceTerminateTimers.delete(workspaceId);
    const hb = this.workspaceHeartbeatTimers.get(workspaceId);
    if (hb) clearInterval(hb);
    this.workspaceHeartbeatTimers.delete(workspaceId);
  }

  private async hasSnapshotForRun(runId: string, workspaceId: string): Promise<boolean> {
    const run = await getCloudRun(this.db, runId);
    if (run?.snapshot_id) return true;
    const existing = await this.db
      .selectFrom("cloud_snapshots")
      .select("id")
      .where((eb) => eb.or([eb("run_id", "=", runId), eb("sandbox_id", "=", workspaceId)]))
      .executeTakeFirst();
    return Boolean(existing);
  }

  private async terminateWorkspaceAndCleanup(workspaceId: string, sessionId?: string | null, runId?: string | null) {
    try {
      if (runId) {
        const alreadySnapshotted = await this.hasSnapshotForRun(runId, workspaceId);
        if (alreadySnapshotted) {
          this.logger.info(`[cloud][snapshot] skip snapshot (already exists) run=${runId} workspace=${workspaceId}`);
        } else {
          const snap = await this.snapshotWithRetries({ runId, workspaceId, sourceStatus: "termination", retries: 2 });
          if (!snap) {
            this.logger.warn(
              `[cloud][snapshot] continuing terminate after snapshot failures workspace=${workspaceId} run=${runId}`,
            );
          }
        }
      }
      await this.provider.terminateWorkspace({ id: workspaceId, rootPath: this.workspaceFromId(workspaceId).rootPath });
      this.logger.info(`[cloud][workspace] terminated id=${workspaceId} provider=${this.provider.id}`);
      await this.deleteWorkspaceLeaseWithRetry(workspaceId, "terminate");
    } catch (e) {
      this.logger.warn(`[cloud][workspace] terminate failed id=${workspaceId}: ${String(e)}`);
    } finally {
      if (sessionId) {
        await this.releaseBrowserbaseForSession(sessionId, "workspace_terminated").catch(() => {});
        await this.releaseHyperbrowserForSession(sessionId, "workspace_terminated").catch(() => {});
      }
    }
  }

  private async scheduleWorkspaceTermination(
    workspaceId: string,
    identityId: string | null,
    runId?: string | null,
    sessionId?: string | null,
  ) {
    const delay = await this.keepaliveMs(identityId);
    await this.recordWorkspaceLease({
      workspaceId,
      runId: runId ?? null,
      identityId,
      ttlMs: delay,
      reason: "schedule_termination",
    });
    if (delay <= 0) {
      void this.terminateWorkspaceAndCleanup(workspaceId, sessionId, runId ?? null);
      return;
    }
    this.clearWorkspaceTermination(workspaceId);
    const timer = setTimeout(() => {
      this.workspaceTerminateTimers.delete(workspaceId);
      void this.terminateWorkspaceAndCleanup(workspaceId, sessionId, runId ?? null);
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
    playground?: boolean;
    restoreSnapshotId?: string | null;
  }): Promise<{ runId: string; sessionId: string }> {
    this.ensureEnabled();
    const isPlayground = opts.playground === true;
    if (opts.repoIds.length === 0 && !isPlayground) throw new Error("No repo selected.");
    const primaryRepoId = opts.repoIds[0] ?? null;
    const runStartMs = Date.now();
    const runStartTs = new Date(runStartMs).toISOString();
    this.logger.info(
      `[cloud][timing] run start ts=${runStartTs} identity=${opts.identityId} repos=${opts.repoIds.length} agent=${opts.agent}`,
    );

    let setupSpec = primaryRepoId ? await getLatestSetupSpec(this.db, primaryRepoId) : null;
    let setupSnapshotId: string | null = opts.restoreSnapshotId ?? setupSpec?.snapshot_id ?? null;
    let usedSnapshot = false;
    let workspace: CloudWorkspace;
    const snapshotId = setupSnapshotId;
    if (snapshotId && this.provider.id === "modal") {
      try {
        workspace = await this.time(
          "workspace.create",
          () => this.getModalProvider().createWorkspaceFromSnapshot(snapshotId),
          `source=snapshot id=${snapshotId}`,
        );
        usedSnapshot = true;
        this.logger.info(`[cloud] workspace restored id=${workspace.id} snapshot=${snapshotId}`);
      } catch (e) {
        this.logger.warn(`[cloud] snapshot restore failed (${snapshotId}): ${String(e)}; falling back to base image`);
        workspace = await this.time(
          "workspace.create",
          () => this.provider.createWorkspace({ prefix: "cloud" }),
          `source=base provider=${this.provider.id}`,
        );
      }
    } else {
      workspace = await this.time(
        "workspace.create",
        () => this.provider.createWorkspace({ prefix: "cloud" }),
        `source=base provider=${this.provider.id}`,
      );
    }
    if (!usedSnapshot) {
      this.logger.info(`[cloud] workspace created id=${workspace.id} root=${workspace.rootPath}`);
    }
    if (this.provider.id === "modal") {
      void this.time(
        "modal.secrets.bashrc",
        () => this.injectModalSecretsBashrc(opts.identityId, workspace),
        `workspace=${workspace.id}`,
      ).catch((e) => {
        this.logger.warn(`[cloud][modal] failed to inject secrets into .bashrc: ${String(e)}`);
      });
    }
    const run = await createCloudRun(this.db, {
      identityId: opts.identityId,
      primaryRepoId,
      provider: this.provider.id,
      workspaceId: workspace.id,
      status: "queued",
      prompt: opts.prompt,
    });
    if (this.provider.id !== "local") {
      await this.recordWorkspaceLease({
        workspaceId: workspace.id,
        runId: run.id,
        identityId: opts.identityId,
        ttlMs: this.workspaceInitialTtlMs(),
        reason: "run_start",
      });
      await this.startWorkspaceHeartbeat(workspace.id, opts.identityId, run.id);
    }

    let runStatus: "ok" | "error" = "ok";
    let sessionId: string | null = null;
    try {
      this.logger.info(
        `[cloud] run start id=${run.id} agent=${opts.agent} repos=${opts.repoIds.length} workspace=${workspace.id}`,
      );
      const repoMounts: Array<{ repoId: string; mountPath: string; absPath: string }> = [];
      if (opts.repoIds.length > 0) {
        for (let i = 0; i < opts.repoIds.length; i++) {
          const repoId = opts.repoIds[i]!;
          const mountPath = i === 0 ? path.posix.join("repo", "main") : path.posix.join("repo", `dep${i}`);
          const absPath = this.joinWorkspacePath(workspace.rootPath, mountPath);
          repoMounts.push({ repoId, mountPath, absPath });
          await addRunRepo(this.db, { runId: run.id, repoId, mountPath });
          const { repo, clone } = await this.time(
            "repo.resolve",
            () => this.resolveCloneInfo(repoId),
            `repoId=${repoId}`,
            "debug",
          );
          if (usedSnapshot) {
            this.logger.info(`[cloud] keep snapshot repo state; set remote repo=${repo.name} url=${clone.redacted}`);
            await this.time(
              "repo.remoteUrl",
              () => this.ensureRepoRemote({ workspace, absPath, cloneUrl: clone.url }),
              `repo=${repo.name}`,
            );
          } else {
            this.logger.info(`[cloud] clone repo=${repo.name} url=${clone.redacted}`);
            await this.time(
              "repo.clone",
              () => this.cloneRepo({ workspace, absPath, cloneUrl: clone.url }),
              `repo=${repo.name}`,
            );
          }
        }
      }

      // Apply setup spec if present (DB or repo file).
      if (repoMounts.length > 0 && primaryRepoId && !setupSpec) {
        const specPath = path.join(repoMounts[0]!.absPath, "tintin-setup.yml");
        const specText = await readFile(specPath, "utf8").catch(() => null);
        if (specText) {
          const hash = hashSetupSpec(specText);
          await putSetupSpec(this.db, { repoId: primaryRepoId, ymlBlob: specText, hash });
          setupSpec = await getLatestSetupSpec(this.db, primaryRepoId);
        }
      }
      if (setupSpec && !usedSnapshot) {
        const spec = parseSetupSpec(setupSpec.yml_blob);
        const secrets = await this.time(
          "secrets.load",
          () => this.loadSecretsMap(opts.identityId),
          `identity=${opts.identityId}`,
          "debug",
        );
        const envVars: Record<string, string> = {};
        for (const entry of spec.env ?? []) {
          if (!entry.value) continue;
          envVars[entry.name] = interpolateSecrets(entry.value, (name) => secrets.get(name) ?? null);
        }

        if (spec.files && spec.files.length > 0) {
          const files = spec.files
            .filter((f) => f.content !== undefined)
            .map((f) => ({ path: f.path, content: f.content ?? "", mode: f.mode }));
          if (files.length > 0) {
            await this.time(
              "setupSpec.uploadFiles",
              () => this.provider.uploadFiles(workspace, files),
              `files=${files.length}`,
            );
          }
        }

        const mainRepoPath = repoMounts[0]!.absPath;
        const commands = spec.commands ?? [];
        if (commands.length > 0) {
          this.logger.info(`[cloud] applying setup spec commands count=${commands.length}`);
          await this.time(
            "setupSpec.runCommands",
            () => this.provider.runCommands({ workspace, cwd: mainRepoPath, commands, env: envVars }),
            `commands=${commands.length}`,
          );
        }
        setupSnapshotId = await this.time("setupSpec.snapshot", () => this.provider.snapshotWorkspace(workspace, "setup"));
        await updateCloudRun(this.db, run.id, { snapshot_id: setupSnapshotId });
        if (setupSpec.id) {
          await updateSetupSpecSnapshot(this.db, { id: setupSpec.id, snapshotId: setupSnapshotId });
        }
      } else if (usedSnapshot && setupSpec?.snapshot_id) {
        setupSnapshotId = setupSpec.snapshot_id;
      } else if (usedSnapshot && setupSnapshotId) {
        if (setupSpec?.id) {
          await updateSetupSpecSnapshot(this.db, { id: setupSpec.id, snapshotId: setupSnapshotId });
        }
      }

      const mainRepoPath = repoMounts.length > 0 ? repoMounts[0]!.absPath : workspace.rootPath;
      const projectId = primaryRepoId ? `cloud:${primaryRepoId}` : `cloud:playground:${run.id}`;
      if (this.provider.id !== "local") {
        this.logger.info(`[cloud] starting remote session run=${run.id} workspace=${workspace.id}`);
        sessionId = await this.time(
          "session.startRemote",
          () =>
            this.startRemoteSession({
              identityId: opts.identityId,
              platform: opts.platform,
              workspaceId: opts.workspaceId,
              chatId: opts.chatId,
              spaceId: opts.spaceId,
              userId: opts.userId,
              runId: run.id,
              projectId,
              projectPath: mainRepoPath,
              prompt: opts.prompt,
              agent: opts.agent,
              workspace,
            }),
          `run=${run.id}`,
        );
      } else {
        if (!this.sessionManager) throw new Error("Cloud manager is not attached to session manager.");
        const envOverrides = await this.time(
          "env.build",
          () => this.buildAgentEnv(opts.identityId),
          `run=${run.id} identity=${opts.identityId}`,
          "debug",
        );
        sessionId = await this.time(
          "session.startLocal",
          () =>
            this.sessionManager!.startNewSession({
              platform: opts.platform,
              workspaceId: opts.workspaceId,
              chatId: opts.chatId,
              spaceId: opts.spaceId,
              userId: opts.userId,
              projectId,
              projectPathResolved: mainRepoPath,
              initialPrompt: opts.prompt,
              agent: opts.agent,
              envOverrides,
            }),
          `run=${run.id}`,
        );
      }
      if (!sessionId) {
        throw new Error("Session start failed.");
      }

      await updateCloudRun(this.db, run.id, {
        status: "running",
        session_id: sessionId,
        started_at: nowMs(),
        snapshot_id: setupSnapshotId ?? null,
      });

      return { runId: run.id, sessionId: sessionId };
    } catch (e) {
      runStatus = "error";
      this.logger.warn(`[cloud] run failed id=${run.id}: ${String(e)}`);
      await updateCloudRun(this.db, run.id, { status: "error", finished_at: nowMs() });
      if (this.provider.id !== "local") {
        await this.provider.terminateWorkspace(workspace).catch(() => {});
        if (sessionId) {
          await this.releaseBrowserbaseForSession(sessionId, "run_failed").catch(() => {});
          await this.releaseHyperbrowserForSession(sessionId, "run_failed").catch(() => {});
        }
      }
      throw e;
    } finally {
      const runEndMs = Date.now();
      const runEndTs = new Date(runEndMs).toISOString();
      this.logger.info(
        `[cloud][timing] run end ts=${runEndTs} id=${run.id} status=${runStatus} ms=${runEndMs - runStartMs}`,
      );
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
    let secretCount = 0;
    for (const s of secrets) {
      try {
        env[s.name] = decryptSecret(s.encrypted_value, key);
        secretCount += 1;
      } catch {
        continue;
      }
    }
    const identity = await this.db
      .selectFrom("identities")
      .select(["git_user_name", "git_user_email"])
      .where("id", "=", identityId)
      .executeTakeFirst();
    if (identity?.git_user_name && identity.git_user_name.trim().length > 0) {
      env.TINTIN_GIT_USER_NAME = identity.git_user_name.trim();
    }
    if (identity?.git_user_email && identity.git_user_email.trim().length > 0) {
      env.TINTIN_GIT_USER_EMAIL = identity.git_user_email.trim();
    }
    if (this.config.chatgpt_oauth) {
      try {
        const account = await getChatgptAccountForIdentity({ db: this.db, config: this.config, identityId });
        if (account?.accessToken && account.accessToken.length > 0) {
          env.CHATGPT_PROXY_ENABLED = "1";
          env.CHATGPT_ACCESS_TOKEN = account.accessToken;
          env.CHATGPT_REFRESH_TOKEN = account.refreshToken;
          env.CHATGPT_EXPIRES_AT = String(account.expiresAt);
          env.CHATGPT_ACCOUNT_ID = account.chatgptUserId;
          env.OPENAI_BASE_URL = env.OPENAI_BASE_URL ?? "http://127.0.0.1:19191";
          env.OPENAI_API_KEY = env.OPENAI_API_KEY ?? "chatgpt-oauth";
          this.logger.info(
            `[cloud] applied ChatGPT OAuth tokens for identity=${identityId} account=${account.chatgptUserId} exp=${new Date(account.expiresAt).toISOString()}`,
          );
        }
      } catch (e) {
        this.logger.warn(
          `[cloud] ChatGPT token unavailable for identity=${identityId}; please re-auth with /connect chatgpt. Err=${String(e)}`,
        );
      }
    }
    if (secretCount > 0) {
      this.logger.info(`[cloud] loaded ${secretCount} secrets for identity=${identityId}`);
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

  private resolveRemoteSessionsRoot(cwd: string, sessionsDir: string): string {
    const homeOverride = this.provider.id === "modal" ? "/home/ubuntu" : undefined;
    return resolveSessionsRoot(cwd, sessionsDir, homeOverride);
  }

  private ensureNoProxyForLocalhost(env: Record<string, string>): void {
    const additions = ["127.0.0.1", "localhost", "::1"];
    for (const key of ["NO_PROXY", "no_proxy"] as const) {
      const raw = env[key] ?? "";
      const cur = raw.trim();
      if (cur === "*") continue;
      const parts = cur
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const set = new Set(parts);
      let changed = false;
      for (const a of additions) {
        if (set.has(a)) continue;
        set.add(a);
        changed = true;
      }
      if (changed) env[key] = Array.from(set).join(",");
    }
  }

  private async readRemoteText(sandbox: Sandbox, targetPath: string): Promise<string | null> {
    try {
      const handle = await sandbox.open(targetPath, "r");
      const bytes = await handle.read();
      await handle.close();
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return null;
    }
  }

  private async ensureRemoteCodexAuthFile(
    sandbox: Sandbox,
    env: Record<string, string>,
    codexHome: string,
    timeoutMs: number,
  ): Promise<void> {
    if (this.provider.id !== "modal") return;
    const openaiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY : "";
    if (!openaiKey) return;
    const homeDir = typeof env.HOME === "string" && env.HOME ? toPosix(env.HOME) : "/home/ubuntu";
    const codexDir = toPosix(codexHome);
    const homeCodexDir = toPosix(path.posix.join(homeDir, ".codex"));
    const authDirs = Array.from(new Set([codexDir, homeCodexDir])).filter((dir) => dir.length > 0);

    for (const dir of authDirs) {
      await this.ensureRemoteDir(sandbox, dir, timeoutMs);
      const chown = await this.runRemoteCommand(sandbox, `chown -R ubuntu:ubuntu ${shellQuote(dir)}`, {
        cwd: "/",
        timeoutMs,
        stdout: "ignore",
        stderr: "ignore",
      });
      if (chown.exitCode !== 0) {
        throw new Error(`Failed to chown ${dir} for codex auth`);
      }
      const authPath = path.posix.join(dir, "auth.json");
      const current = await this.readRemoteText(sandbox, authPath);
      let next: Record<string, unknown> = {};
      if (current) {
        try {
          const parsed = JSON.parse(current);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            next = parsed as Record<string, unknown>;
          }
        } catch {
          next = {};
        }
      }
      next.OPENAI_API_KEY = openaiKey;
      const nextText = `${JSON.stringify(next, null, 2)}\n`;
      if (current && current.trim() === nextText.trim()) continue;
      await this.writeRemoteText(sandbox, authPath, nextText);
    }
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

  private async resolveCloneInfo(repoId: string): Promise<{ repo: any; clone: { url: string; redacted: string } }> {
    const repo = await this.db.selectFrom("repos").selectAll().where("id", "=", repoId).executeTakeFirstOrThrow();
    const conn = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("id", "=", repo.connection_id)
      .executeTakeFirstOrThrow();
    let cloneToken = conn.access_token;
    let cloneUser: string | undefined;
    if (conn.type === "github_app" && this.config.cloud?.github_app) {
      const token = await ensureGithubAppToken({
        db: this.db,
        config: this.config.cloud.github_app,
        secretKey: this.config.cloud.secrets_key,
        connection: conn,
      });
      cloneToken = token.token;
      cloneUser = "x-access-token";
    }
    const clone = buildCloneUrl(repo.url, cloneToken, cloneUser ? { username: cloneUser } : undefined);
    return { repo, clone };
  }

  private async cloneRepo(opts: { workspace: CloudWorkspace; absPath: string; cloneUrl: string }) {
    const parentDir = path.dirname(opts.absPath);
    const cwd = this.provider.id === "modal" ? "/" : opts.workspace.rootPath;
    const script = [
      `mkdir -p ${shellQuote(parentDir)}`,
      `git clone --depth 1 ${shellQuote(opts.cloneUrl)} ${shellQuote(opts.absPath)}`,
    ].join("\n");
    await this.provider.runCommands({
      workspace: opts.workspace,
      cwd,
      commands: [script],
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
  }

  private async ensureRepoRemote(opts: { workspace: CloudWorkspace; absPath: string; cloneUrl: string }) {
    const parentDir = path.dirname(opts.absPath);
    const gitDir = path.join(opts.absPath, ".git");
    const script = [
      `mkdir -p ${shellQuote(parentDir)}`,
      `if [ -d ${shellQuote(gitDir)} ]; then`,
      `  git -C ${shellQuote(opts.absPath)} remote set-url origin ${shellQuote(opts.cloneUrl)}`,
      "else",
      `  git clone --depth 1 ${shellQuote(opts.cloneUrl)} ${shellQuote(opts.absPath)}`,
      "fi",
    ].join("\n");
    const cwd = this.provider.id === "modal" ? "/" : opts.workspace.rootPath;
    await this.provider.runCommands({
      workspace: opts.workspace,
      cwd,
      commands: [script],
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
  }

  private async refreshRepo(opts: { workspace: CloudWorkspace; absPath: string; cloneUrl: string }) {
    const parentDir = path.dirname(opts.absPath);
    const gitDir = path.join(opts.absPath, ".git");
    const script = [
      `mkdir -p ${shellQuote(parentDir)}`,
      `if [ -d ${shellQuote(gitDir)} ]; then`,
      `  git -C ${shellQuote(opts.absPath)} remote set-url origin ${shellQuote(opts.cloneUrl)}`,
      `  git -C ${shellQuote(opts.absPath)} fetch --depth 1 origin`,
      "  git -C " + shellQuote(opts.absPath) + " reset --hard FETCH_HEAD",
      "  git -C " + shellQuote(opts.absPath) + " clean -fdx",
      "else",
      `  git clone --depth 1 ${shellQuote(opts.cloneUrl)} ${shellQuote(opts.absPath)}`,
      "fi",
    ].join("\n");
    const cwd = this.provider.id === "modal" ? "/" : opts.workspace.rootPath;
    await this.provider.runCommands({
      workspace: opts.workspace,
      cwd,
      commands: [script],
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
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

  private buildRemotePlaywrightArgs(agent: SessionAgent, serverOverride?: PlaywrightServerInfo): string[] {
    if (this.provider.id === "local") return [];
    const cfg = this.config.playwright_mcp;
    if (!cfg?.enabled) return [];
    const server: PlaywrightServerInfo =
      serverOverride ?? {
        port: cfg.port_start,
        url: `http://localhost:${cfg.port_start}/mcp`,
        userDataDir: "",
        outputDir: "",
      };
    const startupSec = Math.ceil(cfg.timeout_ms / 1000);
    const adapter = getAgentAdapter(agent);
    return adapter.buildPlaywrightCliArgs({ server, playwrightStartupTimeoutSec: startupSec });
  }

  private isBrowserbaseEnabled(): boolean {
    const cfg = this.config.playwright_mcp;
    return this.provider.id === "modal" && Boolean(cfg?.enabled && cfg.provider === "browserbase");
  }

  private isHyperbrowserEnabled(): boolean {
    const cfg = this.config.playwright_mcp;
    return this.provider.id === "modal" && Boolean(cfg?.enabled && cfg.provider === "hyperbrowser");
  }

  private requireBrowserbaseConfig(): { mcp: PlaywrightMcpSection; browserbase: PlaywrightMcpBrowserbaseSection } {
    const mcp = this.config.playwright_mcp;
    if (!mcp || !mcp.enabled) throw new Error("Playwright MCP is not enabled.");
    if (mcp.provider !== "browserbase") throw new Error("Playwright MCP provider is not browserbase.");
    const browserbase = mcp.browserbase;
    if (!browserbase) throw new Error("Missing [playwright_mcp.browserbase] configuration.");
    if (!browserbase.api_key || !browserbase.project_id) {
      throw new Error("Browserbase config missing api_key or project_id.");
    }
    return { mcp, browserbase };
  }

  private requireHyperbrowserConfig(): { mcp: PlaywrightMcpSection; hyperbrowser: PlaywrightMcpHyperbrowserSection } {
    const mcp = this.config.playwright_mcp;
    if (!mcp || !mcp.enabled) throw new Error("Playwright MCP is not enabled.");
    if (mcp.provider !== "hyperbrowser") throw new Error("Playwright MCP provider is not hyperbrowser.");
    const hyperbrowser = mcp.hyperbrowser;
    if (!hyperbrowser) throw new Error("Missing [playwright_mcp.hyperbrowser] configuration.");
    if (!hyperbrowser.api_key) {
      throw new Error("Hyperbrowser config missing api_key.");
    }
    return { mcp, hyperbrowser };
  }

  private pickRemoteMcpPort(cfg: PlaywrightMcpSection): number {
    const preferred = cfg.port_start;
    if (preferred === 11000) {
      if (cfg.port_end >= 11001) {
        this.logger.warn("[cloud][playwright] port_start=11000 conflicts with the Modal image default; using port=11001");
        return 11001;
      }
      this.logger.warn("[cloud][playwright] port_start=11000 may conflict with the Modal image default (11000).");
    }
    return preferred;
  }

  private buildBrowserbaseUserMetadata(
    base: Record<string, unknown> | null,
    extra: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const merged: Record<string, unknown> = {};
    const pushEntries = (source: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(source)) {
        const sanitized = sanitizeBrowserbaseMetadataValue(value);
        if (sanitized === null) continue;
        merged[key] = sanitized;
      }
    };
    if (base) pushEntries(base);
    const prefixed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null || value === "") continue;
      prefixed[`tintin_${key}`] = value;
    }
    pushEntries(prefixed);
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private buildBrowserbaseBootstrapLines(opts: {
    sessionId: string;
    connectUrl: string;
    port: number;
    startupTimeoutSec: number;
    config: PlaywrightMcpSection;
  }): string[] {
    const cfg = opts.config;
    const args = [
      "-y",
      cfg.package,
      "--host",
      "127.0.0.1",
      "--port",
      String(opts.port),
      "--browser",
      "chromium",
      "--cdp-endpoint",
      opts.connectUrl,
      "--shared-browser-context",
      "--snapshot-mode",
      cfg.snapshot_mode,
      "--image-responses",
      cfg.image_responses,
      "--timeout-navigation",
      String(Math.max(1_000, Math.min(cfg.timeout_ms, 60_000))),
    ];
    if (cfg.user_agent) args.push("--user-agent", cfg.user_agent);
    if (cfg.viewport_size) args.push("--viewport-size", cfg.viewport_size);
    const cmd = ["npx", ...args].map(shellQuote).join(" ");

    const logPath = `/tmp/tintin-playwright-mcp-${opts.sessionId}.log`;
    const pidPath = `/tmp/tintin-playwright-mcp-${opts.sessionId}.pid`;
    const lines: string[] = [];
    lines.push(`PLAYWRIGHT_MCP_LOG=${shellQuote(logPath)}`);
    lines.push(`PLAYWRIGHT_MCP_PIDFILE=${shellQuote(pidPath)}`);
    lines.push(`PLAYWRIGHT_MCP_PORT=${shellQuote(String(opts.port))}`);
    lines.push(`PLAYWRIGHT_MCP_STARTUP_SEC=${shellQuote(String(Math.max(1, opts.startupTimeoutSec)))}`);
    lines.push("export PLAYWRIGHT_MCP_PORT");
    lines.push("export PLAYWRIGHT_MCP_STARTUP_SEC");
    lines.push(`${cmd} > "$PLAYWRIGHT_MCP_LOG" 2>&1 &`);
    lines.push('PLAYWRIGHT_MCP_PID="$!"');
    lines.push('echo "$PLAYWRIGHT_MCP_PID" > "$PLAYWRIGHT_MCP_PIDFILE"');
    lines.push("PLAYWRIGHT_MCP_READY=0");
    lines.push('for i in $(seq 1 "$PLAYWRIGHT_MCP_STARTUP_SEC"); do');
    lines.push("if python3 - <<'PY'; then");
    lines.push("import os, socket, sys");
    lines.push("host = '127.0.0.1'");
    lines.push("port = int(os.environ.get('PLAYWRIGHT_MCP_PORT', '0') or '0')");
    lines.push("s = socket.socket()");
    lines.push("s.settimeout(1.0)");
    lines.push("try:");
    lines.push("    s.connect((host, port))");
    lines.push("except Exception:");
    lines.push("    sys.exit(1)");
    lines.push("else:");
    lines.push("    sys.exit(0)");
    lines.push("finally:");
    lines.push("    s.close()");
    lines.push("PY");
    lines.push("  PLAYWRIGHT_MCP_READY=1");
    lines.push("  break");
    lines.push("fi");
    lines.push('  if ! kill -0 "$PLAYWRIGHT_MCP_PID" >/dev/null 2>&1; then');
    lines.push("    break");
    lines.push("  fi");
    lines.push("  sleep 1");
    lines.push("done");
    lines.push('if [ "$PLAYWRIGHT_MCP_READY" -ne 1 ]; then');
    lines.push('  echo "Playwright MCP failed to start" >&2');
    lines.push('  tail -n 200 "$PLAYWRIGHT_MCP_LOG" >&2 || true');
    lines.push("  exit 1");
    lines.push("fi");
    return lines;
  }

  private buildHyperbrowserBootstrapLines(opts: {
    sessionId: string;
    wsEndpoint: string;
    port: number;
    startupTimeoutSec: number;
    config: PlaywrightMcpSection;
  }): string[] {
    const cfg = opts.config;
    const args = [
      "-y",
      cfg.package,
      "--host",
      "127.0.0.1",
      "--port",
      String(opts.port),
      "--browser",
      "chromium",
      "--cdp-endpoint",
      opts.wsEndpoint,
      "--shared-browser-context",
      "--snapshot-mode",
      cfg.snapshot_mode,
      "--image-responses",
      cfg.image_responses,
      "--timeout-navigation",
      String(Math.max(1_000, Math.min(cfg.timeout_ms, 60_000))),
    ];
    if (cfg.user_agent) args.push("--user-agent", cfg.user_agent);
    if (cfg.viewport_size) args.push("--viewport-size", cfg.viewport_size);
    const cmd = ["npx", ...args].map(shellQuote).join(" ");

    const logPath = `/tmp/tintin-playwright-mcp-${opts.sessionId}.log`;
    const pidPath = `/tmp/tintin-playwright-mcp-${opts.sessionId}.pid`;
    const lines: string[] = [];
    lines.push(`PLAYWRIGHT_MCP_LOG=${shellQuote(logPath)}`);
    lines.push(`PLAYWRIGHT_MCP_PIDFILE=${shellQuote(pidPath)}`);
    lines.push(`PLAYWRIGHT_MCP_PORT=${shellQuote(String(opts.port))}`);
    lines.push(`PLAYWRIGHT_MCP_STARTUP_SEC=${shellQuote(String(Math.max(1, opts.startupTimeoutSec)))}`);
    lines.push("export PLAYWRIGHT_MCP_PORT");
    lines.push("export PLAYWRIGHT_MCP_STARTUP_SEC");
    lines.push(`${cmd} > "$PLAYWRIGHT_MCP_LOG" 2>&1 &`);
    lines.push('PLAYWRIGHT_MCP_PID="$!"');
    lines.push('echo "$PLAYWRIGHT_MCP_PID" > "$PLAYWRIGHT_MCP_PIDFILE"');
    lines.push("PLAYWRIGHT_MCP_READY=0");
    lines.push('for i in $(seq 1 "$PLAYWRIGHT_MCP_STARTUP_SEC"); do');
    lines.push("if python3 - <<'PY'; then");
    lines.push("import os, socket, sys");
    lines.push("host = '127.0.0.1'");
    lines.push("port = int(os.environ.get('PLAYWRIGHT_MCP_PORT', '0') or '0')");
    lines.push("s = socket.socket()");
    lines.push("s.settimeout(1.0)");
    lines.push("try:");
    lines.push("    s.connect((host, port))");
    lines.push("except Exception:");
    lines.push("    sys.exit(1)");
    lines.push("else:");
    lines.push("    sys.exit(0)");
    lines.push("finally:");
    lines.push("    s.close()");
    lines.push("PY");
    lines.push("  PLAYWRIGHT_MCP_READY=1");
    lines.push("  break");
    lines.push("fi");
    lines.push('  if ! kill -0 "$PLAYWRIGHT_MCP_PID" >/dev/null 2>&1; then');
    lines.push("    break");
    lines.push("  fi");
    lines.push("  sleep 1");
    lines.push("done");
    lines.push('if [ "$PLAYWRIGHT_MCP_READY" -ne 1 ]; then');
    lines.push('  echo "Playwright MCP failed to start" >&2');
    lines.push('  tail -n 200 "$PLAYWRIGHT_MCP_LOG" >&2 || true');
    lines.push("  exit 1");
    lines.push("fi");
    return lines;
  }

  private async prepareBrowserbaseSession(opts: {
    sessionId: string;
    runId?: string | null;
    agent: SessionAgent;
    projectId: string;
    projectPath: string;
  }): Promise<RemotePlaywrightSetup> {
    const { mcp, browserbase } = this.requireBrowserbaseConfig();
    if (this.browserbaseSessions.has(opts.sessionId)) {
      await this.releaseBrowserbaseForSession(opts.sessionId, "replaced");
    }

    let created: { id: string; connectUrl: string } | null = null;
    try {
      const metadata = this.buildBrowserbaseUserMetadata(browserbase.user_metadata ?? null, {
        session_id: opts.sessionId,
        run_id: opts.runId ?? undefined,
        agent: opts.agent,
        project_id: opts.projectId,
        project_path: path.basename(opts.projectPath),
      });
      created = await createBrowserbaseSession({ config: browserbase, userMetadata: metadata });

      const port = this.pickRemoteMcpPort(mcp);
      const startupTimeoutSec = Math.ceil(mcp.timeout_ms / 1000);
      const bootstrapLines = this.buildBrowserbaseBootstrapLines({
        sessionId: opts.sessionId,
        connectUrl: created.connectUrl,
        port,
        startupTimeoutSec,
        config: mcp,
      });
      this.browserbaseSessions.set(opts.sessionId, {
        browserbaseSessionId: created.id,
        projectId: browserbase.project_id,
        keepAlive: browserbase.keep_alive,
        connectUrl: created.connectUrl,
        port,
      });
      await updateSession(this.db, opts.sessionId, { browserbase_session_id: created.id });
      this.logger.info(
        `[cloud][browserbase] session created tintin_session=${opts.sessionId} browserbase_session=${created.id} region=${browserbase.region ?? "default"} keepAlive=${browserbase.keep_alive} port=${port}`,
      );
      const server: PlaywrightServerInfo = {
        port,
        url: `http://localhost:${port}/mcp`,
        userDataDir: "",
        outputDir: "",
      };
      return { server, bootstrapLines, port };
    } catch (e) {
      if (created) {
        try {
          await releaseBrowserbaseSession({ config: browserbase, sessionId: created.id });
        } catch (releaseErr) {
          this.logger.warn(
            `[cloud][browserbase] cleanup failed after create error session=${opts.sessionId} browserbase_session=${created.id}: ${String(releaseErr)}`,
          );
        }
      }
      throw e;
    }
  }

  private buildExistingBrowserbaseSetup(sessionId: string): RemotePlaywrightSetup | null {
    const cfg = this.config.playwright_mcp;
    if (!cfg || !cfg.enabled || cfg.provider !== "browserbase") return null;
    const entry = this.browserbaseSessions.get(sessionId);
    if (!entry || !entry.keepAlive) return null;
    const port = entry.port;
    const startupTimeoutSec = Math.ceil(cfg.timeout_ms / 1000);
    const bootstrapLines = this.buildBrowserbaseBootstrapLines({
      sessionId,
      connectUrl: entry.connectUrl,
      port,
      startupTimeoutSec,
      config: cfg,
    });
    const server: PlaywrightServerInfo = {
      port,
      url: `http://localhost:${port}/mcp`,
      userDataDir: "",
      outputDir: "",
    };
    return { server, bootstrapLines, port };
  }

  private async prepareHyperbrowserSession(opts: {
    sessionId: string;
    runId?: string | null;
    agent: SessionAgent;
    projectId: string;
    projectPath: string;
  }): Promise<RemotePlaywrightSetup> {
    const { mcp, hyperbrowser } = this.requireHyperbrowserConfig();
    if (this.hyperbrowserSessions.has(opts.sessionId)) {
      await this.releaseHyperbrowserForSession(opts.sessionId, "replaced");
    }

    let created: { id: string; wsEndpoint: string } | null = null;
    try {
      created = await createHyperbrowserSession({ config: hyperbrowser });
      const port = this.pickRemoteMcpPort(mcp);
      const startupTimeoutSec = Math.ceil(mcp.timeout_ms / 1000);
      const bootstrapLines = this.buildHyperbrowserBootstrapLines({
        sessionId: opts.sessionId,
        wsEndpoint: created.wsEndpoint,
        port,
        startupTimeoutSec,
        config: mcp,
      });
      this.hyperbrowserSessions.set(opts.sessionId, {
        hyperbrowserSessionId: created.id,
        wsEndpoint: created.wsEndpoint,
        port,
      });
      await updateSession(this.db, opts.sessionId, { hyperbrowser_session_id: created.id });
      this.logger.info(
        `[cloud][hyperbrowser] session created tintin_session=${opts.sessionId} hyperbrowser_session=${created.id} port=${port}`,
      );
      const server: PlaywrightServerInfo = {
        port,
        url: `http://localhost:${port}/mcp`,
        userDataDir: "",
        outputDir: "",
      };
      return { server, bootstrapLines, port };
    } catch (e) {
      if (created) {
        try {
          await stopHyperbrowserSession({ config: hyperbrowser, sessionId: created.id });
        } catch (releaseErr) {
          this.logger.warn(
            `[cloud][hyperbrowser] cleanup failed after create error session=${opts.sessionId} hyperbrowser_session=${created.id}: ${String(releaseErr)}`,
          );
        }
      }
      throw e;
    }
  }

  private buildExistingHyperbrowserSetup(sessionId: string): RemotePlaywrightSetup | null {
    const cfg = this.config.playwright_mcp;
    if (!cfg || !cfg.enabled || cfg.provider !== "hyperbrowser") return null;
    const entry = this.hyperbrowserSessions.get(sessionId);
    if (!entry) return null;
    const port = entry.port;
    const startupTimeoutSec = Math.ceil(cfg.timeout_ms / 1000);
    const bootstrapLines = this.buildHyperbrowserBootstrapLines({
      sessionId,
      wsEndpoint: entry.wsEndpoint,
      port,
      startupTimeoutSec,
      config: cfg,
    });
    const server: PlaywrightServerInfo = {
      port,
      url: `http://localhost:${port}/mcp`,
      userDataDir: "",
      outputDir: "",
    };
    return { server, bootstrapLines, port };
  }

  private async waitForCodexThreadId(logPaths: string[], timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    const offsets = new Map<string, number>();
    while (Date.now() < deadline) {
      for (const filePath of logPaths) {
        let raw: string;
        try {
          raw = await readFile(filePath, "utf8");
        } catch {
          continue;
        }
        const start = offsets.get(filePath) ?? 0;
        if (raw.length <= start) continue;
        const chunk = raw.slice(start);
        offsets.set(filePath, raw.length);
        const lines = chunk.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as { type?: string; thread_id?: string };
            if (obj.type === "thread.started" && typeof obj.thread_id === "string" && obj.thread_id.length > 0) {
              return obj.thread_id;
            }
          } catch {
            continue;
          }
        }
      }
      await sleep(200);
    }
    return null;
  }

  private async findCodexThreadIdInLogs(logPaths: string[]): Promise<string | null> {
    for (const filePath of logPaths) {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const lines = raw.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as { type?: string; thread_id?: string };
          if (obj.type === "thread.started" && typeof obj.thread_id === "string" && obj.thread_id.length > 0) {
            return obj.thread_id;
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  private async resolveCodexThreadIdFromOffsets(sessionId: string): Promise<string | null> {
    const offsets = await listSessionOffsets(this.db, sessionId);
    const paths = offsets.map((row) => row.jsonl_path).filter(Boolean);
    const direct = this.agentLogPaths.get(sessionId);
    if (direct) paths.push(direct);
    const unique = Array.from(new Set(paths));
    if (unique.length === 0) return null;
    const found = await this.findCodexThreadIdInLogs(unique);
    if (found) return found;
    return await this.waitForCodexThreadId(unique, 5_000);
  }

  private async releaseBrowserbaseForSession(sessionId: string, reason: string): Promise<void> {
    const entry = this.browserbaseSessions.get(sessionId);
    if (!entry) return;
    this.browserbaseSessions.delete(sessionId);
    const cfg = this.config.playwright_mcp;
    const browserbase = cfg?.browserbase;
    if (!cfg || cfg.provider !== "browserbase" || !browserbase) {
      this.logger.warn(
        `[cloud][browserbase] release skipped session=${sessionId} reason=${reason} (missing config)`,
      );
      return;
    }
    if (!browserbase.api_key || !browserbase.project_id) {
      this.logger.warn(
        `[cloud][browserbase] release skipped session=${sessionId} reason=${reason} (missing api_key/project_id)`,
      );
      return;
    }
    try {
      await releaseBrowserbaseSession({ config: browserbase, sessionId: entry.browserbaseSessionId });
      this.logger.info(
        `[cloud][browserbase] session released tintin_session=${sessionId} browserbase_session=${entry.browserbaseSessionId} reason=${reason}`,
      );
    } catch (e) {
      this.logger.warn(
        `[cloud][browserbase] release failed tintin_session=${sessionId} browserbase_session=${entry.browserbaseSessionId} reason=${reason}: ${String(e)}`,
      );
    }
  }

  private async releaseHyperbrowserForSession(sessionId: string, reason: string): Promise<void> {
    const entry = this.hyperbrowserSessions.get(sessionId);
    if (!entry) return;
    this.hyperbrowserSessions.delete(sessionId);
    const cfg = this.config.playwright_mcp;
    const hyperbrowser = cfg?.hyperbrowser;
    if (!cfg || cfg.provider !== "hyperbrowser" || !hyperbrowser) {
      this.logger.warn(`[cloud][hyperbrowser] release skipped session=${sessionId} reason=${reason} (missing config)`);
      return;
    }
    if (!hyperbrowser.api_key) {
      this.logger.warn(`[cloud][hyperbrowser] release skipped session=${sessionId} reason=${reason} (missing api_key)`);
      return;
    }
    try {
      await stopHyperbrowserSession({ config: hyperbrowser, sessionId: entry.hyperbrowserSessionId });
      this.logger.info(
        `[cloud][hyperbrowser] session released tintin_session=${sessionId} hyperbrowser_session=${entry.hyperbrowserSessionId} reason=${reason}`,
      );
    } catch (e) {
      this.logger.warn(
        `[cloud][hyperbrowser] release failed tintin_session=${sessionId} hyperbrowser_session=${entry.hyperbrowserSessionId} reason=${reason}: ${String(e)}`,
      );
    }
  }

  private async startRemoteSession(opts: {
    identityId: string;
    platform: string;
    workspaceId: string | null;
    chatId: string;
    spaceId: string;
    userId: string;
    runId?: string | null;
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
      browserbase_session_id: null,
      hyperbrowser_session_id: null,
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
      let envOverrides = await this.time(
        "env.build",
        () => this.buildAgentEnv(opts.identityId),
        `session=${sessionId} identity=${opts.identityId}`,
        "debug",
      );
      envOverrides = this.applyProxyEnv(envOverrides, opts.identityId, opts.agent);
      if (opts.agent === "codex") {
        envOverrides = this.normalizeChatgptProxyEnv(sessionId, envOverrides);
      }
      this.logger.info(
        `[cloud] spawn agent=${opts.agent} session=${sessionId} cwd=${opts.projectPath} env_keys=${Object.keys(envOverrides).length}`,
      );
      let playwrightSetup: RemotePlaywrightSetup | null = null;
      if (this.isBrowserbaseEnabled()) {
        playwrightSetup = await this.time(
          "browserbase.create",
          () =>
            this.prepareBrowserbaseSession({
              sessionId,
              runId: opts.runId ?? null,
              agent: opts.agent,
              projectId: opts.projectId,
              projectPath: opts.projectPath,
            }),
          `session=${sessionId}`,
          "debug",
        );
      } else if (this.isHyperbrowserEnabled()) {
        playwrightSetup = await this.time(
          "hyperbrowser.create",
          () =>
            this.prepareHyperbrowserSession({
              sessionId,
              runId: opts.runId ?? null,
              agent: opts.agent,
              projectId: opts.projectId,
              projectPath: opts.projectPath,
            }),
          `session=${sessionId}`,
          "debug",
        );
      }
      const { handle, agentSessionId, logSyncers, debug } = await this.time(
        "remote.spawnAgent",
        () =>
          this.spawnRemoteAgent({
            sessionId,
            prompt: opts.prompt,
            cwd: opts.projectPath,
            agent: opts.agent,
            workspace: opts.workspace,
            envOverrides,
            playwright: playwrightSetup,
          }),
        `session=${sessionId} agent=${opts.agent}`,
      );

      await updateSession(this.db, sessionId, {
        pid: handle.pid ?? null,
        ...(agentSessionId ? { codex_session_id: agentSessionId } : {}),
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
      await this.releaseBrowserbaseForSession(sessionId, "spawn_failed").catch(() => {});
      await this.releaseHyperbrowserForSession(sessionId, "spawn_failed").catch(() => {});
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
    const openaiKey = typeof out.OPENAI_API_KEY === "string" ? out.OPENAI_API_KEY : this.config.codex.env.OPENAI_API_KEY;
    const hasOpenAIKey = typeof openaiKey === "string" && openaiKey.length > 0;
    const hasOpenAIBase = Boolean(out.OPENAI_BASE_URL || out.OPENAI_API_BASE);
    if (agent === "codex" && !hasOpenAIKey && !hasOpenAIBase && proxy.openai_api_key) {
      out.OPENAI_API_KEY = token;
      const openaiBase = `${baseUrl}${proxy.openai_path}`;
      out.OPENAI_BASE_URL = openaiBase;
      out.OPENAI_API_BASE = openaiBase;
      this.logger.info("[cloud] proxy applied for OpenAI (token).");
    }
    const hasAnthropicKey =
      (typeof out.ANTHROPIC_API_KEY === "string" && out.ANTHROPIC_API_KEY.length > 0) ||
      (this.config.claude_code?.env && typeof this.config.claude_code.env.ANTHROPIC_API_KEY === "string" && this.config.claude_code.env.ANTHROPIC_API_KEY.length > 0);
    const hasAnthropicBase = "ANTHROPIC_BASE_URL" in out;
    if (agent === "claude_code" && !hasAnthropicKey && !hasAnthropicBase && proxy.anthropic_api_key) {
      out.ANTHROPIC_API_KEY = token;
      out.ANTHROPIC_BASE_URL = `${baseUrl}${proxy.anthropic_path}`;
      this.logger.info("[cloud] proxy applied for Anthropic (token).");
    }
    return out;
  }

  private normalizeChatgptProxyEnv(sessionId: string, env: Record<string, string>): Record<string, string> {
    if (env.CHATGPT_PROXY_ENABLED !== "1") return env;
    const out = { ...env };
    const host = out.CHATGPT_PROXY_HOST || "127.0.0.1";
    const port = out.CHATGPT_PROXY_PORT || "19191";
    const refreshPath = out.CHATGPT_REFRESH_OUT ?? `/tmp/tintin-chatgpt-refresh-${sessionId}.json`;
    const logPath = out.CHATGPT_PROXY_LOG ?? `/tmp/tintin-chatgpt-proxy-${sessionId}.log`;
    out.CHATGPT_REFRESH_OUT = refreshPath;
    out.CHATGPT_PROXY_LOG = logPath;
    out.CHATGPT_PROXY_LOG_PREFIX = out.CHATGPT_PROXY_LOG_PREFIX ?? `[chatgpt][proxy][${sessionId}]`;
    out.CHATGPT_REFRESH_PREFIX = out.CHATGPT_REFRESH_PREFIX ?? `[chatgpt][refresh][${sessionId}]`;
    if (!out.OPENAI_BASE_URL) out.OPENAI_BASE_URL = `http://${host}:${port}`;
    if (!out.OPENAI_API_BASE) out.OPENAI_API_BASE = out.OPENAI_BASE_URL;
    if (!out.OPENAI_API_KEY) out.OPENAI_API_KEY = "chatgpt-oauth";
    this.ensureNoProxyForLocalhost(out);
    this.chatgptRefreshPaths.set(sessionId, refreshPath);
    return out;
  }

  private describeOpenaiAuthSource(env: Record<string, string>): { source: string; account?: string } {
    if (env.CHATGPT_PROXY_ENABLED === "1") {
      const account = typeof env.CHATGPT_ACCOUNT_ID === "string" ? env.CHATGPT_ACCOUNT_ID : "";
      return { source: "chatgpt_oauth", ...(account ? { account } : {}) };
    }
    const cloud = this.config.cloud;
    const proxy = cloud?.proxy;
    const base = cloud?.public_base_url ?? "";
    const openaiBase = env.OPENAI_BASE_URL || env.OPENAI_API_BASE || "";
    if (proxy?.enabled && base && openaiBase) {
      const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
      const expected = `${trimmed}${proxy.openai_path}`;
      if (openaiBase === expected) return { source: "cloud_proxy" };
    }
    const hasKey = typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0;
    if (openaiBase && hasKey) return { source: "api_key" };
    if (openaiBase && !hasKey) return { source: "custom_base" };
    if (hasKey) return { source: "api_key" };
    return { source: "missing" };
  }

  private async persistChatgptRefreshFromLines(sessionId: string, identityId: string, lines: string[]): Promise<boolean> {
    let updated = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const brace = trimmed.indexOf("{");
      const jsonPart = brace >= 0 ? trimmed.slice(brace) : trimmed;
      try {
        const obj = JSON.parse(jsonPart) as Record<string, any>;
        const access = typeof obj.access_token === "string" ? obj.access_token : "";
        const refresh = typeof obj.refresh_token === "string" ? obj.refresh_token : "";
        const expRaw = obj.expires_at ?? obj.expiresAt;
        const exp = typeof expRaw === "number" ? expRaw : Number(expRaw);
        if (!access || !refresh || !Number.isFinite(exp)) continue;
        await persistChatgptProxyTokens({
          db: this.db,
          config: this.config,
          identityId,
          accessToken: access,
          refreshToken: refresh,
          expiresAt: exp,
          scope: typeof obj.scope === "string" ? obj.scope : null,
          expectedAccountId: typeof obj.account_id === "string" ? obj.account_id : undefined,
        });
        updated = true;
      } catch {
        continue;
      }
    }
    return updated;
  }

  private async writeRemoteText(sandbox: Sandbox, targetPath: string, text: string): Promise<void> {
    const file = await sandbox.open(targetPath, "w");
    await file.write(Buffer.from(text, "utf8"));
    await file.flush();
    await file.close();
  }

  private async readTailLines(filePath: string, maxBytes: number): Promise<string[]> {
    try {
      const fh = await openFile(filePath, "r");
      const stat = await fh.stat();
      const size = stat.size;
      const start = size > maxBytes ? size - maxBytes : 0;
      const length = size - start;
      const buf = Buffer.alloc(Math.max(0, length));
      if (length > 0) await fh.read(buf, 0, length, start);
      await fh.close();
      const raw = buf.toString("utf8");
      return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
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

  private async captureChatgptRefreshFromSandbox(sessionId: string, sandbox: Sandbox | null): Promise<void> {
    if (!sandbox) return;
    const refreshPath = this.chatgptRefreshPaths.get(sessionId);
    if (!refreshPath) return;
    const run = await getCloudRunBySession(this.db, sessionId);
    const identityId = run?.identity_id ?? null;
    if (!identityId) return;
    const read = await this.runRemoteCommand(
      sandbox,
      `[ -f ${shellQuote(refreshPath)} ] && cat ${shellQuote(refreshPath)} || true`,
      { cwd: "/", timeoutMs: 10_000, stdout: "pipe", stderr: "ignore" },
    );
    const raw = (read.stdout ?? "").trim();
    if (!raw) return;
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const updated = await this.persistChatgptRefreshFromLines(sessionId, identityId, lines);
    if (!updated) {
      // Fall back: the refresh file may be pure JSON without prefix.
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, any>;
          const access = typeof obj.access_token === "string" ? obj.access_token : "";
          const refresh = typeof obj.refresh_token === "string" ? obj.refresh_token : "";
          const expRaw = obj.expires_at ?? obj.expiresAt;
          const exp = typeof expRaw === "number" ? expRaw : Number(expRaw);
          if (!access || !refresh || !Number.isFinite(exp)) continue;
          await persistChatgptProxyTokens({
            db: this.db,
            config: this.config,
            identityId,
            accessToken: access,
            refreshToken: refresh,
            expiresAt: exp,
            scope: typeof obj.scope === "string" ? obj.scope : null,
            expectedAccountId: typeof obj.account_id === "string" ? obj.account_id : undefined,
          });
          this.logger.info(`[chatgpt][oauth] persisted refreshed tokens (fallback) session=${sessionId} identity=${identityId}`);
          return;
        } catch {
          continue;
        }
      }
    } else {
      this.logger.info(`[chatgpt][oauth] persisted refreshed tokens session=${sessionId} identity=${identityId}`);
    }
  }

  private buildChatgptProxyLines(env: Record<string, string>): string[] {
    if (env.CHATGPT_PROXY_ENABLED !== "1") return [];
    const bin = "/usr/local/bin/tintin-chatgpt-proxy.js";
    const host = env.CHATGPT_PROXY_HOST || "127.0.0.1";
    const port = env.CHATGPT_PROXY_PORT || "19191";
    const logPath = env.CHATGPT_PROXY_LOG || "/tmp/tintin-chatgpt-proxy.log";

    return [
      `if [ -x ${shellQuote(bin)} ]; then`,
      `  CHATGPT_PROXY_LOG=${shellQuote(logPath)}`,
      "  export CHATGPT_PROXY_LOG",
      '  echo "[chatgpt][proxy] starting local proxy port=${CHATGPT_PROXY_PORT:-19191}" >&2',
      `  node ${shellQuote(bin)} >> "$CHATGPT_PROXY_LOG" 2>&1 &`,
      "  CHATGPT_PROXY_PID=$!",
      '  echo "[chatgpt][proxy] waiting for proxy to be ready..." >&2',
      // Wait for port to be listening (max 10 seconds)
      `  for i in $(seq 1 20); do`,
      `    if nc -z ${host} ${port} 2>/dev/null || curl -s http://${host}:${port}/ >/dev/null 2>&1; then`,
      '      echo "[chatgpt][proxy] proxy ready" >&2',
      '      break',
      '    fi',
      '    sleep 0.5',
      '  done',
      "fi",
    ];
  }

  private buildRemoteBootstrap(opts: {
    promptFile: string;
    promptText: string;
    sessionsRoot: string;
    configDir?: string | null;
    codexHome?: string | null;
    includeCodexAuth: boolean;
    extraLines?: string[] | null;
  }): string {
    const lines: string[] = ["set -e"];
    lines.push("_tintin_cleanup() {");
    lines.push('  if [ -n "${CHATGPT_PROXY_PID:-}" ]; then');
    lines.push('    kill "$CHATGPT_PROXY_PID" >/dev/null 2>&1 || true');
    lines.push("  fi");
    lines.push("}");
    lines.push("trap _tintin_cleanup EXIT");
    lines.push('BOOTSTRAP_START=$(date +%s)');
    lines.push('BOOTSTRAP_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")');
    lines.push('printf \'{"type":"event_msg","payload":{"type":"background_event","message":"tintin bootstrap start ts=%s"}}\\n\' "$BOOTSTRAP_TS"');
    const promptB64 = Buffer.from(opts.promptText, "utf8").toString("base64");
    lines.push(`PROMPT_PATH=${shellQuote(opts.promptFile)}`);
    lines.push(`PROMPT_B64=${shellQuote(promptB64)}`);
    lines.push("if command -v base64 >/dev/null 2>&1; then");
    lines.push('  printf %s "$PROMPT_B64" | base64 -d > "$PROMPT_PATH"');
    lines.push("else");
    lines.push("  python3 - <<'PY'");
    lines.push("import base64, os, sys");
    lines.push("data = os.environ.get('PROMPT_B64', '')");
    lines.push("path = os.environ.get('PROMPT_PATH', '')");
    lines.push("if not path:");
    lines.push("    sys.exit(1)");
    lines.push("with open(path, 'wb') as f:");
    lines.push("    f.write(base64.b64decode(data.encode()))");
    lines.push("PY");
    lines.push("fi");
    lines.push('if [ -z "$HOME" ]; then');
    lines.push('  export HOME="/home/ubuntu"');
    lines.push("fi");
    lines.push('TINTIN_GIT_USER_NAME="${TINTIN_GIT_USER_NAME:-tintin[bot]}"');
    lines.push('TINTIN_GIT_USER_EMAIL="${TINTIN_GIT_USER_EMAIL:-tintin@fuzz.land}"');
    lines.push("if command -v git >/dev/null 2>&1; then");
    lines.push('  git config --global user.name "$TINTIN_GIT_USER_NAME"');
    lines.push('  git config --global user.email "$TINTIN_GIT_USER_EMAIL"');
    lines.push("fi");

    const dirs: string[] = [];
    if (opts.sessionsRoot) dirs.push(opts.sessionsRoot);
    if (opts.configDir) {
      dirs.push(opts.configDir);
      dirs.push(path.posix.join(opts.configDir, "projects"));
    }
    if (opts.codexHome) dirs.push(opts.codexHome);
    const uniqueDirs = Array.from(new Set(dirs.filter((d) => d.length > 0)));
    if (uniqueDirs.length > 0) {
      lines.push(`mkdir -p ${uniqueDirs.map(shellQuote).join(" ")}`);
    }

    if (opts.includeCodexAuth) {
      lines.push('if [ -n "$OPENAI_API_KEY" ]; then');
      lines.push('  HOME_DIR="${HOME:-/home/ubuntu}"');
      lines.push('  CODEX_AUTH_DIRS="${CODEX_HOME:-} ${HOME_DIR}/.codex"');
      lines.push("  export CODEX_AUTH_DIRS");
      lines.push("  for dir in $CODEX_AUTH_DIRS; do");
      lines.push('    [ -z "$dir" ] && continue');
      lines.push('    mkdir -p "$dir"');
      lines.push('    chown -R ubuntu:ubuntu "$dir"');
      lines.push("  done");
      lines.push("  if command -v node >/dev/null 2>&1; then");
      lines.push("    node - <<'NODE'");
      lines.push('const fs = require("fs");');
      lines.push('const path = require("path");');
      lines.push('const key = process.env.OPENAI_API_KEY || "";');
      lines.push("if (!key) process.exit(0);");
      lines.push('const dirs = String(process.env.CODEX_AUTH_DIRS || "").split(" ").filter(Boolean);');
      lines.push("for (const dir of dirs) {");
      lines.push('  const authPath = path.join(dir, "auth.json");');
      lines.push("  let next = {};");
      lines.push(
        '  try { const current = fs.readFileSync(authPath, "utf8"); const parsed = JSON.parse(current); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) next = parsed; } catch {}',
      );
      lines.push("  next.OPENAI_API_KEY = key;");
      lines.push('  fs.writeFileSync(authPath, JSON.stringify(next, null, 2) + "\\n", "utf8");');
      lines.push("}");
      lines.push("NODE");
      lines.push("  else");
      lines.push("    for dir in $CODEX_AUTH_DIRS; do");
      lines.push('      [ -z "$dir" ] && continue');
      lines.push('      printf \'{"OPENAI_API_KEY":"%s"}\\n\' "$OPENAI_API_KEY" > "$dir/auth.json"');
      lines.push("    done");
      lines.push("  fi");
      lines.push("fi");
    }

    if (opts.extraLines && opts.extraLines.length > 0) {
      lines.push(...opts.extraLines);
    }

    lines.push('BOOTSTRAP_END=$(date +%s)');
    lines.push('BOOTSTRAP_END_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")');
    lines.push(
      'printf \'{"type":"event_msg","payload":{"type":"background_event","message":"tintin bootstrap end ts=%s elapsed_s=%s"}}\\n\' "$BOOTSTRAP_END_TS" "$((BOOTSTRAP_END-BOOTSTRAP_START))"',
    );
    return lines.join("\n");
  }

  private async spawnRemoteAgent(opts: {
    sessionId: string;
    prompt: string;
    cwd: string;
    agent: SessionAgent;
    workspace: CloudWorkspace;
    envOverrides: Record<string, string>;
    playwright?: RemotePlaywrightSetup | null;
  }): Promise<{ handle: RemoteHandle; agentSessionId: string; logSyncers: RemoteLogSync[]; debug: RemoteDebug }> {
    const modal = this.getModalProvider();
    const sandbox = modal.getSandbox(opts.workspace.id);
    const modalCfg = this.config.cloud?.modal;
    if (!modalCfg) throw new Error("cloud.modal is required for remote runs.");

    const promptFile = `/tmp/tintin-prompt-${opts.sessionId}.txt`;
    const promptText = opts.prompt.endsWith("\n") ? opts.prompt : `${opts.prompt}\n`;

    let agentSessionId = opts.agent === "claude_code" ? crypto.randomUUID() : "";
    let sessionsRoot = "";
    let configDir: string | null = null;
    let codexHome: string | null = null;
    let relayConfig: { token: string; url: string } | null = null;
    let relayLogPath: string | null = null;
    let cmd = "";
    let env: Record<string, string> = {};
    const mcpEnabled = this.provider.id === "modal" && this.config.playwright_mcp?.enabled;
    const playwrightArgs = mcpEnabled ? this.buildRemotePlaywrightArgs(opts.agent, opts.playwright?.server) : [];
    const localLogPaths: string[] = [];

    if (opts.agent === "claude_code") {
      if (!this.config.claude_code) throw new Error("Claude Code is not configured.");
      sessionsRoot = this.resolveRemoteSessionsRoot(opts.cwd, this.config.claude_code.sessions_dir);
      const resolvedConfigDir = resolveClaudeConfigDirFromSessionsRoot(sessionsRoot);
      configDir = resolvedConfigDir;
      const baseArgs = this.buildClaudeArgs(agentSessionId);
      const baseCmd = `${modalCfg.claude_binary} ${baseArgs.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
      if (mcpEnabled && playwrightArgs.length > 0) {
        const argsWithMcp = [...baseArgs, ...playwrightArgs];
        const mcpCmd = `${modalCfg.claude_binary} ${argsWithMcp.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
        cmd = mcpCmd;
      } else {
        cmd = baseCmd;
      }
      env = {
        ...this.config.claude_code.env,
        ...opts.envOverrides,
        CLAUDE_CONFIG_DIR: toPosix(resolvedConfigDir),
      };
    } else {
      sessionsRoot = this.resolveRemoteSessionsRoot(opts.cwd, this.config.codex.sessions_dir);
      const homeDir = resolveCodexHomeFromSessionsRoot(sessionsRoot);
      codexHome = toPosix(homeDir);
      const baseArgs = this.buildCodexArgs(opts.cwd);
      const baseCmd = `${modalCfg.codex_binary} ${baseArgs.map(shellQuote).join(" ")} - < ${shellQuote(promptFile)}`;
      if (mcpEnabled && playwrightArgs.length > 0) {
        const argsWithMcp = [...baseArgs, ...playwrightArgs];
        const mcpCmd = `${modalCfg.codex_binary} ${argsWithMcp.map(shellQuote).join(" ")} - < ${shellQuote(promptFile)}`;
        cmd = mcpCmd;
      } else {
        cmd = baseCmd;
      }
      env = {
        ...this.config.codex.env,
        ...opts.envOverrides,
        CODEX_HOME: toPosix(homeDir),
      };
    }

    env = this.ensureModalEnv(env);
    const chatgptLines = this.buildChatgptProxyLines(env);
    const combinedExtraLines = [...(opts.playwright?.bootstrapLines ?? []), ...chatgptLines];
    const bootstrap = this.buildRemoteBootstrap({
      promptFile,
      promptText,
      sessionsRoot: toPosix(sessionsRoot),
      configDir: configDir ? toPosix(configDir) : null,
      codexHome,
      includeCodexAuth: opts.agent === "codex",
      extraLines: combinedExtraLines.length > 0 ? combinedExtraLines : null,
    });
    cmd = `${bootstrap}\n${cmd}`;
    const relayUrl = this.buildAgentRelayUrl(opts.sessionId);
      if (relayUrl) {
        const token = this.issueAgentToken(opts.sessionId);
        relayConfig = { token, url: relayUrl };
        relayLogPath = await this.ensureAgentLogPath(opts.sessionId, "exec");
        localLogPaths.push(relayLogPath);
        this.logger.info(`[cloud] log relay enabled session=${opts.sessionId} url=${relayUrl}`);
      } else {
        this.logger.info(`[cloud] log relay disabled session=${opts.sessionId} (missing cloud.public_base_url)`);
      }
    const openaiKeyLen = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.length : 0;
    const anthropicKeyLen = typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.length : 0;
    const openaiBase = env.OPENAI_BASE_URL || env.OPENAI_API_BASE || "";
    const anthropicBase = env.ANTHROPIC_BASE_URL || "";
    const openaiAuth = this.describeOpenaiAuthSource(env);
    const authAccount = openaiAuth.account ? ` account=${openaiAuth.account}` : "";
    this.logger.info(
      `[cloud] env check openai_key=${openaiKeyLen > 0 ? `len=${openaiKeyLen}` : "missing"} openai_base=${openaiBase || "(none)"} openai_auth=${openaiAuth.source}${authAccount} anthropic_key=${anthropicKeyLen > 0 ? `len=${anthropicKeyLen}` : "missing"} anthropic_base=${anthropicBase || "(none)"}`,
    );
    const errPath = `/tmp/tintin-agent-${opts.sessionId}.err`;
    if (relayConfig) {
      cmd = this.wrapAgentRelayCommand(cmd, {
        sessionId: opts.sessionId,
        agent: opts.agent,
        token: relayConfig.token,
        url: relayConfig.url,
      });
    }
    cmd = `${cmd} 2> ${shellQuote(errPath)}`;

    if (this.provider.id === "modal") {
      const binary = opts.agent === "claude_code" ? modalCfg.claude_binary : modalCfg.codex_binary;
      void this.time(
        "remote.binaryCheck",
        () => this.runRemoteDebugCommand(sandbox, `command -v ${shellQuote(binary)}`, modalCfg.command_timeout_ms),
        `agent=${opts.agent}`,
        "debug",
      )
        .then((check) => {
          const stdout = check.stdout.trim();
          const stderr = check.stderr.trim();
          this.logger.info(
            `[cloud] binary check agent=${opts.agent} cmd=${binary} exit=${check.exitCode} path=${stdout || "(not found)"}`,
          );
          if (stderr) {
            this.logger.info(`[cloud] binary check stderr: ${stderr.slice(0, 500)}`);
          }
        })
        .catch((e) => {
          this.logger.debug(`[cloud] binary check failed agent=${opts.agent} cmd=${binary}: ${String(e)}`);
        });
    }

    await this.ensureRemoteDir(sandbox, opts.cwd, modalCfg.command_timeout_ms);

    const cmdLog = this.formatRemoteCommandLog(cmd);
    this.logger.info(
      `[cloud] exec agent=${opts.agent} session=${opts.sessionId} agent_session=${agentSessionId || "(pending)"} cmd=${cmdLog} env_keys=${Object.keys(env).length}`,
    );

    const proc = await this.time(
      "remote.exec",
      () =>
        sandbox.exec(["/bin/sh", "-lc", cmd], {
          workdir: toPosix(opts.cwd),
          env,
          stdout: "ignore",
          stderr: "ignore",
          mode: "text",
        }),
      `agent=${opts.agent} session=${opts.sessionId}`,
      "debug",
    );
    const handle: RemoteHandle = { pid: null, wait: () => proc.wait() };

    const logSyncers: RemoteLogSync[] = [];
    if (!relayConfig) {
      let remoteFiles: string[] = [];
      if (opts.agent === "claude_code") {
        if (!configDir) throw new Error("Claude config dir not resolved.");
        remoteFiles = [toPosix(resolveClaudeSessionJsonlPath(configDir, opts.cwd, agentSessionId))];
      } else {
        const primaryRoot = toPosix(sessionsRoot);
        const homeDir = typeof env.HOME === "string" && env.HOME ? toPosix(env.HOME) : "/home/ubuntu";
        const fallbackRoot = path.posix.join(homeDir, ".codex", "sessions");
        const discovered = await this.time(
          "remote.logSearch",
          () =>
            findRemoteJsonlFiles({
              sandbox,
              sessionsRoot: primaryRoot,
              sessionId: null,
              timeoutMs: 10_000,
              pollMs: 100,
            }),
          `root=${primaryRoot} session=${opts.sessionId}`,
          "debug",
        );
        this.logger.info(`[cloud] log search agent=codex root=${primaryRoot} matches=${discovered.length}`);
        if (discovered.length > 0) {
          remoteFiles.push(...discovered);
        } else if (fallbackRoot !== primaryRoot) {
          const fallbackFound = await this.time(
            "remote.logSearch",
            () =>
              findRemoteJsonlFiles({
                sandbox,
                sessionsRoot: fallbackRoot,
                sessionId: null,
                timeoutMs: 2_000,
                pollMs: 100,
              }),
            `root=${fallbackRoot} session=${opts.sessionId}`,
            "debug",
          );
          this.logger.info(`[cloud] log search agent=codex root=${fallbackRoot} matches=${fallbackFound.length}`);
          if (fallbackFound.length > 0) remoteFiles.push(...fallbackFound);
        }
        remoteFiles = Array.from(new Set(remoteFiles));
      }

      if (remoteFiles.length === 0) {
        this.logger.warn(
          `[cloud] could not locate remote JSONL logs for session ${opts.sessionId} (sessions_root=${toPosix(
            sessionsRoot,
          )}).`,
        );
      } else {
        this.logger.info(`[cloud] located ${remoteFiles.length} remote log file(s) for session ${opts.sessionId}.`);
      }

      const logsDir = path.join(this.config.cloud!.workspaces_dir, "logs", opts.sessionId);
      await mkdir(logsDir, { recursive: true });
      for (let i = 0; i < remoteFiles.length; i++) {
        const remotePath = remoteFiles[i]!;
        const base = path.posix.basename(remotePath);
        const localPath = path.join(logsDir, `${i}-${base}`);
        localLogPaths.push(localPath);
        await this.time(
          "local.logInit",
          async () => {
            await writeFile(localPath, "", "utf8");
            await upsertSessionOffset(this.db, {
              id: crypto.randomUUID(),
              session_id: opts.sessionId,
              jsonl_path: localPath,
              byte_offset: 0,
              updated_at: nowMs(),
            });
          },
          `session=${opts.sessionId}`,
          "debug",
        );
        const syncer = new RemoteLogSync(sandbox, remotePath, localPath, this.logger, 100, modalCfg.command_timeout_ms, 0);
        syncer.start();
        logSyncers.push(syncer);
      }
    }

    if (opts.agent === "codex") {
      if (localLogPaths.length === 0) {
        this.logger.warn(`[cloud] codex logs unavailable; thread id pending session=${opts.sessionId}`);
      } else {
        void this.waitForCodexThreadId(localLogPaths, 20_000).then(async (threadId) => {
          if (!threadId) {
            this.logger.warn(`[cloud] codex thread id unresolved session=${opts.sessionId}`);
            return;
          }
          await updateSession(this.db, opts.sessionId, { codex_session_id: threadId });
          this.logger.info(`[cloud] codex thread resolved session=${opts.sessionId} agent_session=${threadId}`);
        });
      }
    }

    if (localLogPaths.length > 0) {
      this.chatgptLogPaths.set(opts.sessionId, localLogPaths);
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
    playwright?: RemotePlaywrightSetup | null;
  }): Promise<{ handle: RemoteHandle; logSyncers: RemoteLogSync[]; debug: RemoteDebug }> {
    const modal = this.getModalProvider();
    const sandbox = modal.getSandbox(opts.workspace.id);
    const modalCfg = this.config.cloud?.modal;
    if (!modalCfg) throw new Error("cloud.modal is required for remote runs.");

    const promptFile = `/tmp/tintin-prompt-${opts.sessionId}.txt`;
    const promptText = opts.prompt.endsWith("\n") ? opts.prompt : `${opts.prompt}\n`;

    let sessionsRoot = "";
    let configDir: string | null = null;
    let codexHome: string | null = null;
    let relayConfig: { token: string; url: string } | null = null;
    let cmd = "";
    let env: Record<string, string> = {};
    const mcpEnabled = this.provider.id === "modal" && this.config.playwright_mcp?.enabled;
    const playwrightArgs = mcpEnabled ? this.buildRemotePlaywrightArgs(opts.agent, opts.playwright?.server) : [];

    if (opts.agent === "claude_code") {
      if (!this.config.claude_code) throw new Error("Claude Code is not configured.");
      sessionsRoot = this.resolveRemoteSessionsRoot(opts.cwd, this.config.claude_code.sessions_dir);
      const resolvedConfigDir = resolveClaudeConfigDirFromSessionsRoot(sessionsRoot);
      configDir = resolvedConfigDir;
      const baseArgs = this.buildClaudeResumeArgs(opts.agentSessionId);
      const baseCmd = `${modalCfg.claude_binary} ${baseArgs.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
      if (mcpEnabled && playwrightArgs.length > 0) {
        const argsWithMcp = [...baseArgs, ...playwrightArgs];
        const mcpCmd = `${modalCfg.claude_binary} ${argsWithMcp.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
        cmd = mcpCmd;
      } else {
        cmd = baseCmd;
      }
      env = {
        ...this.config.claude_code.env,
        ...opts.envOverrides,
        CLAUDE_CONFIG_DIR: toPosix(resolvedConfigDir),
      };
    } else {
      sessionsRoot = this.resolveRemoteSessionsRoot(opts.cwd, this.config.codex.sessions_dir);
      const homeDir = resolveCodexHomeFromSessionsRoot(sessionsRoot);
      codexHome = toPosix(homeDir);
      const baseArgs = this.buildCodexArgs(opts.cwd);
      const extraArgs = mcpEnabled && playwrightArgs.length > 0 ? playwrightArgs : [];
      const args = [...baseArgs, ...extraArgs, "resume", opts.agentSessionId];
      cmd = `${modalCfg.codex_binary} ${args.map(shellQuote).join(" ")} - < ${shellQuote(promptFile)}`;
      env = {
        ...this.config.codex.env,
        ...opts.envOverrides,
        CODEX_HOME: toPosix(homeDir),
      };
    }

    env = this.ensureModalEnv(env);
    const chatgptLines = this.buildChatgptProxyLines(env);
    const combinedExtraLines = [...(opts.playwright?.bootstrapLines ?? []), ...chatgptLines];
    const bootstrap = this.buildRemoteBootstrap({
      promptFile,
      promptText,
      sessionsRoot: toPosix(sessionsRoot),
      configDir: configDir ? toPosix(configDir) : null,
      codexHome,
      includeCodexAuth: opts.agent === "codex",
      extraLines: combinedExtraLines.length > 0 ? combinedExtraLines : null,
    });
    cmd = `${bootstrap}\n${cmd}`;
    const relayUrl = this.buildAgentRelayUrl(opts.sessionId);
    if (relayUrl) {
      const token = this.issueAgentToken(opts.sessionId);
      relayConfig = { token, url: relayUrl };
      await this.ensureAgentLogPath(opts.sessionId, "resume");
      this.logger.info(`[cloud] log relay enabled session=${opts.sessionId} url=${relayUrl}`);
    } else {
      this.logger.info(`[cloud] log relay disabled session=${opts.sessionId} (missing cloud.public_base_url)`);
    }
    const openaiKeyLen = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.length : 0;
    const anthropicKeyLen = typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.length : 0;
    const openaiBase = env.OPENAI_BASE_URL || env.OPENAI_API_BASE || "";
    const anthropicBase = env.ANTHROPIC_BASE_URL || "";
    const openaiAuth = this.describeOpenaiAuthSource(env);
    const authAccount = openaiAuth.account ? ` account=${openaiAuth.account}` : "";
    this.logger.info(
      `[cloud] env check openai_key=${openaiKeyLen > 0 ? `len=${openaiKeyLen}` : "missing"} openai_base=${openaiBase || "(none)"} openai_auth=${openaiAuth.source}${authAccount} anthropic_key=${anthropicKeyLen > 0 ? `len=${anthropicKeyLen}` : "missing"} anthropic_base=${anthropicBase || "(none)"}`,
    );
    if (mcpEnabled) {
      const mcpPort = opts.playwright?.port ?? this.config.playwright_mcp!.port_start;
      this.logger.info(
        `[cloud] playwright mcp enabled (startup_timeout=${this.config.playwright_mcp!.timeout_ms}ms, port=${mcpPort})`,
      );
    }

    await this.ensureRemoteDir(sandbox, opts.cwd, modalCfg.command_timeout_ms);

    const errPath = `/tmp/tintin-agent-${opts.sessionId}.err`;
    if (relayConfig) {
      cmd = this.wrapAgentRelayCommand(cmd, {
        sessionId: opts.sessionId,
        agent: opts.agent,
        token: relayConfig.token,
        url: relayConfig.url,
      });
    }
    cmd = `${cmd} 2> ${shellQuote(errPath)}`;

    const logSyncers: RemoteLogSync[] = [];
    if (!relayConfig) {
      let remoteFiles: string[] = [];
      if (opts.agent === "claude_code") {
        if (!configDir) throw new Error("Claude config dir not resolved.");
        remoteFiles = [toPosix(resolveClaudeSessionJsonlPath(configDir, opts.cwd, opts.agentSessionId))];
      } else {
        const primaryRoot = toPosix(sessionsRoot);
        const homeDir = typeof env.HOME === "string" && env.HOME ? toPosix(env.HOME) : "/home/ubuntu";
        const fallbackRoot = path.posix.join(homeDir, ".codex", "sessions");
        const discovered = await this.time(
          "remote.logSearch",
          () =>
            findRemoteJsonlFiles({
              sandbox,
              sessionsRoot: primaryRoot,
              sessionId: opts.agentSessionId,
              timeoutMs: 10_000,
              pollMs: 100,
            }),
          `root=${primaryRoot} session=${opts.sessionId}`,
          "debug",
        );
        this.logger.info(`[cloud] log search agent=codex root=${primaryRoot} matches=${discovered.length}`);
        if (discovered.length > 0) {
          remoteFiles.push(...discovered);
        } else if (fallbackRoot !== primaryRoot) {
          const fallbackFound = await this.time(
            "remote.logSearch",
            () =>
              findRemoteJsonlFiles({
                sandbox,
                sessionsRoot: fallbackRoot,
                sessionId: opts.agentSessionId,
                timeoutMs: 2_000,
                pollMs: 100,
              }),
            `root=${fallbackRoot} session=${opts.sessionId}`,
            "debug",
          );
          this.logger.info(`[cloud] log search agent=codex root=${fallbackRoot} matches=${fallbackFound.length}`);
          if (fallbackFound.length > 0) remoteFiles.push(...fallbackFound);
        }
        remoteFiles = Array.from(new Set(remoteFiles));
      }

      if (remoteFiles.length === 0) {
        this.logger.warn(`[cloud] could not locate remote JSONL logs for session ${opts.sessionId}.`);
      }

      const initialOffsets: number[] = [];
      for (const remotePath of remoteFiles) {
        initialOffsets.push(
          await this.time(
            "remote.logSize",
            () =>
              getRemoteFileSize({
                sandbox,
                remotePath,
                timeoutMs: modalCfg.command_timeout_ms,
              }),
            `path=${path.posix.basename(remotePath)} session=${opts.sessionId}`,
            "debug",
          ),
        );
      }

      const logsDir = path.join(this.config.cloud!.workspaces_dir, "logs", opts.sessionId);
      await mkdir(logsDir, { recursive: true });
      for (let i = 0; i < remoteFiles.length; i++) {
        const remotePath = remoteFiles[i]!;
        const base = path.posix.basename(remotePath);
        const localPath = path.join(logsDir, `${Date.now()}-${i}-${base}`);
        await this.time(
          "local.logInit",
          async () => {
            await writeFile(localPath, "", "utf8");
            await upsertSessionOffset(this.db, {
              id: crypto.randomUUID(),
              session_id: opts.sessionId,
              jsonl_path: localPath,
              byte_offset: 0,
              updated_at: nowMs(),
            });
          },
          `session=${opts.sessionId}`,
          "debug",
        );
        const initialOffset = initialOffsets[i] ?? 0;
        const syncer = new RemoteLogSync(sandbox, remotePath, localPath, this.logger, 100, modalCfg.command_timeout_ms, initialOffset);
        syncer.start();
        logSyncers.push(syncer);
      }
    }

    const localPaths: string[] = [];
    if (relayConfig && this.agentLogPaths.has(opts.sessionId)) {
      localPaths.push(this.agentLogPaths.get(opts.sessionId)!);
    }
    if (localPaths.length > 0) {
      this.chatgptLogPaths.set(opts.sessionId, localPaths);
    }

    const proc = await this.time(
      "remote.exec",
      () =>
        sandbox.exec(["/bin/sh", "-lc", cmd], {
          workdir: toPosix(opts.cwd),
          env,
          stdout: "ignore",
          stderr: "ignore",
          mode: "text",
        }),
      `agent=${opts.agent} session=${opts.sessionId}`,
      "debug",
    );
    const handle: RemoteHandle = { pid: null, wait: () => proc.wait() };

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
      if (this.forcedStopSessions.has(opts.sessionId)) {
        status = "killed";
        this.forcedStopSessions.delete(opts.sessionId);
      }
      if (opts.debug) {
        await this.logRemoteAgentError(opts.debug).catch((e) => {
          const msg = String(e);
          if (msg.includes("Sandbox has already completed")) {
            this.logger.debug(`[cloud] skip agent stderr (sandbox completed): ${msg}`);
          } else {
            this.logger.warn(`[cloud] failed to read agent stderr: ${msg}`);
          }
        });
      }
      for (const syncer of opts.logSyncers) syncer.stop();
      for (const syncer of opts.logSyncers) await syncer.drain().catch(() => {});
      try {
        const run = await getCloudRunBySession(this.db, opts.sessionId);
        const identityId = run?.identity_id ?? null;
        if (identityId) {
          // Prefer the dedicated refresh file (small, targeted).
          await this.captureChatgptRefreshFromSandbox(opts.sessionId, opts.debug?.sandbox ?? null).catch((e) => {
            this.logger.warn(`[chatgpt][oauth] refresh capture failed session=${opts.sessionId}: ${String(e)}`);
          });

          // Then parse any relay/log files we already synced locally, tail-only to reduce overhead.
          const logPaths = this.chatgptLogPaths.get(opts.sessionId) ?? [];
          let aggregated = false;
          for (const p of logPaths) {
            try {
              const lines = await this.readTailLines(p, 32768);
              if (lines.length === 0) continue;
              const updated = await this.persistChatgptRefreshFromLines(opts.sessionId, identityId, lines);
              aggregated = aggregated || updated;
            } catch {
              continue;
            }
          }
          if (aggregated) {
            this.logger.info(`[chatgpt][oauth] persisted refreshed tokens from logs session=${opts.sessionId} identity=${identityId}`);
          }
        }
      } finally {
        this.chatgptRefreshPaths.delete(opts.sessionId);
        this.chatgptLogPaths.delete(opts.sessionId);
      }
      if (this.sessionManager) {
        try {
          await this.sessionManager.drainSession(opts.sessionId);
        } catch (e) {
          this.logger.warn(`[cloud] final drain failed session=${opts.sessionId}: ${String(e)}`);
        }
      }

      const pending = await listPendingMessages(this.db, opts.sessionId, 100);
      if (pending.length > 0) {
        const next = pending[0]!;
        const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", opts.sessionId).executeTakeFirst();
        if (session) {
          try {
            const resumed = await this.resumeCloudSession(session as SessionRow, next.message_text);
            if (resumed === "resumed") {
              await consumePendingMessages(this.db, [next.id]);
              this.logger.info(
                `[cloud] resumed queued message session=${opts.sessionId} pending=${pending.length}`,
              );
              return;
            }
          } catch (e) {
            this.logger.warn(
              `[cloud] resume queued message failed session=${opts.sessionId}: ${String(e)}`,
            );
          }
        }
      }

      await updateSession(this.db, opts.sessionId, {
        status,
        exit_code: exitCode,
        finished_at: nowMs(),
        pid: null,
      });
      await this.handleSessionFinished(opts.sessionId, status);
      if (this.sessionManager) {
        try {
          await this.sessionManager.notifySessionFinished(opts.sessionId);
        } catch (e) {
          this.logger.warn(`[cloud] final button attach failed session=${opts.sessionId}: ${String(e)}`);
        }
      }
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
    let agentSessionId = session.codex_session_id ?? "";
    if (!agentSessionId && session.agent === "codex") {
      const resolved = await this.resolveCodexThreadIdFromOffsets(session.id);
      if (resolved) {
        agentSessionId = resolved;
        await updateSession(this.db, session.id, { codex_session_id: resolved });
      }
    }
    if (!agentSessionId) throw new Error("Session missing codex_session_id");

    try {
      this.getModalProvider().getSandbox(run.workspace_id);
    } catch {
      return "expired";
    }

    this.clearWorkspaceTermination(run.workspace_id);

    await updateSession(this.db, session.id, {
      status: "starting",
      exit_code: null,
      finished_at: null,
    });
    const normalizedProjectId = this.normalizeCloudProjectId(run);
    if (session.project_id !== normalizedProjectId) {
      await updateSession(this.db, session.id, { project_id: normalizedProjectId });
      session = { ...session, project_id: normalizedProjectId };
    }
    await updateCloudRun(this.db, run.id, { status: "running", finished_at: null, diff_patch: null, diff_summary: null });

    const workspace = this.workspaceFromId(run.workspace_id);
    const envOverrides = this.applyProxyEnv(
      await this.time(
        "env.build",
        () => this.buildAgentEnv(run.identity_id),
        `session=${session.id} identity=${run.identity_id}`,
        "debug",
      ),
      run.identity_id,
      session.agent,
    );
    const normalizedEnv = session.agent === "codex" ? this.normalizeChatgptProxyEnv(session.id, envOverrides) : envOverrides;
    let playwrightSetup: RemotePlaywrightSetup | null = null;
    if (this.isBrowserbaseEnabled()) {
      const existing = this.buildExistingBrowserbaseSetup(session.id);
      if (existing) {
        playwrightSetup = existing;
      } else {
        playwrightSetup = await this.time(
          "browserbase.create",
          () =>
            this.prepareBrowserbaseSession({
              sessionId: session.id,
              runId: run.id,
              agent: session.agent,
              projectId: session.project_id,
              projectPath: session.codex_cwd,
            }),
          `session=${session.id}`,
          "debug",
        );
      }
    } else if (this.isHyperbrowserEnabled()) {
      const existing = this.buildExistingHyperbrowserSetup(session.id);
      if (existing) {
        playwrightSetup = existing;
      } else {
        playwrightSetup = await this.time(
          "hyperbrowser.create",
          () =>
            this.prepareHyperbrowserSession({
              sessionId: session.id,
              runId: run.id,
              agent: session.agent,
              projectId: session.project_id,
              projectPath: session.codex_cwd,
            }),
          `session=${session.id}`,
          "debug",
        );
      }
    }
    try {
      const { handle, logSyncers, debug } = await this.time(
        "remote.resume",
        () =>
          this.spawnRemoteResume({
            sessionId: session.id,
            agentSessionId,
            prompt,
            cwd: session.codex_cwd,
            agent: session.agent,
            workspace,
            envOverrides: normalizedEnv,
            playwright: playwrightSetup,
          }),
        `session=${session.id} agent=${session.agent}`,
      );

      await updateSession(this.db, session.id, { pid: handle.pid ?? null, status: "running", started_at: nowMs() });

      void this.monitorRemoteSession({
        sessionId: session.id,
        handle,
        logSyncers,
        workspace,
        debug,
      });

      return "resumed";
    } catch (e) {
      await this.releaseBrowserbaseForSession(session.id, "resume_failed").catch(() => {});
      await this.releaseHyperbrowserForSession(session.id, "resume_failed").catch(() => {});
      throw e;
    }
  }

  async restartCloudSession(session: SessionRow, prompt: string): Promise<"restarted" | "not_cloud"> {
    if (this.provider.id !== "modal") return "not_cloud";
    const run = await getCloudRunBySession(this.db, session.id);
    if (!run || run.provider !== "modal") return "not_cloud";

    await this.releaseBrowserbaseForSession(session.id, "sandbox_expired").catch(() => {});
    await this.releaseHyperbrowserForSession(session.id, "sandbox_expired").catch(() => {});

    const runRepos = await this.db
      .selectFrom("cloud_run_repos")
      .selectAll()
      .where("run_id", "=", run.id)
      .execute();

    const hasRepos = runRepos.length > 0;
    const primaryRepoId = hasRepos ? run.primary_repo_id ?? runRepos[0]!.repo_id : null;
    let setupSpec = primaryRepoId ? await getLatestSetupSpec(this.db, primaryRepoId) : null;
    let setupSnapshotId: string | null = setupSpec?.snapshot_id ?? run.snapshot_id ?? null;
    let usedSnapshot = false;
    let workspace: CloudWorkspace;
    const snapshotId = setupSnapshotId;
    if (snapshotId && this.provider.id === "modal") {
      try {
        workspace = await this.time(
          "workspace.create",
          () => this.getModalProvider().createWorkspaceFromSnapshot(snapshotId),
          `source=snapshot id=${snapshotId}`,
        );
        usedSnapshot = true;
        this.logger.info(
          `[cloud] workspace restored id=${workspace.id} snapshot=${snapshotId} run=${run.id} session=${session.id}`,
        );
      } catch (e) {
        this.logger.warn(
          `[cloud] snapshot restore failed (${snapshotId}): ${String(e)}; falling back to base image`,
        );
        workspace = await this.time(
          "workspace.create",
          () => this.provider.createWorkspace({ prefix: "cloud" }),
          `source=base provider=${this.provider.id}`,
        );
      }
    } else {
      workspace = await this.time(
        "workspace.create",
        () => this.provider.createWorkspace({ prefix: "cloud" }),
        `source=base provider=${this.provider.id}`,
      );
    }
    if (!usedSnapshot) {
      this.logger.info(`[cloud] workspace recreated id=${workspace.id} run=${run.id} session=${session.id}`);
    }
    if (this.provider.id === "modal") {
      void this.time(
        "modal.secrets.bashrc",
        () => this.injectModalSecretsBashrc(run.identity_id, workspace),
        `workspace=${workspace.id}`,
      ).catch((e) => {
        this.logger.warn(`[cloud][modal] failed to inject secrets into .bashrc: ${String(e)}`);
      });
    }

    try {
      const repoMounts = hasRepos
        ? runRepos
            .map((r) => ({
              repoId: r.repo_id,
              mountPath: r.mount_path,
              absPath: this.joinWorkspacePath(workspace.rootPath, r.mount_path),
            }))
            .sort((a, b) => {
              if (a.repoId === primaryRepoId && b.repoId !== primaryRepoId) return -1;
              if (b.repoId === primaryRepoId && a.repoId !== primaryRepoId) return 1;
              return a.mountPath.localeCompare(b.mountPath);
            })
        : [];

      if (repoMounts.length > 0) {
        for (const mount of repoMounts) {
          const { repo, clone } = await this.time(
            "repo.resolve",
            () => this.resolveCloneInfo(mount.repoId),
            `repoId=${mount.repoId}`,
            "debug",
          );
          if (usedSnapshot) {
            this.logger.info(`[cloud] refresh repo=${repo.name} url=${clone.redacted}`);
            await this.time(
              "repo.refresh",
              () => this.refreshRepo({ workspace, absPath: mount.absPath, cloneUrl: clone.url }),
              `repo=${repo.name}`,
            );
          } else {
            this.logger.info(`[cloud] clone repo=${repo.name} url=${clone.redacted}`);
            await this.time(
              "repo.clone",
              () => this.cloneRepo({ workspace, absPath: mount.absPath, cloneUrl: clone.url }),
              `repo=${repo.name}`,
            );
          }
        }
      }

      if (repoMounts.length > 0 && !setupSpec) {
        const specPath = path.join(repoMounts[0]!.absPath, "tintin-setup.yml");
        const specText = await readFile(specPath, "utf8").catch(() => null);
        if (specText && primaryRepoId) {
          const hash = hashSetupSpec(specText);
          await putSetupSpec(this.db, { repoId: primaryRepoId, ymlBlob: specText, hash });
          setupSpec = await getLatestSetupSpec(this.db, primaryRepoId);
        }
      }
      if (setupSpec && !usedSnapshot && repoMounts.length > 0) {
        const spec = parseSetupSpec(setupSpec.yml_blob);
        const secrets = await this.time(
          "secrets.load",
          () => this.loadSecretsMap(run.identity_id),
          `identity=${run.identity_id}`,
          "debug",
        );
        const envVars: Record<string, string> = {};
        for (const entry of spec.env ?? []) {
          if (!entry.value) continue;
          envVars[entry.name] = interpolateSecrets(entry.value, (name) => secrets.get(name) ?? null);
        }

        if (spec.files && spec.files.length > 0) {
          const files = spec.files
            .filter((f) => f.content !== undefined)
            .map((f) => ({ path: f.path, content: f.content ?? "", mode: f.mode }));
          if (files.length > 0) {
            await this.time(
              "setupSpec.uploadFiles",
              () => this.provider.uploadFiles(workspace, files),
              `files=${files.length}`,
            );
          }
        }

        const mainRepoPath = repoMounts[0]!.absPath;
        const commands = spec.commands ?? [];
        if (commands.length > 0) {
          this.logger.info(`[cloud] applying setup spec commands count=${commands.length}`);
          await this.time(
            "setupSpec.runCommands",
            () => this.provider.runCommands({ workspace, cwd: mainRepoPath, commands, env: envVars }),
            `commands=${commands.length}`,
          );
        }
        setupSnapshotId = await this.time("setupSpec.snapshot", () => this.provider.snapshotWorkspace(workspace, "setup"));
        if (setupSpec.id) {
          await updateSetupSpecSnapshot(this.db, { id: setupSpec.id, snapshotId: setupSnapshotId });
        }
      } else if (usedSnapshot && setupSpec?.snapshot_id) {
        setupSnapshotId = setupSpec.snapshot_id;
      } else if (usedSnapshot && setupSnapshotId) {
        if (setupSpec?.id) {
          await updateSetupSpecSnapshot(this.db, { id: setupSpec.id, snapshotId: setupSnapshotId });
        }
      }

      const mainRepoPath = repoMounts.length > 0 ? repoMounts[0]!.absPath : workspace.rootPath;
      await updateSession(this.db, session.id, {
        status: "starting",
        exit_code: null,
        finished_at: null,
        pid: null,
        codex_session_id: null,
        browserbase_session_id: null,
        hyperbrowser_session_id: null,
        started_at: null,
        project_path_resolved: mainRepoPath,
        codex_cwd: mainRepoPath,
      });
      await deleteSessionOffsets(this.db, session.id);

      const envOverrides = this.applyProxyEnv(
        await this.time(
          "env.build",
          () => this.buildAgentEnv(run.identity_id),
          `session=${session.id} identity=${run.identity_id}`,
          "debug",
        ),
        run.identity_id,
        session.agent,
      );
      let playwrightSetup: RemotePlaywrightSetup | null = null;
      if (this.isBrowserbaseEnabled()) {
        playwrightSetup = await this.time(
          "browserbase.create",
          () =>
            this.prepareBrowserbaseSession({
              sessionId: session.id,
              runId: run.id,
              agent: session.agent,
              projectId: session.project_id,
              projectPath: mainRepoPath,
            }),
          `session=${session.id}`,
          "debug",
        );
      } else if (this.isHyperbrowserEnabled()) {
        playwrightSetup = await this.time(
          "hyperbrowser.create",
          () =>
            this.prepareHyperbrowserSession({
              sessionId: session.id,
              runId: run.id,
              agent: session.agent,
              projectId: session.project_id,
              projectPath: mainRepoPath,
            }),
          `session=${session.id}`,
          "debug",
        );
      }
      const { handle, agentSessionId, logSyncers, debug } = await this.time(
        "remote.spawnAgent",
        () =>
          this.spawnRemoteAgent({
            sessionId: session.id,
            prompt,
            cwd: mainRepoPath,
            agent: session.agent,
            workspace,
            envOverrides,
            playwright: playwrightSetup,
          }),
        `session=${session.id} agent=${session.agent}`,
      );

      await updateSession(this.db, session.id, {
        pid: handle.pid ?? null,
        status: "running",
        started_at: nowMs(),
        ...(agentSessionId ? { codex_session_id: agentSessionId } : {}),
      });
      await updateCloudRun(this.db, run.id, {
        status: "running",
        workspace_id: workspace.id,
        started_at: nowMs(),
        finished_at: null,
        diff_patch: null,
        diff_summary: null,
        snapshot_id: setupSnapshotId ?? run.snapshot_id ?? null,
        session_id: session.id,
      });

      void this.monitorRemoteSession({
        sessionId: session.id,
        handle,
        logSyncers,
        workspace,
        debug,
      });

      return "restarted";
    } catch (e) {
      this.logger.warn(`[cloud] failed to restart session=${session.id}: ${String(e)}`);
      await this.releaseBrowserbaseForSession(session.id, "restart_failed").catch(() => {});
      await this.releaseHyperbrowserForSession(session.id, "restart_failed").catch(() => {});
      await updateSession(this.db, session.id, { status: "error", finished_at: nowMs(), pid: null });
      await updateCloudRun(this.db, run.id, { status: "error", finished_at: nowMs() });
      await this.provider.terminateWorkspace(workspace).catch(() => {});
      throw e;
    }
  }

  private isValidBranchName(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("-")) return false;
    if (trimmed.endsWith("/") || trimmed.endsWith(".lock")) return false;
    if (/[~^:\?\*\[\]\s]/.test(trimmed)) return false;
    if (trimmed.includes("..") || trimmed.includes("@{") || trimmed.includes("//")) return false;
    return true;
  }

  private parseGithubRepoSlug(url: string): { owner: string; repo: string } | null {
    const normalized = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
    const match = normalized.match(/github\.com[:/](.+?)\/([^/]+)$/i);
    if (!match) return null;
    return { owner: match[1]!, repo: match[2]! };
  }

  private async resolveRunRepo(sessionId: string): Promise<{
    run: CloudRunsTable;
    repo: ReposTable;
    workspace: CloudWorkspace;
    cwd: string;
  }> {
    const run = await getCloudRunBySession(this.db, sessionId);
    if (!run) throw new Error(`Cloud run not found for session ${sessionId}`);
    const runRepos = await this.db.selectFrom("cloud_run_repos").selectAll().where("run_id", "=", run.id).execute();
    if (runRepos.length === 0) throw new Error(`Cloud run ${run.id} has no repos`);
    const primaryRepoId = run.primary_repo_id ?? runRepos[0]!.repo_id;
    const mount = runRepos.find((r) => r.repo_id === primaryRepoId) ?? runRepos[0]!;
    const repo = await this.db.selectFrom("repos").selectAll().where("id", "=", mount.repo_id).executeTakeFirst();
    if (!repo) throw new Error(`Repo not found for run ${run.id}`);
    const workspace = this.workspaceFromId(run.workspace_id);
    const cwd = path.join(workspace.rootPath, mount.mount_path);
    return { run, repo, workspace, cwd };
  }

  async getVscodeUrl(sessionId: string, timeoutMs = 8_000): Promise<string | null> {
    this.ensureEnabled();
    if (this.provider.id !== "modal") return null;
    const run = await getCloudRunBySession(this.db, sessionId);
    if (!run) return null;
    let sandbox: Sandbox;
    try {
      sandbox = this.getModalProvider().getSandbox(run.workspace_id);
    } catch {
      return null;
    }
    try {
      const tunnels = (await sandbox.tunnels(timeoutMs)) as Record<string | number, { url?: string } | undefined>;
      const vsCode = tunnels[8080];
      const url = vsCode?.url;
      return typeof url === "string" && url.trim().length > 0 ? url : null;
    } catch (e) {
      this.logger.debug(`[cloud][modal] vscode tunnel lookup failed session=${sessionId}: ${String(e)}`);
      return null;
    }
  }

  async stopSandboxForSession(sessionId: string): Promise<void> {
    this.ensureEnabled();
    const run = await getCloudRunBySession(this.db, sessionId);
    if (!run) throw new Error("Cloud run not found.");
    this.clearWorkspaceTermination(run.workspace_id);
    const session = await this.db.selectFrom("sessions").select(["status"]).where("id", "=", sessionId).executeTakeFirst();
    if (session && (session.status === "running" || session.status === "starting")) {
      this.forcedStopSessions.add(sessionId);
    }
    await this.releaseBrowserbaseForSession(sessionId, "stop_sandbox").catch(() => {});
    await this.releaseHyperbrowserForSession(sessionId, "stop_sandbox").catch(() => {});
    const workspace = this.workspaceFromId(run.workspace_id);
    try {
      const alreadySnapshotted = await this.hasSnapshotForRun(run.id, workspace.id);
      if (alreadySnapshotted) {
        this.logger.info(`[cloud][stop] skip snapshot (already exists) run=${run.id} workspace=${workspace.id}`);
      } else {
        this.logger.info(`[cloud][stop] snapshot before terminate run=${run.id} workspace=${workspace.id}`);
        await this.snapshotWithRetries({
          runId: run.id,
          workspaceId: workspace.id,
          sourceStatus: "killed",
          note: "user stop",
          retries: 1,
        });
      }
    } catch (e) {
      this.logger.warn(`[cloud][snapshot] stop snapshot failed run=${run.id} workspace=${workspace.id}: ${String(e)}`);
    }
    try {
      this.logger.info(`[cloud][stop] terminating workspace id=${workspace.id} run=${run.id}`);
      await this.provider.terminateWorkspace(workspace);
      await this.deleteWorkspaceLeaseWithRetry(workspace.id, "stop");
      await updateCloudRun(this.db, run.id, { status: "killed", finished_at: nowMs() });
      this.logger.info(`[cloud][stop] terminated workspace id=${workspace.id} run=${run.id}`);
    } catch (e) {
      this.logger.warn(`[cloud][workspace] stop terminate failed id=${workspace.id}: ${String(e)}`);
    }
    this.clearWorkspaceTermination(workspace.id);
  }

  async commitAndPushRun(opts: {
    sessionId: string;
    commitMessage: string;
    branchName: string;
    gitUserName?: string | null;
    gitUserEmail?: string | null;
  }): Promise<{ runId: string; branchName: string; repo: ReposTable }> {
    this.ensureEnabled();
    const { run, repo, workspace, cwd } = await this.resolveRunRepo(opts.sessionId);
    const message = (opts.commitMessage ?? "").trim();
    if (!message) throw new Error("Commit message is empty.");
    const branchName = (opts.branchName ?? "").trim();
    if (!this.isValidBranchName(branchName)) throw new Error(`Invalid branch name: ${branchName}`);
    const authorName = (opts.gitUserName ?? "").trim() || "tintin[bot]";
    const authorEmail = (opts.gitUserEmail ?? "").trim() || "tintin@fuzz.land";
    const singleLine = message.split(/\r?\n/)[0]?.trim() || message;
    await this.provider.runCommands({
      workspace,
      cwd,
      commands: [
        `git config user.name ${shellQuote(authorName)}`,
        `git config user.email ${shellQuote(authorEmail)}`,
        `git checkout -B ${shellQuote(branchName)}`,
        "git add -A",
        `git commit -m ${shellQuote(singleLine)}`,
        `git push -u origin ${shellQuote(branchName)}`,
      ],
    });
    return { runId: run.id, branchName, repo };
  }

  async createPullRequestForRun(opts: {
    sessionId: string;
    branchName: string;
    title: string;
    body?: string | null;
  }): Promise<{ url: string | null; number: number | null; base: string }> {
    this.ensureEnabled();
    if (!this.config.cloud?.github_app) throw new Error("GitHub App is not configured.");
    const { repo } = await this.resolveRunRepo(opts.sessionId);
    if (repo.provider !== "github") throw new Error("Pull request creation only supported for GitHub repos.");
    const connection = await this.db.selectFrom("connections").selectAll().where("id", "=", repo.connection_id).executeTakeFirst();
    if (!connection) throw new Error("Repo connection not found.");
    if (connection.type !== "github_app") throw new Error("GitHub App connection not found.");
    const slug = this.parseGithubRepoSlug(repo.url);
    if (!slug) throw new Error("Unable to parse GitHub repo URL.");
    const base = repo.default_branch?.trim() || "main";
    const pr = await createGithubPullRequest({
      db: this.db,
      config: this.config.cloud.github_app,
      secretKey: this.config.cloud.secrets_key,
      connection,
      owner: slug.owner,
      repo: slug.repo,
      title: opts.title,
      head: opts.branchName,
      base,
      body: opts.body ?? null,
    });
    return { url: pr.url ?? null, number: pr.number ?? null, base };
  }

  async handleSessionFinished(sessionId: string, status: SessionStatus): Promise<void> {
    const run = await getCloudRunBySession(this.db, sessionId);
    if (!run) return;
    if (run.status === "killed") {
      this.logger.info(`[cloud] session finished but run already killed run=${run.id} session=${sessionId}`);
      return;
    }
    const workspace = this.workspaceFromId(run.workspace_id);
    const mount = await this.db
      .selectFrom("cloud_run_repos")
      .selectAll()
      .where("run_id", "=", run.id)
      .where("repo_id", "=", run.primary_repo_id ?? "")
      .executeTakeFirst();
    const cwd = mount ? path.join(workspace.rootPath, mount.mount_path) : workspace.rootPath;
    let diff: { diff: string; summary: string } | null = null;
    if (run.primary_repo_id) {
      try {
        diff = await this.provider.pullDiff({ workspace, cwd });
      } catch (e) {
        this.logger.warn(`[cloud] diff pull failed session=${sessionId}: ${String(e)}`);
      }
    } else {
      diff = { diff: "", summary: "Playground run (no repo attached)." };
    }
    const maxPatch = 200_000;
    const patch = diff ? (diff.diff.length > maxPatch ? null : diff.diff) : null;
    const summary = diff ? diff.summary : null;
    const cloudStatus = status === "finished" ? "finished" : status === "killed" ? "killed" : "error";
    await updateCloudRun(this.db, run.id, {
      status: cloudStatus,
      diff_patch: patch,
      diff_summary: summary,
      finished_at: nowMs(),
    });
    if (this.provider.id === "modal") {
      void (async () => {
        const alreadySnapshotted = await this.hasSnapshotForRun(run.id, run.workspace_id);
        if (alreadySnapshotted) {
          this.logger.info(`[cloud][snapshot] skip snapshot (already exists) run=${run.id} workspace=${run.workspace_id}`);
          return;
        }
        await this.snapshotWithRetries({
          runId: run.id,
          workspaceId: run.workspace_id,
          sourceStatus: cloudStatus,
          note: summary ?? "",
          retries: 2,
        });
      })();
    }
    this.agentLogPaths.delete(sessionId);
    if (this.provider.id !== "local") {
      void this.scheduleWorkspaceTermination(run.workspace_id, run.identity_id, run.id, sessionId);
    }
  }
}
