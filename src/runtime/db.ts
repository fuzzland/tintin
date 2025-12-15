import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import { Pool as PgPool, types as pgTypes } from "pg";
import mysql from "mysql2/promise";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Logger } from "./log.js";
import type { AppConfig } from "./config.js";

export type SessionStatus = "wizard" | "starting" | "running" | "finished" | "error" | "killed";

export interface SessionsTable {
  id: string;
  platform: string;
  workspace_id: string | null;
  chat_id: string;
  space_id: string;
  created_by_user_id: string;
  project_id: string;
  project_path_resolved: string;
  codex_session_id: string | null;
  codex_cwd: string;
  status: SessionStatus;
  pid: number | null;
  exit_code: number | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
  last_user_message_at: number | null;
}

export interface SessionStreamOffsetsTable {
  id: string;
  session_id: string;
  jsonl_path: string;
  byte_offset: number;
  updated_at: number;
}

export type WizardState = "await_project" | "await_custom_path" | "await_initial_prompt";

export interface WizardStatesTable {
  id: string;
  platform: string;
  chat_id: string;
  user_id: string;
  state: WizardState;
  project_id: string | null;
  custom_path_candidate: string | null;
  created_at: number;
  updated_at: number;
}

export interface AuditEventsTable {
  id: string;
  session_id: string | null;
  kind: string;
  payload_json: string;
  created_at: number;
}

export interface SessionPendingMessagesTable {
  id: string;
  session_id: string;
  user_id: string;
  message_text: string;
  created_at: number;
  consumed_at: number | null;
}

export interface DatabaseSchema {
  sessions: SessionsTable;
  session_stream_offsets: SessionStreamOffsetsTable;
  wizard_states: WizardStatesTable;
  audit_events: AuditEventsTable;
  session_pending_messages: SessionPendingMessagesTable;
}

export type Db = Kysely<DatabaseSchema>;

function normalizeDbUrl(url: string): string {
  if (url.startsWith("postgresql+asyncpg://")) return `postgresql://${url.slice("postgresql+asyncpg://".length)}`;
  if (url.startsWith("postgres+asyncpg://")) return `postgres://${url.slice("postgres+asyncpg://".length)}`;
  if (url.startsWith("mysql+aiomysql://")) return `mysql://${url.slice("mysql+aiomysql://".length)}`;
  return url;
}

function parseSqliteFilePath(sqliteUrl: string, baseDir: string): string {
  // Supports SQLAlchemy-style:
  // - sqlite+aiosqlite:///./relative.db
  // - sqlite:////absolute/path.db
  // - sqlite:///:memory:
  const m = sqliteUrl.match(/^sqlite(?:\+[^:]+)?:([/]{0,4})(.*)$/);
  if (!m) throw new Error(`Invalid sqlite URL: ${sqliteUrl}`);
  const slashes = m[1] ?? "";
  const rest = m[2] ?? "";
  if (rest === ":memory:" || rest.startsWith(":memory:")) return ":memory:";
  if (slashes === "////") return `/${rest}`;
  if (slashes === "///") return path.resolve(baseDir, rest);
  if (slashes === "//") throw new Error(`sqlite URL with authority not supported: ${sqliteUrl}`);
  return path.resolve(baseDir, `${slashes}${rest}`);
}

export async function createDatabase(config: AppConfig, logger: Logger): Promise<Db> {
  const url = normalizeDbUrl(config.db.url);

  if (url.startsWith("sqlite")) {
    const filePath = parseSqliteFilePath(url, config.config_dir);
    logger.info(`DB: sqlite (${filePath === ":memory:" ? "memory" : filePath})`);
    if (filePath !== ":memory:") {
      await mkdir(path.dirname(filePath), { recursive: true });
    }
    const sqlite = new Database(filePath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    return new Kysely<DatabaseSchema>({
      dialect: new SqliteDialect({ database: sqlite }),
    });
  }

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    logger.info("DB: postgres");
    // Parse int8/bigint as number when safe.
    pgTypes.setTypeParser(20, (val: string) => {
      const n = Number(val);
      return Number.isSafeInteger(n) ? n : val;
    });
    const pool = new PgPool({ connectionString: url });
    return new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
    });
  }

  if (url.startsWith("mysql://")) {
    logger.info("DB: mysql");
    const pool = mysql.createPool(url);
    return new Kysely<DatabaseSchema>({
      dialect: new MysqlDialect({ pool }),
    });
  }

  throw new Error(`Unsupported DB URL scheme: ${config.db.url}`);
}
