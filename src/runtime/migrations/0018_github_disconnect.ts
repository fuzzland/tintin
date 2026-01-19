import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("connections").addColumn("installation_id", "varchar(64)").execute();
  await db.schema.createIndex("connections_installation_idx").on("connections").column("installation_id").execute();

  await db.schema
    .createTable("github_installations")
    .addColumn("installation_id", "varchar(64)", (c) => c.primaryKey())
    .addColumn("app_id", "varchar(64)", (c) => c.notNull())
    .addColumn("account_login", "varchar(128)")
    .addColumn("account_type", "varchar(32)")
    .addColumn("status", "varchar(32)", (c) => c.notNull().defaultTo("active"))
    .addColumn("permissions_json", "text")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("github_installation_tokens")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("installation_id", "varchar(64)", (c) => c.notNull())
    .addColumn("encrypted_token", "text", (c) => c.notNull())
    .addColumn("expires_at", "bigint")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("github_installation_tokens_installation_uq")
    .unique()
    .on("github_installation_tokens")
    .column("installation_id")
    .execute();

  await db.schema
    .createTable("github_installation_repos")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("installation_id", "varchar(64)", (c) => c.notNull())
    .addColumn("provider_repo_id", "varchar(128)", (c) => c.notNull())
    .addColumn("full_name", "varchar(256)", (c) => c.notNull())
    .addColumn("url", "text", (c) => c.notNull())
    .addColumn("default_branch", "varchar(128)")
    .addColumn("archived", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("private", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("permissions_json", "text")
    .addColumn("removed_at", "bigint")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("github_installation_repos_installation_repo_uq")
    .unique()
    .on("github_installation_repos")
    .columns(["installation_id", "provider_repo_id"])
    .execute();

  await db.schema
    .createTable("github_installation_identities")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("installation_id", "varchar(64)", (c) => c.notNull())
    .addColumn("identity_id", "varchar(36)", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("github_installation_identities_uq")
    .unique()
    .on("github_installation_identities")
    .columns(["installation_id", "identity_id"])
    .execute();

  await db.schema
    .createTable("github_webhook_events")
    .addColumn("delivery_id", "varchar(128)", (c) => c.primaryKey())
    .addColumn("event", "varchar(64)", (c) => c.notNull())
    .addColumn("action", "varchar(64)")
    .addColumn("installation_id", "varchar(64)")
    .addColumn("repo_id", "varchar(128)")
    .addColumn("headers_json", "text", (c) => c.notNull())
    .addColumn("payload_json", "text", (c) => c.notNull())
    .addColumn("received_at", "bigint", (c) => c.notNull())
    .addColumn("processed_at", "bigint")
    .addColumn("status", "varchar(32)")
    .addColumn("error", "text")
    .execute();
  await db.schema
    .createIndex("github_webhook_events_installation_idx")
    .on("github_webhook_events")
    .column("installation_id")
    .execute();

  await db.schema
    .createTable("pending_actions")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("action", "varchar(64)", (c) => c.notNull())
    .addColumn("identity_id", "varchar(36)", (c) => c.notNull())
    .addColumn("token_hash", "varchar(128)", (c) => c.notNull())
    .addColumn("payload_json", "text", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("expires_at", "bigint", (c) => c.notNull())
    .addColumn("consumed_at", "bigint")
    .execute();
  await db.schema.createIndex("pending_actions_identity_idx").on("pending_actions").column("identity_id").execute();
  await db.schema.createIndex("pending_actions_action_idx").on("pending_actions").column("action").execute();
  await db.schema.createIndex("pending_actions_token_idx").on("pending_actions").column("token_hash").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("pending_actions_action_idx").ifExists().execute();
  await db.schema.dropIndex("pending_actions_identity_idx").ifExists().execute();
  await db.schema.dropIndex("pending_actions_token_idx").ifExists().execute();
  await db.schema.dropTable("pending_actions").ifExists().execute();

  await db.schema.dropIndex("github_webhook_events_installation_idx").ifExists().execute();
  await db.schema.dropTable("github_webhook_events").ifExists().execute();

  await db.schema.dropIndex("github_installation_identities_uq").ifExists().execute();
  await db.schema.dropTable("github_installation_identities").ifExists().execute();

  await db.schema.dropIndex("github_installation_repos_installation_repo_uq").ifExists().execute();
  await db.schema.dropTable("github_installation_repos").ifExists().execute();

  await db.schema.dropIndex("github_installation_tokens_installation_uq").ifExists().execute();
  await db.schema.dropTable("github_installation_tokens").ifExists().execute();

  await db.schema.dropTable("github_installations").ifExists().execute();

  await db.schema.dropIndex("connections_installation_idx").ifExists().execute();
  await db.schema.alterTable("connections").dropColumn("installation_id").execute();
}
