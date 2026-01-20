import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("chatgpt_accounts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("chatgpt_user_id", "text", (col) => col.notNull())
    .addColumn("email", "text")
    .addColumn("access_token", "text", (col) => col.notNull())
    .addColumn("refresh_token", "text", (col) => col.notNull())
    .addColumn("expires_at", "integer", (col) => col.notNull())
    .addColumn("scope", "text")
    .addColumn("workspace_id", "text")
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("chatgpt_oauth_states")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull())
    .addColumn("code_verifier", "text", (col) => col.notNull())
    .addColumn("redirect_uri", "text", (col) => col.notNull())
    .addColumn("metadata_json", "text")
    .addColumn("expires_at", "integer", (col) => col.notNull())
    .addColumn("created_at", "integer", (col) => col.notNull())
    .execute();

  await db.schema.createIndex("chatgpt_accounts_identity_uq").on("chatgpt_accounts").column("identity_id").unique().execute();
  await db.schema.createIndex("chatgpt_accounts_user_idx").on("chatgpt_accounts").column("chatgpt_user_id").execute();
  await db.schema.createIndex("chatgpt_oauth_states_identity_uq").on("chatgpt_oauth_states").column("identity_id").unique().execute();
  await db.schema.createIndex("chatgpt_oauth_states_state_uq").on("chatgpt_oauth_states").column("state").unique().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("chatgpt_oauth_states_state_uq").ifExists().execute();
  await db.schema.dropIndex("chatgpt_oauth_states_identity_uq").ifExists().execute();
  await db.schema.dropIndex("chatgpt_accounts_user_idx").ifExists().execute();
  await db.schema.dropIndex("chatgpt_accounts_identity_uq").ifExists().execute();
  await db.schema.dropTable("chatgpt_oauth_states").ifExists().execute();
  await db.schema.dropTable("chatgpt_accounts").ifExists().execute();
}
