/**
 * TelegramAdapter - Telegram-specific message handling.
 *
 * Converts Telegram messages/callbacks to platform-agnostic format
 * and delegates to SessionOrchestrator.
 */

import type { UserLanguage } from "../../locales/index.js";
import type { Logger } from "../log.js";
import type { TelegramClient, TelegramUpdate, TelegramMessage } from "../platform/telegram.js";
import type { ChatRequest, ChatResult, ActionContext, SessionInfo } from "../orchestrator/index.js";
import type { SessionOrchestrator } from "../orchestrator/SessionOrchestrator.js";
import { parseTelegramAction } from "../shared/ActionParser.js";
import { RequestRouter, type RoutingContext } from "./RequestRouter.js";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  TelegramMessageContext,
  TelegramCallbackContext,
  ResponseStrategy,
} from "./types.js";

/**
 * Result of handling a Telegram update.
 */
export interface HandleUpdateResult {
  /** Whether the update was handled by the new adapter */
  handled: boolean;
  /** Error message if handling failed */
  error?: string;
}

export interface TelegramAdapterDeps {
  telegram: TelegramClient | null;
  logger: Logger;
  /** Session orchestrator for handling messages */
  orchestrator?: SessionOrchestrator;
  /** Request router for intent detection */
  router?: RequestRouter;
  /** Get user's language preference */
  getUserLanguage?: (userId: string) => Promise<UserLanguage>;
  /** Find active session for a chat/space */
  findActiveSession?: (chatId: string, spaceId: string | null) => Promise<SessionInfo | null>;
  /** Check if user has an active wizard */
  hasActiveWizard?: (chatId: string, spaceId: string | null) => Promise<boolean>;
  /** Whether cloud features are enabled */
  cloudEnabled?: boolean;
}

export class TelegramAdapter extends BaseAdapter {
  readonly platform = "telegram" as const;

  constructor(
    private readonly deps: TelegramAdapterDeps,
  ) {
    super(deps.logger);
  }

  /**
   * Convert Telegram message context to ChatRequest.
   */
  override toChatRequest(ctx: TelegramMessageContext, prompt: string): ChatRequest {
    return {
      platform: "telegram",
      chatId: ctx.chatId,
      userId: ctx.userId,
      prompt,
      language: ctx.language,
      workspaceId: null,
      isDirect: ctx.isDirect,
    };
  }

  /**
   * Send response to Telegram.
   */
  async sendResponse(ctx: TelegramMessageContext, result: ChatResult): Promise<void> {
    if (!this.deps.telegram) return;

    const message = this.buildStatusMessage(result, ctx.language);
    if (!message) return;

    await this.deps.telegram.sendMessage({
      chatId: ctx.chatId,
      text: message,
      replyToMessageId: ctx.replyToMessageId,
      messageThreadId: ctx.messageThreadId,
      priority: "user",
    });
  }

  /**
   * Parse callback data and return action if valid.
   */
  parseCallback(data: string) {
    return parseTelegramAction(data);
  }

  /**
   * Create response strategy for callback queries.
   */
  createCallbackResponder(ctx: TelegramCallbackContext): ResponseStrategy {
    const telegram = this.deps.telegram;

    return {
      sendMessage: async (text: string) => {
        if (!telegram) return;
        await telegram.sendMessage({
          chatId: ctx.chatId,
          text,
          replyToMessageId: ctx.replyToMessageId,
          messageThreadId: ctx.messageThreadId,
          priority: "user",
        });
      },
      sendEphemeral: async (text: string) => {
        if (!telegram) return;
        await telegram.answerCallbackQuery(ctx.callbackQueryId, text);
      },
      updateMessage: async (text: string) => {
        if (!telegram) return;
        await telegram.editMessageText({
          chatId: ctx.chatId,
          messageId: ctx.messageId,
          text,
        });
      },
    };
  }

  /**
   * Build ActionContext from callback context.
   */
  toActionContext(ctx: TelegramCallbackContext): ActionContext {
    return {
      platform: "telegram",
      chatId: ctx.chatId,
      userId: ctx.userId,
      language: ctx.language,
      workspaceId: null,
      messageId: String(ctx.messageId),
      messageText: ctx.messageText,
      interactionId: ctx.callbackQueryId,
    };
  }

  /**
   * Send response for unrecognized callback.
   */
  async sendUnknownCallback(ctx: TelegramCallbackContext): Promise<void> {
    if (!this.deps.telegram) return;
    await this.deps.telegram.answerCallbackQuery(ctx.callbackQueryId, "Unknown action");
  }

  // ==========================================================================
  // Update Handling (Phase 1 Entry Point)
  // ==========================================================================

  /**
   * Handle a Telegram update.
   * Returns whether the update was handled by the new adapter.
   * If false, the caller should fall back to the old handler.
   */
  async handleUpdate(update: TelegramUpdate): Promise<HandleUpdateResult> {
    // Skip if no telegram client
    if (!this.deps.telegram) {
      return { handled: false, error: "No telegram client" };
    }

    // Handle callback queries (button presses)
    if (update.callback_query) {
      return this.handleCallbackUpdate(update.callback_query);
    }

    // Handle messages
    const message = update.message || update.edited_message;
    if (message) {
      return this.handleMessageUpdate(message);
    }

    // Not handled - let old handler deal with channel posts, etc.
    return { handled: false };
  }

  /**
   * Handle a message update.
   */
  private async handleMessageUpdate(message: TelegramMessage): Promise<HandleUpdateResult> {
    // Skip if no router or orchestrator
    if (!this.deps.router || !this.deps.orchestrator) {
      return { handled: false };
    }

    const text = message.text?.trim() || "";
    if (!text) {
      return { handled: false };
    }

    try {
      // Build routing context
      const chatId = String(message.chat.id);
      const userId = String(message.from?.id || 0);
      const spaceId = this.getSpaceId(message);
      const ctx = await this.buildRoutingContext(chatId, spaceId, userId);

      // Detect intent
      const intent = await this.deps.router.detectIntent(text, ctx);

      // Handle based on intent type
      switch (intent.type) {
        case "session": {
          // Handle session message through orchestrator
          if (ctx.activeSession) {
            const messageCtx = this.buildMessageContext(message);
            const request = this.toChatRequest(messageCtx, intent.prompt);
            const result = await this.deps.orchestrator.handleSessionMessage(
              ctx.activeSession,
              request,
            );
            await this.sendResponse(messageCtx, result);
            return { handled: true };
          }
          return { handled: false };
        }

        case "wizard":
        case "command":
        case "cloud":
          // Not yet implemented - fall back to old handler
          return { handled: false };

        case "unknown":
        default:
          return { handled: false };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`TelegramAdapter handleMessageUpdate error: ${msg}`);
      return { handled: false, error: msg };
    }
  }

  /**
   * Handle a callback query update.
   */
  private async handleCallbackUpdate(
    query: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<HandleUpdateResult> {
    // Skip if no orchestrator
    if (!this.deps.orchestrator) {
      return { handled: false };
    }

    const data = query.data;
    if (!data) {
      return { handled: false };
    }

    try {
      // Parse the callback action
      const action = this.parseCallback(data);
      if (!action) {
        return { handled: false };
      }

      // Build callback context
      const ctx = await this.buildCallbackContext(query);

      // Convert to SessionAction if applicable
      const sessionAction = this.toSessionAction(action);
      if (!sessionAction) {
        // Not a session action - fall back to old handler
        return { handled: false };
      }

      // Handle through orchestrator
      const actionCtx = this.toActionContext(ctx);
      const result = await this.deps.orchestrator.handleAction(sessionAction, actionCtx);

      // Send response
      const responder = this.createCallbackResponder(ctx);
      await this.sendActionResponse(result, responder);

      return { handled: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`TelegramAdapter handleCallbackUpdate error: ${msg}`);
      return { handled: false, error: msg };
    }
  }

  /**
   * Build routing context for intent detection.
   */
  private async buildRoutingContext(
    chatId: string,
    spaceId: string | null,
    userId: string,
  ): Promise<RoutingContext> {
    const hasActiveWizard = this.deps.hasActiveWizard
      ? await this.deps.hasActiveWizard(chatId, spaceId)
      : false;

    const activeSession = this.deps.findActiveSession
      ? await this.deps.findActiveSession(chatId, spaceId)
      : null;

    return {
      platform: "telegram",
      chatId,
      spaceId,
      userId,
      hasActiveWizard,
      activeSession,
      cloudEnabled: this.deps.cloudEnabled ?? false,
    };
  }

  /**
   * Build message context from a Telegram message.
   */
  private buildMessageContext(message: TelegramMessage): TelegramMessageContext {
    const chat = message.chat;
    return {
      platform: "telegram",
      chatId: String(chat.id),
      userId: String(message.from?.id || 0),
      language: "en", // Will be resolved by caller
      replyToMessageId: message.message_id,
      messageThreadId: message.message_thread_id,
      isDirect: chat.type === "private",
      isForumTopic: chat.is_forum && message.is_topic_message,
    };
  }

  /**
   * Build callback context from a Telegram callback query.
   */
  private async buildCallbackContext(
    query: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<TelegramCallbackContext> {
    const chat = query.message?.chat;
    const userId = String(query.from.id);
    const language = this.deps.getUserLanguage
      ? await this.deps.getUserLanguage(userId)
      : "en";

    return {
      callbackQueryId: query.id,
      chatId: String(chat?.id || 0),
      userId,
      messageId: query.message?.message_id || 0,
      messageText: query.message?.text,
      data: query.data || "",
      language,
      replyToMessageId: query.message?.message_id,
      messageThreadId: query.message?.message_thread_id,
    };
  }

  /**
   * Get space ID from a message (for forum topics).
   */
  private getSpaceId(message: TelegramMessage): string | null {
    if (message.chat.is_forum && message.message_thread_id) {
      return `${message.chat.id}:${message.message_thread_id}`;
    }
    return null;
  }

  /**
   * Convert InteractionAction to SessionAction.
   */
  private toSessionAction(
    action: ReturnType<typeof parseTelegramAction>,
  ): import("../orchestrator/types.js").SessionAction | null {
    if (!action) return null;

    switch (action.kind) {
      case "kill":
        return { kind: "kill", sessionId: action.sessionId };
      case "review":
        return { kind: "review", sessionId: action.sessionId };
      case "commit":
        return { kind: "commit", sessionId: action.sessionId };
      case "run_status":
        return { kind: "run_status", runId: action.runId };
      case "stop_sandbox":
        return { kind: "stop_sandbox", sessionId: action.sessionId };
      default:
        // lang, commit_proposal not handled by SessionOrchestrator
        return null;
    }
  }
}
