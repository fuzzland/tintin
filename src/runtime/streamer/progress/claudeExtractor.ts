import type { ProgressEvent } from "./types.js";
import { parseMcpFunctionName } from "../PlaywrightScreenshotManager.js";
import { truncateLogLine } from "../eventMappers/helpers.js";

const MAX_OUTPUT_LEN = 500;
const MAX_INPUT_LEN = 200;

/**
 * Extract progress events from a Claude Code JSONL event object.
 */
export function extractClaudeProgress(obj: unknown): ProgressEvent[] {
  if (!obj || typeof obj !== "object") return [];
  const type = (obj as { type?: unknown }).type;

  if (type === "assistant" || type === "user") {
    const message = (obj as { message?: unknown }).message;
    if (!message || typeof message !== "object") return [];
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];

    const events: ProgressEvent[] = [];
    let hasToolUse = false;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const blockType = (block as { type?: unknown }).type;

      if (blockType === "tool_use") {
        hasToolUse = true;
        const id = typeof (block as { id?: unknown }).id === "string" ? (block as { id: string }).id : "";
        const name = typeof (block as { name?: unknown }).name === "string" ? (block as { name: string }).name : "";
        events.push({
          kind: "tool_call_start",
          id,
          tool: normalizeToolName(name),
          input: extractInputSummary(name, (block as { input?: unknown }).input),
          ts: Date.now(),
        });
        continue;
      }

      if (blockType === "tool_result") {
        const id = typeof (block as { tool_use_id?: unknown }).tool_use_id === "string"
          ? (block as { tool_use_id: string }).tool_use_id : "";
        events.push(
          { kind: "tool_call_end", id, ts: Date.now() },
          { kind: "tool_call_result", id, output: truncateOutput((block as { content?: unknown }).content), ts: Date.now() },
        );
        continue;
      }
    }

    // Text-only assistant message = thinking phase
    if (type === "assistant" && !hasToolUse && hasTextContent(content)) {
      events.push({ kind: "thinking_start", ts: Date.now() });
    }

    return events;
  }

  if (type === "result") {
    if ((obj as { is_error?: unknown }).is_error) {
      const error = (obj as { error?: unknown }).error;
      const message = typeof error === "string" ? error : "unknown";
      return [{ kind: "run_error", message, ts: Date.now() }];
    }
  }

  return [];
}

function normalizeToolName(name: string): string {
  if (!name) return "unknown";
  const parsed = parseMcpFunctionName(name);
  if (parsed) return `mcp:${parsed.server}.${parsed.tool}`;
  return name;
}

function extractInputSummary(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const inp = input as Record<string, unknown>;
  // Bash → command
  if (typeof inp.command === "string") return truncateLogLine(inp.command, MAX_INPUT_LEN);
  // Read → file_path
  if (typeof inp.file_path === "string") return truncateLogLine(inp.file_path, MAX_INPUT_LEN);
  // Glob → pattern
  if (typeof inp.pattern === "string") return truncateLogLine(inp.pattern, MAX_INPUT_LEN);
  // Grep → pattern
  if (typeof inp.regex === "string") return truncateLogLine(inp.regex, MAX_INPUT_LEN);
  // Edit → file_path
  if (typeof inp.path === "string") return truncateLogLine(inp.path, MAX_INPUT_LEN);
  return undefined;
}

function truncateOutput(content: unknown): string | undefined {
  if (typeof content === "string") return truncateLogLine(content, MAX_OUTPUT_LEN);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if ((item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string") {
        parts.push((item as { text: string }).text);
      }
    }
    const joined = parts.join("\n").trim();
    return joined ? truncateLogLine(joined, MAX_OUTPUT_LEN) : undefined;
  }
  return undefined;
}

function hasTextContent(content: unknown[]): boolean {
  return content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.trim().length > 0,
  );
}
