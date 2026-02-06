/**
 * WebSocketAdapter - WebSocket-specific message handling.
 *
 * Converts WebSocket messages to platform-agnostic format
 * and delegates to SessionOrchestrator.
 */

import type { Logger } from "../log.js";
import type { WebSocketManager } from "../websocket/manager.js";
import type { ChatRequest, ChatResult, ActionContext } from "../orchestrator/index.js";
import type { CloudRunWsStatus } from "../cloud/types.js";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  WebSocketMessageContext,
  ResponseStrategy,
} from "./types.js";

export interface WebSocketAdapterDeps {
  wsManager: WebSocketManager;
  logger: Logger;
}

export class WebSocketAdapter extends BaseAdapter {
  readonly platform = "websocket" as const;

  constructor(private readonly deps: WebSocketAdapterDeps) {
    super(deps.logger);
  }

  /**
   * Convert WebSocket message context to ChatRequest.
   */
  override toChatRequest(
    ctx: WebSocketMessageContext,
    prompt: string,
    options?: {
      repoIds?: string[];
      agent?: "codex" | "claude_code";
      restoreSnapshotId?: string | null;
    },
  ): ChatRequest {
    return {
      platform: "websocket",
      chatId: ctx.chatId,
      userId: ctx.userId,
      prompt,
      language: ctx.language,
      workspaceId: null,
      isDirect: true,
      repoIds: options?.repoIds,
      agent: options?.agent,
      restoreSnapshotId: options?.restoreSnapshotId,
    };
  }

  /**
   * Send response to WebSocket connection.
   */
  async sendResponse(ctx: WebSocketMessageContext, result: ChatResult): Promise<void> {
    if (result.error) {
      this.deps.wsManager.sendToConnection(ctx.connId, {
        type: "error",
        code: "SESSION_ERROR",
        message: result.error,
      });
      return;
    }

    if (result.queued) {
      this.deps.wsManager.sendToConnection(ctx.connId, {
        type: "run_status",
        chatId: ctx.chatId,
        status: "preparing",
        message: result.statusMessage,
      });
      return;
    }

    if (result.sessionId) {
      this.deps.wsManager.sendToConnection(ctx.connId, {
        type: "run_status",
        chatId: ctx.chatId,
        status: "running",
        message: result.statusMessage,
      });
    }
  }

  /**
   * Create response strategy for WebSocket.
   */
  createResponder(ctx: WebSocketMessageContext): ResponseStrategy {
    const wsManager = this.deps.wsManager;

    return {
      sendMessage: async (text: string) => {
        wsManager.sendToConnection(ctx.connId, {
          type: "chunk",
          chatId: ctx.chatId,
          content: text,
        });
      },
      sendEphemeral: async (text: string) => {
        // WebSocket doesn't have ephemeral messages, use chunk
        wsManager.sendToConnection(ctx.connId, {
          type: "chunk",
          chatId: ctx.chatId,
          content: text,
        });
      },
    };
  }

  /**
   * Build ActionContext from WebSocket context.
   */
  toActionContext(ctx: WebSocketMessageContext): ActionContext {
    return {
      platform: "websocket",
      chatId: ctx.chatId,
      userId: ctx.userId,
      language: ctx.language,
      workspaceId: null,
    };
  }

  /**
   * Subscribe connection to session updates.
   */
  subscribeToSession(connId: string, sessionId: string): void {
    this.deps.wsManager.subscribeToSession(connId, sessionId);
  }

  /**
   * Send error to connection.
   */
  sendError(connId: string, code: string, message: string): void {
    this.deps.wsManager.sendToConnection(connId, {
      type: "error",
      code,
      message,
    });
  }

  /**
   * Send run status update.
   */
  sendRunStatus(
    connId: string,
    chatId: string,
    status: CloudRunWsStatus,
    message?: string,
  ): void {
    this.deps.wsManager.sendToConnection(connId, {
      type: "run_status",
      chatId,
      status,
      message,
    });
  }

  /**
   * Send done message.
   */
  sendDone(connId: string, chatId: string, stopped?: boolean): void {
    this.deps.wsManager.sendToConnection(connId, {
      type: "done",
      chatId,
      stopped,
    });
  }

  /**
   * Send browser session info.
   */
  sendBrowserSession(
    connId: string,
    sessionId: string,
    cdpUrl: string,
    liveViewUrl?: string,
  ): void {
    this.deps.wsManager.sendToConnection(connId, {
      type: "browser_session",
      sessionId,
      cdpUrl,
      liveViewUrl,
      provider: "hyperbrowser",
    });
  }
}
