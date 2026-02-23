import type { ProgressEvent } from "./types.js";
import { formatCommand, truncateLogLine, stringOrEmpty, extractMcpResultText } from "../eventMappers/helpers.js";

const MAX_OUTPUT_LEN = 500;
const MAX_INPUT_LEN = 200;

let idCounter = 0;
function genId(): string {
  return `codex_${++idCounter}_${Date.now()}`;
}

/**
 * Extract progress events from a Codex JSONL event object.
 */
export function extractCodexProgress(obj: unknown): ProgressEvent[] {
  if (!obj || typeof obj !== "object") return [];
  const type = stringOrEmpty((obj as { type?: unknown }).type);

  // Error events
  if (type === "turn.failed" || type === "thread.failed") {
    const message = stringOrEmpty((obj as { message?: unknown }).message) || "unknown error";
    return [{ kind: "run_error", message, ts: Date.now() }];
  }

  if (type === "error") {
    const message = stringOrEmpty((obj as { message?: unknown }).message);
    if (message && !/^reconnecting/i.test(message)) {
      return [{ kind: "run_error", message, ts: Date.now() }];
    }
    return [];
  }

  // event_msg with payload
  if (type === "event_msg") {
    const payload = (obj as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") return [];
    return extractFromEventMsgPayload(payload as Record<string, unknown>);
  }

  // response_item
  if (type === "response_item") {
    const payload = (obj as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") return [];
    return extractFromResponseItem(payload as Record<string, unknown>);
  }

  // item.* events (ThreadEvent JSONL)
  if (type.startsWith("item.")) {
    const item = (obj as { item?: unknown }).item;
    if (!item || typeof item !== "object") return [];
    return extractFromItemEvent(type, item as Record<string, unknown>);
  }

  return [];
}

function extractFromEventMsgPayload(payload: Record<string, unknown>): ProgressEvent[] {
  const evType = stringOrEmpty(payload.type);

  switch (evType) {
    case "exec_command_begin": {
      const cmd = formatCommand(payload.command);
      return [{ kind: "tool_call_start", id: genId(), tool: "Bash", input: cmd || undefined, ts: Date.now() }];
    }
    case "exec_command_end":
      return [{ kind: "tool_call_end", id: genId(), ts: Date.now() }];

    case "mcp_tool_call_begin": {
      const inv = payload.invocation;
      const name = extractMcpToolName(inv);
      return [{ kind: "tool_call_start", id: genId(), tool: `mcp:${name}`, ts: Date.now() }];
    }
    case "mcp_tool_call_end": {
      const result = extractMcpResultText(payload.result);
      const endId = genId();
      const events: ProgressEvent[] = [{ kind: "tool_call_end", id: endId, ts: Date.now() }];
      if (result) events.push({ kind: "tool_call_result", id: endId, output: truncateLogLine(result, MAX_OUTPUT_LEN), ts: Date.now() });
      return events;
    }

    case "patch_apply_begin": {
      const changes = payload.changes;
      const files = changes && typeof changes === "object" ? Object.keys(changes as Record<string, unknown>).join(", ") : undefined;
      return [{ kind: "tool_call_start", id: genId(), tool: "Patch", input: files ? truncateLogLine(files, MAX_INPUT_LEN) : undefined, ts: Date.now() }];
    }
    case "patch_apply_end":
      return [{ kind: "tool_call_end", id: genId(), ts: Date.now() }];

    case "web_search_begin": {
      const query = stringOrEmpty(payload.query);
      return [{ kind: "tool_call_start", id: genId(), tool: "WebSearch", input: query || undefined, ts: Date.now() }];
    }
    case "web_search_end":
      return [{ kind: "tool_call_end", id: genId(), ts: Date.now() }];

    default:
      return [];
  }
}

function extractFromResponseItem(payload: Record<string, unknown>): ProgressEvent[] {
  const itemType = stringOrEmpty(payload.type);
  const callId = stringOrEmpty(payload.call_id) || genId();

  if (itemType === "function_call") {
    const name = stringOrEmpty(payload.name);
    const argsRaw = payload.arguments;
    const cmd = extractCommandFromArgs(argsRaw);
    return [{
      kind: "tool_call_start",
      id: callId,
      tool: name || "unknown",
      input: cmd || undefined,
      ts: Date.now(),
    }];
  }

  if (itemType === "function_call_output") {
    const output = typeof payload.output === "string" ? payload.output : undefined;
    return [
      { kind: "tool_call_end", id: callId, ts: Date.now() },
      { kind: "tool_call_result", id: callId, output: output ? truncateLogLine(output, MAX_OUTPUT_LEN) : undefined, ts: Date.now() },
    ];
  }

  if (itemType === "local_shell_call") {
    const action = payload.action;
    const cmd = action && typeof action === "object" ? stringOrEmpty((action as { command?: unknown }).command) : "";
    return [{
      kind: "tool_call_start",
      id: callId,
      tool: "Bash",
      input: cmd || undefined,
      ts: Date.now(),
    }];
  }

  if (itemType === "web_search_call") {
    const action = payload.action;
    const query = action && typeof action === "object" ? stringOrEmpty((action as { query?: unknown }).query) : "";
    return [{
      kind: "tool_call_start",
      id: callId,
      tool: "WebSearch",
      input: query || undefined,
      ts: Date.now(),
    }];
  }

  return [];
}

function extractFromItemEvent(type: string, item: Record<string, unknown>): ProgressEvent[] {
  const detailsType = stringOrEmpty(item.type);
  const isStart = type === "item.started" || stringOrEmpty(item.status) === "in_progress";

  if (detailsType === "command_execution") {
    const cmd = stringOrEmpty(item.command);
    if (isStart) {
      return [{ kind: "tool_call_start", id: genId(), tool: "Bash", input: cmd || undefined, ts: Date.now() }];
    }
    const output = stringOrEmpty(item.aggregated_output);
    return [
      { kind: "tool_call_end", id: genId(), ts: Date.now() },
      ...(output ? [{ kind: "tool_call_result" as const, id: genId(), output: truncateLogLine(output, MAX_OUTPUT_LEN), ts: Date.now() }] : []),
    ];
  }

  if (detailsType === "mcp_tool_call") {
    const server = stringOrEmpty(item.server);
    const tool = stringOrEmpty(item.tool);
    const name = [server, tool].filter(Boolean).join(".");
    if (isStart) {
      return [{ kind: "tool_call_start", id: genId(), tool: `mcp:${name}`, ts: Date.now() }];
    }
    const output = extractMcpResultText(item.result);
    return [
      { kind: "tool_call_end", id: genId(), ts: Date.now() },
      ...(output ? [{ kind: "tool_call_result" as const, id: genId(), output: truncateLogLine(output, MAX_OUTPUT_LEN), ts: Date.now() }] : []),
    ];
  }

  return [];
}

function extractMcpToolName(invocation: unknown): string {
  if (!invocation || typeof invocation !== "object") return "unknown";
  const server = stringOrEmpty((invocation as { server?: unknown }).server);
  const tool = stringOrEmpty((invocation as { tool?: unknown }).tool);
  return [server, tool].filter(Boolean).join(".");
}

function extractCommandFromArgs(argsRaw: unknown): string | null {
  if (typeof argsRaw !== "string") return null;
  try {
    const parsed = JSON.parse(argsRaw) as Record<string, unknown>;
    if (typeof parsed.command === "string") return truncateLogLine(parsed.command, MAX_INPUT_LEN);
    if (typeof parsed.patch === "string") return "apply_patch";
  } catch {
    // ignore
  }
  return null;
}
