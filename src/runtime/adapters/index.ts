/**
 * Platform Adapters - Thin layer for protocol conversion.
 *
 * Adapters convert platform-specific messages to platform-agnostic ChatRequest,
 * delegate to SessionOrchestrator for business logic,
 * and convert ChatResult back to platform-specific responses.
 *
 * Key responsibilities:
 * - Message parsing and validation
 * - Protocol conversion (Telegram/Slack/WebSocket → ChatRequest)
 * - Response formatting (ChatResult → platform-specific format)
 * - Action handling (button presses, interactions)
 */

// Types
export type {
  MessageContext,
  TelegramMessageContext,
  SlackMessageContext,
  WebSocketMessageContext,
  TelegramCallbackContext,
  SlackInteractionContext,
  ResponseStrategy,
  ResponseOptions,
  PlatformAdapter,
  ParsedAction,
} from "./types.js";

// Base adapter
export { BaseAdapter } from "./BaseAdapter.js";

// Platform adapters
export {
  TelegramAdapter,
  type TelegramAdapterDeps,
  type HandleUpdateResult,
} from "./TelegramAdapter.js";
export {
  SlackAdapter,
  type SlackAdapterDeps,
  type HandleEventResult,
  type SlackEventBody,
} from "./SlackAdapter.js";
export { WebSocketAdapter, type WebSocketAdapterDeps } from "./WebSocketAdapter.js";

// Request routing
export {
  RequestRouter,
  createRequestRouter,
  type RouterDeps,
  type RoutingContext,
  type RequestIntent,
  type CommandIntent,
  type WizardAction,
} from "./RequestRouter.js";
