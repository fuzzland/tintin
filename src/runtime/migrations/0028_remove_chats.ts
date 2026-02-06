import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Drop index on multi_chat_id
  await db.schema.dropIndex("idx_sessions_multi_chat_id").execute();

  // 2. Drop multi_chat_id column from sessions
  await db.schema.alterTable("sessions").dropColumn("multi_chat_id").execute();

  // 3. Drop chats table index
  await db.schema.dropIndex("idx_chats_identity").execute();

  // 4. Drop chats table
  await db.schema.dropTable("chats").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // 1. Recreate chats table
  await db.schema
    .createTable("chats")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("title", "text")
    .addColumn("repo_id", "text")
    .addColumn("initial_prompt", "text", (col) => col.notNull())
    .addColumn("last_snapshot_id", "text")
    .addColumn("status", "text", (col) => col.defaultTo("active").notNull())
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();

  // 2. Recreate chats index
  await db.schema
    .createIndex("idx_chats_identity")
    .on("chats")
    .columns(["identity_id", "created_at"])
    .execute();

  // 3. Add multi_chat_id column back to sessions
  await db.schema
    .alterTable("sessions")
    .addColumn("multi_chat_id", "text")
    .execute();

  // 4. Recreate index on multi_chat_id
  await db.schema
    .createIndex("idx_sessions_multi_chat_id")
    .on("sessions")
    .columns(["multi_chat_id"])
    .execute();
}
