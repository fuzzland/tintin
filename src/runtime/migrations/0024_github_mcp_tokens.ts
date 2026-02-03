import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("github_mcp_tokens")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("identity_id", "varchar(36)", (c) => c.notNull())
    .addColumn("encrypted_token", "text", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .execute();

  await db.schema
    .createIndex("github_mcp_tokens_identity_uq")
    .on("github_mcp_tokens")
    .column("identity_id")
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("github_mcp_tokens_identity_uq").ifExists().execute();
  await db.schema.dropTable("github_mcp_tokens").ifExists().execute();
}
