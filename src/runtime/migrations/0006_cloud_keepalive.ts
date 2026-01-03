import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("identities").addColumn("keepalive_minutes", "bigint").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("identities").dropColumn("keepalive_minutes").execute();
}
