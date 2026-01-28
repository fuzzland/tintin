import type { SessionAgent } from "../../db.js";
import type { StreamFragment, EventMapperOptions, MessageVerbosity } from "../types.js";
import { mapCodexEventToFragments } from "./codexMapper.js";
import { mapClaudeEventToFragments } from "./claudeMapper.js";

// Re-export all mappers and helpers
export { mapCodexEventToFragments } from "./codexMapper.js";
export { mapClaudeEventToFragments } from "./claudeMapper.js";
export { mapEventMsgPayload } from "./messageDispatcher.js";
export {
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
} from "./helpers.js";

/**
 * Event mappers indexed by agent type.
 */
export const EVENT_MAPPERS: Record<
  SessionAgent,
  (obj: unknown, opts?: EventMapperOptions) => StreamFragment[]
> = {
  codex: mapCodexEventToFragments,
  claude_code: mapClaudeEventToFragments,
};

/**
 * Map a JSONL event to stream fragments based on agent type.
 */
export function mapEventToFragments(
  agent: SessionAgent,
  obj: unknown,
  opts?: { includeUserMessages?: boolean; verbosity?: MessageVerbosity; lang?: string },
): StreamFragment[] {
  const mapper = EVENT_MAPPERS[agent];
  return mapper ? mapper(obj, opts as EventMapperOptions) : [];
}
