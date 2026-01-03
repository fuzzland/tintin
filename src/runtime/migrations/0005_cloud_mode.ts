import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("identities")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("platform", "varchar(32)", (c) => c.notNull())
    .addColumn("workspace_id", "varchar(128)")
    .addColumn("user_id", "varchar(128)", (c) => c.notNull())
    .addColumn("active_repo_id", "varchar(36)")
    .addColumn("onboarded_at", "bigint")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .addUniqueConstraint("identities_unique", ["platform", "workspace_id", "user_id"])
    .execute();

  await db.schema
    .createTable("connections")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("identity_id", "varchar(36)", (c) => c.notNull().references("identities.id").onDelete("cascade"))
    .addColumn("type", "varchar(32)", (c) => c.notNull())
    .addColumn("access_token", "text", (c) => c.notNull())
    .addColumn("refresh_token", "text")
    .addColumn("scope", "text")
    .addColumn("token_expires_at", "bigint")
    .addColumn("metadata_json", "text")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .execute();

  await db.schema.createIndex("connections_identity_idx").on("connections").column("identity_id").execute();

  await db.schema
    .createTable("repos")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("connection_id", "varchar(36)", (c) => c.notNull().references("connections.id").onDelete("cascade"))
    .addColumn("provider", "varchar(32)", (c) => c.notNull())
    .addColumn("provider_repo_id", "varchar(256)")
    .addColumn("name", "varchar(256)", (c) => c.notNull())
    .addColumn("url", "text", (c) => c.notNull())
    .addColumn("default_branch", "varchar(128)")
    .addColumn("fingerprint", "varchar(256)")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .addUniqueConstraint("repos_provider_unique", ["connection_id", "provider_repo_id"])
    .execute();

  await db.schema.createIndex("repos_connection_idx").on("repos").column("connection_id").execute();

  await db.schema
    .createTable("cloud_runs")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("identity_id", "varchar(36)", (c) => c.notNull().references("identities.id").onDelete("cascade"))
    .addColumn("primary_repo_id", "varchar(36)", (c) => c.references("repos.id").onDelete("set null"))
    .addColumn("provider", "varchar(32)", (c) => c.notNull())
    .addColumn("workspace_id", "varchar(128)", (c) => c.notNull())
    .addColumn("status", "varchar(32)", (c) => c.notNull())
    .addColumn("session_id", "varchar(36)", (c) => c.references("sessions.id").onDelete("set null"))
    .addColumn("snapshot_id", "varchar(128)")
    .addColumn("diff_summary", "text")
    .addColumn("diff_patch", "text")
    .addColumn("started_at", "bigint")
    .addColumn("finished_at", "bigint")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .execute();

  await db.schema.createIndex("cloud_runs_identity_idx").on("cloud_runs").column("identity_id").execute();
  await db.schema.createIndex("cloud_runs_session_idx").on("cloud_runs").column("session_id").execute();

  await db.schema
    .createTable("cloud_run_repos")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("run_id", "varchar(36)", (c) => c.notNull().references("cloud_runs.id").onDelete("cascade"))
    .addColumn("repo_id", "varchar(36)", (c) => c.notNull().references("repos.id").onDelete("cascade"))
    .addColumn("mount_path", "varchar(256)", (c) => c.notNull())
    .addUniqueConstraint("cloud_run_repos_unique", ["run_id", "repo_id"])
    .execute();

  await db.schema.createIndex("cloud_run_repos_run_idx").on("cloud_run_repos").column("run_id").execute();

  await db.schema
    .createTable("secrets")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("identity_id", "varchar(36)", (c) => c.notNull().references("identities.id").onDelete("cascade"))
    .addColumn("name", "varchar(128)", (c) => c.notNull())
    .addColumn("encrypted_value", "text", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .addUniqueConstraint("secrets_identity_unique", ["identity_id", "name"])
    .execute();

  await db.schema.createIndex("secrets_identity_idx").on("secrets").column("identity_id").execute();

  await db.schema
    .createTable("setup_specs")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("repo_id", "varchar(36)", (c) => c.notNull().references("repos.id").onDelete("cascade"))
    .addColumn("yml_blob", "text", (c) => c.notNull())
    .addColumn("hash", "varchar(64)", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .addUniqueConstraint("setup_specs_unique", ["repo_id", "hash"])
    .execute();

  await db.schema
    .createTable("shared_repos")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("platform", "varchar(32)", (c) => c.notNull())
    .addColumn("workspace_id", "varchar(128)")
    .addColumn("chat_id", "varchar(128)", (c) => c.notNull())
    .addColumn("repo_id", "varchar(36)", (c) => c.notNull().references("repos.id").onDelete("cascade"))
    .addColumn("shared_by_identity_id", "varchar(36)", (c) => c.notNull().references("identities.id").onDelete("cascade"))
    .addColumn("shared_at", "bigint", (c) => c.notNull())
    .addUniqueConstraint("shared_repos_unique", ["platform", "workspace_id", "chat_id", "repo_id"])
    .execute();

  await db.schema
    .createTable("oauth_states")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("provider", "varchar(32)", (c) => c.notNull())
    .addColumn("state", "varchar(128)", (c) => c.notNull())
    .addColumn("code_verifier", "varchar(128)", (c) => c.notNull())
    .addColumn("redirect_url", "text", (c) => c.notNull())
    .addColumn("identity_id", "varchar(36)", (c) => c.references("identities.id").onDelete("set null"))
    .addColumn("metadata_json", "text")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("expires_at", "bigint", (c) => c.notNull())
    .execute();

  await db.schema.createIndex("oauth_states_state_idx").on("oauth_states").column("state").execute();

  await db.schema.alterTable("audit_events").addColumn("identity_id", "varchar(36)").execute();
  await db.schema.alterTable("audit_events").addColumn("action", "varchar(64)").execute();
  await db.schema.alterTable("audit_events").addColumn("metadata_json", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("audit_events").dropColumn("metadata_json").execute();
  await db.schema.alterTable("audit_events").dropColumn("action").execute();
  await db.schema.alterTable("audit_events").dropColumn("identity_id").execute();

  await db.schema.dropTable("oauth_states").ifExists().execute();
  await db.schema.dropTable("shared_repos").ifExists().execute();
  await db.schema.dropTable("setup_specs").ifExists().execute();
  await db.schema.dropTable("secrets").ifExists().execute();
  await db.schema.dropTable("cloud_run_repos").ifExists().execute();
  await db.schema.dropTable("cloud_runs").ifExists().execute();
  await db.schema.dropTable("repos").ifExists().execute();
  await db.schema.dropTable("connections").ifExists().execute();
  await db.schema.dropTable("identities").ifExists().execute();
}
