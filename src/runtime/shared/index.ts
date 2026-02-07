/**
 * Shared services layer - Platform-agnostic utilities.
 *
 * This module provides unified implementations of cross-platform functionality:
 * - Action parsing: parseTelegramAction, parseSlackAction
 * - Access control: AccessControl class
 * - UI building: Platform-specific keyboard/block builders
 * - Identity resolution: IdentityResolver class + WebSocket utilities
 *
 * Command parsing is handled by the existing controller/commands.ts module,
 * which is re-exported through types.ts.
 */

// Types
export * from "./types.js";

// Action parsing (standalone functions, no class wrapper)
export { parseTelegramAction, parseSlackAction } from "./ActionParser.js";

// Access control
export {
  AccessControl,
  telegramChatIdMatchesAllowlist,
  type AccessControlDeps,
} from "./AccessControl.js";

// UI building (standalone functions, no class wrapper)
export {
  buildTelegramRunKeyboard,
  buildTelegramSessionKeyboard,
  buildSlackRunBlocks,
  buildSlackSessionBlocks,
  buildRunActionMarkup,
  buildSessionActionMarkup,
  buildTelegramProjectKeyboard,
  buildSlackProjectBlocks,
  buildProjectSelectionMarkup,
  type PlatformMarkup,
  type ProjectOption,
} from "./UIBuilder.js";

// Identity resolution
export {
  IdentityResolver,
  parseWebSocketIdentity,
  createAnonymousIdentity,
} from "./IdentityResolver.js";

// Session list formatting
export {
  formatSessionList,
  agentDisplayName,
  agentShortName,
  formatSessionFilterLabel,
  buildMenuText,
  buildCommandExamples,
  buildCloudHelpText,
  type FormatSessionListOptions,
} from "./SessionListFormatter.js";
