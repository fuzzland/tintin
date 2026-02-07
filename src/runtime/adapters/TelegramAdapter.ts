/**
 * TelegramAdapter - Telegram-specific message handling.
 *
 * Converts Telegram messages/callbacks to platform-agnostic format
 * and delegates to SessionOrchestrator.
 */

import type { Logger } from "../log.js";
import type { TelegramClient } from "../platform/telegram.js";
import type { ChatRequest, ChatResult, ActionContext } from "../orchestrator/index.js";
import { parseTelegramAction } from "../shared/ActionParser.js";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  TelegramMessageContext,
  TelegramCallbackContext,
  ResponseStrategy,
} from "./types.js";

export interface TelegramAdapterDeps {
  telegram: TelegramClient | null;
  logger: Logger;
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
}
