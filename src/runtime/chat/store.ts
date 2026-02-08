import crypto from "node:crypto";
import type { Db } from "../db.js";
import { nowMs } from "../util.js";
import { chatFromRow, type ChatCreateInput, type ChatListOptions, type ChatRecord, type ChatDb } from "./types.js";

const asChatDb = (db: Db): ChatDb => db as unknown as ChatDb;

export async function insertChat(db: Db, input: ChatCreateInput): Promise<ChatRecord> {
  const now = nowMs();
  const id = input.id ?? crypto.randomUUID();
  const chatDb = asChatDb(db);

  await chatDb
    .insertInto("chats")
    .values({
      id,
      identity_id: input.identityId,
      title: input.title,
      repo_id: input.repoId,
      initial_prompt: input.initialPrompt,
      last_snapshot_id: null,
      status: input.status,
      created_at: now,
      updated_at: now,
    })
    .execute();

  const row = await chatDb
    .selectFrom("chats")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

  return chatFromRow(row);
}

export async function selectChatById(db: Db, chatId: string): Promise<ChatRecord | null> {
  const chatDb = asChatDb(db);
  const row = await chatDb
    .selectFrom("chats")
    .selectAll()
    .where("id", "=", chatId)
    .executeTakeFirst();
  return row ? chatFromRow(row) : null;
}

export async function selectChatsByIdentity(db: Db, identityId: string, options: ChatListOptions = {}): Promise<ChatRecord[]> {
  const limit = options.limit ?? 50;
  const chatDb = asChatDb(db);
  let query = chatDb
    .selectFrom("chats")
    .selectAll()
    .where("identity_id", "=", identityId)
    .where("status", "=", "active")
    .orderBy("created_at", "desc")
    .limit(limit);

  if (options.cursor) {
    query = query.where("created_at", "<", parseInt(options.cursor, 10));
  }

  const rows = await query.execute();
  return rows.map(chatFromRow);
}

export async function updateChatSnapshot(db: Db, chatId: string, snapshotId: string): Promise<void> {
  const chatDb = asChatDb(db);
  const now = nowMs();
  await chatDb
    .updateTable("chats")
    .set({
      last_snapshot_id: snapshotId,
      updated_at: now,
    })
    .where("id", "=", chatId)
    .execute();
}

export async function updateChatTitle(db: Db, chatId: string, title: string): Promise<void> {
  const chatDb = asChatDb(db);
  const now = nowMs();
  await chatDb
    .updateTable("chats")
    .set({
      title,
      updated_at: now,
    })
    .where("id", "=", chatId)
    .execute();
}

export async function deleteChatById(db: Db, chatId: string): Promise<void> {
  const chatDb = asChatDb(db);
  await chatDb.deleteFrom("chats").where("id", "=", chatId).execute();
}

export async function archiveChatById(db: Db, chatId: string): Promise<void> {
  const chatDb = asChatDb(db);
  const now = nowMs();
  await chatDb
    .updateTable("chats")
    .set({
      status: "archived",
      updated_at: now,
    })
    .where("id", "=", chatId)
    .execute();
}
