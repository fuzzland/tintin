/**
 * SlackAdapter - Slack-specific message handling.
 *
 * Converts Slack messages/interactions to platform-agnostic format
 * and delegates to SessionOrchestrator.
 */

import type { Logger } from "../log.js";
import type { SlackClient } from "../platform/slack.js";
import type { ChatRequest, ChatResult, ActionContext } from "../orchestrator/index.js";
import { parseSlackAction } from "../shared/ActionParser.js";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  SlackMessageContext,
  SlackInteractionContext,
  ResponseStrategy,
} from "./types.js";

export interface SlackAdapterDeps {
  slack: SlackClient | null;
  logger: Logger;
}

export class SlackAdapter extends BaseAdapter {
  readonly platform = "slack" as const;

  constructor(private readonly deps: SlackAdapterDeps) {
    super(deps.logger);
  }

  /**
   * Convert Slack message context to ChatRequest.
   */
  override toChatRequest(ctx: SlackMessageContext, prompt: string): ChatRequest {
    return {
      platform: "slack",
      chatId: ctx.chatId,
      userId: ctx.userId,
      prompt,
      language: ctx.language,
      workspaceId: ctx.workspaceId,
      isDirect: ctx.isDirect,
    };
  }

  /**
   * Send response to Slack.
   */
  async sendResponse(ctx: SlackMessageContext, result: ChatResult): Promise<void> {
    if (!this.deps.slack) return;

    const message = this.buildStatusMessage(result, ctx.language);
    if (!message) return;

    await this.deps.slack.postMessage({
      channel: ctx.chatId,
      text: message,
      thread_ts: ctx.threadTs,
      workspaceId: ctx.workspaceId,
    });
  }

  /**
   * Parse interaction action.
   */
  parseInteraction(actionId: string, value: string | null) {
    return parseSlackAction(actionId, value);
  }

  /**
   * Create response strategy for interactions.
   */
  createInteractionResponder(ctx: SlackInteractionContext): ResponseStrategy {
    const slack = this.deps.slack;

    return {
      sendMessage: async (text: string) => {
        if (!slack) return;
        await slack.postMessage({
          channel: ctx.channelId,
          text,
          thread_ts: ctx.threadTs,
          workspaceId: ctx.workspaceId,
        });
      },
      sendEphemeral: async (text: string) => {
        if (!slack) return;
        await slack.postEphemeral({
          channel: ctx.channelId,
          user: ctx.userId,
          text,
          thread_ts: ctx.threadTs,
          workspaceId: ctx.workspaceId,
        });
      },
    };
  }

  /**
   * Build ActionContext from interaction context.
   */
  toActionContext(ctx: SlackInteractionContext): ActionContext {
    return {
      platform: "slack",
      chatId: ctx.channelId,
      userId: ctx.userId,
      language: ctx.language,
      workspaceId: ctx.workspaceId,
      messageId: ctx.messageTs,
      threadTs: ctx.threadTs,
    };
  }
}
