import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sessions").addColumn("browserbase_session_id", "varchar(128)").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sessions").dropColumn("browserbase_session_id").execute();
}
