/**
 * CloudOrchestrator - Handles cloud command processing.
 *
 * Commands handled:
 * - /run - Start a cloud run
 * - /repos - List/manage repositories
 * - /connect - Connect to GitHub/GitLab
 * - /disconnect - Disconnect providers
 * - /secrets - Manage secrets
 * - /snapshots - Manage snapshots
 * - /status - Check run status
 * - /pull - Pull run changes
 * - /token - Generate CLI token
 */

import type { UserLanguage } from "../../locales/index.js";
import { t } from "../../locales/index.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionPlatform } from "./types.js";
import type { AppConfig } from "../config.js";
import type { CloudManager } from "../cloud/manager.js";
import type { CloudCommand } from "../controller/commands.js";
import type { SlackClient } from "../platform/slack.js";
import type { TelegramClient } from "../platform/telegram.js";
import type { IMessagingPlatform, InteractiveMarkup } from "../platform/base.js";
import { CloudHandler, type CloudHandlerDeps } from "../controller/cloudHandler.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Context for cloud command processing.
 */
export interface CloudContext {
  platform: SessionPlatform;
  chatId: string;
  userId: string;
  language: UserLanguage;
  workspaceId: string | null;
  /** Whether the message is from a direct/private conversation */
  isDirect: boolean;
  /** Space ID for the conversation */
  spaceId: string;
  /** Reply context for Telegram */
  replyToMessageId?: number;
  messageThreadId?: number;
  /** Reply context for Slack */
  slackThreadTs?: string;
}

/**
 * Result from cloud command processing.
 */
export interface CloudResult {
  /** Whether the command was handled */
  handled: boolean;
  /** Whether the command succeeded (if handled) */
  success?: boolean;
  /** Error message if any */
  error?: string;
}

// ============================================================================
// Dependencies
// ============================================================================

export interface CloudOrchestratorDeps {
  logger: Logger;
  config: AppConfig;
  db: Db;
  cloudManager: CloudManager | null;
  telegram: TelegramClient | null;
  slack: SlackClient | null;

  /** Send a platform message */
  sendPlatformMessage: (opts: {
    platform: IMessagingPlatform | null;
    chatId: string;
    text: string;
    markup?: InteractiveMarkup;
    threadId?: string | number;
    replyToMessageId?: string | number;
    priority?: "user" | "background";
    workspaceId?: string | null;
  }) => Promise<void>;

  /** Resolve user language preference */
  resolveUserLanguage: (platform: "telegram" | "slack", userId: string) => Promise<UserLanguage>;
}

// ============================================================================
// CloudOrchestrator Implementation
// ============================================================================

export class CloudOrchestrator {
  private readonly cloudHandler: CloudHandler;

  constructor(private readonly deps: CloudOrchestratorDeps) {
    // Create CloudHandler with the same dependencies
    const handlerDeps: CloudHandlerDeps = {
      config: deps.config,
      db: deps.db,
      logger: deps.logger,
      cloudManager: deps.cloudManager,
      telegram: deps.telegram,
      slack: deps.slack,
      sendPlatformMessage: deps.sendPlatformMessage,
      resolveUserLanguage: deps.resolveUserLanguage,
    };
    this.cloudHandler = new CloudHandler(handlerDeps);
  }

  /**
   * Check if cloud features are enabled.
   */
  isEnabled(): boolean {
    return !!this.deps.cloudManager && !!this.deps.config.cloud?.enabled;
  }

  /**
   * Handle a cloud command.
   */
  async handle(ctx: CloudContext, command: CloudCommand): Promise<CloudResult> {
    // Check if cloud is enabled
    if (!this.isEnabled()) {
      return {
        handled: true,
        success: false,
        error: "Cloud features not enabled",
      };
    }

    try {
      // Delegate to CloudHandler
      const platform = ctx.platform as "telegram" | "slack";
      const handled = await this.cloudHandler.handleCloudCommand({
        platform,
        command,
        chatId: ctx.chatId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        isDirect: ctx.isDirect,
        spaceId: ctx.spaceId,
        replyToMessageId: ctx.replyToMessageId,
        messageThreadId: ctx.messageThreadId,
        slackThreadTs: ctx.slackThreadTs,
      });

      return {
        handled,
        success: handled,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`CloudOrchestrator handle error: ${msg}`);
      return {
        handled: true,
        success: false,
        error: msg,
      };
    }
  }

  /**
   * Send cloud run status to a chat.
   */
  async sendRunStatus(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    workspaceId: string | null;
    runId: string;
    isDirect: boolean;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }): Promise<void> {
    await this.cloudHandler.sendCloudRunStatus(opts);
  }

  /**
   * Send cloud help text.
   */
  async sendHelp(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    workspaceId: string | null;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }): Promise<void> {
    await this.cloudHandler.sendCloudHelp(opts);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createCloudOrchestrator(deps: CloudOrchestratorDeps): CloudOrchestrator {
  return new CloudOrchestrator(deps);
}
