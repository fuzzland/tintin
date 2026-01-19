import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import type { CloudSection } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import { nowMs } from "../util.js";
import type { CloudManager } from "./manager.js";
import { isGithubInstallationMissing } from "./githubApp.js";
import { deleteS3Object } from "./s3.js";
import { getGithubInstallation, upsertGithubInstallation } from "./store.js";

type GithubDisconnectScope = {
  installationId: string;
  connectionIds: string[];
  identityIds: string[];
  repoIds: string[];
  runIds: string[];
  sessionIds: string[];
  jsonlPaths: string[];
  screenshotKeys: string[];
  snapshotIds: string[];
};

export type GithubDisconnectImpact = {
  installationId: string;
  connections: number;
  identities: number;
  repos: number;
  sharedRepos: number;
  setupSpecs: number;
  runLinks: number;
  runs: number;
  sessions: number;
  screenshots: number;
  snapshots: number;
};

async function loadGithubDisconnectScope(db: Db, installationId: string): Promise<GithubDisconnectScope> {
  const connections = await db
    .selectFrom("connections")
    .select(["id", "identity_id"])
    .where("type", "=", "github_app")
    .where("installation_id", "=", installationId)
    .execute();
  const connectionIds = connections.map((row) => row.id);
  const identityIds = Array.from(new Set(connections.map((row) => row.identity_id)));

  const repoRows =
    connectionIds.length > 0
      ? await db
          .selectFrom("repos")
          .select(["id"])
          .where("connection_id", "in", connectionIds)
          .execute()
      : [];
  const repoIds = repoRows.map((row) => row.id);

  const runIds = new Set<string>();
  if (repoIds.length > 0) {
    const runRepoRows = await db
      .selectFrom("cloud_run_repos")
      .select(["run_id"])
      .where("repo_id", "in", repoIds)
      .execute();
    for (const row of runRepoRows) runIds.add(row.run_id);
    const primaryRows = await db
      .selectFrom("cloud_runs")
      .select(["id"])
      .where("primary_repo_id", "in", repoIds)
      .execute();
    for (const row of primaryRows) runIds.add(row.id);
  }
  const runIdList = Array.from(runIds);
  const runs =
    runIdList.length > 0
      ? await db.selectFrom("cloud_runs").select(["id", "session_id", "status"]).where("id", "in", runIdList).execute()
      : [];
  const sessionIds = runs.map((row) => row.session_id).filter((v): v is string => typeof v === "string" && v.length > 0);

  const screenshotRows =
    runIdList.length > 0
      ? await db.selectFrom("cloud_run_screenshots").select(["s3_key"]).where("run_id", "in", runIdList).execute()
      : [];
  const screenshotKeys = screenshotRows.map((row) => row.s3_key).filter(Boolean);

  const snapshotRows =
    runIdList.length > 0
      ? await db.selectFrom("cloud_snapshots").select(["id"]).where("run_id", "in", runIdList).execute()
      : [];
  const snapshotIds = snapshotRows.map((row) => row.id);

  const jsonlRows =
    sessionIds.length > 0
      ? await db.selectFrom("session_stream_offsets").select(["jsonl_path"]).where("session_id", "in", sessionIds).execute()
      : [];
  const jsonlPaths = jsonlRows.map((row) => row.jsonl_path).filter(Boolean);

  return {
    installationId,
    connectionIds,
    identityIds,
    repoIds,
    runIds: runIdList,
    sessionIds,
    jsonlPaths,
    screenshotKeys,
    snapshotIds,
  };
}

export async function computeGithubDisconnectImpact(db: Db, installationId: string): Promise<GithubDisconnectImpact> {
  const scope = await loadGithubDisconnectScope(db, installationId);
  const sharedRepos =
    scope.repoIds.length > 0
      ? await db
          .selectFrom("shared_repos")
          .select(({ fn }) => fn.count("id").as("count"))
          .where("repo_id", "in", scope.repoIds)
          .executeTakeFirst()
      : null;
  const setupSpecs =
    scope.repoIds.length > 0
      ? await db
          .selectFrom("setup_specs")
          .select(({ fn }) => fn.count("id").as("count"))
          .where("repo_id", "in", scope.repoIds)
          .executeTakeFirst()
      : null;
  const runLinks =
    scope.repoIds.length > 0
      ? await db
          .selectFrom("cloud_run_repos")
          .select(({ fn }) => fn.count("id").as("count"))
          .where("repo_id", "in", scope.repoIds)
          .executeTakeFirst()
      : null;
  return {
    installationId: scope.installationId,
    connections: scope.connectionIds.length,
    identities: scope.identityIds.length,
    repos: scope.repoIds.length,
    sharedRepos: Number(sharedRepos?.count ?? 0),
    setupSpecs: Number(setupSpecs?.count ?? 0),
    runLinks: Number(runLinks?.count ?? 0),
    runs: scope.runIds.length,
    sessions: scope.sessionIds.length,
    screenshots: scope.screenshotKeys.length,
    snapshots: scope.snapshotIds.length,
  };
}

export async function executeGithubDisconnect(opts: {
  db: Db;
  cloud: CloudSection;
  logger: Logger;
  installationId: string;
  identityId: string;
  cloudManager: CloudManager | null;
}): Promise<GithubDisconnectImpact> {
  const cfg = opts.cloud.github_app;
  if (!cfg) throw new Error("Missing [cloud].github_app configuration.");
  const missing = await isGithubInstallationMissing({ config: cfg, installationId: opts.installationId });
  if (!missing) throw new Error("GitHub App installation still active; uninstall it first.");

  const installation = await getGithubInstallation(opts.db, opts.installationId);
  if (!installation) {
    await upsertGithubInstallation(opts.db, {
      installationId: opts.installationId,
      appId: cfg.app_id,
      status: "disconnecting",
    });
  } else if (installation.status === "disconnecting") {
    throw new Error("Installation disconnect already in progress.");
  }

  await opts.db
    .updateTable("github_installations")
    .set({ status: "disconnecting", updated_at: nowMs() })
    .where("installation_id", "=", opts.installationId)
    .execute();

  const scope = await loadGithubDisconnectScope(opts.db, opts.installationId);
  const impact = await computeGithubDisconnectImpact(opts.db, opts.installationId);

  if (opts.cloudManager && scope.runIds.length > 0) {
    const runs = await opts.db
      .selectFrom("cloud_runs")
      .select(["id", "session_id", "status"])
      .where("id", "in", scope.runIds)
      .execute();
    for (const run of runs) {
      if (run.session_id && (run.status === "queued" || run.status === "running")) {
        try {
          await opts.cloudManager.stopSandboxForSession(run.session_id);
        } catch (e) {
          opts.logger.warn(`[github_disconnect] stop run failed run=${run.id}: ${String(e)}`);
        }
      }
    }
  }

  const now = nowMs();
  await opts.db.transaction().execute(async (trx) => {
    await trx.deleteFrom("github_installation_tokens").where("installation_id", "=", opts.installationId).execute();
    await trx.deleteFrom("github_installation_identities").where("installation_id", "=", opts.installationId).execute();
    await trx
      .updateTable("github_installations")
      .set({
        status: "disconnected",
        account_login: null,
        account_type: null,
        permissions_json: null,
        updated_at: now,
      })
      .where("installation_id", "=", opts.installationId)
      .execute();
    await trx
      .updateTable("github_installation_repos")
      .set({ removed_at: now, updated_at: now })
      .where("installation_id", "=", opts.installationId)
      .execute();
    await trx.deleteFrom("github_webhook_events").where("installation_id", "=", opts.installationId).execute();

    if (scope.repoIds.length > 0) {
      await trx
        .updateTable("identities")
        .set({ active_repo_id: null, updated_at: now })
        .where("active_repo_id", "in", scope.repoIds)
        .execute();
      await trx.deleteFrom("shared_repos").where("repo_id", "in", scope.repoIds).execute();
      await trx.deleteFrom("setup_specs").where("repo_id", "in", scope.repoIds).execute();
      await trx.deleteFrom("cloud_run_repos").where("repo_id", "in", scope.repoIds).execute();
      await trx.updateTable("cloud_runs").set({ primary_repo_id: null }).where("primary_repo_id", "in", scope.repoIds).execute();
      await trx.deleteFrom("repos").where("id", "in", scope.repoIds).execute();
    }

    if (scope.runIds.length > 0) {
      await trx.deleteFrom("cloud_run_screenshots").where("run_id", "in", scope.runIds).execute();
      await trx.deleteFrom("cloud_snapshots").where("run_id", "in", scope.runIds).execute();
      await trx.deleteFrom("cloud_workspaces").where("run_id", "in", scope.runIds).execute();
      await trx.deleteFrom("cloud_runs").where("id", "in", scope.runIds).execute();
    }

    if (scope.sessionIds.length > 0) {
      await trx.deleteFrom("session_stream_offsets").where("session_id", "in", scope.sessionIds).execute();
      await trx.deleteFrom("sessions").where("id", "in", scope.sessionIds).execute();
    }

    if (scope.connectionIds.length > 0) {
      await trx.deleteFrom("connections").where("id", "in", scope.connectionIds).execute();
    }

    if (scope.identityIds.length > 0) {
      await trx
        .deleteFrom("oauth_states")
        .where("provider", "=", "github_app")
        .where("identity_id", "in", scope.identityIds)
        .execute();
    }

    await trx.insertInto("audit_events").values({
      id: crypto.randomUUID(),
      session_id: null,
      kind: "github_disconnect",
      payload_json: JSON.stringify({
        installation_id: opts.installationId,
        connection_count: scope.connectionIds.length,
        repo_count: scope.repoIds.length,
        run_count: scope.runIds.length,
      }),
      identity_id: opts.identityId,
      action: "github_disconnect",
      metadata_json: null,
      created_at: now,
    }).execute();
  });

  const ui = opts.cloud.ui;
  if (ui && ui.s3_bucket && ui.s3_region && ui.token_secret) {
    for (const key of scope.screenshotKeys) {
      try {
        await deleteS3Object(ui, key);
      } catch (e) {
        opts.logger.warn(`[github_disconnect] s3 delete failed key=${key}: ${String(e)}`);
      }
    }
  }

  for (const path of scope.jsonlPaths) {
    try {
      await unlink(path);
    } catch {
      // ignore missing files
    }
  }

  return impact;
}
