import type { Db } from "../../db.js";
import type { Logger } from "../../log.js";
import type { WebSocketManager } from "../manager.js";
import type { WSConnection } from "../types.js";
import { ErrorCodes } from "../types.js";
import { ChatService } from "../../chat/index.js";
import { IdentityResolver } from "./identity.js";
import type { CloudManager } from "../../cloud/manager.js";

/**
 * ChatSessionService - Handles chat-based WebSocket connections.
 *
 * Responsibilities:
 * - Validate chat ownership
 * - Send chat info and history on connection
 * - Coordinate workspace restoration (when snapshots exist)
 */
export class ChatSessionService {
  private readonly chatService: ChatService;
  private readonly identityResolver: IdentityResolver;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly cloudManager: CloudManager | null,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {
    this.chatService = new ChatService(db, logger);
    this.identityResolver = new IdentityResolver(db);
  }

  /**
   * Handle a chat_connect message from the client.
   * Validates ownership, sends chat info, and loads history.
   */
  async handleChatConnect(connId: string, conn: WSConnection, chatId: string): Promise<void> {
    if (!conn.identityId) {
      this.logger.warn(`[chat-ws] no identity for connection connId=${connId}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.AUTH_REQUIRED,
        message: 'Not authenticated',
      });
      return;
    }

    // Resolve database identity
    const dbIdentityId = await this.identityResolver.resolve(conn.identityId);

    // Load chat and verify ownership
    const chat = await this.chatService.getChat(chatId, dbIdentityId);
    if (!chat) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.ACCESS_DENIED,
        message: 'Chat not found',
      });
      return;
    }

    this.logger.info(`[chat-ws] connected connId=${connId} chatId=${chatId} identity=${dbIdentityId}`);

    // Send chat info
    this.wsManager.sendToConnection(connId, {
      type: 'chat_info',
      chatId: chat.id,
      title: chat.title,
      repoId: chat.repoId,
      hasSnapshot: Boolean(chat.lastSnapshotId),
      status: chat.lastSnapshotId ? 'restoring' : 'ready',
    });

    // Load and send chat history
    await this.sendChatHistory(connId, chat.id);

    // If there's a snapshot and cloud is enabled, notify about restoration
    // (Actual restoration happens when the client sends a cloud_run or follow-up)
    if (chat.lastSnapshotId && this.cloudManager) {
      this.logger.debug(`[chat-ws] chat has snapshot connId=${connId} chatId=${chatId} snapshot=${chat.lastSnapshotId}`);

      // Send ready status - workspace restoration is handled by cloud_run flow
      this.wsManager.sendToConnection(connId, {
        type: 'chat_info',
        chatId: chat.id,
        title: chat.title,
        repoId: chat.repoId,
        hasSnapshot: true,
        status: 'ready',
      });
    }
  }

  /**
   * Load and send chat message history to the client.
   */
  private async sendChatHistory(connId: string, chatId: string): Promise<void> {
    // Load sessions for this chat
    const sessions = await this.db
      .selectFrom("sessions")
      .select(["id", "created_at"])
      .where("multi_chat_id", "=", chatId)
      .orderBy("created_at", "asc")
      .execute();

    // TODO: In the future, load actual messages from JSONL files
    // For now, we send an empty history - the client will see new messages
    // as they stream in via the existing WebSocket message flow
    const messages: Array<{
      role: "user" | "assistant";
      content: string;
      sessionId: string;
      timestamp: number;
    }> = [];

    this.wsManager.sendToConnection(connId, {
      type: 'chat_history',
      messages,
    });

    this.logger.debug(`[chat-ws] sent history connId=${connId} chatId=${chatId} sessions=${sessions.length}`);
  }
}
