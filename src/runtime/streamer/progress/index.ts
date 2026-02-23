import type { SessionAgent } from "../../db.js";
import type { ProgressEvent } from "./types.js";
import { extractClaudeProgress } from "./claudeExtractor.js";
import { extractCodexProgress } from "./codexExtractor.js";

export type { ProgressEvent } from "./types.js";

export type ProgressExtractorFn = (obj: unknown) => ProgressEvent[];

const PROGRESS_EXTRACTORS: Record<SessionAgent, ProgressExtractorFn> = {
  codex: extractCodexProgress,
  claude_code: extractClaudeProgress,
};

export function extractProgress(agent: SessionAgent, obj: unknown): ProgressEvent[] {
  const extractor = PROGRESS_EXTRACTORS[agent];
  return extractor ? extractor(obj) : [];
}
