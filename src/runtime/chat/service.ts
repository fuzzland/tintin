import crypto from "node:crypto";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import { insertChat, selectChatById, selectChatsByIdentity, updateChatSnapshot, deleteChatById } from "./store.js";
import type { ChatDetail, ChatListOptions, ChatDb, ChatSessionSummary } from "./types.js";

const MAX_TITLE_LENGTH = 60;

export class ChatService {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  async createChat(input: { identityId: string; prompt: string; repoId?: string }): Promise<ChatDetail> {
    const chatId = crypto.randomUUID();
    const title = this.generateTitle(input.prompt);
    const chat = await insertChat(this.db, {
      id: chatId,
      identityId: input.identityId,
      title,
      repoId: input.repoId ?? null,
      initialPrompt: input.prompt,
      status: "active",
    });

    this.logger.info(`[chat] created chat=${chatId} identity=${input.identityId}`);
    return {
      ...chat,
      sessions: [],
      messages: [],
    };
  }

  async listChats(identityId: string, options: ChatListOptions = {}) {
    return selectChatsByIdentity(this.db, identityId, options);
  }

  async getChat(chatId: string, identityId: string): Promise<ChatDetail | null> {
    const chat = await selectChatById(this.db, chatId);
    if (!chat || chat.identityId !== identityId) {
      return null;
    }

    const sessions = await this.getSessionsForChat(chatId);
    return {
      ...chat,
      sessions,
      messages: [],
    };
  }

  async deleteChat(chatId: string, identityId: string): Promise<boolean> {
    const chat = await selectChatById(this.db, chatId);
    if (!chat || chat.identityId !== identityId) {
      return false;
    }
    await deleteChatById(this.db, chatId);
    this.logger.info(`[chat] deleted chat=${chatId}`);
    return true;
  }

  async updateSnapshot(chatId: string, snapshotId: string): Promise<void> {
    await updateChatSnapshot(this.db, chatId, snapshotId);
    this.logger.debug(`[chat] updated snapshot chat=${chatId} snapshot=${snapshotId}`);
  }

  generateTitle(prompt: string): string {
    const firstLine = prompt.split("\n")[0]?.trim() ?? prompt.trim();
    if (firstLine.length <= MAX_TITLE_LENGTH) {
      return firstLine;
    }

    const truncated = firstLine.substring(0, MAX_TITLE_LENGTH);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > MAX_TITLE_LENGTH / 2) {
      return truncated.substring(0, lastSpace) + "...";
    }
    return truncated.trimEnd() + "...";
  }

  private async getSessionsForChat(chatId: string): Promise<ChatSessionSummary[]> {
    const chatDb = this.db as unknown as ChatDb;
    const rows = await chatDb
      .selectFrom("sessions")
      .select(["id", "status", "created_at", "finished_at"])
      .where("multi_chat_id", "=", chatId)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    }));
  }
}
