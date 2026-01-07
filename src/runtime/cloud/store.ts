import crypto from "node:crypto";
import type { Db, CloudRunStatus } from "../db.js";
import { nowMs } from "../util.js";

export interface IdentityRow {
  id: string;
  platform: string;
  workspace_id: string | null;
  user_id: string;
  active_repo_id: string | null;
  onboarded_at: number | null;
  keepalive_minutes: number | null;
  message_verbosity: number | null;
  branch_name_rule: string | null;
  git_user_name: string | null;
  git_user_email: string | null;
  created_at: number;
  updated_at: number;
}

export async function getIdentity(db: Db, opts: { platform: string; workspaceId: string | null; userId: string }): Promise<IdentityRow | null> {
  const row = await db
    .selectFrom("identities")
    .selectAll()
    .where("platform", "=", opts.platform)
    .where("workspace_id", "is", opts.workspaceId)
    .where("user_id", "=", opts.userId)
    .executeTakeFirst();
  return row ?? null;
}

export async function getOrCreateIdentity(
  db: Db,
  opts: { platform: string; workspaceId: string | null; userId: string },
): Promise<IdentityRow> {
  const existing = await getIdentity(db, opts);
  if (existing) return existing;
  const now = nowMs();
  const id = crypto.randomUUID();
  const row: IdentityRow = {
    id,
    platform: opts.platform,
    workspace_id: opts.workspaceId,
    user_id: opts.userId,
    active_repo_id: null,
    onboarded_at: null,
    keepalive_minutes: null,
    message_verbosity: null,
    branch_name_rule: null,
    git_user_name: null,
    git_user_email: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto("identities").values(row).execute();
  return row;
}

export async function setIdentityKeepaliveMinutes(db: Db, identityId: string, minutes: number | null): Promise<void> {
  await db
    .updateTable("identities")
    .set({ keepalive_minutes: minutes, updated_at: nowMs() })
    .where("id", "=", identityId)
    .execute();
}

export async function setIdentityMessageVerbosity(db: Db, identityId: string, verbosity: number | null): Promise<void> {
  await db
    .updateTable("identities")
    .set({ message_verbosity: verbosity, updated_at: nowMs() })
    .where("id", "=", identityId)
    .execute();
}

export async function setIdentityBranchNameRule(db: Db, identityId: string, rule: string | null): Promise<void> {
  await db
    .updateTable("identities")
    .set({ branch_name_rule: rule, updated_at: nowMs() })
    .where("id", "=", identityId)
    .execute();
}

export async function setIdentityGitUserName(db: Db, identityId: string, name: string | null): Promise<void> {
  await db
    .updateTable("identities")
    .set({ git_user_name: name, updated_at: nowMs() })
    .where("id", "=", identityId)
    .execute();
}

export async function setIdentityGitUserEmail(db: Db, identityId: string, email: string | null): Promise<void> {
  await db
    .updateTable("identities")
    .set({ git_user_email: email, updated_at: nowMs() })
    .where("id", "=", identityId)
    .execute();
}

export async function markIdentityOnboarded(db: Db, identityId: string): Promise<void> {
  await db.updateTable("identities").set({ onboarded_at: nowMs(), updated_at: nowMs() }).where("id", "=", identityId).execute();
}

export async function setIdentityActiveRepo(db: Db, identityId: string, repoId: string | null): Promise<void> {
  await db
    .updateTable("identities")
    .set({ active_repo_id: repoId, updated_at: nowMs() })
    .where("id", "=", identityId)
    .execute();
}

export async function listConnections(db: Db, identityId: string) {
  return await db.selectFrom("connections").selectAll().where("identity_id", "=", identityId).execute();
}

export async function upsertConnection(db: Db, opts: {
  identityId: string;
  type: string;
  accessToken: string;
  refreshToken?: string | null;
  scope?: string | null;
  tokenExpiresAt?: number | null;
  metadataJson?: string | null;
}) {
  const now = nowMs();
  const existing = await db
    .selectFrom("connections")
    .selectAll()
    .where("identity_id", "=", opts.identityId)
    .where("type", "=", opts.type)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("connections")
      .set({
        access_token: opts.accessToken,
        refresh_token: opts.refreshToken ?? null,
        scope: opts.scope ?? null,
        token_expires_at: opts.tokenExpiresAt ?? null,
        metadata_json: opts.metadataJson ?? null,
        updated_at: now,
      })
      .where("id", "=", existing.id)
      .execute();
    return { ...existing, access_token: opts.accessToken, refresh_token: opts.refreshToken ?? null, scope: opts.scope ?? null };
  }
  const id = crypto.randomUUID();
  await db
    .insertInto("connections")
    .values({
      id,
      identity_id: opts.identityId,
      type: opts.type,
      access_token: opts.accessToken,
      refresh_token: opts.refreshToken ?? null,
      scope: opts.scope ?? null,
      token_expires_at: opts.tokenExpiresAt ?? null,
      metadata_json: opts.metadataJson ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return await db.selectFrom("connections").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

export async function upsertRepo(db: Db, opts: {
  connectionId: string;
  provider: string;
  providerRepoId: string | null;
  name: string;
  url: string;
  defaultBranch?: string | null;
  fingerprint?: string | null;
}) {
  const now = nowMs();
  let query = db.selectFrom("repos").selectAll().where("connection_id", "=", opts.connectionId);
  if (opts.providerRepoId) {
    query = query.where("provider_repo_id", "=", opts.providerRepoId);
  } else if (opts.fingerprint) {
    query = query.where("fingerprint", "=", opts.fingerprint);
  } else {
    query = query.where("url", "=", opts.url);
  }
  const existing = await query.executeTakeFirst();
  if (existing) {
    await db
      .updateTable("repos")
      .set({
        name: opts.name,
        url: opts.url,
        default_branch: opts.defaultBranch ?? null,
        fingerprint: opts.fingerprint ?? null,
        updated_at: now,
      })
      .where("id", "=", existing.id)
      .execute();
    return { ...existing, name: opts.name, url: opts.url };
  }
  const id = crypto.randomUUID();
  await db
    .insertInto("repos")
    .values({
      id,
      connection_id: opts.connectionId,
      provider: opts.provider,
      provider_repo_id: opts.providerRepoId,
      name: opts.name,
      url: opts.url,
      default_branch: opts.defaultBranch ?? null,
      fingerprint: opts.fingerprint ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return await db.selectFrom("repos").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

export async function listReposForIdentity(db: Db, identityId: string) {
  return await db
    .selectFrom("repos")
    .innerJoin("connections", "connections.id", "repos.connection_id")
    .select([
      "repos.id",
      "repos.provider",
      "repos.provider_repo_id",
      "repos.name",
      "repos.url",
      "repos.default_branch",
      "repos.fingerprint",
      "repos.connection_id",
      "connections.type as connection_type",
    ])
    .where("connections.identity_id", "=", identityId)
    .orderBy("repos.name", "asc")
    .execute();
}

export async function createCloudRun(db: Db, opts: {
  identityId: string;
  primaryRepoId: string | null;
  provider: string;
  workspaceId: string;
  status: CloudRunStatus;
  sessionId?: string | null;
  snapshotId?: string | null;
  prompt: string;
}) {
  const now = nowMs();
  const id = crypto.randomUUID();
  await db
    .insertInto("cloud_runs")
    .values({
      id,
      identity_id: opts.identityId,
      primary_repo_id: opts.primaryRepoId,
      provider: opts.provider,
      workspace_id: opts.workspaceId,
      status: opts.status,
      session_id: opts.sessionId ?? null,
      snapshot_id: opts.snapshotId ?? null,
      prompt: opts.prompt,
      diff_summary: null,
      diff_patch: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return await db.selectFrom("cloud_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

export async function updateCloudRun(db: Db, runId: string, patch: Partial<{
  status: CloudRunStatus;
  session_id: string | null;
  snapshot_id: string | null;
  diff_summary: string | null;
  diff_patch: string | null;
  started_at: number | null;
  finished_at: number | null;
  workspace_id: string;
}>) {
  await db
    .updateTable("cloud_runs")
    .set({ ...patch, updated_at: nowMs() })
    .where("id", "=", runId)
    .execute();
}

export async function addRunRepo(db: Db, opts: { runId: string; repoId: string; mountPath: string }) {
  const id = crypto.randomUUID();
  await db.insertInto("cloud_run_repos").values({ id, run_id: opts.runId, repo_id: opts.repoId, mount_path: opts.mountPath }).execute();
}

export async function getCloudRun(db: Db, runId: string) {
  return await db.selectFrom("cloud_runs").selectAll().where("id", "=", runId).executeTakeFirst();
}

export async function getCloudRunBySession(db: Db, sessionId: string) {
  return await db.selectFrom("cloud_runs").selectAll().where("session_id", "=", sessionId).executeTakeFirst();
}

export async function addCloudRunScreenshot(db: Db, opts: {
  runId: string;
  sessionId?: string | null;
  s3Key: string;
  mimeType?: string | null;
  tool?: string | null;
}) {
  const id = crypto.randomUUID();
  await db
    .insertInto("cloud_run_screenshots")
    .values({
      id,
      run_id: opts.runId,
      session_id: opts.sessionId ?? null,
      s3_key: opts.s3Key,
      mime_type: opts.mimeType ?? null,
      tool: opts.tool ?? null,
      created_at: nowMs(),
    })
    .execute();
  return id;
}

export async function listCloudRunScreenshots(db: Db, runId: string) {
  return await db
    .selectFrom("cloud_run_screenshots")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("created_at", "asc")
    .execute();
}

export async function upsertCloudSnapshot(db: Db, opts: {
  id: string;
  identityId: string;
  runId: string;
  sandboxId: string;
  title: string;
  note?: string;
  sourceStatus?: string;
  vectorId: string;
}) {
  const now = nowMs();
  const existingBySandbox = await db.selectFrom("cloud_snapshots").selectAll().where("sandbox_id", "=", opts.sandboxId).executeTakeFirst();
  if (existingBySandbox && existingBySandbox.id !== opts.id) {
    await db.deleteFrom("cloud_snapshots").where("sandbox_id", "=", opts.sandboxId).execute();
  }
  const createdAt = existingBySandbox && existingBySandbox.id === opts.id ? existingBySandbox.created_at : now;
  await db
    .insertInto("cloud_snapshots")
    .values({
      id: opts.id,
      identity_id: opts.identityId,
      run_id: opts.runId,
      sandbox_id: opts.sandboxId,
      created_at: createdAt,
      title: opts.title,
      note: opts.note ?? "",
      source_status: opts.sourceStatus ?? "",
      vector_id: opts.vectorId,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        identity_id: opts.identityId,
        run_id: opts.runId,
        sandbox_id: opts.sandboxId,
        title: opts.title,
        note: opts.note ?? "",
        source_status: opts.sourceStatus ?? "",
        vector_id: opts.vectorId,
        created_at: createdAt,
      }),
    )
    .execute();
  return await db.selectFrom("cloud_snapshots").selectAll().where("id", "=", opts.id).executeTakeFirstOrThrow();
}

export async function getCloudSnapshot(db: Db, snapshotId: string) {
  return await db.selectFrom("cloud_snapshots").selectAll().where("id", "=", snapshotId).executeTakeFirst();
}

export async function listSnapshotsByRun(db: Db, runId: string) {
  return await db
    .selectFrom("cloud_snapshots")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("created_at", "desc")
    .execute();
}

export async function listSnapshotsByIdentity(db: Db, opts: { identityId: string; limit?: number; before?: number | null }) {
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 20;
  let query = db
    .selectFrom("cloud_snapshots")
    .selectAll()
    .where("identity_id", "=", opts.identityId)
    .orderBy("created_at", "desc");
  if (typeof opts.before === "number" && Number.isFinite(opts.before)) {
    query = query.where("created_at", "<", Math.floor(opts.before));
  }
  return await query.limit(limit).execute();
}

export async function deleteCloudSnapshot(db: Db, snapshotId: string) {
  await db.deleteFrom("cloud_snapshots").where("id", "=", snapshotId).execute();
}

export async function listRunRepoIds(db: Db, runId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("cloud_run_repos")
    .select(["repo_id"])
    .where("run_id", "=", runId)
    .orderBy("id", "asc")
    .execute();
  return rows.map((r) => r.repo_id);
}

export async function listCloudRunsForRepo(db: Db, repoId: string, limit = 20) {
  return await db
    .selectFrom("cloud_runs")
    .selectAll()
    .where("primary_repo_id", "=", repoId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}

export async function listCloudRunsForPlayground(db: Db, identityId: string, limit = 20) {
  return await db
    .selectFrom("cloud_runs")
    .selectAll()
    .where("identity_id", "=", identityId)
    .where("primary_repo_id", "is", null)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}

export async function listCloudRunsForIdentity(db: Db, opts: { identityId: string; limit?: number; before?: number | null }) {
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 20;
  let query = db.selectFrom("cloud_runs").selectAll().where("identity_id", "=", opts.identityId);
  if (typeof opts.before === "number" && Number.isFinite(opts.before)) {
    query = query.where("created_at", "<", Math.floor(opts.before));
  }
  return await query.orderBy("created_at", "desc").limit(limit).execute();
}

export async function getLatestRunForIdentity(db: Db, identityId: string) {
  return await db.selectFrom("cloud_runs").selectAll().where("identity_id", "=", identityId).orderBy("created_at", "desc").limit(1).executeTakeFirst();
}

export async function setSecret(db: Db, opts: { identityId: string; name: string; encryptedValue: string }) {
  const now = nowMs();
  const existing = await db
    .selectFrom("secrets")
    .selectAll()
    .where("identity_id", "=", opts.identityId)
    .where("name", "=", opts.name)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("secrets")
      .set({ encrypted_value: opts.encryptedValue, updated_at: now })
      .where("id", "=", existing.id)
      .execute();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db
    .insertInto("secrets")
    .values({
      id,
      identity_id: opts.identityId,
      name: opts.name,
      encrypted_value: opts.encryptedValue,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

export async function listSecrets(db: Db, identityId: string) {
  return await db
    .selectFrom("secrets")
    .select(["id", "name", "created_at", "updated_at"])
    .where("identity_id", "=", identityId)
    .orderBy("name", "asc")
    .execute();
}

export async function deleteSecret(db: Db, identityId: string, name: string): Promise<boolean> {
  const res = await db
    .deleteFrom("secrets")
    .where("identity_id", "=", identityId)
    .where("name", "=", name)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

export async function getSecret(db: Db, identityId: string, name: string) {
  return await db
    .selectFrom("secrets")
    .selectAll()
    .where("identity_id", "=", identityId)
    .where("name", "=", name)
    .executeTakeFirst();
}

export async function putSetupSpec(db: Db, opts: { repoId: string; ymlBlob: string; hash: string }) {
  const now = nowMs();
  const existing = await db
    .selectFrom("setup_specs")
    .selectAll()
    .where("repo_id", "=", opts.repoId)
    .where("hash", "=", opts.hash)
    .executeTakeFirst();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db
    .insertInto("setup_specs")
    .values({
      id,
      repo_id: opts.repoId,
      yml_blob: opts.ymlBlob,
      hash: opts.hash,
      snapshot_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

export async function getLatestSetupSpec(db: Db, repoId: string) {
  return await db
    .selectFrom("setup_specs")
    .selectAll()
    .where("repo_id", "=", repoId)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

export async function updateSetupSpecSnapshot(db: Db, opts: { id: string; snapshotId: string | null }) {
  await db
    .updateTable("setup_specs")
    .set({ snapshot_id: opts.snapshotId, updated_at: nowMs() })
    .where("id", "=", opts.id)
    .execute();
}

export async function shareRepo(db: Db, opts: {
  platform: string;
  workspaceId: string | null;
  chatId: string;
  repoId: string;
  sharedByIdentityId: string;
}) {
  const existing = await db
    .selectFrom("shared_repos")
    .selectAll()
    .where("platform", "=", opts.platform)
    .where("workspace_id", "is", opts.workspaceId)
    .where("chat_id", "=", opts.chatId)
    .where("repo_id", "=", opts.repoId)
    .executeTakeFirst();
  if (existing) return { alreadyShared: true };
  const id = crypto.randomUUID();
  await db
    .insertInto("shared_repos")
    .values({
      id,
      platform: opts.platform,
      workspace_id: opts.workspaceId,
      chat_id: opts.chatId,
      repo_id: opts.repoId,
      shared_by_identity_id: opts.sharedByIdentityId,
      shared_at: nowMs(),
    })
    .execute();
  return { alreadyShared: false };
}

export async function unshareRepo(db: Db, opts: { platform: string; workspaceId: string | null; chatId: string; repoId: string }) {
  const res = await db
    .deleteFrom("shared_repos")
    .where("platform", "=", opts.platform)
    .where("workspace_id", "is", opts.workspaceId)
    .where("chat_id", "=", opts.chatId)
    .where("repo_id", "=", opts.repoId)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

export async function listSharedRepos(db: Db, opts: { platform: string; workspaceId: string | null; chatId: string }) {
  return await db
    .selectFrom("shared_repos")
    .innerJoin("repos", "repos.id", "shared_repos.repo_id")
    .select([
      "shared_repos.repo_id as repo_id",
      "repos.name",
      "repos.url",
      "shared_repos.shared_by_identity_id",
      "shared_repos.shared_at",
    ])
    .where("shared_repos.platform", "=", opts.platform)
    .where("shared_repos.workspace_id", "is", opts.workspaceId)
    .where("shared_repos.chat_id", "=", opts.chatId)
    .orderBy("repos.name", "asc")
    .execute();
}

export async function getSharedRepo(db: Db, opts: { platform: string; workspaceId: string | null; chatId: string; repoId: string }) {
  return await db
    .selectFrom("shared_repos")
    .selectAll()
    .where("platform", "=", opts.platform)
    .where("workspace_id", "is", opts.workspaceId)
    .where("chat_id", "=", opts.chatId)
    .where("repo_id", "=", opts.repoId)
    .executeTakeFirst();
}

export async function createOAuthState(db: Db, opts: {
  provider: string;
  state: string;
  codeVerifier: string;
  redirectUrl: string;
  identityId?: string | null;
  metadataJson?: string | null;
  ttlMs: number;
}) {
  const now = nowMs();
  const id = crypto.randomUUID();
  await db
    .insertInto("oauth_states")
    .values({
      id,
      provider: opts.provider,
      state: opts.state,
      code_verifier: opts.codeVerifier,
      redirect_url: opts.redirectUrl,
      identity_id: opts.identityId ?? null,
      metadata_json: opts.metadataJson ?? null,
      created_at: now,
      expires_at: now + opts.ttlMs,
    })
    .execute();
  return id;
}

export async function consumeOAuthState(db: Db, provider: string, state: string) {
  const row = await db
    .selectFrom("oauth_states")
    .selectAll()
    .where("provider", "=", provider)
    .where("state", "=", state)
    .executeTakeFirst();
  if (!row) return null;
  const now = nowMs();
  if (row.expires_at < now) {
    await db.deleteFrom("oauth_states").where("id", "=", row.id).execute();
    return null;
  }
  await db.deleteFrom("oauth_states").where("id", "=", row.id).execute();
  return row;
}
