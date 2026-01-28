import { t, type UserLanguage } from "../../../locales/index.js";
import type { StreamFragment, EventMapperOptions, MessageVerbosity } from "../types.js";
import {
  stringOrEmpty,
  numberOrNull,
  normalizeMessageVerbosity,
  formatTitledText,
  truncateJson,
} from "./helpers.js";
import { parseMcpFunctionName } from "../PlaywrightScreenshotManager.js";

/**
 * Map a Claude Code JSONL event to stream fragments.
 */
export function mapClaudeEventToFragments(
  obj: unknown,
  opts?: EventMapperOptions,
): StreamFragment[] {
  if (!obj || typeof obj !== "object") return [];
  const verbosity = normalizeMessageVerbosity(opts?.verbosity);
  const lang = opts?.lang ?? "en";
  const includeUserMessages = opts?.includeUserMessages !== false;
  const includeEvents = verbosity >= 2;
  const includeTools = verbosity >= 3;

  const type = stringOrEmpty((obj as { type?: unknown }).type);

  if (type === "result") {
    // Non-interactive print mode emits a final result event; treat this as flush boundary.
    // Keep chat quiet on success unless verbosity requests events.
    const subtype = stringOrEmpty((obj as { subtype?: unknown }).subtype);
    const isError = Boolean((obj as { is_error?: unknown }).is_error);
    const statusLabel = subtype || t("streamer.unknown", lang);
    const statusSuffix = isError ? t("streamer.result_error_suffix", lang) : "";
    const msg =
      includeEvents && (isError || (subtype && subtype !== "success"))
        ? formatTitledText(t("streamer.result", lang), `${statusLabel}${statusSuffix}`.trim())
        : null;
    const prefix = msg ? [{ kind: "text" as const, text: msg }] : [];
    return [...prefix, { kind: "final" }];
  }

  if (type === "assistant" || type === "user") {
    const message = (obj as { message?: unknown }).message;
    if (!message || typeof message !== "object") return [];
    const content = (message as { content?: unknown }).content;

    const fragments: StreamFragment[] = [];

    const pushText = (text: string, continuous = false, separate = false) => {
      const trimmed = text.trimEnd();
      if (!trimmed) return;
      fragments.push({ kind: "text", text: trimmed, continuous, separate });
    };
    let separateNext = type === "assistant";

    if (typeof content === "string") {
      if (type === "user") {
        if (includeUserMessages) pushText(t("streamer.user", lang, { message: content }));
      } else {
        pushText(content, false, true);
      }
      return fragments;
    }

    if (!Array.isArray(content)) return fragments;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const blockType = stringOrEmpty((block as { type?: unknown }).type);

      if (blockType === "text" && typeof (block as { text?: unknown }).text === "string") {
        if (type === "user" && !includeUserMessages) continue;
        const blockText = (block as { text: string }).text;
        if (type === "user") {
          pushText(t("streamer.user", lang, { message: blockText }), false, separateNext);
        } else {
          pushText(blockText, false, separateNext);
        }
        separateNext = false;
        continue;
      }

      if (blockType === "tool_use") {
        if (!includeTools) continue;
        const name = stringOrEmpty((block as { name?: unknown }).name);
        const input = (block as { input?: unknown }).input;
        const formatted = formatClaudeToolUse(name, input, lang);
        if (formatted) fragments.push({ kind: "tool_call", text: formatted });
        continue;
      }

      if (blockType === "tool_result") {
        if (!includeTools) continue;
        const output = formatClaudeToolResult(block as Record<string, unknown>);
        if (output) fragments.push({ kind: "tool_output", text: output });
        continue;
      }
    }

    return fragments;
  }

  if (type === "system") {
    if (!includeEvents) return [];
    const subtype = stringOrEmpty((obj as { subtype?: unknown }).subtype);
    const text = subtype ? formatTitledText(t("streamer.system", lang), subtype) : null;
    return text ? [{ kind: "text", text }] : [];
  }

  if (type === "tool_progress") {
    if (!includeEvents) return [];
    const tool = stringOrEmpty((obj as { tool_name?: unknown }).tool_name);
    const elapsed = numberOrNull((obj as { elapsed_time_seconds?: unknown }).elapsed_time_seconds);
    const suffix = tool ? `${tool}${elapsed !== null ? ` (${elapsed}s)` : ""}` : t("streamer.tool_progress_fallback", lang);
    return [{ kind: "text", text: formatTitledText(t("streamer.tool_progress", lang), suffix) }];
  }

  return [];
}

/**
 * Format a Claude tool_use block for display.
 */
function formatClaudeToolUse(name: string, input: unknown, lang: UserLanguage): string | null {
  if (!name) return null;

  if (name === "Bash") {
    const cmd =
      input && typeof input === "object" ? ((input as { command?: unknown }).command as unknown) : undefined;
    if (typeof cmd === "string" && cmd.trim().length > 0) return `$ ${cmd.trim()}`;
    return t("streamer.tool", lang, { name: "Bash" });
  }

  const parsed = parseMcpFunctionName(name);
  if (parsed) return `MCP: ${parsed.server}.${parsed.tool}`;
  return t("streamer.tool", lang, { name });
}

/**
 * Format a Claude tool_result block for display.
 */
function formatClaudeToolResult(block: Record<string, unknown>): string | null {
  const content = block.content;
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const itemType = stringOrEmpty((item as { type?: unknown }).type);
      if (itemType === "text" && typeof (item as { text?: unknown }).text === "string") {
        const text = (item as { text: string }).text.trimEnd();
        if (text) out.push(text);
        continue;
      }
      out.push(truncateJson(item, 200));
    }
    const joined = out.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }

  if (content && typeof content === "object") return truncateJson(content, 800);
  return null;
}
