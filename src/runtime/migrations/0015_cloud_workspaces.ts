import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("cloud_workspaces")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("run_id", "text")
    .addColumn("identity_id", "text")
    .addColumn("expires_at", "integer", (col) => col.notNull())
    .addColumn("last_seen_at", "integer", (col) => col.notNull())
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("cloud_workspaces_expires_idx").on("cloud_workspaces").column("expires_at").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("cloud_workspaces_expires_idx").ifExists().execute();
  await db.schema.dropTable("cloud_workspaces").execute();
}
