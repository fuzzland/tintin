import type { Db, SessionAgent, SessionStatus, WizardState } from "./db.js";
import { nowMs } from "./util.js";

export interface WizardStateRow {
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

export async function getWizardState(db: Db, platform: string, chatId: string, userId: string) {
  return db
    .selectFrom("wizard_states")
    .selectAll()
    .where("platform", "=", platform)
    .where("chat_id", "=", chatId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

export async function setWizardState(
  db: Db,
  row: Omit<WizardStateRow, "created_at" | "updated_at"> & { created_at?: number; updated_at?: number },
) {
  const now = nowMs();
  const createdAt = row.created_at ?? now;
  const updatedAt = row.updated_at ?? now;

  await db
    .deleteFrom("wizard_states")
    .where("platform", "=", row.platform)
    .where("chat_id", "=", row.chat_id)
    .where("user_id", "=", row.user_id)
    .execute();

  await db
    .insertInto("wizard_states")
    .values({
      ...row,
      created_at: createdAt,
      updated_at: updatedAt,
    })
    .execute();
}

export async function clearWizardState(db: Db, platform: string, chatId: string, userId: string) {
  await db
    .deleteFrom("wizard_states")
    .where("platform", "=", platform)
    .where("chat_id", "=", chatId)
    .where("user_id", "=", userId)
    .execute();
}

export interface SessionRow {
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

export async function getSessionBySpace(db: Db, platform: string, chatId: string, spaceId: string) {
  return db
    .selectFrom("sessions")
    .selectAll()
    .where("platform", "=", platform)
    .where("chat_id", "=", chatId)
    .where("space_id", "=", spaceId)
    .executeTakeFirst();
}

export async function countSessionsForChat(db: Db, platform: string, chatId: string) {
  const row = await db
    .selectFrom("sessions")
    .select(({ fn }) => fn.countAll().as("count"))
    .where("platform", "=", platform)
    .where("chat_id", "=", chatId)
    .executeTakeFirst();
  return Number((row as any)?.count ?? 0);
}

export async function countConcurrentSessionsForChat(db: Db, platform: string, chatId: string) {
  const row = await db
    .selectFrom("sessions")
    .select(({ fn }) => fn.countAll().as("count"))
    .where("platform", "=", platform)
    .where("chat_id", "=", chatId)
    .where("status", "in", ["starting", "running"])
    .executeTakeFirst();
  return Number((row as any)?.count ?? 0);
}

export async function createSession(db: Db, row: SessionRow) {
  await db.insertInto("sessions").values(row).execute();
}

export async function updateSession(db: Db, sessionId: string, patch: Partial<SessionRow>) {
  const now = nowMs();
  await db.updateTable("sessions").set({ ...patch, updated_at: now }).where("id", "=", sessionId).execute();
}

export async function listRunningSessions(db: Db) {
  return db.selectFrom("sessions").selectAll().where("status", "=", "running").execute();
}

export interface SessionListPage {
  sessions: SessionRow[];
  page: number;
  limit: number;
  hasMore: boolean;
}

export async function listSessionsForChat(opts: {
  db: Db;
  platform: string;
  chatId: string;
  workspaceId?: string | null;
  statuses?: SessionStatus[];
  limit?: number;
  page?: number;
}): Promise<SessionListPage> {
  const limitRaw = typeof opts.limit === "number" ? opts.limit : null;
  const limit = Number.isFinite(limitRaw) && limitRaw && limitRaw > 0 ? Math.floor(limitRaw) : 20;
  const pageRaw = typeof opts.page === "number" ? opts.page : null;
  const page = Number.isFinite(pageRaw) && pageRaw && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const offset = (page - 1) * limit;

  let q = opts.db
    .selectFrom("sessions")
    .selectAll()
    .where("platform", "=", opts.platform)
    .where("chat_id", "=", opts.chatId);

  if (opts.platform === "slack" && opts.workspaceId) {
    q = q.where("workspace_id", "=", opts.workspaceId);
  }
  if (opts.statuses && opts.statuses.length > 0) {
    q = q.where("status", "in", opts.statuses);
  }

  const rows = await q.orderBy("created_at", "desc").limit(limit + 1).offset(offset).execute();
  const sessions = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { sessions, page, limit, hasMore };
}

export interface SessionStreamOffsetRow {
  id: string;
  session_id: string;
  jsonl_path: string;
  byte_offset: number;
  updated_at: number;
}

export async function listSessionOffsets(db: Db, sessionId: string) {
  return db.selectFrom("session_stream_offsets").selectAll().where("session_id", "=", sessionId).execute();
}

export async function upsertSessionOffset(db: Db, row: SessionStreamOffsetRow) {
  const now = nowMs();
  const res = await db
    .updateTable("session_stream_offsets")
    .set({ byte_offset: row.byte_offset, updated_at: now })
    .where("session_id", "=", row.session_id)
    .where("jsonl_path", "=", row.jsonl_path)
    .executeTakeFirst();

  const updated = Number(res.numUpdatedRows ?? 0);
  if (updated > 0) return;

  await db
    .insertInto("session_stream_offsets")
    .values({ ...row, updated_at: now })
    .execute();
}

export async function writeAuditEvent(db: Db, row: { id: string; session_id: string | null; kind: string; payload_json: string }) {
  await db
    .insertInto("audit_events")
    .values({ ...row, created_at: nowMs() })
    .execute();
}

export interface PendingMessageRow {
  id: string;
  session_id: string;
  user_id: string;
  message_text: string;
  created_at: number;
  consumed_at: number | null;
}

export async function enqueuePendingMessage(db: Db, row: Omit<PendingMessageRow, "created_at" | "consumed_at">) {
  await db
    .insertInto("session_pending_messages")
    .values({
      ...row,
      created_at: nowMs(),
      consumed_at: null,
    })
    .execute();
}

export async function listPendingMessages(db: Db, sessionId: string, limit = 50): Promise<PendingMessageRow[]> {
  return db
    .selectFrom("session_pending_messages")
    .selectAll()
    .where("session_id", "=", sessionId)
    .where("consumed_at", "is", null)
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute();
}

export async function countPendingMessages(db: Db, sessionId: string): Promise<number> {
  const row = await db
    .selectFrom("session_pending_messages")
    .select(({ fn }) => fn.countAll().as("count"))
    .where("session_id", "=", sessionId)
    .where("consumed_at", "is", null)
    .executeTakeFirst();
  return Number((row as any)?.count ?? 0);
}

export async function consumePendingMessages(db: Db, ids: string[]) {
  if (ids.length === 0) return;
  await db
    .updateTable("session_pending_messages")
    .set({ consumed_at: nowMs() })
    .where("id", "in", ids)
    .execute();
}
