import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("cloud_run_screenshots")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("run_id", "varchar(36)", (c) => c.notNull().references("cloud_runs.id").onDelete("cascade"))
    .addColumn("session_id", "varchar(36)", (c) => c.references("sessions.id").onDelete("set null"))
    .addColumn("s3_key", "text", (c) => c.notNull())
    .addColumn("mime_type", "varchar(64)")
    .addColumn("tool", "varchar(64)")
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .execute();

  await db.schema.createIndex("cloud_run_screenshots_run_idx").on("cloud_run_screenshots").column("run_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("cloud_run_screenshots").ifExists().execute();
}
