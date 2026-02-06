/**
 * Shared services layer - Platform-agnostic utilities.
 *
 * This module provides unified implementations of cross-platform functionality:
 * - ActionParser: Button/interaction parsing
 * - AccessControl: Permission checking
 * - UIBuilder: Platform-specific UI construction
 * - IdentityResolver: User identity resolution
 *
 * Command parsing is handled by the existing controller/commands.ts module,
 * which is re-exported through types.ts.
 */

// Types
export * from "./types.js";

// Action parsing
export { ActionParser, parseTelegramAction, parseSlackAction } from "./ActionParser.js";

// Access control
export {
  AccessControl,
  telegramChatIdMatchesAllowlist,
  type AccessControlDeps,
} from "./AccessControl.js";

// UI building
export {
  UIBuilder,
  buildTelegramRunKeyboard,
  buildTelegramSessionKeyboard,
  buildSlackRunBlocks,
  buildSlackSessionBlocks,
} from "./UIBuilder.js";

// Identity resolution
export { IdentityResolver } from "./IdentityResolver.js";
