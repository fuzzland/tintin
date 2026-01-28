import { t, type UserLanguage } from "../../../locales/index.js";
import type { StreamFragment, EventMsgPayloadOptions } from "../types.js";
import { parsePlanUpdatePayload } from "../PlanUpdateHandler.js";
import {
  stringOrEmpty,
  numberOrNull,
  formatTitledText,
  formatCommand,
  decodeBase64ToString,
  normalizeAgentMessage,
  extractTitleFromPayload,
  formatSessionConfigured,
  formatMcpStartupUpdate,
  formatMcpStartupComplete,
  formatMcpInvocation,
  formatMcpToolResult,
  formatMcpListTools,
  formatPatchApprovalRequest,
  formatPatchApplyBegin,
  formatPatchApplyEnd,
  formatCustomPrompts,
  formatTurnAbortReason,
  formatEnteredReview,
  formatExitedReview,
} from "./helpers.js";

/**
 * Map an event_msg payload (from Codex) to stream fragments.
 * This handles the ~40+ event types that can appear in event_msg payloads.
 */
export function mapEventMsgPayload(
  payload: Record<string, unknown>,
  opts?: EventMsgPayloadOptions,
): StreamFragment[] {
  const evType = typeof payload.type === "string" ? payload.type : null;
  if (!evType) return [];
  const lang = opts?.lang ?? "en";
  const includeUserMessages = opts?.includeUserMessages !== false;
  const includeReasoning = opts?.includeReasoning !== false;
  const includeEvents = opts?.includeEvents !== false;
  const includeTools = opts?.includeTools !== false;

  const text = (value: unknown, continuous = false, separate = false): StreamFragment[] => {
    if (typeof value !== "string" || value.length === 0) return [];
    return [{ kind: "text", text: value, continuous, separate }];
  };

  switch (evType) {
    case "error":
      if (!includeEvents) return [];
      if (/^reconnecting/i.test(stringOrEmpty(payload.message))) return [];
      return text(formatTitledText(t("streamer.error", lang), stringOrEmpty(payload.message)));
    case "warning":
      if (!includeEvents) return [];
      return text(formatTitledText(t("streamer.warning", lang), stringOrEmpty(payload.message)));
    case "context_compacted":
      if (!includeEvents) return [];
      return text(formatTitledText(t("streamer.context_compacted", lang)));
    case "task_started": {
      if (!includeEvents) return [];
      const ctxWin = numberOrNull(payload.model_context_window);
      const suffix = ctxWin !== null ? t("streamer.context_window", lang, { n: ctxWin }) : "";
      return text(formatTitledText(t("streamer.task_started", lang), suffix || null));
    }
    case "task_complete": {
      if (!includeEvents) return [];
      const last = stringOrEmpty(payload.last_agent_message);
      const body = last ? t("streamer.last_message", lang, { message: last }) : null;
      return text(formatTitledText(t("streamer.task_complete", lang), body));
    }
    case "token_count":
      return [];
    case "agent_message": {
      const msg = normalizeAgentMessage(payload);
      return text(msg, false, true);
    }
    case "user_message":
      return includeUserMessages
        ? text(t("streamer.user", lang, { message: stringOrEmpty(payload.message) }))
        : [];
    case "agent_message_delta":
    case "agent_message_content_delta":
      return text(stringOrEmpty(payload.delta), true);
    case "agent_reasoning": {
      if (!includeReasoning) return [];
      const msg = stringOrEmpty(payload.text);
      const { title, content } = extractTitleFromPayload(payload);
      return content
        ? text(formatTitledText(title ?? t("streamer.reasoning", lang), content ?? msg, { inline: false }))
        : [];
    }
    case "agent_reasoning_delta":
    case "reasoning_content_delta":
      return includeReasoning ? text(stringOrEmpty(payload.delta), true) : [];
    case "agent_reasoning_raw_content": {
      if (!includeReasoning) return [];
      const msg = stringOrEmpty(payload.text);
      const title = stringOrEmpty((payload as { title?: unknown }).title) || t("streamer.reasoning_raw", lang);
      return msg ? text(formatTitledText(title, msg, { inline: false })) : [];
    }
    case "agent_reasoning_raw_content_delta":
    case "reasoning_raw_content_delta":
      return includeReasoning ? text(stringOrEmpty(payload.delta), true) : [];
    case "agent_reasoning_section_break":
      return includeReasoning ? text("\n----\n", true) : [];
    case "session_configured":
      if (!includeEvents) return [];
      return text(formatTitledText(t("streamer.session_configured", lang), formatSessionConfigured(payload) || null));
    case "mcp_startup_update": {
      if (!includeEvents) return [];
      const update = formatMcpStartupUpdate(payload, lang);
      return text(formatTitledText(update.title, update.detail || null));
    }
    case "mcp_startup_complete": {
      if (!includeEvents) return [];
      const summary = formatMcpStartupComplete(payload, lang);
      return text(formatTitledText(summary.title, summary.detail));
    }
    case "mcp_tool_call_begin": {
      if (!includeTools) return [];
      const call = formatMcpInvocation(payload.invocation);
      return call ? [{ kind: "tool_call", text: call }] : [];
    }
    case "mcp_tool_call_end": {
      if (!includeTools) return [];
      const summary = formatMcpToolResult(payload.result, payload.invocation, lang);
      return summary ? [{ kind: "tool_output", text: summary }] : [];
    }
    case "web_search_begin":
      if (!includeTools) return [];
      return text(t("streamer.web_search_started", lang));
    case "web_search_end": {
      if (!includeTools) return [];
      const query = stringOrEmpty(payload.query);
      return query ? text(t("streamer.web_search", lang, { query })) : [];
    }
    case "exec_command_begin": {
      if (!includeTools) return [];
      const cmd = formatCommand(payload.command);
      const cwd = stringOrEmpty(payload.cwd);
      const prefix = cwd ? `[${cwd}] ` : "";
      const body = cmd ? `${prefix}$ ${cmd}\n` : `${prefix}$`;
      return text(body);
    }
    case "exec_command_output_delta": {
      if (!includeTools) return [];
      const chunk = decodeBase64ToString(payload.chunk);
      return chunk ? text(chunk, true) : [];
    }
    case "terminal_interaction": {
      if (!includeTools) return [];
      const stdin = stringOrEmpty(payload.stdin);
      const pid = stringOrEmpty(payload.process_id);
      if (!stdin) return [];
      return text(pid ? `[stdin -> ${pid}] ${stdin}` : `[stdin] ${stdin}`);
    }
    case "exec_command_end": {
      if (!includeTools) return [];
      const exit = numberOrNull(payload.exit_code);
      const cmd = formatCommand(payload.command);
      const status = exit !== null ? ` ${t("streamer.command_exit", lang, { code: exit })}` : "";
      const suffix = stringOrEmpty(payload.stderr);
      const commandLabel = cmd ? `$ ${cmd}` : t("streamer.command", lang);
      const base = cmd
        ? t("streamer.command_completed_with", lang, { command: commandLabel })
        : t("streamer.command_completed", lang);
      const summary = `${base}${status}`;
      if (suffix) return text(`${summary}: ${suffix}`);
      return text(summary);
    }
    case "view_image_tool_call": {
      if (!includeTools) return [];
      const path = stringOrEmpty(payload.path);
      return path ? text(t("streamer.view_image", lang, { path })) : [];
    }
    case "exec_approval_request": {
      if (!includeEvents) return [];
      const cmd = formatCommand(payload.command);
      const cwd = stringOrEmpty(payload.cwd);
      const reason = stringOrEmpty(payload.reason);
      const parts = [];
      if (cwd) parts.push(`[${cwd}]`);
      if (cmd) parts.push(`$ ${cmd}`);
      if (reason) parts.push(t("streamer.reason", lang, { reason }));
      return text(formatTitledText(t("streamer.approval_needed", lang), parts.join(" ").trim() || null));
    }
    case "elicitation_request": {
      if (!includeEvents) return [];
      const server = stringOrEmpty(payload.server_name);
      const message = stringOrEmpty(payload.message);
      const prefix = server ? `${server}: ` : "";
      return text(formatTitledText(t("streamer.elicitation_request", lang), `${prefix}${message}`.trim() || null));
    }
    case "apply_patch_approval_request": {
      if (!includeEvents) return [];
      const summary = formatPatchApprovalRequest(payload, lang);
      return summary ? text(formatTitledText(t("streamer.patch_approval_needed", lang), summary)) : [];
    }
    case "deprecation_notice": {
      if (!includeEvents) return [];
      const summary = stringOrEmpty(payload.summary);
      const details = stringOrEmpty(payload.details);
      const body = details ? `${summary} - ${details}` : summary;
      return text(formatTitledText(t("streamer.deprecated", lang), body || null));
    }
    case "background_event":
      if (!includeEvents) return [];
      {
        const msg = stringOrEmpty(payload.message);
        if (msg.startsWith("tintin ")) return [];
        return text(msg);
      }
    case "undo_started": {
      if (!includeEvents) return [];
      const msg = stringOrEmpty(payload.message);
      return text(formatTitledText(t("streamer.undo_started", lang), msg || null));
    }
    case "undo_completed": {
      if (!includeEvents) return [];
      const msg = stringOrEmpty(payload.message);
      const success = typeof payload.success === "boolean" ? payload.success : false;
      const base = success ? t("streamer.undo_completed", lang) : t("streamer.undo_failed", lang);
      return text(formatTitledText(base, msg || null));
    }
    case "stream_error":
      if (!includeEvents) return [];
      return text(formatTitledText(t("streamer.stream_error", lang), stringOrEmpty(payload.message)));
    case "patch_apply_begin": {
      if (!includeEvents) return [];
      const summary = formatPatchApplyBegin(payload, lang);
      return text(formatTitledText(t("streamer.applying_patch", lang), summary));
    }
    case "patch_apply_end": {
      if (!includeEvents) return [];
      const summary = formatPatchApplyEnd(payload, lang);
      return text(formatTitledText(t("streamer.patch_apply", lang), summary));
    }
    case "turn_diff": {
      if (!includeTools) return [];
      const diff = stringOrEmpty(payload.unified_diff);
      return diff ? [{ kind: "tool_output", text: diff }] : [];
    }
    case "get_history_entry_response": {
      if (!includeEvents) return [];
      const offset = numberOrNull(payload.offset);
      const logId = numberOrNull(payload.log_id);
      const entry = (payload as { entry?: unknown }).entry;
      const found = entry !== null && entry !== undefined;
      const parts: string[] = [];
      if (logId !== null) parts.push(t("streamer.history_entry_log", lang, { id: logId }));
      if (offset !== null) parts.push(t("streamer.history_entry_offset", lang, { offset }));
      const label = [t("streamer.history_entry", lang), parts.join(" ")].filter(Boolean).join(" ");
      return text(formatTitledText(label, found ? t("streamer.history_entry_returned", lang) : t("streamer.history_entry_not_found", lang)));
    }
    case "mcp_list_tools_response":
      if (!includeEvents) return [];
      return text(formatTitledText(t("streamer.mcp_list", lang), formatMcpListTools(payload, lang)));
    case "list_custom_prompts_response":
      if (!includeEvents) return [];
      return text(formatTitledText(t("streamer.custom_prompts", lang), formatCustomPrompts(payload, lang)));
    case "plan_update": {
      const parsed = parsePlanUpdatePayload(payload);
      if (!parsed) return [];
      return [{ kind: "plan_update", plan: parsed.plan, explanation: parsed.explanation }];
    }
    case "turn_aborted": {
      if (!includeEvents) return [];
      const reason = formatTurnAbortReason(payload.reason);
      return text(formatTitledText(t("streamer.turn_aborted", lang), reason || null));
    }
    case "shutdown_complete": {
      const message = includeEvents ? text(formatTitledText(t("streamer.shutdown_complete", lang))) : [];
      return [...message, { kind: "final" }];
    }
    case "entered_review_mode": {
      if (!includeEvents) return [];
      const summary = formatEnteredReview(payload, lang);
      return text(formatTitledText(t("streamer.entered_review_mode", lang), summary));
    }
    case "exited_review_mode": {
      if (!includeEvents) return [];
      const summary = formatExitedReview(payload, lang);
      return text(formatTitledText(t("streamer.exited_review_mode", lang), summary));
    }
    case "raw_response_item":
    case "item_started":
    case "item_completed":
      return [];
    default:
      return [];
  }
}
