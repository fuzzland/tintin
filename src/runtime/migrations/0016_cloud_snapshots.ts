import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("cloud_snapshots")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("run_id", "text", (col) => col.notNull())
    .addColumn("sandbox_id", "text", (col) => col.notNull())
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("note", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("source_status", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("vector_id", "text", (col) => col.notNull())
    .execute();

  await db.schema.createIndex("cloud_snapshots_run_id_idx").on("cloud_snapshots").column("run_id").execute();
  await db.schema
    .createIndex("cloud_snapshots_identity_created_idx")
    .on("cloud_snapshots")
    .columns(["identity_id", "created_at"])
    .execute();
  await db.schema.createIndex("cloud_snapshots_sandbox_id_uq").unique().on("cloud_snapshots").column("sandbox_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("cloud_snapshots_sandbox_id_uq").ifExists().execute();
  await db.schema.dropIndex("cloud_snapshots_identity_created_idx").ifExists().execute();
  await db.schema.dropIndex("cloud_snapshots_run_id_idx").ifExists().execute();
  await db.schema.dropTable("cloud_snapshots").execute();
}
