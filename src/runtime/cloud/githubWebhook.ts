import crypto from "node:crypto";
import type { CloudSection } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import { nowMs, timingSafeEqualString } from "../util.js";
import { ensureGithubAppTokenForInstallation } from "./githubApp.js";
import { fetchGithubInstallationRepos, type RemoteRepo } from "./repos.js";
import {
  deleteGithubInstallationToken,
  replaceGithubInstallationRepos,
  upsertGithubInstallation,
  upsertGithubInstallationIdentity,
  upsertRepo,
} from "./store.js";

const WEBHOOK_MAX_BODY_BYTES = 2_000_000;
const WEBHOOK_POLL_INTERVAL_MS = 10_000;
const WEBHOOK_BATCH_SIZE = 25;
const WEBHOOK_MAX_ATTEMPTS = 8;
const WEBHOOK_RETRY_BASE_MS = 5_000;
const WEBHOOK_RETRY_MAX_MS = 10 * 60 * 1000;
const WEBHOOK_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

type GithubWebhookMetadata = {
  action: string | null;
  installationId: string | null;
  repoId: string | null;
  appId: string | null;
  accountLogin: string | null;
  accountType: string | null;
  permissionsJson: string | null;
};

type GithubWebhookErrorState = {
  attempts: number;
  last_error?: string;
  last_attempt_at?: number;
  next_retry_at?: number;
  processing_started_at?: number;
};

type GithubWebhookProcessingResult = {
  processed: number;
  skipped: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  return null;
}

function readId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function extractGithubWebhookMetadata(payload: unknown): GithubWebhookMetadata {
  if (!isRecord(payload)) {
    return {
      action: null,
      installationId: null,
      repoId: null,
      appId: null,
      accountLogin: null,
      accountType: null,
      permissionsJson: null,
    };
  }
  const action = readString(payload.action);
  const appId = readId(payload.app_id);

  const installationRaw = isRecord(payload.installation) ? payload.installation : null;
  const installationId = readId(installationRaw?.id) ?? readId(payload.installation_id);
  const accountRaw = installationRaw && isRecord(installationRaw.account) ? installationRaw.account : null;
  const accountLogin = readString(accountRaw?.login);
  const accountType = readString(accountRaw?.type);
  const permissionsRaw = installationRaw && isRecord(installationRaw.permissions) ? installationRaw.permissions : null;
  const permissionsJson = permissionsRaw ? JSON.stringify(permissionsRaw) : null;

  const repositoryRaw = isRecord(payload.repository) ? payload.repository : null;
  let repoId = readId(repositoryRaw?.id);
  if (!repoId) {
    const addedRaw = payload.repositories_added;
    if (Array.isArray(addedRaw) && addedRaw.length > 0 && isRecord(addedRaw[0])) {
      repoId = readId(addedRaw[0]?.id);
    }
  }

  return {
    action,
    installationId,
    repoId,
    appId,
    accountLogin,
    accountType,
    permissionsJson,
  };
}

export function githubWebhookAppIdMatches(payloadAppId: string | null, configAppId: string): boolean {
  if (!payloadAppId) return true;
  const payloadTrimmed = payloadAppId.trim();
  const configTrimmed = configAppId.trim();
  const payloadNum = Number(payloadTrimmed);
  const configNum = Number(configTrimmed);
  if (Number.isFinite(payloadNum) && Number.isFinite(configNum)) {
    return payloadNum === configNum;
  }
  return payloadTrimmed === configTrimmed;
}

function parseErrorState(raw: string | null): GithubWebhookErrorState {
  if (!raw) return { attempts: 0 };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const attempts = typeof parsed.attempts === "number" && Number.isFinite(parsed.attempts) ? parsed.attempts : 0;
    return {
      attempts,
      last_error: readString(parsed.last_error) ?? undefined,
      last_attempt_at: typeof parsed.last_attempt_at === "number" ? parsed.last_attempt_at : undefined,
      next_retry_at: typeof parsed.next_retry_at === "number" ? parsed.next_retry_at : undefined,
      processing_started_at: typeof parsed.processing_started_at === "number" ? parsed.processing_started_at : undefined,
    };
  } catch {
    return { attempts: 0, last_error: raw };
  }
}

function serializeErrorState(state: GithubWebhookErrorState): string {
  return JSON.stringify(state);
}

function computeRetryDelayMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  const delay = WEBHOOK_RETRY_BASE_MS * Math.pow(2, exp);
  return Math.min(delay, WEBHOOK_RETRY_MAX_MS);
}

function shouldReclaimProcessing(state: GithubWebhookErrorState, now: number): boolean {
  if (!state.processing_started_at) return false;
  return now - state.processing_started_at > WEBHOOK_PROCESSING_TIMEOUT_MS;
}

export function githubWebhookMaxBodyBytes(): number {
  return WEBHOOK_MAX_BODY_BYTES;
}

export function githubWebhookPollIntervalMs(): number {
  return WEBHOOK_POLL_INTERVAL_MS;
}

export function verifyGithubWebhookSignature(opts: {
  body: string;
  signature256: string | null;
  signature: string | null;
  secret: string;
}): boolean {
  const secret = opts.secret.trim();
  if (!secret) return false;
  const signature256Raw = opts.signature256?.trim() ?? "";
  const signatureRaw = opts.signature?.trim() ?? "";
  const signature256 = signature256Raw.toLowerCase();
  const signature = signatureRaw.toLowerCase();
  if (signature256.startsWith("sha256=")) {
    const digest = crypto.createHmac("sha256", secret).update(opts.body, "utf8").digest("hex");
    const expected = `sha256=${digest}`;
    if (timingSafeEqualString(expected, signature256)) return true;
  }
  if (signature.startsWith("sha1=")) {
    const digest = crypto.createHmac("sha1", secret).update(opts.body, "utf8").digest("hex");
    const expected = `sha1=${digest}`;
    if (timingSafeEqualString(expected, signature)) return true;
  }
  return false;
}

export function parseGithubWebhookPayload(payload: unknown): GithubWebhookMetadata {
  return extractGithubWebhookMetadata(payload);
}

export async function recordGithubWebhookEvent(opts: {
  db: Db;
  deliveryId: string;
  event: string;
  action: string | null;
  installationId: string | null;
  repoId: string | null;
  headersJson: string;
  payloadJson: string;
}): Promise<"inserted" | "duplicate"> {
  const now = nowMs();
  try {
    await opts.db
      .insertInto("github_webhook_events")
      .values({
        delivery_id: opts.deliveryId,
        event: opts.event,
        action: opts.action,
        installation_id: opts.installationId,
        repo_id: opts.repoId,
        headers_json: opts.headersJson,
        payload_json: opts.payloadJson,
        received_at: now,
        processed_at: null,
        status: "received",
        error: null,
      })
      .execute();
    return "inserted";
  } catch (err) {
    const msg = String(err).toLowerCase();
    if (msg.includes("unique") || msg.includes("duplicate")) return "duplicate";
    throw err;
  }
}

async function markGithubWebhookProcessing(db: Db, deliveryId: string, state: GithubWebhookErrorState, now: number): Promise<boolean> {
  const nextState: GithubWebhookErrorState = { ...state, processing_started_at: now };
  const res = await db
    .updateTable("github_webhook_events")
    .set({ status: "processing", error: serializeErrorState(nextState) })
    .where("delivery_id", "=", deliveryId)
    .where("processed_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("status", "is", null),
        eb("status", "=", "received"),
        eb("status", "=", "retry"),
        eb("status", "=", "processing"),
      ]),
    )
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

async function markGithubWebhookProcessed(db: Db, deliveryId: string, status: string, now: number): Promise<void> {
  await db
    .updateTable("github_webhook_events")
    .set({ status, processed_at: now, error: null })
    .where("delivery_id", "=", deliveryId)
    .execute();
}

async function markGithubWebhookFailed(
  db: Db,
  deliveryId: string,
  state: GithubWebhookErrorState,
  err: unknown,
  now: number,
): Promise<void> {
  const attempts = Math.max(0, state.attempts) + 1;
  if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
    const finalState: GithubWebhookErrorState = {
      attempts,
      last_error: String(err),
      last_attempt_at: now,
    };
    await db
      .updateTable("github_webhook_events")
      .set({ status: "dead", processed_at: now, error: serializeErrorState(finalState) })
      .where("delivery_id", "=", deliveryId)
      .execute();
    return;
  }
  const nextRetryAt = now + computeRetryDelayMs(attempts);
  const nextState: GithubWebhookErrorState = {
    attempts,
    last_error: String(err),
    last_attempt_at: now,
    next_retry_at: nextRetryAt,
  };
  await db
    .updateTable("github_webhook_events")
    .set({ status: "retry", processed_at: null, error: serializeErrorState(nextState) })
    .where("delivery_id", "=", deliveryId)
    .execute();
}

async function reclaimStaleProcessing(db: Db, logger: Logger, now: number): Promise<void> {
  const rows = await db
    .selectFrom("github_webhook_events")
    .select(["delivery_id", "error"])
    .where("processed_at", "is", null)
    .where("status", "=", "processing")
    .orderBy("received_at", "asc")
    .execute();
  for (const row of rows) {
    const state = parseErrorState(row.error);
    if (!shouldReclaimProcessing(state, now)) continue;
    const attempts = Math.max(0, state.attempts) + 1;
    const nextRetryAt = now + computeRetryDelayMs(attempts);
    const nextState: GithubWebhookErrorState = {
      attempts,
      last_error: "processing timeout",
      last_attempt_at: now,
      next_retry_at: nextRetryAt,
    };
    await db
      .updateTable("github_webhook_events")
      .set({ status: "retry", processed_at: null, error: serializeErrorState(nextState) })
      .where("delivery_id", "=", row.delivery_id)
      .execute();
    logger.warn(`[github_webhook] reclaimed stale delivery_id=${row.delivery_id}`);
  }
}

async function reconcileGithubInstallationRepos(opts: {
  db: Db;
  cloud: CloudSection;
  installationId: string;
  forceRefresh?: boolean;
}): Promise<RemoteRepo[]> {
  const cfg = opts.cloud.github_app;
  if (!cfg) throw new Error("Missing [cloud].github_app configuration.");
  const token = await ensureGithubAppTokenForInstallation({
    db: opts.db,
    config: cfg,
    secretKey: opts.cloud.secrets_key,
    installationId: opts.installationId,
    forceRefresh: opts.forceRefresh,
  });
  const repos = await fetchGithubInstallationRepos({ token: token.token, apiBaseUrl: cfg.api_base_url });
  await replaceGithubInstallationRepos(opts.db, {
    installationId: opts.installationId,
    repos: repos.map((r) => ({
      providerRepoId: r.providerRepoId,
      name: r.name,
      url: r.url,
      defaultBranch: r.defaultBranch,
      archived: r.archived,
      private: r.private,
      permissionsJson: r.permissionsJson ?? null,
    })),
  });
  const connections = await opts.db
    .selectFrom("connections")
    .selectAll()
    .where("type", "=", "github_app")
    .where("installation_id", "=", opts.installationId)
    .execute();
  for (const conn of connections) {
    await upsertGithubInstallationIdentity(opts.db, {
      installationId: opts.installationId,
      identityId: conn.identity_id,
    });
    for (const repo of repos) {
      await upsertRepo(opts.db, {
        connectionId: conn.id,
        provider: "github",
        providerRepoId: repo.providerRepoId,
        name: repo.name,
        url: repo.url,
        defaultBranch: repo.defaultBranch ?? null,
        fingerprint: null,
      });
    }
  }
  return repos;
}

async function clearInstallationRepos(opts: { db: Db; installationId: string }) {
  await replaceGithubInstallationRepos(opts.db, { installationId: opts.installationId, repos: [] });
}

async function clearGithubAppConnections(opts: { db: Db; installationId: string }) {
  const now = nowMs();
  const connections = await opts.db
    .selectFrom("connections")
    .select(["id"])
    .where("type", "=", "github_app")
    .where("installation_id", "=", opts.installationId)
    .execute();
  if (connections.length === 0) return;
  const connectionIds = connections.map((row) => row.id);
  const repoRows = await opts.db
    .selectFrom("repos")
    .select(["id"])
    .where("connection_id", "in", connectionIds)
    .execute();
  const repoIds = repoRows.map((row) => row.id);
  if (repoIds.length > 0) {
    await opts.db
      .updateTable("identities")
      .set({ active_repo_id: null, updated_at: now })
      .where("active_repo_id", "in", repoIds)
      .execute();
  }
  await opts.db
    .updateTable("connections")
    .set({
      installation_id: null,
      access_token: "github_app",
      refresh_token: null,
      scope: null,
      token_expires_at: null,
      metadata_json: null,
      updated_at: now,
    })
    .where("id", "in", connectionIds)
    .execute();
}

async function handleGithubWebhookEvent(opts: {
  db: Db;
  cloud: CloudSection;
  logger: Logger;
  row: {
    delivery_id: string;
    event: string;
    action: string | null;
    installation_id: string | null;
    payload_json: string;
  };
}): Promise<string> {
  const cfg = opts.cloud.github_app;
  if (!cfg) throw new Error("Missing [cloud].github_app configuration.");
  const payload = JSON.parse(opts.row.payload_json) as unknown;
  const meta = extractGithubWebhookMetadata(payload);
  const installationId = meta.installationId ?? opts.row.installation_id;
  const action = meta.action ?? opts.row.action;

  switch (opts.row.event) {
    case "ping":
      return "processed";
    case "installation": {
      if (!installationId) throw new Error("Installation webhook missing installation_id");
      const status = (() => {
        if (action === "deleted") return "deleted";
        if (action === "suspend") return "suspended";
        return "active";
      })();
      await upsertGithubInstallation(opts.db, {
        installationId,
        appId: cfg.app_id,
        accountLogin: meta.accountLogin ?? null,
        accountType: meta.accountType ?? null,
        status,
        permissionsJson: meta.permissionsJson ?? null,
      });
      if (action === "deleted") {
        await deleteGithubInstallationToken(opts.db, installationId);
        await clearInstallationRepos({ db: opts.db, installationId });
        await opts.db.deleteFrom("github_installation_identities").where("installation_id", "=", installationId).execute();
        await clearGithubAppConnections({ db: opts.db, installationId });
        return "processed";
      }
      if (action === "suspend") {
        await deleteGithubInstallationToken(opts.db, installationId);
        await clearInstallationRepos({ db: opts.db, installationId });
        return "processed";
      }
      await reconcileGithubInstallationRepos({
        db: opts.db,
        cloud: opts.cloud,
        installationId,
        forceRefresh: action === "created" || action === "unsuspend" || action === "new_permissions_accepted",
      });
      return "processed";
    }
    case "installation_repositories": {
      if (!installationId) throw new Error("Installation repositories webhook missing installation_id");
      await upsertGithubInstallation(opts.db, {
        installationId,
        appId: cfg.app_id,
        accountLogin: meta.accountLogin ?? null,
        accountType: meta.accountType ?? null,
        status: "active",
        permissionsJson: meta.permissionsJson ?? null,
      });
      await reconcileGithubInstallationRepos({ db: opts.db, cloud: opts.cloud, installationId });
      return "processed";
    }
    case "repository": {
      if (!installationId) throw new Error("Repository webhook missing installation_id");
      await upsertGithubInstallation(opts.db, {
        installationId,
        appId: cfg.app_id,
        accountLogin: meta.accountLogin ?? null,
        accountType: meta.accountType ?? null,
        status: "active",
        permissionsJson: meta.permissionsJson ?? null,
      });
      await reconcileGithubInstallationRepos({ db: opts.db, cloud: opts.cloud, installationId });
      return "processed";
    }
    default: {
      opts.logger.debug(`[github_webhook] ignoring event=${opts.row.event} delivery_id=${opts.row.delivery_id}`);
      return "ignored";
    }
  }
}

export async function processPendingGithubWebhookEvents(opts: {
  db: Db;
  cloud: CloudSection;
  logger: Logger;
}): Promise<GithubWebhookProcessingResult> {
  if (!opts.cloud.github_app) return { processed: 0, skipped: 0 };
  const now = nowMs();
  await reclaimStaleProcessing(opts.db, opts.logger, now);
  const rows = await opts.db
    .selectFrom("github_webhook_events")
    .select(["delivery_id", "event", "action", "installation_id", "repo_id", "payload_json", "status", "error"])
    .where("processed_at", "is", null)
    .where((eb) =>
      eb.or([eb("status", "is", null), eb("status", "=", "received"), eb("status", "=", "retry"), eb("status", "=", "processing")]),
    )
    .orderBy("received_at", "asc")
    .limit(WEBHOOK_BATCH_SIZE)
    .execute();
  let processed = 0;
  let skipped = 0;
  for (const row of rows) {
    const state = parseErrorState(row.error);
    if (row.status === "retry" && state.next_retry_at && state.next_retry_at > now) {
      skipped++;
      continue;
    }
    if (row.status === "processing" && !shouldReclaimProcessing(state, now)) {
      skipped++;
      continue;
    }
    const claimed = await markGithubWebhookProcessing(opts.db, row.delivery_id, state, now);
    if (!claimed) {
      skipped++;
      continue;
    }
    try {
      const status = await handleGithubWebhookEvent({
        db: opts.db,
        cloud: opts.cloud,
        logger: opts.logger,
        row: {
          delivery_id: row.delivery_id,
          event: row.event,
          action: row.action,
          installation_id: row.installation_id,
          payload_json: row.payload_json,
        },
      });
      await markGithubWebhookProcessed(opts.db, row.delivery_id, status, nowMs());
      opts.logger.info(
        `[github_webhook] processed event=${row.event} action=${row.action ?? "-"} delivery_id=${row.delivery_id} installation_id=${row.installation_id ?? "-"} repo_id=${row.repo_id ?? "-"} status=${status}`,
      );
      processed++;
    } catch (err) {
      await markGithubWebhookFailed(opts.db, row.delivery_id, state, err, nowMs());
      opts.logger.warn(`[github_webhook] process failed delivery_id=${row.delivery_id}: ${String(err)}`);
    }
  }
  return { processed, skipped };
}

export function shouldHandleGithubWebhookEvent(config: CloudSection | null | undefined, path: string): boolean {
  if (!config?.enabled) return false;
  if (!config.github_app) return false;
  return path === config.github_app.webhook_path;
}
