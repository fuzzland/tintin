import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("setup_specs").addColumn("snapshot_id", "varchar(128)").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("setup_specs").dropColumn("snapshot_id").execute();
}
