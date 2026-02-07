/**
 * CommandOrchestrator - Handles local command processing.
 *
 * Commands handled:
 * - /sessions - List sessions with optional filters
 * - /settings - View/modify settings
 * - /lang - Change language preference
 * - /help - Show help text
 * - /version - Show version info
 * - /kill - Kill a session
 */

import type { UserLanguage } from "../../locales/index.js";
import { t, isUserLanguage } from "../../locales/index.js";
import type { SessionAgent, SessionStatus, Db } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionPlatform } from "./types.js";
import type { AppConfig } from "../config.js";
import type { SessionListPage } from "../store.js";
import type { SettingsCommand, SessionListIntent } from "../controller/commands.js";
import { normalizeLanguageToken } from "../controller/commands.js";
import {
  formatSessionList,
  formatSessionFilterLabel,
  buildMenuText,
  buildCloudHelpText,
} from "../shared/SessionListFormatter.js";
import {
  applySettingsCommand,
  applyIdentitySettingsCommand,
  applyCloudSettingsCommand,
  formatSettingsSummary,
} from "../controller/settings.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Command context from the caller.
 */
export interface CommandContext {
  platform: SessionPlatform;
  chatId: string;
  userId: string;
  language: UserLanguage;
  workspaceId: string | null;
}

/**
 * Command types that can be handled.
 */
export type CommandType =
  | { kind: "sessions"; intent: SessionListIntent }
  | { kind: "settings"; command: SettingsCommand }
  | { kind: "lang"; target?: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "kill"; sessionId?: string };

/**
 * Command result.
 */
export interface CommandResult {
  /** Text message to display */
  text: string;
  /** Whether to show language selection keyboard */
  showLanguageKeyboard?: boolean;
  /** Whether the command was handled successfully */
  success: boolean;
  /** Error message if any */
  error?: string;
}

// ============================================================================
// Dependencies
// ============================================================================

export interface CommandOrchestratorDeps {
  logger: Logger;
  config: AppConfig;
  db: Db;

  /** Get sessions for listing */
  listSessions: (opts: {
    platform: string;
    chatId: string;
    statuses?: SessionStatus[];
    page: number;
    limit: number;
  }) => Promise<SessionListPage>;

  /** Get or create identity for user */
  getOrCreateIdentity: (ctx: {
    platform: string;
    workspaceId: string | null;
    userId: string;
  }) => Promise<{
    id: string;
    keepalive_minutes: number | null;
    message_verbosity: number | null;
    branch_name_rule: string | null;
    git_user_name: string | null;
    git_user_email: string | null;
  }>;

  /** Set user language preference */
  setUserLanguage: (platform: string, userId: string, lang: UserLanguage) => Promise<void>;

  /** Get default agent for user */
  getDefaultAgent: (platform: string, userId: string) => SessionAgent;

  /** Check if cloud key is set for identity */
  getCloudKeyStatus?: (identityId: string) => Promise<{ openai: boolean; anthropic: boolean }>;

  /** Get version info */
  getVersion: () => string;

  /** Kill a session by ID */
  killSession?: (sessionId: string, reason: string) => Promise<boolean>;

  /** Find session by ID */
  findSession?: (sessionId: string) => Promise<{ id: string; platform: string; chat_id: string } | null>;
}

// ============================================================================
// CommandOrchestrator Implementation
// ============================================================================

export class CommandOrchestrator {
  constructor(private readonly deps: CommandOrchestratorDeps) {}

  /**
   * Handle a command.
   */
  async handle(ctx: CommandContext, command: CommandType): Promise<CommandResult> {
    switch (command.kind) {
      case "sessions":
        return this.handleSessions(ctx, command.intent);
      case "settings":
        return this.handleSettings(ctx, command.command);
      case "lang":
        return this.handleLang(ctx, command.target);
      case "help":
        return this.handleHelp(ctx);
      case "version":
        return this.handleVersion(ctx);
      case "kill":
        return this.handleKill(ctx, command.sessionId);
      default:
        return {
          text: t("error.generic", ctx.language, { message: "Unknown command" }),
          success: false,
          error: "Unknown command",
        };
    }
  }

  // ==========================================================================
  // Command Handlers
  // ==========================================================================

  /**
   * Handle /sessions command.
   */
  private async handleSessions(
    ctx: CommandContext,
    intent: SessionListIntent,
  ): Promise<CommandResult> {
    const platform = ctx.platform as "telegram" | "slack";
    const limit = 10;

    try {
      const result = await this.deps.listSessions({
        platform: ctx.platform,
        chatId: ctx.chatId,
        statuses: intent.statuses,
        page: intent.page,
        limit,
      });

      const filterLabel = formatSessionFilterLabel(intent.statuses);
      const text = formatSessionList(platform, ctx.language, {
        ...result,
        filterLabel,
      });

      return { text, success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`CommandOrchestrator handleSessions error: ${msg}`);
      return {
        text: t("error.generic", ctx.language, { message: msg }),
        success: false,
        error: msg,
      };
    }
  }

  /**
   * Handle /settings command.
   */
  private async handleSettings(
    ctx: CommandContext,
    command: SettingsCommand,
  ): Promise<CommandResult> {
    const platform = ctx.platform as "telegram" | "slack";
    const defaultAgent = this.deps.getDefaultAgent(ctx.platform, ctx.userId);

    try {
      // Get identity for user
      const identity = await this.deps.getOrCreateIdentity({
        platform: ctx.platform,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
      });

      // Check if this is an identity-level setting
      const identityResult = await applyIdentitySettingsCommand({
        config: this.deps.config,
        db: this.deps.db,
        cmd: command,
        identityId: identity.id,
        lang: ctx.language,
      });

      if (identityResult) {
        return { text: identityResult, success: true };
      }

      // Check if this is a cloud setting
      const cloudResult = await applyCloudSettingsCommand({
        config: this.deps.config,
        db: this.deps.db,
        cmd: command,
        identityId: identity.id,
        lang: ctx.language,
      });

      if (cloudResult) {
        return { text: cloudResult, success: true };
      }

      // Handle list command with full summary
      if (command.kind === "list") {
        const cloudKeyStatus = this.deps.getCloudKeyStatus
          ? await this.deps.getCloudKeyStatus(identity.id)
          : null;

        const text = formatSettingsSummary(
          this.deps.config,
          defaultAgent,
          platform,
          ctx.language,
          identity,
          cloudKeyStatus,
        );

        return { text, success: true };
      }

      // Handle agent-level settings
      const text = applySettingsCommand(
        this.deps.config,
        command,
        defaultAgent,
        platform,
        ctx.language,
      );

      return { text, success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`CommandOrchestrator handleSettings error: ${msg}`);
      return {
        text: t("error.generic", ctx.language, { message: msg }),
        success: false,
        error: msg,
      };
    }
  }

  /**
   * Handle /lang command.
   */
  private async handleLang(
    ctx: CommandContext,
    target?: string,
  ): Promise<CommandResult> {
    const cmdPrefix = ctx.platform === "telegram" ? "/" : "";
    const cmdExample = `${cmdPrefix}lang <en|zh>`;

    // If no target, show language selection
    if (!target) {
      return {
        text: t("lang.usage", ctx.language, { cmd: cmdExample }),
        showLanguageKeyboard: true,
        success: true,
      };
    }

    // Normalize and validate target language
    const nextLang = normalizeLanguageToken(target);
    if (!nextLang || !isUserLanguage(nextLang)) {
      return {
        text: t("lang.invalid", ctx.language, { value: target }),
        showLanguageKeyboard: true,
        success: false,
        error: "Invalid language",
      };
    }

    try {
      // Set user language
      await this.deps.setUserLanguage(ctx.platform, ctx.userId, nextLang);

      // Also update any active sessions
      await this.deps.db
        .updateTable("sessions")
        .set({ language: nextLang, updated_at: Date.now() })
        .where("platform", "=", ctx.platform)
        .where("created_by_user_id", "=", ctx.userId)
        .where("status", "in", ["starting", "running"])
        .execute();

      const confirmKey = nextLang === "zh" ? "lang.switched_zh" : "lang.switched_en";
      return {
        text: t(confirmKey, nextLang),
        success: true,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`CommandOrchestrator handleLang error: ${msg}`);
      return {
        text: t("error.generic", ctx.language, { message: msg }),
        success: false,
        error: msg,
      };
    }
  }

  /**
   * Handle /help command.
   */
  private handleHelp(ctx: CommandContext): CommandResult {
    const platform = ctx.platform as "telegram" | "slack";
    const defaultAgent = this.deps.getDefaultAgent(ctx.platform, ctx.userId);

    // Check if cloud is enabled
    const cloudEnabled = !!this.deps.config.cloud?.enabled;

    let text: string;
    if (cloudEnabled) {
      text = buildCloudHelpText(platform, ctx.language);
    } else {
      text = buildMenuText(platform, defaultAgent, ctx.language);
    }

    return { text, success: true };
  }

  /**
   * Handle /version command.
   */
  private handleVersion(ctx: CommandContext): CommandResult {
    const version = this.deps.getVersion();
    return {
      text: `Tintin v${version}`,
      success: true,
    };
  }

  /**
   * Handle /kill command.
   */
  private async handleKill(
    ctx: CommandContext,
    sessionId?: string,
  ): Promise<CommandResult> {
    const cmdPrefix = ctx.platform === "telegram" ? "/" : "";

    if (!sessionId) {
      return {
        text: t("error.generic", ctx.language, { message: `Usage: ${cmdPrefix}kill <session-id>` }),
        success: false,
        error: "No session ID provided",
      };
    }

    if (!this.deps.killSession || !this.deps.findSession) {
      return {
        text: t("error.generic", ctx.language, { message: "Kill command not available" }),
        success: false,
        error: "Kill not available",
      };
    }

    try {
      // Find the session
      const session = await this.deps.findSession(sessionId);
      if (!session) {
        return {
          text: t("session.not_found", ctx.language),
          success: false,
          error: "Session not found",
        };
      }

      // Verify the session belongs to this chat
      if (session.platform !== ctx.platform || session.chat_id !== ctx.chatId) {
        return {
          text: t("session.not_found", ctx.language),
          success: false,
          error: "Session not in this chat",
        };
      }

      // Kill the session
      const reason = t("session.stop_requested", ctx.language);
      const killed = await this.deps.killSession(sessionId, reason);

      if (killed) {
        return {
          text: t("session.stopping", ctx.language),
          success: true,
        };
      } else {
        return {
          text: t("session.already_finished", ctx.language),
          success: false,
          error: "Session already finished",
        };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`CommandOrchestrator handleKill error: ${msg}`);
      return {
        text: t("error.generic", ctx.language, { message: msg }),
        success: false,
        error: msg,
      };
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createCommandOrchestrator(deps: CommandOrchestratorDeps): CommandOrchestrator {
  return new CommandOrchestrator(deps);
}
