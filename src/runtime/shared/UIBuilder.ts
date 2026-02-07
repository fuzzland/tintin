/**
 * UIBuilder - Unified UI component builder for all platforms.
 *
 * Consolidates duplicate logic from:
 * - CloudHandler.buildRunActionTelegramKeyboard()
 * - CloudHandler.buildRunActionSlackBlocks()
 * - TelegramHandler.buildRunActionTelegramKeyboard()
 *
 * Follows SRP: Only responsible for building platform-specific UI components.
 */

import { t, type UserLanguage } from "../../locales/index.js";
import type {
  RunActionOptions,
  SessionActionOptions,
  TelegramInlineKeyboard,
  TelegramInlineKeyboardButton,
  SlackActionsBlock,
  SlackButtonElement,
} from "./types.js";

/**
 * Build Telegram inline keyboard for run actions.
 */
export function buildTelegramRunKeyboard(opts: RunActionOptions): TelegramInlineKeyboard {
  const { sessionId, runId, lang, viewUrl, vscodeUrl, includeStop = true, includeStatus = true } = opts;

  const rows: TelegramInlineKeyboardButton[][] = [];

  // Action buttons row
  const actionRow: TelegramInlineKeyboardButton[] = [];
  if (includeStop) {
    actionRow.push({ text: t("button.stop", lang), callback_data: `kill:${sessionId}` });
  }
  if (includeStatus && runId) {
    actionRow.push({ text: t("button.status", lang), callback_data: `run_status:${runId}` });
  }
  if (actionRow.length > 0) {
    rows.push(actionRow);
  }

  // Link buttons row
  const linkRow: TelegramInlineKeyboardButton[] = [];
  if (viewUrl) {
    linkRow.push({ text: t("button.view", lang), url: viewUrl });
  }
  if (vscodeUrl) {
    linkRow.push({ text: t("button.vscode", lang), url: vscodeUrl });
  }
  if (linkRow.length > 0) {
    rows.push(linkRow);
  }

  return { inline_keyboard: rows };
}

/**
 * Build Telegram inline keyboard for session actions (review/commit).
 */
export function buildTelegramSessionKeyboard(opts: SessionActionOptions): TelegramInlineKeyboard {
  const { sessionId, lang, includeKill = false, includeReview = false, includeCommit = false } = opts;

  const rows: TelegramInlineKeyboardButton[][] = [];
  const actionRow: TelegramInlineKeyboardButton[] = [];

  if (includeKill) {
    actionRow.push({ text: t("button.stop", lang), callback_data: `kill:${sessionId}` });
  }
  if (includeReview) {
    actionRow.push({ text: t("button.review", lang), callback_data: `review:${sessionId}` });
  }
  if (includeCommit) {
    actionRow.push({ text: t("button.commit", lang), callback_data: `commit:${sessionId}` });
  }

  if (actionRow.length > 0) {
    rows.push(actionRow);
  }

  return { inline_keyboard: rows };
}

/**
 * Build Slack blocks for run actions.
 */
export function buildSlackRunBlocks(opts: RunActionOptions): SlackActionsBlock[] {
  const { sessionId, runId, lang, viewUrl, vscodeUrl, includeStop = true, includeStatus = true } = opts;

  const elements: SlackButtonElement[] = [];

  if (includeStop) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: t("button.stop", lang) },
      style: "danger",
      action_id: "kill_session",
      value: sessionId,
    });
  }

  if (includeStatus && runId) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: t("button.status", lang) },
      action_id: "run_status",
      value: runId,
    });
  }

  if (viewUrl) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: t("button.view", lang) },
      action_id: "view_run",
      url: viewUrl,
    });
  }

  if (vscodeUrl) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: t("button.vscode", lang) },
      action_id: "open_vscode",
      url: vscodeUrl,
    });
  }

  if (elements.length === 0) {
    return [];
  }

  return [{ type: "actions", elements }];
}

/**
 * Build Slack blocks for session actions (review/commit).
 */
export function buildSlackSessionBlocks(opts: SessionActionOptions): SlackActionsBlock[] {
  const { sessionId, lang, includeKill = false, includeReview = false, includeCommit = false } = opts;

  const elements: SlackButtonElement[] = [];

  if (includeKill) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: t("button.stop", lang) },
      style: "danger",
      action_id: "kill_session",
      value: sessionId,
    });
  }

  if (includeReview) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: t("button.review", lang) },
      action_id: "review_session",
      value: sessionId,
    });
  }

  if (includeCommit) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: t("button.commit", lang) },
      action_id: "commit_session",
      value: sessionId,
    });
  }

  if (elements.length === 0) {
    return [];
  }

  return [{ type: "actions", elements }];
}

// ============================================================================
// Platform-agnostic builders
// ============================================================================

export type PlatformMarkup =
  | { type: "inline_keyboard"; payload: TelegramInlineKeyboard }
  | { type: "blocks"; payload: SlackActionsBlock[] };

/**
 * Build run action UI for any platform.
 */
export function buildRunActionMarkup(
  platform: "telegram" | "slack",
  opts: RunActionOptions,
): PlatformMarkup {
  if (platform === "telegram") {
    return {
      type: "inline_keyboard",
      payload: buildTelegramRunKeyboard(opts),
    };
  }
  return {
    type: "blocks",
    payload: buildSlackRunBlocks(opts),
  };
}

/**
 * Build session action UI for any platform.
 */
export function buildSessionActionMarkup(
  platform: "telegram" | "slack",
  opts: SessionActionOptions,
): PlatformMarkup {
  if (platform === "telegram") {
    return {
      type: "inline_keyboard",
      payload: buildTelegramSessionKeyboard(opts),
    };
  }
  return {
    type: "blocks",
    payload: buildSlackSessionBlocks(opts),
  };
}

// Note: UIBuilder class removed - use standalone functions directly
