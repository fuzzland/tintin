import crypto from "node:crypto";
import { sql } from "kysely";
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
  installationId?: string | null;
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
        installation_id: opts.installationId ?? null,
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
      installation_id: opts.installationId ?? null,
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
    .leftJoin("github_installation_repos", (join) =>
      join
        .onRef("github_installation_repos.installation_id", "=", "connections.installation_id")
        .onRef("github_installation_repos.provider_repo_id", "=", "repos.provider_repo_id"),
    )
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
    .where((eb) =>
      eb.or([
        eb("connections.type", "!=", "github_app"),
        eb.and([
          eb("connections.type", "=", "github_app"),
          eb("github_installation_repos.removed_at", "is", null),
          eb("github_installation_repos.id", "is not", null),
        ]),
      ]),
    )
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

export async function setGithubMcpToken(db: Db, opts: { identityId: string; encryptedToken: string }) {
  const now = nowMs();
  const existing = await db
    .selectFrom("github_mcp_tokens")
    .select(["id"])
    .where("identity_id", "=", opts.identityId)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("github_mcp_tokens")
      .set({ encrypted_token: opts.encryptedToken, updated_at: now })
      .where("id", "=", existing.id)
      .execute();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db
    .insertInto("github_mcp_tokens")
    .values({
      id,
      identity_id: opts.identityId,
      encrypted_token: opts.encryptedToken,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

export async function getGithubMcpToken(db: Db, identityId: string) {
  return await db
    .selectFrom("github_mcp_tokens")
    .selectAll()
    .where("identity_id", "=", identityId)
    .executeTakeFirst();
}

export async function getLatestNotionMcpClient(db: Db) {
  return await db
    .selectFrom("notion_mcp_clients")
    .selectAll()
    .orderBy("updated_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

export async function getNotionMcpClientByClientId(db: Db, clientId: string) {
  return await db
    .selectFrom("notion_mcp_clients")
    .selectAll()
    .where("client_id", "=", clientId)
    .executeTakeFirst();
}

export async function getNotionMcpClientById(db: Db, id: string) {
  return await db
    .selectFrom("notion_mcp_clients")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function upsertNotionMcpClient(db: Db, opts: {
  clientId: string;
  clientSecret: string;
  registrationUri?: string | null;
  authEndpoint: string;
  tokenEndpoint: string;
}) {
  const now = nowMs();
  const existing = await db
    .selectFrom("notion_mcp_clients")
    .select(["id"])
    .where("client_id", "=", opts.clientId)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("notion_mcp_clients")
      .set({
        client_secret: opts.clientSecret,
        registration_uri: opts.registrationUri ?? null,
        auth_endpoint: opts.authEndpoint,
        token_endpoint: opts.tokenEndpoint,
        updated_at: now,
      })
      .where("id", "=", existing.id)
      .execute();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db
    .insertInto("notion_mcp_clients")
    .values({
      id,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      registration_uri: opts.registrationUri ?? null,
      auth_endpoint: opts.authEndpoint,
      token_endpoint: opts.tokenEndpoint,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

export async function getNotionMcpToken(db: Db, identityId: string) {
  return await db
    .selectFrom("notion_mcp_tokens")
    .selectAll()
    .where("identity_id", "=", identityId)
    .executeTakeFirst();
}

export async function deleteNotionMcpToken(db: Db, identityId: string) {
  const res = await db
    .deleteFrom("notion_mcp_tokens")
    .where("identity_id", "=", identityId)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

export async function upsertNotionMcpToken(db: Db, opts: {
  identityId: string;
  clientId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: number | null;
  botId?: string | null;
  workspaceName?: string | null;
  workspaceIcon?: string | null;
}) {
  const now = nowMs();
  const existing = await db
    .selectFrom("notion_mcp_tokens")
    .select(["id"])
    .where("identity_id", "=", opts.identityId)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("notion_mcp_tokens")
      .set({
        client_id: opts.clientId,
        encrypted_access_token: opts.encryptedAccessToken,
        encrypted_refresh_token: opts.encryptedRefreshToken,
        expires_at: opts.expiresAt,
        bot_id: opts.botId ?? null,
        workspace_name: opts.workspaceName ?? null,
        workspace_icon: opts.workspaceIcon ?? null,
        updated_at: now,
      })
      .where("id", "=", existing.id)
      .execute();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db
    .insertInto("notion_mcp_tokens")
    .values({
      id,
      identity_id: opts.identityId,
      client_id: opts.clientId,
      encrypted_access_token: opts.encryptedAccessToken,
      encrypted_refresh_token: opts.encryptedRefreshToken,
      expires_at: opts.expiresAt,
      bot_id: opts.botId ?? null,
      workspace_name: opts.workspaceName ?? null,
      workspace_icon: opts.workspaceIcon ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
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

export async function upsertGithubInstallation(db: Db, opts: {
  installationId: string;
  appId: string;
  accountLogin?: string | null;
  accountType?: string | null;
  status?: string;
  permissionsJson?: string | null;
}) {
  const now = nowMs();
  const existing = await db
    .selectFrom("github_installations")
    .select(["installation_id"])
    .where("installation_id", "=", opts.installationId)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("github_installations")
      .set({
        app_id: opts.appId,
        account_login: opts.accountLogin ?? null,
        account_type: opts.accountType ?? null,
        status: opts.status ?? "active",
        permissions_json: opts.permissionsJson ?? null,
        updated_at: now,
      })
      .where("installation_id", "=", opts.installationId)
      .execute();
    return;
  }
  await db
    .insertInto("github_installations")
    .values({
      installation_id: opts.installationId,
      app_id: opts.appId,
      account_login: opts.accountLogin ?? null,
      account_type: opts.accountType ?? null,
      status: opts.status ?? "active",
      permissions_json: opts.permissionsJson ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

export async function updateGithubInstallationStatus(db: Db, opts: { installationId: string; status: string }) {
  const now = nowMs();
  const res = await db
    .updateTable("github_installations")
    .set({ status: opts.status, updated_at: now })
    .where("installation_id", "=", opts.installationId)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

export async function getGithubInstallation(db: Db, installationId: string) {
  return await db
    .selectFrom("github_installations")
    .selectAll()
    .where("installation_id", "=", installationId)
    .executeTakeFirst();
}

export async function upsertGithubInstallationIdentity(db: Db, opts: { installationId: string; identityId: string }) {
  const existing = await db
    .selectFrom("github_installation_identities")
    .select(["id"])
    .where("installation_id", "=", opts.installationId)
    .where("identity_id", "=", opts.identityId)
    .executeTakeFirst();
  if (existing) return;
  const now = nowMs();
  await db
    .insertInto("github_installation_identities")
    .values({
      id: crypto.randomUUID(),
      installation_id: opts.installationId,
      identity_id: opts.identityId,
      created_at: now,
    })
    .execute();
}

export async function listGithubInstallationsForIdentity(db: Db, identityId: string) {
  return await db
    .selectFrom("github_installation_identities")
    .innerJoin("github_installations", "github_installations.installation_id", "github_installation_identities.installation_id")
    .select([
      "github_installations.installation_id",
      "github_installations.app_id",
      "github_installations.account_login",
      "github_installations.account_type",
      "github_installations.status",
      "github_installations.created_at",
      "github_installations.updated_at",
    ])
    .where("github_installation_identities.identity_id", "=", identityId)
    .orderBy("github_installations.updated_at", "desc")
    .execute();
}

export async function upsertGithubInstallationToken(db: Db, opts: {
  installationId: string;
  encryptedToken: string;
  expiresAt: number | null;
}) {
  const now = nowMs();
  const existing = await db
    .selectFrom("github_installation_tokens")
    .select(["id"])
    .where("installation_id", "=", opts.installationId)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("github_installation_tokens")
      .set({
        encrypted_token: opts.encryptedToken,
        expires_at: opts.expiresAt,
        created_at: now,
      })
      .where("installation_id", "=", opts.installationId)
      .execute();
    return;
  }
  await db
    .insertInto("github_installation_tokens")
    .values({
      id: crypto.randomUUID(),
      installation_id: opts.installationId,
      encrypted_token: opts.encryptedToken,
      expires_at: opts.expiresAt,
      created_at: now,
    })
    .execute();
}

export async function getGithubInstallationToken(db: Db, installationId: string) {
  return await db
    .selectFrom("github_installation_tokens")
    .selectAll()
    .where("installation_id", "=", installationId)
    .executeTakeFirst();
}

export async function deleteGithubInstallationToken(db: Db, installationId: string) {
  await db.deleteFrom("github_installation_tokens").where("installation_id", "=", installationId).execute();
}

export async function replaceGithubInstallationRepos(
  db: Db,
  opts: {
    installationId: string;
    repos: Array<{
      providerRepoId: string;
      name: string;
      url: string;
      defaultBranch: string | null;
      archived?: boolean;
      private?: boolean;
      permissionsJson?: string | null;
    }>;
  },
) {
  const now = nowMs();
  const repoIds = opts.repos.map((r) => r.providerRepoId);
  if (repoIds.length === 0) {
    await db
      .updateTable("github_installation_repos")
      .set({ removed_at: now, updated_at: now })
      .where("installation_id", "=", opts.installationId)
      .execute();
  } else {
    await db
      .updateTable("github_installation_repos")
      .set({ removed_at: now, updated_at: now })
      .where("installation_id", "=", opts.installationId)
      .where("provider_repo_id", "not in", repoIds)
      .execute();
  }
  for (const repo of opts.repos) {
    const existing = await db
      .selectFrom("github_installation_repos")
      .select(["id"])
      .where("installation_id", "=", opts.installationId)
      .where("provider_repo_id", "=", repo.providerRepoId)
      .executeTakeFirst();
    const values = {
      installation_id: opts.installationId,
      provider_repo_id: repo.providerRepoId,
      full_name: repo.name,
      url: repo.url,
      default_branch: repo.defaultBranch ?? null,
      archived: repo.archived ? 1 : 0,
      private: repo.private ? 1 : 0,
      permissions_json: repo.permissionsJson ?? null,
      removed_at: null,
      updated_at: now,
    };
    if (existing) {
      await db.updateTable("github_installation_repos").set(values).where("id", "=", existing.id).execute();
    } else {
      await db
        .insertInto("github_installation_repos")
        .values({ id: crypto.randomUUID(), created_at: now, ...values })
        .execute();
    }
  }
}

export async function listGithubInstallationRepos(db: Db, installationId: string) {
  return await db
    .selectFrom("github_installation_repos")
    .selectAll()
    .where("installation_id", "=", installationId)
    .where("removed_at", "is", null)
    .execute();
}

export async function createPendingAction(db: Db, opts: {
  action: string;
  identityId: string;
  tokenHash: string;
  payloadJson: string;
  ttlMs: number;
}) {
  const now = nowMs();
  const id = crypto.randomUUID();
  await db
    .insertInto("pending_actions")
    .values({
      id,
      action: opts.action,
      identity_id: opts.identityId,
      token_hash: opts.tokenHash,
      payload_json: opts.payloadJson,
      created_at: now,
      expires_at: now + opts.ttlMs,
      consumed_at: null,
    })
    .execute();
  return id;
}

export async function consumePendingAction(db: Db, opts: { action: string; identityId: string; tokenHash: string }) {
  const row = await db
    .selectFrom("pending_actions")
    .selectAll()
    .where("action", "=", opts.action)
    .where("identity_id", "=", opts.identityId)
    .where("token_hash", "=", opts.tokenHash)
    .executeTakeFirst();
  if (!row) return null;
  const now = nowMs();
  if (row.expires_at < now) return null;
  if (row.consumed_at) return null;
  await db.updateTable("pending_actions").set({ consumed_at: now }).where("id", "=", row.id).execute();
  return row;
}

async function nextIdx(db: Db, table: "code_registry" | "site_registry" | "static_deploys" | "dynamic_deploys"): Promise<number> {
  const row = await db.selectFrom(table).select(sql`max(idx)`.as("max")).executeTakeFirst();
  const raw = row?.max;
  if (typeof raw === "number") return raw + 1;
  if (typeof raw === "bigint") return Number(raw) + 1;
  if (raw === null || raw === undefined) return 1;
  const parsed = Number.parseInt(String(raw), 10);
  return (Number.isFinite(parsed) ? parsed : 0) + 1;
}

function isUniqueConstraintError(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string };
  const code = anyErr?.code ?? "";
  if (code === "SQLITE_CONSTRAINT" || code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505" || code === "ER_DUP_ENTRY") return true;
  const message = (anyErr?.message ?? String(err)).toLowerCase();
  return message.includes("unique") || message.includes("duplicate") || message.includes("constraint");
}

async function insertWithRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isUniqueConstraintError(err) || i === attempts - 1) throw err;
    }
  }
  throw lastErr ?? new Error("insert failed");
}

export async function createCodeRegistryEntry(db: Db, opts: { identityId: string; directory: string; summary: string }) {
  return await insertWithRetry(async () => {
    return await db.transaction().execute(async (trx) => {
      const idx = await nextIdx(trx, "code_registry");
      const now = nowMs();
      const id = crypto.randomUUID();
      const row = {
        id,
        idx,
        identity_id: opts.identityId,
        directory: opts.directory,
        summary: opts.summary,
        created_at: now,
        updated_at: now,
      };
      await trx.insertInto("code_registry").values(row).execute();
      return row;
    });
  });
}

export async function listCodeRegistryEntries(db: Db, identityId: string) {
  return await db.selectFrom("code_registry").selectAll().where("identity_id", "=", identityId).orderBy("idx", "asc").execute();
}

export async function ignoreCodeRegistryEntry(db: Db, opts: { identityId: string; target: string }): Promise<number> {
  const target = opts.target.trim();
  if (!target) return 0;
  const idx = Number.parseInt(target, 10);
  let query = db.deleteFrom("code_registry").where("identity_id", "=", opts.identityId);
  if (Number.isFinite(idx) && String(idx) === target) {
    query = query.where("idx", "=", idx);
  } else {
    query = query.where("directory", "=", target);
  }
  const res = await query.executeTakeFirst();
  return Number(res?.numDeletedRows ?? 0);
}

export async function createSiteRegistryEntry(db: Db, opts: { identityId: string; port: number; path: string; summary: string }) {
  return await insertWithRetry(async () => {
    return await db.transaction().execute(async (trx) => {
      const idx = await nextIdx(trx, "site_registry");
      const now = nowMs();
      const id = crypto.randomUUID();
      const row = {
        id,
        idx,
        identity_id: opts.identityId,
        port: opts.port,
        path: opts.path,
        summary: opts.summary,
        created_at: now,
        updated_at: now,
      };
      await trx.insertInto("site_registry").values(row).execute();
      return row;
    });
  });
}

export async function listSiteRegistryEntries(db: Db, identityId: string) {
  return await db.selectFrom("site_registry").selectAll().where("identity_id", "=", identityId).orderBy("idx", "asc").execute();
}

export async function ignoreSiteRegistryEntry(db: Db, opts: { identityId: string; idx: number }): Promise<number> {
  const res = await db
    .deleteFrom("site_registry")
    .where("identity_id", "=", opts.identityId)
    .where("idx", "=", opts.idx)
    .executeTakeFirst();
  return Number(res?.numDeletedRows ?? 0);
}

export async function createStaticDeployEntry(db: Db, opts: {
  identityId: string;
  sessionId: string;
  appName: string;
  summary: string;
  rootPath: string;
  versionHost: string;
  stableHost: string;
}) {
  return await insertWithRetry(async () => {
    return await db.transaction().execute(async (trx) => {
      const idx = await nextIdx(trx, "static_deploys");
      const now = nowMs();
      const id = crypto.randomUUID();
      const row = {
        id,
        idx,
        identity_id: opts.identityId,
        session_id: opts.sessionId,
        app_name: opts.appName,
        summary: opts.summary,
        root_path: opts.rootPath,
        version_host: opts.versionHost,
        stable_host: opts.stableHost,
        is_active: 0,
        created_at: now,
        updated_at: now,
      };
      await trx.insertInto("static_deploys").values(row).execute();
      return row;
    });
  });
}

export type StaticDeployPatch = Partial<{
  root_path: string;
  version_host: string;
  stable_host: string;
  is_active: number;
}>;

export async function updateStaticDeployEntry(db: Db, opts: { identityId: string; idx: number; patch: StaticDeployPatch }) {
  await db
    .updateTable("static_deploys")
    .set({ ...opts.patch, updated_at: nowMs() })
    .where("identity_id", "=", opts.identityId)
    .where("idx", "=", opts.idx)
    .execute();
}

export async function setStaticDeployActive(db: Db, opts: { identityId: string; sessionId: string; idx: number }) {
  const now = nowMs();
  await db
    .updateTable("static_deploys")
    .set({ is_active: 0, updated_at: now })
    .where("identity_id", "=", opts.identityId)
    .where("session_id", "=", opts.sessionId)
    .execute();
  await db
    .updateTable("static_deploys")
    .set({ is_active: 1, updated_at: now })
    .where("identity_id", "=", opts.identityId)
    .where("idx", "=", opts.idx)
    .execute();
}

export async function listStaticDeploys(db: Db, identityId: string) {
  return await db.selectFrom("static_deploys").selectAll().where("identity_id", "=", identityId).orderBy("created_at", "desc").execute();
}

export async function getStaticDeployByIdx(db: Db, identityId: string, idx: number) {
  return await db
    .selectFrom("static_deploys")
    .selectAll()
    .where("identity_id", "=", identityId)
    .where("idx", "=", idx)
    .executeTakeFirst();
}

export async function createDynamicDeployEntry(db: Db, opts: {
  identityId: string;
  sessionId: string;
  appName: string;
  summary: string;
  provider: string;
  imageRef: string;
  workspaceId: string;
  port: number;
  startup: string;
  setupJson: string;
  ignoreJson: string;
  archivePath: string;
  logPath: string;
}) {
  return await insertWithRetry(async () => {
    return await db.transaction().execute(async (trx) => {
      const idx = await nextIdx(trx, "dynamic_deploys");
      const now = nowMs();
      const id = crypto.randomUUID();
      const row = {
        id,
        idx,
        identity_id: opts.identityId,
        session_id: opts.sessionId,
        app_name: opts.appName,
        summary: opts.summary,
        provider: opts.provider,
        image_ref: opts.imageRef,
        workspace_id: opts.workspaceId,
        port: opts.port,
        startup: opts.startup,
        setup_json: opts.setupJson,
        ignore_json: opts.ignoreJson,
        snapshot_id: null,
        archive_path: opts.archivePath,
        url: "",
        log_path: opts.logPath,
        status: "pending",
        created_at: now,
        updated_at: now,
      };
      await trx.insertInto("dynamic_deploys").values(row).execute();
      return row;
    });
  });
}

export type DynamicDeployPatch = Partial<{
  provider: string;
  image_ref: string;
  workspace_id: string;
  port: number;
  startup: string;
  setup_json: string;
  ignore_json: string;
  snapshot_id: string | null;
  archive_path: string;
  url: string;
  log_path: string;
  status: string;
}>;

export async function updateDynamicDeployEntry(db: Db, opts: { identityId: string; idx: number; patch: DynamicDeployPatch }) {
  await db
    .updateTable("dynamic_deploys")
    .set({ ...opts.patch, updated_at: nowMs() })
    .where("identity_id", "=", opts.identityId)
    .where("idx", "=", opts.idx)
    .execute();
}

export async function listDynamicDeploys(db: Db, identityId: string) {
  return await db.selectFrom("dynamic_deploys").selectAll().where("identity_id", "=", identityId).orderBy("created_at", "desc").execute();
}

export async function getDynamicDeployByIdx(db: Db, identityId: string, idx: number) {
  return await db
    .selectFrom("dynamic_deploys")
    .selectAll()
    .where("identity_id", "=", identityId)
    .where("idx", "=", idx)
    .executeTakeFirst();
}
