/**
 * Session formatting utilities.
 *
 * @deprecated This module is deprecated. Import from `shared/SessionListFormatter.ts` instead.
 * All functions here are re-exported from the shared layer.
 *
 * Migration guide:
 * - Replace `from "../controller/sessions.js"` with `from "../shared/SessionListFormatter.js"`
 * - All exported functions have the same names and signatures
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
