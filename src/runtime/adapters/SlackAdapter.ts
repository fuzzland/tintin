/**
 * SlackAdapter - Slack-specific message handling.
 *
 * Converts Slack messages/interactions to platform-agnostic format
 * and delegates to SessionOrchestrator.
 */

import type { UserLanguage } from "../../locales/index.js";
import type { Logger } from "../log.js";
import type { SlackClient } from "../platform/slack.js";
import type { ChatRequest, ChatResult, ActionContext, SessionInfo } from "../orchestrator/index.js";
import type { SessionOrchestrator } from "../orchestrator/SessionOrchestrator.js";
import type {
  WizardOrchestrator,
  WizardContext,
  WizardResult,
  ProjectInfo,
} from "../orchestrator/WizardOrchestrator.js";
import { parseSlackAction } from "../shared/ActionParser.js";
import { buildSlackProjectBlocks, type ProjectOption } from "../shared/UIBuilder.js";
import type { SlackActionsBlock } from "../shared/types.js";
import { RequestRouter, type RoutingContext, type WizardAction } from "./RequestRouter.js";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  SlackMessageContext,
  SlackInteractionContext,
  ResponseStrategy,
} from "./types.js";

/**
 * Result of handling a Slack event.
 */
export interface HandleEventResult {
  /** Whether the event was handled by the new adapter */
  handled: boolean;
  /** Error message if handling failed */
  error?: string;
}

/**
 * Slack event body structure (simplified).
 */
export interface SlackEventBody {
  type?: string;
  event?: {
    type?: string;
    subtype?: string;
    channel?: string;
    user?: string;
    text?: string;
    thread_ts?: string;
    ts?: string;
    bot_id?: string;
    bot_profile?: unknown;
  };
  team_id?: string;
  enterprise_id?: string;
}

export interface SlackAdapterDeps {
  slack: SlackClient | null;
  logger: Logger;
  /** Session orchestrator for handling messages */
  orchestrator?: SessionOrchestrator;
  /** Wizard orchestrator for new session creation */
  wizardOrchestrator?: WizardOrchestrator;
  /** Request router for intent detection */
  router?: RequestRouter;
  /** Get user's language preference */
  getUserLanguage?: (userId: string) => Promise<UserLanguage>;
  /** Find active session for a chat/space */
  findActiveSession?: (chatId: string, spaceId: string | null) => Promise<SessionInfo | null>;
  /** Check if user has an active wizard */
  hasActiveWizard?: (chatId: string, spaceId: string | null) => Promise<boolean>;
  /** Get available projects for wizard */
  getProjects?: () => ProjectInfo[];
  /** Whether cloud features are enabled */
  cloudEnabled?: boolean;
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

  /**
   * Send response for unrecognized interaction.
   */
  async sendUnknownInteraction(ctx: SlackInteractionContext): Promise<void> {
    if (!this.deps.slack) return;
    await this.deps.slack.postEphemeral({
      channel: ctx.channelId,
      user: ctx.userId,
      text: "Unknown action",
      thread_ts: ctx.threadTs,
      workspaceId: ctx.workspaceId,
    });
  }

  // ==========================================================================
  // Event Handling (Phase 1 Entry Point)
  // ==========================================================================

  /**
   * Handle a Slack event.
   * Returns whether the event was handled by the new adapter.
   * If false, the caller should fall back to the old handler.
   */
  async handleEvent(body: SlackEventBody): Promise<HandleEventResult> {
    // Skip if no slack client
    if (!this.deps.slack) {
      return { handled: false, error: "No slack client" };
    }

    // Only handle event_callback type
    if (body.type !== "event_callback" || !body.event) {
      return { handled: false };
    }

    const event = body.event;

    // Only handle message events
    if (event.type === "message") {
      return this.handleMessageEvent(event, body.team_id || null, body.enterprise_id || null);
    }

    // Not handled - let old handler deal with other events
    return { handled: false };
  }

  /**
   * Handle a message event.
   */
  private async handleMessageEvent(
    event: NonNullable<SlackEventBody["event"]>,
    teamId: string | null,
    enterpriseId: string | null,
  ): Promise<HandleEventResult> {
    // Skip if no router or orchestrator
    if (!this.deps.router || !this.deps.orchestrator) {
      return { handled: false };
    }

    // Skip bot messages and subtypes
    if (event.subtype || event.bot_id || event.bot_profile) {
      return { handled: false };
    }

    const channelId = event.channel;
    const userId = event.user;
    const text = event.text?.trim() || "";

    if (!channelId || !userId || !text) {
      return { handled: false };
    }

    // Only handle DM messages
    if (!channelId.startsWith("D")) {
      return { handled: false };
    }

    try {
      // Build routing context
      const spaceId = channelId; // Use channel as space for Slack
      const ctx = await this.buildRoutingContext(channelId, spaceId, userId, teamId);

      // Detect intent
      const intent = await this.deps.router.detectIntent(text, ctx);

      // Handle based on intent type
      switch (intent.type) {
        case "wizard": {
          // Handle wizard actions
          const messageCtx = this.buildMessageContext(channelId, userId, teamId, enterpriseId, event.thread_ts);
          const wizardResult = await this.handleWizardIntent(
            intent.action,
            messageCtx,
            intent.agent,
            intent.projectId,
            intent.path,
            text,
          );
          if (wizardResult) {
            await this.sendWizardResponse(messageCtx, wizardResult);
            return { handled: true };
          }
          return { handled: false };
        }

        case "session": {
          // Handle session message through orchestrator
          if (ctx.activeSession) {
            const messageCtx = this.buildMessageContext(channelId, userId, teamId, enterpriseId, event.thread_ts);
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
      this.deps.logger.error(`SlackAdapter handleMessageEvent error: ${msg}`);
      return { handled: false, error: msg };
    }
  }

  /**
   * Handle a Slack interaction (button press).
   * Returns whether the interaction was handled.
   */
  async handleInteraction(ctx: SlackInteractionContext): Promise<HandleEventResult> {
    try {
      // Parse the action
      const action = this.parseInteraction(ctx.actionId, ctx.value);
      if (!action) {
        return { handled: false };
      }

      // Handle project selection for wizard
      if (action.kind === "project_select") {
        if (!this.deps.wizardOrchestrator) {
          return { handled: false };
        }

        const language = ctx.language;
        const wizardCtx: WizardContext = {
          platform: "slack",
          chatId: ctx.channelId,
          userId: ctx.userId,
          language,
          workspaceId: ctx.workspaceId,
          spaceId: ctx.channelId,
        };

        const result = await this.deps.wizardOrchestrator.handleProjectSelect(
          wizardCtx,
          action.projectId,
        );

        const messageCtx: SlackMessageContext = {
          platform: "slack",
          chatId: ctx.channelId,
          userId: ctx.userId,
          language,
          workspaceId: ctx.workspaceId,
          isDirect: true,
          threadTs: ctx.threadTs,
        };
        await this.sendWizardResponse(messageCtx, result);

        return { handled: true };
      }

      // Skip if no session orchestrator for session actions
      if (!this.deps.orchestrator) {
        return { handled: false };
      }

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
      const responder = this.createInteractionResponder(ctx);
      await this.sendActionResponse(result, responder);

      return { handled: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`SlackAdapter handleInteraction error: ${msg}`);
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
    workspaceId: string | null,
  ): Promise<RoutingContext> {
    const hasActiveWizard = this.deps.hasActiveWizard
      ? await this.deps.hasActiveWizard(chatId, spaceId)
      : false;

    const activeSession = this.deps.findActiveSession
      ? await this.deps.findActiveSession(chatId, spaceId)
      : null;

    return {
      platform: "slack",
      chatId,
      spaceId,
      userId,
      hasActiveWizard,
      activeSession,
      cloudEnabled: this.deps.cloudEnabled ?? false,
    };
  }

  /**
   * Build message context from Slack event.
   */
  private buildMessageContext(
    channelId: string,
    userId: string,
    teamId: string | null,
    enterpriseId: string | null,
    threadTs?: string,
  ): SlackMessageContext {
    return {
      platform: "slack",
      chatId: channelId,
      userId,
      language: "en", // Will be resolved by caller
      workspaceId: teamId,
      isDirect: channelId.startsWith("D"),
      threadTs,
      enterpriseId,
    };
  }

  /**
   * Convert InteractionAction to SessionAction.
   */
  private toSessionAction(
    action: ReturnType<typeof parseSlackAction>,
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
        // lang, commit_proposal, project_select not handled by SessionOrchestrator
        return null;
    }
  }

  // ==========================================================================
  // Wizard Handling
  // ==========================================================================

  /**
   * Handle wizard intent.
   */
  private async handleWizardIntent(
    action: WizardAction,
    messageCtx: SlackMessageContext,
    agent?: import("../db.js").SessionAgent,
    projectId?: string,
    path?: string,
    text?: string,
  ): Promise<WizardResult | null> {
    if (!this.deps.wizardOrchestrator) {
      return null;
    }

    const language = this.deps.getUserLanguage
      ? await this.deps.getUserLanguage(messageCtx.userId)
      : "en" as UserLanguage;

    const wizardCtx: WizardContext = {
      platform: "slack",
      chatId: messageCtx.chatId,
      userId: messageCtx.userId,
      language,
      workspaceId: messageCtx.workspaceId ?? null,
      spaceId: messageCtx.chatId,
    };

    switch (action) {
      case "start":
        return this.deps.wizardOrchestrator.start(wizardCtx, agent || "codex");
      case "project_select":
        if (projectId) {
          return this.deps.wizardOrchestrator.handleProjectSelect(wizardCtx, projectId);
        }
        return null;
      case "path_input":
        if (path) {
          return this.deps.wizardOrchestrator.handleCustomPath(wizardCtx, path);
        }
        return null;
      case "continue":
        return this.deps.wizardOrchestrator.continue(wizardCtx, text || "");
      default:
        return null;
    }
  }

  /**
   * Send wizard response to Slack.
   */
  private async sendWizardResponse(
    ctx: SlackMessageContext,
    result: WizardResult,
  ): Promise<void> {
    if (!this.deps.slack) return;

    // Build blocks if needed
    let blocks: SlackActionsBlock[] | undefined;
    if (result.showProjectKeyboard && this.deps.getProjects) {
      const projects = this.deps.getProjects();
      const projectOptions: ProjectOption[] = projects.map(p => ({ id: p.id, name: p.name }));
      blocks = buildSlackProjectBlocks(projectOptions);
    }

    await this.deps.slack.postMessage({
      channel: ctx.chatId,
      text: result.message,
      thread_ts: ctx.threadTs,
      workspaceId: ctx.workspaceId,
      blocks: blocks as unknown as import("@slack/web-api").Block[],
    });
  }
}
