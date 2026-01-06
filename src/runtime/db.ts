import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import { Pool as PgPool, types as pgTypes } from "pg";
import mysql from "mysql2/promise";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Logger } from "./log.js";
import type { AppConfig } from "./config.js";

export type SessionStatus = "wizard" | "starting" | "running" | "finished" | "error" | "killed";
export type SessionAgent = "codex" | "claude_code";

export interface SessionsTable {
  id: string;
  agent: SessionAgent;
  platform: string;
  workspace_id: string | null;
  chat_id: string;
  space_id: string;
  space_emoji: string | null;
  created_by_user_id: string;
  project_id: string;
  project_path_resolved: string;
  codex_session_id: string | null;
  browserbase_session_id: string | null;
  hyperbrowser_session_id: string | null;
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
  agent: SessionAgent;
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
  identity_id: string | null;
  action: string | null;
  metadata_json: string | null;
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

export interface IdentitiesTable {
  id: string;
  platform: string;
  workspace_id: string | null;
  user_id: string;
  active_repo_id: string | null;
  onboarded_at: number | null;
  keepalive_minutes: number | null;
  message_verbosity: number | null;
  branch_name_rule: string | null;
  git_user_name: string | null;
  git_user_email: string | null;
  created_at: number;
  updated_at: number;
}

export interface ConnectionsTable {
  id: string;
  identity_id: string;
  type: string;
  access_token: string;
  refresh_token: string | null;
  scope: string | null;
  token_expires_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface ReposTable {
  id: string;
  connection_id: string;
  provider: string;
  provider_repo_id: string | null;
  name: string;
  url: string;
  default_branch: string | null;
  fingerprint: string | null;
  created_at: number;
  updated_at: number;
}

export type CloudRunStatus = "queued" | "running" | "finished" | "error" | "killed";

export interface CloudRunsTable {
  id: string;
  identity_id: string;
  primary_repo_id: string | null;
  provider: string;
  workspace_id: string;
  status: CloudRunStatus;
  session_id: string | null;
  snapshot_id: string | null;
  diff_summary: string | null;
  diff_patch: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CloudRunReposTable {
  id: string;
  run_id: string;
  repo_id: string;
  mount_path: string;
}

export interface CloudRunScreenshotsTable {
  id: string;
  run_id: string;
  session_id: string | null;
  s3_key: string;
  mime_type: string | null;
  tool: string | null;
  created_at: number;
}

export interface CloudWorkspacesTable {
  id: string;
  provider: string;
  run_id: string | null;
  identity_id: string | null;
  expires_at: number;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
}

export interface SecretsTable {
  id: string;
  identity_id: string;
  name: string;
  encrypted_value: string;
  created_at: number;
  updated_at: number;
}

export interface SetupSpecsTable {
  id: string;
  repo_id: string;
  yml_blob: string;
  hash: string;
  snapshot_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SharedReposTable {
  id: string;
  platform: string;
  workspace_id: string | null;
  chat_id: string;
  repo_id: string;
  shared_by_identity_id: string;
  shared_at: number;
}

export interface OAuthStatesTable {
  id: string;
  provider: string;
  state: string;
  code_verifier: string;
  redirect_url: string;
  identity_id: string | null;
  metadata_json: string | null;
  created_at: number;
  expires_at: number;
}

export interface DatabaseSchema {
  sessions: SessionsTable;
  session_stream_offsets: SessionStreamOffsetsTable;
  wizard_states: WizardStatesTable;
  audit_events: AuditEventsTable;
  session_pending_messages: SessionPendingMessagesTable;
  identities: IdentitiesTable;
  connections: ConnectionsTable;
  repos: ReposTable;
  cloud_runs: CloudRunsTable;
  cloud_run_repos: CloudRunReposTable;
  cloud_run_screenshots: CloudRunScreenshotsTable;
  cloud_workspaces: CloudWorkspacesTable;
  secrets: SecretsTable;
  setup_specs: SetupSpecsTable;
  shared_repos: SharedReposTable;
  oauth_states: OAuthStatesTable;
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
