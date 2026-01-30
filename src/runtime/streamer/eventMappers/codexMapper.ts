import { t, type UserLanguage } from "../../../locales/index.js";
import type { StreamFragment, MessageVerbosity, EventMapperOptions } from "../types.js";
import {
  stringOrEmpty,
  numberOrNull,
  normalizeMessageVerbosity,
  formatTitledText,
  normalizeAgentMessage,
  formatCommitJsonMessage,
  extractMcpResultText,
  extractCommandFromToolArgs,
  truncateJson,
  truncateLogLine,
  extractTitleFromPayload,
} from "./helpers.js";
import { mapEventMsgPayload } from "./messageDispatcher.js";

/**
 * Map a Codex JSONL event to stream fragments.
 */
export function mapCodexEventToFragments(
  obj: unknown,
  opts?: EventMapperOptions,
): StreamFragment[] {
  if (!obj || typeof obj !== "object") return [];
  const verbosity = normalizeMessageVerbosity(opts?.verbosity);
  const lang = opts?.lang ?? "en";
  const includeUserMessages = opts?.includeUserMessages !== false;
  const includeReasoning = verbosity >= 2;
  const includeEvents = verbosity >= 2;
  const includeTools = verbosity >= 3;
  const type = (obj as { type?: unknown }).type;

  if (typeof type === "string") {
    if (type === "turn.completed" || type === "thread.completed") {
      return [{ kind: "final" }];
    }
    if (type === "turn.failed" || type === "thread.failed") {
      if (!includeEvents) return [];
      const error = (obj as { error?: unknown }).error;
      const message =
        stringOrEmpty((obj as { message?: unknown }).message) ||
        stringOrEmpty((error as { message?: unknown })?.message) ||
        stringOrEmpty(error);
      const body = message || t("streamer.unknown_error", lang);
      return [{ kind: "text", text: formatTitledText(t("streamer.run_failed", lang), body) }];
    }

    if (type === "error") {
      if (!includeEvents) return [];
      const message = stringOrEmpty((obj as { message?: unknown }).message);
      if (!message) return [];
      if (/^reconnecting/i.test(message)) return [];
      return [{ kind: "text", text: formatTitledText(t("streamer.error", lang), message) }];
    }
  }

  // RolloutLine: { timestamp, type, payload }
  if (typeof type === "string" && (obj as { payload?: unknown }).payload !== undefined) {
    const payload = (obj as { payload: unknown }).payload;
    if (type === "response_item") {
      if (!payload || typeof payload !== "object") return [];
      const itemType = (payload as { type?: unknown }).type;

      if (itemType === "message") {
        // Agent messages also arrive as event_msgs; skipping here prevents duplicate sends.
        return [];
      }

      if (itemType === "function_call") {
        if (!includeTools) return [];
        const name = (payload as { name?: unknown }).name;
        const argumentsRaw = (payload as { arguments?: unknown }).arguments;
        if (typeof name !== "string") return [];
        const argsText = typeof argumentsRaw === "string" ? argumentsRaw : "";
        const cmd = extractCommandFromToolArgs(name, argsText);
        const text = cmd ? `$ ${cmd}` : t("streamer.tool", lang, { name });
        return [{ kind: "tool_call", text }];
      }

      if (itemType === "function_call_output") {
        if (!includeTools) return [];
        const output = (payload as { output?: unknown }).output;
        const text = typeof output === "string" ? output : JSON.stringify(output);
        if (!text) return [];
        return [{ kind: "tool_output", text }];
      }

      if (itemType === "custom_tool_call") {
        if (!includeTools) return [];
        const name = (payload as { name?: unknown }).name;
        const input = (payload as { input?: unknown }).input;
        if (typeof name !== "string") return [];
        const line = typeof input === "string" && input.length > 0 ? `${name}: ${input}` : `${name}`;
        return [{ kind: "tool_call", text: t("streamer.tool", lang, { name: line }) }];
      }

      if (itemType === "custom_tool_call_output") {
        if (!includeTools) return [];
        const output = (payload as { output?: unknown }).output;
        const text = typeof output === "string" ? output : JSON.stringify(output);
        if (!text) return [];
        return [{ kind: "tool_output", text }];
      }

      if (itemType === "web_search_call") {
        if (!includeTools) return [];
        const action = (payload as { action?: unknown }).action;
        const query = action && typeof action === "object" ? (action as { query?: unknown }).query : undefined;
        if (typeof query === "string") return [{ kind: "text", text: t("streamer.web_search", lang, { query }) }];
      }

      if (itemType === "local_shell_call") {
        if (!includeTools) return [];
        const action = (payload as { action?: unknown }).action;
        const cmd = action && typeof action === "object" ? (action as { command?: unknown }).command : undefined;
        if (typeof cmd === "string") return [{ kind: "tool_call", text: `$ ${cmd}` }];
      }

      return [];
    }

    if (type === "event_msg") {
      if (!payload || typeof payload !== "object") return [];
      return mapEventMsgPayload(payload as Record<string, unknown>, {
        includeUserMessages,
        includeReasoning,
        includeEvents,
        includeTools,
        lang,
      });
    }

    return [];
  }

  // ThreadEvent JSONL (from codex exec --json stdout or other logs)
  if (typeof type === "string" && type.startsWith("item.") && (obj as { item?: unknown }).item) {
    const item = (obj as { item: unknown }).item;
    if (!item || typeof item !== "object") return [];
    const detailsType = typeof (item as { type?: unknown }).type === "string" ? (item as { type: string }).type : "";
    if (detailsType === "agent_message") {
      const text = normalizeAgentMessage(item);
      const formatted = text ? formatCommitJsonMessage(text, lang) : null;
      const output = formatted ?? text;
      return output ? [{ kind: "text", text: output, separate: true }] : [];
    }
    if (detailsType === "reasoning") {
      if (!includeReasoning) return [];
      const text = stringOrEmpty((item as { text?: unknown }).text);
      if (!text) return [];
      const { title, content } = extractTitleFromPayload({ type: "agent_reasoning", text });
      const body = content ?? text;
      return [{ kind: "text", text: formatTitledText(title ?? t("streamer.reasoning", lang), body, { inline: false }) }];
    }
    if (detailsType === "command_execution") {
      if (!includeTools) return [];
      const cmd = stringOrEmpty((item as { command?: unknown }).command);
      const status = stringOrEmpty((item as { status?: unknown }).status);
      const output = stringOrEmpty((item as { aggregated_output?: unknown }).aggregated_output);
      const exit = numberOrNull((item as { exit_code?: unknown }).exit_code);
      const isStart = type === "item.started" || status === "in_progress";
      if (isStart) {
        return cmd ? [{ kind: "tool_call", text: `$ ${cmd}` }] : [];
      }
      const commandLabel = cmd ? `$ ${cmd}` : t("streamer.command", lang);
      if (output) {
        const suffix = exit !== null ? `\n${t("streamer.command_exit", lang, { code: exit })}` : "";
        return [{ kind: "tool_output", text: `${output}${suffix}` }];
      }
      if (exit !== null) {
        const base = cmd
          ? t("streamer.command_completed_with", lang, { command: commandLabel })
          : t("streamer.command_completed", lang);
        return [{ kind: "text", text: `${base} ${t("streamer.command_exit", lang, { code: exit })}`.trim() }];
      }
      if (status === "failed") {
        return [
          {
            kind: "text",
            text: cmd
              ? t("streamer.command_failed_with", lang, { command: commandLabel })
              : t("streamer.command_failed", lang),
          },
        ];
      }
      return cmd
        ? [{ kind: "text", text: t("streamer.command_completed_with", lang, { command: commandLabel }) }]
        : [{ kind: "text", text: t("streamer.command_completed", lang) }];
    }
    if (detailsType === "mcp_tool_call") {
      if (!includeTools) return [];
      const server = stringOrEmpty((item as { server?: unknown }).server);
      const tool = stringOrEmpty((item as { tool?: unknown }).tool);
      const args = (item as { arguments?: unknown }).arguments;
      const status = stringOrEmpty((item as { status?: unknown }).status);
      const label = [server, tool].filter(Boolean).join(".");
      const argText = args === undefined ? "" : ` ${truncateJson(args, 300)}`;
      const toolLabel = label ? `MCP ${label}` : t("streamer.mcp_tool", lang);
      const isStart = type === "item.started" || status === "in_progress";
      if (isStart) {
        return [{ kind: "tool_call", text: `${toolLabel}${argText}` }];
      }
      const output = extractMcpResultText((item as { result?: unknown }).result);
      const err = stringOrEmpty((item as { error?: unknown }).error);
      let body = output || "";
      if (err) {
        const errorLabel = t("streamer.error", lang);
        body = body ? `${body}\n${errorLabel}: ${err}` : `${errorLabel}: ${err}`;
      }
      if (!body && (item as { result?: unknown }).result !== undefined) {
        body = truncateJson((item as { result?: unknown }).result, 800);
      }
      if (!body) return [{ kind: "text", text: t("streamer.tool_completed", lang, { tool: toolLabel }) }];
      return [{ kind: "tool_output", text: truncateLogLine(body, 4000) }];
    }
    if (detailsType === "file_change") {
      if (!includeEvents) return [];
      const changes = Array.isArray((item as { changes?: unknown }).changes) ? (item as { changes: unknown[] }).changes : [];
      const lines = changes
        .map((change) => {
          if (!change || typeof change !== "object") return "";
          const kindRaw = (change as { kind?: unknown }).kind;
          const kind = typeof kindRaw === "string" ? kindRaw : "change";
          const label =
            kind === "add"
              ? t("streamer.file_added", lang)
              : kind === "modify"
                ? t("streamer.file_modified", lang)
                : kind === "delete"
                  ? t("streamer.file_deleted", lang)
                  : kind;
          const p = stringOrEmpty((change as { path?: unknown }).path);
          return p ? `${label}: ${p}` : label;
        })
        .filter(Boolean);
      const body = lines.length > 0 ? lines.join("\n") : t("streamer.files_changed_empty", lang);
      return [{ kind: "text", text: formatTitledText(t("streamer.files_changed", lang), body, { inline: false }) }];
    }
  }

  return [];
}
