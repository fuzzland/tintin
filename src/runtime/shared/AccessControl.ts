/**
 * AccessControl - Unified access control for all platforms.
 *
 * Consolidates duplicate logic from:
 * - BotController.telegramAccessDecision()
 * - BotController.slackAccessDecision()
 * - WebSocketHandler.handleAuth()
 *
 * Follows SRP: Only responsible for access control decisions.
 */

import type { AppConfig } from "../config.js";
import type { TelegramClient } from "../platform/telegram.js";
import type { Logger } from "../log.js";
import { verifyProxyToken } from "../cloud/proxy.js";
import type {
  AccessDecision,
  TelegramAccessContext,
  SlackAccessContext,
  WebSocketAccessContext,
} from "./types.js";

/**
 * Check if Telegram chat ID matches the allowlist.
 * Handles various chat ID formats (-100xxx, -xxx, xxx).
 */
export function telegramChatIdMatchesAllowlist(chatId: string, allowIds: string[]): boolean {
  if (allowIds.length === 0) return true;

  const c = chatId.trim();
  const candidates = new Set<string>([c]);

  // Handle supergroup/channel prefix -100
  if (c.startsWith("-100") && c.length > 4) {
    candidates.add(c.slice(4));
  }
  // Handle group prefix -
  if (c.startsWith("-") && c.length > 1) {
    candidates.add(c.slice(1));
  }

  for (const raw of allowIds) {
    const a = String(raw).trim();
    if (candidates.has(a)) return true;
  }

  return false;
}

export interface AccessControlDeps {
  config: AppConfig;
  telegram?: TelegramClient | null;
  logger: Logger;
}

export class AccessControl {
  private readonly config: AppConfig;
  private readonly telegram: TelegramClient | null;
  private readonly logger: Logger;

  constructor(deps: AccessControlDeps) {
    this.config = deps.config;
    this.telegram = deps.telegram ?? null;
    this.logger = deps.logger;
  }

  /**
   * Check Telegram access.
   * Validates against chat_ids, user_ids allowlists and optional admin requirement.
   */
  async checkTelegram(ctx: TelegramAccessContext): Promise<AccessDecision> {
    const sec = this.config.security;
    const { chatId, userId } = ctx;

    // Check chat ID allowlist
    if (
      sec.telegram_allow_chat_ids.length > 0 &&
      !telegramChatIdMatchesAllowlist(chatId, sec.telegram_allow_chat_ids)
    ) {
      return { allowed: false, reason: `chat not allowed (${chatId})` };
    }

    // Check user ID allowlist
    if (sec.telegram_allow_user_ids.length > 0 && !sec.telegram_allow_user_ids.includes(userId)) {
      return { allowed: false, reason: `user not allowed (${userId})` };
    }

    // Check admin requirement
    if (sec.telegram_require_admin) {
      if (!this.telegram) {
        return { allowed: false, reason: "telegram not configured" };
      }

      try {
        const member = await this.telegram.getChatMember(chatId, userId);
        if (member.status === "administrator" || member.status === "creator") {
          return { allowed: true };
        }
        return { allowed: false, reason: `not admin (status=${member.status})` };
      } catch (e) {
        return { allowed: false, reason: `admin check failed (${String(e)})` };
      }
    }

    return { allowed: true };
  }

  /**
   * Check Slack access.
   * Validates against workspace_ids, channel_ids, user_ids allowlists.
   */
  checkSlack(ctx: SlackAccessContext): AccessDecision {
    const sec = this.config.security;
    const { workspaceId, channelId, userId } = ctx;

    // Check workspace ID allowlist
    if (sec.slack_allow_workspace_ids.length > 0) {
      if (!workspaceId) {
        return { allowed: false, reason: "missing workspace_id" };
      }
      if (!sec.slack_allow_workspace_ids.includes(workspaceId)) {
        return { allowed: false, reason: `workspace not allowed (${workspaceId})` };
      }
    }

    // Check channel ID allowlist
    if (
      sec.slack_allow_channel_ids.length > 0 &&
      !sec.slack_allow_channel_ids.includes(channelId)
    ) {
      return { allowed: false, reason: `channel not allowed (${channelId})` };
    }

    // Check user ID allowlist
    if (sec.slack_allow_user_ids.length > 0 && !sec.slack_allow_user_ids.includes(userId)) {
      return { allowed: false, reason: `user not allowed (${userId})` };
    }

    return { allowed: true };
  }

  /**
   * Check WebSocket access.
   * Validates proxy token if auth is enabled.
   */
  checkWebSocket(ctx: WebSocketAccessContext, authEnabled: boolean): AccessDecision {
    // If auth is disabled, allow anonymous access
    if (!authEnabled) {
      return { allowed: true };
    }

    const { token } = ctx;
    if (!token) {
      return { allowed: false, reason: "token required" };
    }

    // Verify token using cloud proxy secret
    const secret = this.config.cloud?.proxy?.shared_secret;
    if (!secret) {
      return { allowed: false, reason: "proxy secret not configured" };
    }

    const verified = verifyProxyToken(secret, token);
    if (!verified) {
      return { allowed: false, reason: "invalid token" };
    }

    return { allowed: true };
  }
}
