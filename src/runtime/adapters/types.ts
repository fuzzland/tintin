/**
 * Adapter Types - Platform-specific message conversion.
 *
 * Adapters are thin layers that:
 * 1. Parse platform-specific messages
 * 2. Convert to platform-agnostic ChatRequest
 * 3. Delegate to SessionOrchestrator
 * 4. Convert ChatResult to platform-specific responses
 */

import type { UserLanguage } from "../../locales/index.js";
import type { SessionPlatform, ChatRequest, ChatResult, ActionResult } from "../orchestrator/types.js";
import type { InteractionAction } from "../shared/types.js";
import type { TelegramChat } from "../platform/telegram.js";

/**
 * Platform-specific message context.
 * Each platform provides different context for messages.
 */
export interface MessageContext {
  platform: SessionPlatform;
  chatId: string;
  userId: string;
  language: UserLanguage;
  workspaceId?: string | null;
  isDirect?: boolean;
}

/**
 * Telegram-specific message context.
 */
export interface TelegramMessageContext extends MessageContext {
  platform: "telegram";
  chat?: TelegramChat;
  replyToMessageId?: number;
  messageThreadId?: number;
  isForumTopic?: boolean;
}

/**
 * Slack-specific message context.
 */
export interface SlackMessageContext extends MessageContext {
  platform: "slack";
  threadTs?: string;
  enterpriseId?: string | null;
}

/**
 * WebSocket-specific message context.
 */
export interface WebSocketMessageContext extends MessageContext {
  platform: "websocket";
  connId: string;
  sessionId?: string;
}

/**
 * Telegram callback (button press) context.
 */
export interface TelegramCallbackContext {
  callbackQueryId: string;
  chatId: string;
  userId: string;
  messageId: number;
  messageText?: string;
  data: string;
  language: UserLanguage;
  replyToMessageId?: number;
  messageThreadId?: number;
}

/**
 * Slack interaction (button press) context.
 */
export interface SlackInteractionContext {
  channelId: string;
  userId: string;
  workspaceId: string | null;
  actionId: string;
  value: string | null;
  messageTs?: string;
  threadTs?: string;
  responseUrl?: string;
  language: UserLanguage;
}

/**
 * Response strategy for different platforms.
 */
export interface ResponseStrategy {
  /** Send a text message */
  sendMessage(text: string, options?: ResponseOptions): Promise<void>;
  /** Send an ephemeral/toast response */
  sendEphemeral(text: string): Promise<void>;
  /** Update the original message (for button updates) */
  updateMessage?(text: string, options?: ResponseOptions): Promise<void>;
}

export interface ResponseOptions {
  priority?: "user" | "system";
  markdown?: boolean;
}

/**
 * Adapter interface for all platforms.
 */
export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: SessionPlatform;

  /**
   * Convert platform message to ChatRequest.
   */
  toChatRequest(ctx: MessageContext, prompt: string): ChatRequest;

  /**
   * Send response based on ChatResult.
   */
  sendResponse(ctx: MessageContext, result: ChatResult): Promise<void>;

  /**
   * Handle action result (button press).
   */
  sendActionResponse(result: ActionResult, responder: ResponseStrategy): Promise<void>;
}

/**
 * Parsed action from platform-specific format.
 */
export interface ParsedAction {
  action: InteractionAction;
  context: MessageContext;
}
