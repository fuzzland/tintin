import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add prompt column to cloud_runs to store the run command text for snapshot titles/notes.
  try {
    await db.schema.alterTable("cloud_runs").addColumn("prompt", "text", (col) => col.notNull().defaultTo("")).execute();
  } catch {
    // Column may already exist (e.g., in some environments); ignore.
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // No-op: dropping columns is not portable across all supported dialects.
  return;
}
