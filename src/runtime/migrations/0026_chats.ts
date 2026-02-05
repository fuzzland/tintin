import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Create chats table for multi-chat support
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

  // 2. Create index for listing chats by identity
  await db.schema
    .createIndex("idx_chats_identity")
    .on("chats")
    .columns(["identity_id", "created_at"])
    .execute();

  // 3. Add multi_chat_id column to sessions table
  // Note: Using multi_chat_id because chat_id already exists for platform chat IDs
  await db.schema
    .alterTable("sessions")
    .addColumn("multi_chat_id", "text")
    .execute();

  // 4. Create index for sessions by multi_chat_id
  await db.schema
    .createIndex("idx_sessions_multi_chat_id")
    .on("sessions")
    .columns(["multi_chat_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_sessions_multi_chat_id").execute();
  await db.schema.alterTable("sessions").dropColumn("multi_chat_id").execute();
  await db.schema.dropIndex("idx_chats_identity").execute();
  await db.schema.dropTable("chats").execute();
}
