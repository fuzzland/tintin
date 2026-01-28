import type { UserLanguage } from "../../locales/index.js";

/**
 * A fragment of streamed output from an agent session.
 */
export type StreamFragment =
  | { kind: "text"; text: string; continuous?: boolean; separate?: boolean }
  | { kind: "tool_call"; text: string }
  | { kind: "tool_output"; text: string }
  | { kind: "plan_update"; plan: Array<{ step: string; status: string }>; explanation?: string }
  | { kind: "final" };

/**
 * Message verbosity level:
 * 1 = minimal (text only)
 * 2 = normal (text + events + reasoning)
 * 3 = verbose (text + events + reasoning + tools)
 */
export type MessageVerbosity = 1 | 2 | 3;

/**
 * Options passed to event mappers.
 */
export interface EventMapperOptions {
  includeUserMessages?: boolean;
  verbosity?: MessageVerbosity;
  lang?: UserLanguage;
}

/**
 * Internal options for mapEventMsgPayload with decomposed flags.
 */
export interface EventMsgPayloadOptions {
  includeUserMessages?: boolean;
  includeReasoning?: boolean;
  includeEvents?: boolean;
  includeTools?: boolean;
  lang?: UserLanguage;
}

/**
 * Buffer state for text accumulation before flush.
 */
export interface BufferState {
  text: string;
  lastFlushMs: number;
}
