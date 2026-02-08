import type { Kysely } from "kysely";
import type { DatabaseSchema, SessionsTable } from "../db.js";

export type ChatStatus = "active" | "archived";

export interface ChatsTable {
  id: string;
  identity_id: string;
  title: string | null;
  repo_id: string | null;
  initial_prompt: string;
  last_snapshot_id: string | null;
  status: ChatStatus;
  created_at: number;
  updated_at: number;
}

export type ChatRow = ChatsTable;

export interface ChatRecord {
  id: string;
  identityId: string;
  title: string | null;
  repoId: string | null;
  initialPrompt: string;
  lastSnapshotId: string | null;
  status: ChatStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ChatCreateInput {
  id?: string;
  identityId: string;
  title: string;
  repoId: string | null;
  initialPrompt: string;
  status: ChatStatus;
}

export interface ChatListOptions {
  limit?: number;
  cursor?: string;
}

export interface ChatSessionSummary {
  id: string;
  status: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface ChatDetail extends ChatRecord {
  sessions: ChatSessionSummary[];
  messages: unknown[];
}

export type ChatSessionsTable = SessionsTable & { multi_chat_id: string | null };

export type ChatDatabaseSchema = DatabaseSchema & {
  chats: ChatsTable;
  sessions: ChatSessionsTable;
};

export type ChatDb = Kysely<ChatDatabaseSchema>;

export function chatFromRow(row: ChatRow): ChatRecord {
  return {
    id: row.id,
    identityId: row.identity_id,
    title: row.title,
    repoId: row.repo_id,
    initialPrompt: row.initial_prompt,
    lastSnapshotId: row.last_snapshot_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
