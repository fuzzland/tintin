/**
 * Session formatting utilities.
 *
 * This module now re-exports from the shared layer for consistency.
 * @deprecated Import from shared/SessionListFormatter.ts instead.
 */

import type { SessionAgent, SessionStatus } from "../db.js";
import type { SessionListPage, SessionRow } from "../store.js";
import type { UserLanguage } from "../../locales/index.js";
import { parseTelegramCommand, TELEGRAM_COMMAND_AGENT } from "./commands.js";

// Re-export from shared layer
export {
  formatSessionList,
  agentDisplayName,
  agentShortName,
  formatSessionFilterLabel,
  buildMenuText,
  buildCommandExamples,
  buildCloudHelpText,
} from "../shared/SessionListFormatter.js";

// Keep agent detection here - it's command parsing, not formatting
export function detectAgentFromTelegramMessageText(text: string): SessionAgent {
  const cmd = parseTelegramCommand(text);
  const mapped = cmd ? TELEGRAM_COMMAND_AGENT[cmd.command] : undefined;
  return mapped ?? "codex";
}

// Re-export types
export type { FormatSessionListOptions } from "../shared/SessionListFormatter.js";
