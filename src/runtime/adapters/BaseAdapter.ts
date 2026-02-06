/**
 * BaseAdapter - Shared adapter functionality.
 *
 * Provides common implementations for:
 * - ChatRequest creation
 * - Response sending
 * - Action response handling
 */

import type { Logger } from "../log.js";
import type { ChatRequest, ChatResult, ActionResult, SessionPlatform } from "../orchestrator/types.js";
import type { MessageContext, ResponseStrategy, PlatformAdapter } from "./types.js";
import { t } from "../../locales/index.js";

export abstract class BaseAdapter implements PlatformAdapter {
  abstract readonly platform: SessionPlatform;

  constructor(protected readonly logger: Logger) {}

  /**
   * Convert message context to ChatRequest.
   * Subclasses can override to add platform-specific fields.
   */
  toChatRequest(ctx: MessageContext, prompt: string): ChatRequest {
    return {
      platform: ctx.platform,
      chatId: ctx.chatId,
      userId: ctx.userId,
      prompt,
      language: ctx.language,
      workspaceId: ctx.workspaceId,
      isDirect: ctx.isDirect,
    };
  }

  /**
   * Send response based on ChatResult.
   * Subclasses must implement platform-specific sending.
   */
  abstract sendResponse(ctx: MessageContext, result: ChatResult): Promise<void>;

  /**
   * Handle action result and send appropriate response.
   */
  async sendActionResponse(result: ActionResult, responder: ResponseStrategy): Promise<void> {
    if (!result.handled) {
      this.logger.warn(`[${this.platform}] unhandled action`);
      return;
    }

    if (result.error) {
      await responder.sendEphemeral(result.error);
      return;
    }

    if (result.response) {
      if (result.ephemeral) {
        await responder.sendEphemeral(result.response);
      } else {
        await responder.sendMessage(result.response);
      }
    }
  }

  /**
   * Build status message from ChatResult.
   */
  protected buildStatusMessage(result: ChatResult, lang: string): string {
    if (result.error) {
      return result.error;
    }

    if (result.queued && result.pendingCount !== undefined) {
      return t("session.queued", lang as "en" | "zh", { n: result.pendingCount });
    }

    return result.statusMessage ?? "";
  }
}
