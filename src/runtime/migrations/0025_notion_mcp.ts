import type { Kysely } from "kysely";

export async function up(db: Kysely<any>) {
  await db.schema
    .createTable("notion_mcp_clients")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("client_id", "text", (col) => col.notNull())
    .addColumn("client_secret", "text", (col) => col.notNull())
    .addColumn("registration_uri", "text")
    .addColumn("auth_endpoint", "text", (col) => col.notNull())
    .addColumn("token_endpoint", "text", (col) => col.notNull())
    .addColumn("created_at", "bigint", (col) => col.notNull())
    .addColumn("updated_at", "bigint", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("notion_mcp_tokens")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("client_id", "text", (col) => col.notNull())
    .addColumn("encrypted_access_token", "text", (col) => col.notNull())
    .addColumn("encrypted_refresh_token", "text", (col) => col.notNull())
    .addColumn("expires_at", "bigint")
    .addColumn("bot_id", "text")
    .addColumn("workspace_name", "text")
    .addColumn("workspace_icon", "text")
    .addColumn("created_at", "bigint", (col) => col.notNull())
    .addColumn("updated_at", "bigint", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("notion_mcp_tokens_identity_uq")
    .on("notion_mcp_tokens")
    .column("identity_id")
    .unique()
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.dropIndex("notion_mcp_tokens_identity_uq").ifExists().execute();
  await db.schema.dropTable("notion_mcp_tokens").ifExists().execute();
  await db.schema.dropTable("notion_mcp_clients").ifExists().execute();
}
