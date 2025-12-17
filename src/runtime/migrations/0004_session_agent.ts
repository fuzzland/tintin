import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("agent", "varchar(16)", (c) => c.notNull().defaultTo("codex"))
    .execute();

  await db.schema
    .alterTable("wizard_states")
    .addColumn("agent", "varchar(16)", (c) => c.notNull().defaultTo("codex"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("wizard_states").dropColumn("agent").execute();
  await db.schema.alterTable("sessions").dropColumn("agent").execute();
}

