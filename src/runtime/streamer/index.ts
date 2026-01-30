// Streamer module - modular JSONL stream processing
//
// This module provides the refactored, modular implementation of the JsonlStreamer.
// Each component has a single responsibility:
// - ToolCallManager: Manages pending tool calls queue for pairing calls with outputs
// - PlanUpdateHandler: Handles plan update parsing and output suppression
// - PlaywrightScreenshotManager: Manages browser screenshot capture and sending
// - eventMappers/*: Convert JSONL events to StreamFragment[]

export { ToolCallManager } from "./ToolCallManager.js";
export { PlanUpdateHandler, parsePlanUpdatePayload } from "./PlanUpdateHandler.js";
export {
  PlaywrightScreenshotManager,
  parseMcpFunctionName,
  extractPlaywrightInlineScreenshot,
  extractPlaywrightInlineScreenshotFromMcpResult,
  extractPlaywrightInlineScreenshotFromClaudeToolResult,
  type ExtractedScreenshot,
} from "./PlaywrightScreenshotManager.js";
export { JsonlStreamer } from "./JsonlStreamer.js";

export type {
  StreamFragment,
  MessageVerbosity,
  EventMapperOptions,
  EventMsgPayloadOptions,
  BufferState,
} from "./types.js";

export {
  EVENT_MAPPERS,
  mapEventToFragments,
  mapCodexEventToFragments,
  mapClaudeEventToFragments,
  mapEventMsgPayload,
  stringOrEmpty,
  numberOrNull,
  normalizeMessageVerbosity,
  formatTitledText,
  truncateJson,
  truncateLogLine,
  formatToolPairMessage,
  normalizeAgentMessage,
  extractMcpResultText,
  getTextFromContentItems,
} from "./eventMappers/index.js";
