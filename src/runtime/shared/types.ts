/**
 * Shared types for cross-platform services.
 * These types are platform-agnostic and used by all adapters.
 */

import type { UserLanguage as _UserLanguage } from "../../locales/index.js";

// Re-export UserLanguage for consumers of the shared layer
export type UserLanguage = _UserLanguage;
import type { SessionAgent, SessionStatus } from "../db.js";

// ============================================================================
// Access Control
// ============================================================================

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
}

export interface TelegramAccessContext {
  chatId: string;
  userId: string;
}

export interface SlackAccessContext {
  workspaceId: string | null;
  channelId: string;
  userId: string;
}

export interface WebSocketAccessContext {
  token?: string;
  connId: string;
}

// ============================================================================
// Action Parsing (Button interactions)
// ============================================================================

export type CommitProposalAction = "cancel" | "push" | "pr";

export type InteractionAction =
  | { kind: "project_select"; projectId: string }
  | { kind: "lang"; value: UserLanguage }
  | { kind: "kill"; sessionId: string }
  | { kind: "review"; sessionId: string }
  | { kind: "commit"; sessionId: string }
  | { kind: "run_status"; runId: string }
  | { kind: "stop_sandbox"; sessionId: string }
  | { kind: "commit_proposal"; proposalId: string; action: CommitProposalAction };

// ============================================================================
// UI Building
// ============================================================================

export interface RunActionOptions {
  sessionId: string;
  runId?: string;
  lang: UserLanguage;
  viewUrl?: string | null;
  vscodeUrl?: string | null;
  includeStop?: boolean;
  includeStatus?: boolean;
  includeReview?: boolean;
  includeCommit?: boolean;
}

export interface SessionActionOptions {
  sessionId: string;
  lang: UserLanguage;
  includeKill?: boolean;
  includeReview?: boolean;
  includeCommit?: boolean;
}

// Telegram inline keyboard types
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

// Slack block types
export interface SlackButtonElement {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  style?: "primary" | "danger";
  value?: string;
  url?: string;
}

export interface SlackActionsBlock {
  type: "actions";
  elements: SlackButtonElement[];
}

// ============================================================================
// Identity Resolution
// ============================================================================

export type Platform = "telegram" | "slack" | "websocket";

export interface IdentityContext {
  platform: Platform;
  userId: string;
  workspaceId?: string | null;
}

// ============================================================================
// Command Parsing (shared command types)
// ============================================================================

export type SessionListIntent = { statuses?: SessionStatus[]; page: number };

export type SettingsCommand =
  | { kind: "list" }
  | { kind: "set"; target: string; value: string }
  | { kind: "unset"; target: string };

export type SettingsIntent = { cmd: SettingsCommand; defaultAgent: SessionAgent };

export type { CloudCommand, LanguageCommand } from "./commands.js";

// ============================================================================
// Agent Selection
// ============================================================================

export interface AgentSelectionContext {
  text: string;
  defaultAgent: SessionAgent;
}
