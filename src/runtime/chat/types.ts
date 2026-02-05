import type { ChatStatus } from "../db.js";

export interface Chat {
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

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sessionId: string;
  timestamp: number;
}

export interface SessionSummary {
  id: string;
  status: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface ChatDetail extends Chat {
  sessions: SessionSummary[];
  messages: ChatMessage[];
}

export interface CreateChatInput {
  identityId: string;
  prompt: string;
  repoId?: string;
}

export interface ListChatsOptions {
  limit?: number;
  cursor?: string;
}

// Row type for database operations
export interface ChatRow {
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

// Convert database row to domain object
export function chatFromRow(row: ChatRow): Chat {
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
