import { Kysely, SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import type { Db, DatabaseSchema } from "../../src/runtime/db.js";

export async function createTestDb(): Promise<Db> {
  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new Database(":memory:"),
    }),
  });

  // Create chats table for tests
  await db.schema
    .createTable("chats")
    .ifNotExists()
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

  // Create sessions table with multi_chat_id for tests
  await db.schema
    .createTable("sessions")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("agent", "text", (col) => col.notNull())
    .addColumn("platform", "text", (col) => col.notNull())
    .addColumn("workspace_id", "text")
    .addColumn("chat_id", "text", (col) => col.notNull())
    .addColumn("space_id", "text", (col) => col.notNull())
    .addColumn("space_emoji", "text")
    .addColumn("created_by_user_id", "text", (col) => col.notNull())
    .addColumn("project_id", "text", (col) => col.notNull())
    .addColumn("project_path_resolved", "text", (col) => col.notNull())
    .addColumn("codex_session_id", "text")
    .addColumn("browserbase_session_id", "text")
    .addColumn("hyperbrowser_session_id", "text")
    .addColumn("codex_cwd", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("pid", "integer")
    .addColumn("exit_code", "integer")
    .addColumn("started_at", "integer")
    .addColumn("finished_at", "integer")
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .addColumn("last_user_message_at", "integer")
    .addColumn("language", "text", (col) => col.defaultTo("en").notNull())
    .addColumn("multi_chat_id", "text")
    .execute();

  return db;
}

export async function closeTestDb(db: Db): Promise<void> {
  await db.destroy();
}
