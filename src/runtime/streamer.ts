import { open } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { findSessionJsonlFiles, resolveSessionsRoot } from "./codex.js";
import type { SendToSessionFn } from "./messaging.js";
import { redactText } from "./redact.js";
import { nowMs, sleep } from "./util.js";
import { listRunningSessions, listSessionOffsets, upsertSessionOffset } from "./store.js";

interface BufferState {
  text: string;
  lastFlushMs: number;
}

type MessageVerbosity = 1 | 2 | 3;

type StreamFragment =
  | { kind: "text"; text: string; continuous?: boolean }
  | { kind: "tool_call"; text: string }
  | { kind: "tool_output"; text: string }
  | { kind: "final" };

const USER_PRIORITY_BURST_MESSAGES = 5;

export class JsonlStreamer {
  private readonly buffers = new Map<string, BufferState>();
  private readonly pendingToolCalls = new Map<string, string[]>();
  private readonly pendingUserPriority = new Map<string, number>();
  private readonly lastUserMessageAtSeen = new Map<string, number | null>();
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly sendToSession: SendToSessionFn,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  async drainSession(sessionId: string) {
    await this.pollOnce([sessionId]);
    await this.flushIfNeeded(sessionId, true, { final: true });
  }

  private async loop() {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (e) {
        this.logger.error("streamer loop error", e);
      }
      await sleep(this.config.codex.poll_interval_ms);
    }
  }

  private async pollOnce(onlySessionIds?: string[]) {
    const sessions = await listRunningSessions(this.db);
    const runningSessionIds = new Set<string>();
    for (const session of sessions) {
      if (onlySessionIds && !onlySessionIds.includes(session.id)) continue;
      runningSessionIds.add(session.id);
      this.noteUserActivity(session.id, session.last_user_message_at, session.created_at);
      if (!session.codex_session_id) continue;

      const offsets = await listSessionOffsets(this.db, session.id);
      if (offsets.length === 0) {
        const sessionsRoot = resolveSessionsRoot(session.codex_cwd, this.config.codex.sessions_dir);
        const files = await findSessionJsonlFiles({
          sessionsRoot,
          codexSessionId: session.codex_session_id,
          timeoutMs: 1,
          pollMs: 1,
        });
        if (files.length === 0) continue;
        for (const f of files) {
          const initialOffset = await computeCatchupOffsetBytes(f, this.config.codex.max_catchup_lines).catch(() => 0);
          await upsertSessionOffset(this.db, {
            id: crypto.randomUUID(),
            session_id: session.id,
            jsonl_path: f,
            byte_offset: initialOffset,
            updated_at: nowMs(),
          });
        }
        continue;
      }

      let finalize = false;
      for (const off of offsets) {
        let read;
        try {
          read = await readNewJsonlLines(off.jsonl_path, off.byte_offset);
        } catch {
          continue;
        }
        const { lines, newOffset } = read;
        if (lines.length === 0) continue;
        await upsertSessionOffset(this.db, {
          ...off,
          id: off.id,
          byte_offset: newOffset,
          updated_at: nowMs(),
        });

        const fragments: StreamFragment[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as unknown;
            fragments.push(
              ...mapCodexEventToFragments(obj, {
                includeUserMessages: session.platform !== "telegram",
                verbosity: this.config.bot.message_verbosity,
              }),
            );
          } catch {
            continue;
          }
        }

        for (const frag of fragments) {
          if (frag.kind === "final") {
            finalize = true;
            continue;
          }

          if (frag.kind === "text") {
            this.append(session.id, frag.text, { continuous: frag.continuous });
            continue;
          }

          if (frag.kind === "tool_call") {
            const q = this.pendingToolCalls.get(session.id) ?? [];
            q.push(frag.text);
            this.pendingToolCalls.set(session.id, q);
            continue;
          }

          if (frag.kind === "tool_output") {
            const q = this.pendingToolCalls.get(session.id);
            const callText = q && q.length > 0 ? q.shift()! : null;
            if (q && q.length === 0) this.pendingToolCalls.delete(session.id);

            await this.flushIfNeeded(session.id, true);
            const maxChars = this.config.telegram?.max_chars ?? this.config.slack?.max_chars ?? 3500;
            const msg = formatToolPairMessage({
              callText,
              outputText: frag.text,
              maxMessageChars: maxChars,
            });
            await this.sendToSession(session.id, { text: msg, priority: this.takeSendPriority(session.id) });
          }
        }
      }

      if (finalize) {
        await this.flushIfNeeded(session.id, true, { final: true });
      } else {
        await this.flushIfNeeded(session.id, false);
      }
    }
    if (!onlySessionIds) this.cleanupPriorityState(runningSessionIds);
  }

  private append(sessionId: string, text: string, opts?: { continuous?: boolean }) {
    const s = this.buffers.get(sessionId) ?? { text: "", lastFlushMs: 0 };
    const continuous = opts?.continuous ?? false;
    const next = s.text ? (continuous ? `${s.text}${text}` : `${s.text}\n${text}`) : text;
    this.buffers.set(sessionId, { ...s, text: next });
  }

  private async flushIfNeeded(sessionId: string, force: boolean, opts?: { final?: boolean }) {
    const s = this.buffers.get(sessionId);
    if (!s || s.text.trim().length === 0) return;
    const now = nowMs();
    const should = force || s.text.length >= 1600 || now - s.lastFlushMs >= 1000;
    if (!should) return;
    const payload = s.text.trim();
    this.buffers.set(sessionId, { text: "", lastFlushMs: now });
    await this.sendToSession(sessionId, {
      text: payload,
      final: opts?.final === true,
      priority: this.takeSendPriority(sessionId),
    });
  }

  private noteUserActivity(sessionId: string, lastUserMessageAt: number | null, createdAt: number) {
    const prev = this.lastUserMessageAtSeen.get(sessionId);
    this.lastUserMessageAtSeen.set(sessionId, lastUserMessageAt);

    // On first observation, only treat as a "fresh" session if it was created recently,
    // to avoid a burst of high-priority output after a bot restart.
    if (prev === undefined) {
      const ageMs = nowMs() - createdAt;
      if (ageMs >= 0 && ageMs < 60_000 && typeof lastUserMessageAt === "number" && lastUserMessageAt > 0) {
        this.pendingUserPriority.set(sessionId, USER_PRIORITY_BURST_MESSAGES);
      }
      return;
    }

    if (typeof lastUserMessageAt === "number" && lastUserMessageAt > 0 && (prev === null || lastUserMessageAt > prev)) {
      this.pendingUserPriority.set(sessionId, USER_PRIORITY_BURST_MESSAGES);
    }
  }

  private takeSendPriority(sessionId: string): "user" | "background" {
    const remaining = this.pendingUserPriority.get(sessionId) ?? 0;
    if (remaining <= 0) return "background";
    if (remaining <= 1) this.pendingUserPriority.delete(sessionId);
    else this.pendingUserPriority.set(sessionId, remaining - 1);
    return "user";
  }

  private cleanupPriorityState(runningSessionIds: Set<string>) {
    for (const id of this.lastUserMessageAtSeen.keys()) {
      if (runningSessionIds.has(id)) continue;
      this.lastUserMessageAtSeen.delete(id);
      this.pendingUserPriority.delete(id);
    }
  }
}

async function readNewJsonlLines(
  filePath: string,
  offset: number,
): Promise<{ lines: string[]; newOffset: number }> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (offset >= stat.size) return { lines: [], newOffset: offset };

    const maxBytes = 2_000_000;
    const remaining = stat.size - offset;
    const toRead = Math.min(remaining, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, offset);
    const slice = buf.subarray(0, bytesRead);

    const lastNewline = slice.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], newOffset: offset };

    const complete = slice.subarray(0, lastNewline);
    const text = complete.toString("utf8");
    const lines = text.split("\n");
    const newOffset = offset + lastNewline + 1;
    return { lines, newOffset };
  } finally {
    await handle.close();
  }
}

async function computeCatchupOffsetBytes(filePath: string, maxLines: number): Promise<number> {
  if (maxLines <= 0) return 0;
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (size <= 0) return 0;

    const chunkSize = 64 * 1024;
    let pos = size;
    let linesFound = 0;

    while (pos > 0 && linesFound <= maxLines) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;
      const buf = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(buf, 0, readSize, pos);
      const slice = buf.subarray(0, bytesRead);
      for (let i = slice.length - 1; i >= 0; i--) {
        if (slice[i] === 0x0a) {
          linesFound++;
          if (linesFound > maxLines) return pos + i + 1;
        }
      }
      if (pos === 0) break;
    }

    return 0;
  } finally {
    await handle.close();
  }
}

function getTextFromContentItems(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const t = (item as { type?: unknown }).type;
    if (t === "output_text" && typeof (item as { text?: unknown }).text === "string") {
      out.push((item as { text: string }).text);
    }
  }
  return out.join("");
}

function mapCodexEventToFragments(
  obj: unknown,
  opts?: { includeUserMessages?: boolean; verbosity?: MessageVerbosity },
): StreamFragment[] {
  if (!obj || typeof obj !== "object") return [];
  const verbosity = normalizeMessageVerbosity(opts?.verbosity);
  const includeUserMessages = opts?.includeUserMessages !== false;
  const includeReasoning = verbosity >= 2;
  const includeEvents = verbosity >= 2;
  const includeTools = verbosity >= 3;
  const type = (obj as { type?: unknown }).type;

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
        const text = cmd ? `$ ${cmd}` : `Tool: ${name}`;
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
        return [{ kind: "tool_call", text: `Tool: ${line}` }];
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
        if (typeof query === "string") return [{ kind: "text", text: `Web search: ${query}` }];
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
      });
    }

    return [];
  }

  // ThreadEvent JSONL (from codex exec --json stdout or other logs)
  if (typeof type === "string" && type.startsWith("item.") && (obj as { item?: unknown }).item) {
    const item = (obj as { item: unknown }).item;
    if (!item || typeof item !== "object") return [];
    const detailsType = (item as { type?: unknown }).type;
    if (detailsType === "agent_message") {
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? [{ kind: "text", text }] : [];
    }
  }

  return [];
}

function mapEventMsgPayload(
  payload: Record<string, unknown>,
  opts?: { includeUserMessages?: boolean; includeReasoning?: boolean; includeEvents?: boolean; includeTools?: boolean },
): StreamFragment[] {
  const evType = typeof payload.type === "string" ? payload.type : null;
  if (!evType) return [];
  const includeUserMessages = opts?.includeUserMessages !== false;
  const includeReasoning = opts?.includeReasoning !== false;
  const includeEvents = opts?.includeEvents !== false;
  const includeTools = opts?.includeTools !== false;

  const text = (value: unknown, continuous = false): StreamFragment[] => {
    if (typeof value !== "string" || value.length === 0) return [];
    return [{ kind: "text", text: value, continuous }];
  };

  switch (evType) {
    case "error":
      if (!includeEvents) return [];
      return text(formatTitledText("Error", stringOrEmpty(payload.message)));
    case "warning":
      if (!includeEvents) return [];
      return text(formatTitledText("Warning", stringOrEmpty(payload.message)));
    case "context_compacted":
      if (!includeEvents) return [];
      return text(formatTitledText("Context compacted"));
    case "task_started": {
      if (!includeEvents) return [];
      const ctxWin = numberOrNull(payload.model_context_window);
      const suffix = ctxWin !== null ? `context window ${ctxWin}` : "";
      return text(formatTitledText("Task started", suffix || null));
    }
    case "task_complete": {
      if (!includeEvents) return [];
      const last = stringOrEmpty(payload.last_agent_message);
      const body = last ? `Last message: ${last}` : null;
      return text(formatTitledText("Task complete", body));
    }
    case "token_count":
      return [];
    case "agent_message":
      return text(stringOrEmpty(payload.message));
    case "user_message":
      return includeUserMessages ? text(`User: ${stringOrEmpty(payload.message)}`) : [];
    case "agent_message_delta":
    case "agent_message_content_delta":
      return text(stringOrEmpty(payload.delta), true);
    case "agent_reasoning": {
      if (!includeReasoning) return [];
      const msg = stringOrEmpty(payload.text);
      const title = stringOrEmpty((payload as { title?: unknown }).title) || "Reasoning";
      return msg ? text(formatTitledText(title, msg, { inline: false })) : [];
    }
    case "agent_reasoning_delta":
    case "reasoning_content_delta":
      return includeReasoning ? text(stringOrEmpty(payload.delta), true) : [];
    case "agent_reasoning_raw_content": {
      if (!includeReasoning) return [];
      const msg = stringOrEmpty(payload.text);
      const title = stringOrEmpty((payload as { title?: unknown }).title) || "Reasoning (raw)";
      return msg ? text(formatTitledText(title, msg, { inline: false })) : [];
    }
    case "agent_reasoning_raw_content_delta":
    case "reasoning_raw_content_delta":
      return includeReasoning ? text(stringOrEmpty(payload.delta), true) : [];
    case "agent_reasoning_section_break":
      return includeReasoning ? text("\n----\n", true) : [];
    case "session_configured":
      if (!includeEvents) return [];
      return text(formatTitledText("Session configured", formatSessionConfigured(payload) || null));
    case "mcp_startup_update": {
      if (!includeEvents) return [];
      const update = formatMcpStartupUpdate(payload);
      return text(formatTitledText(update.title, update.detail || null));
    }
    case "mcp_startup_complete": {
      if (!includeEvents) return [];
      const summary = formatMcpStartupComplete(payload);
      return text(formatTitledText(summary.title, summary.detail));
    }
    case "mcp_tool_call_begin": {
      if (!includeTools) return [];
      const call = formatMcpInvocation(payload.invocation);
      return call ? [{ kind: "tool_call", text: call }] : [];
    }
    case "mcp_tool_call_end": {
      if (!includeTools) return [];
      const summary = formatMcpToolResult(payload.result, payload.invocation);
      return summary ? [{ kind: "tool_output", text: summary }] : [];
    }
    case "web_search_begin":
      if (!includeTools) return [];
      return text("Web search started");
    case "web_search_end": {
      if (!includeTools) return [];
      const query = stringOrEmpty(payload.query);
      return query ? text(`Web search: ${query}`) : [];
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
      const status = exit !== null ? ` (exit ${exit})` : "";
      const suffix = stringOrEmpty(payload.stderr);
      const summary = `${cmd ? `$ ${cmd}` : "Command"} completed${status}`;
      if (suffix) return text(`${summary}: ${suffix}`);
      return text(summary);
    }
    case "view_image_tool_call": {
      if (!includeTools) return [];
      const path = stringOrEmpty(payload.path);
      return path ? text(`View image: ${path}`) : [];
    }
    case "exec_approval_request": {
      if (!includeEvents) return [];
      const cmd = formatCommand(payload.command);
      const cwd = stringOrEmpty(payload.cwd);
      const reason = stringOrEmpty(payload.reason);
      const parts = [];
      if (cwd) parts.push(`[${cwd}]`);
      if (cmd) parts.push(`$ ${cmd}`);
      if (reason) parts.push(`reason: ${reason}`);
      return text(formatTitledText("Approval needed", parts.join(" ").trim() || null));
    }
    case "elicitation_request": {
      if (!includeEvents) return [];
      const server = stringOrEmpty(payload.server_name);
      const message = stringOrEmpty(payload.message);
      const prefix = server ? `${server}: ` : "";
      return text(formatTitledText("Elicitation request", `${prefix}${message}`.trim() || null));
    }
    case "apply_patch_approval_request": {
      if (!includeEvents) return [];
      const summary = formatPatchApprovalRequest(payload);
      return summary ? text(formatTitledText("Patch approval needed", summary)) : [];
    }
    case "deprecation_notice": {
      if (!includeEvents) return [];
      const summary = stringOrEmpty(payload.summary);
      const details = stringOrEmpty(payload.details);
      const body = details ? `${summary} - ${details}` : summary;
      return text(formatTitledText("Deprecated", body || null));
    }
    case "background_event":
      if (!includeEvents) return [];
      return text(stringOrEmpty(payload.message));
    case "undo_started": {
      if (!includeEvents) return [];
      const msg = stringOrEmpty(payload.message);
      return text(formatTitledText("Undo started", msg || null));
    }
    case "undo_completed": {
      if (!includeEvents) return [];
      const msg = stringOrEmpty(payload.message);
      const success = typeof payload.success === "boolean" ? payload.success : false;
      const base = success ? "Undo completed" : "Undo failed";
      return text(formatTitledText(base, msg || null));
    }
    case "stream_error":
      if (!includeEvents) return [];
      return text(formatTitledText("Stream error", stringOrEmpty(payload.message)));
    case "patch_apply_begin": {
      if (!includeEvents) return [];
      const summary = formatPatchApplyBegin(payload);
      return text(formatTitledText("Applying patch", summary));
    }
    case "patch_apply_end": {
      if (!includeEvents) return [];
      const summary = formatPatchApplyEnd(payload);
      return text(formatTitledText("Patch apply", summary));
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
      const label = `History entry${logId !== null ? ` log ${logId}` : ""}${
        offset !== null ? ` offset ${offset}` : ""
      }`;
      return text(formatTitledText(label, found ? "returned" : "not found"));
    }
    case "mcp_list_tools_response":
      if (!includeEvents) return [];
      return text(formatTitledText("MCP list", formatMcpListTools(payload)));
    case "list_custom_prompts_response":
      if (!includeEvents) return [];
      return text(formatTitledText("Custom prompts", formatCustomPrompts(payload)));
    case "plan_update": {
      if (!includeEvents) return [];
      const plan = formatPlanUpdate(payload);
      return plan ? text(plan) : [];
    }
    case "turn_aborted": {
      if (!includeEvents) return [];
      const reason = formatTurnAbortReason(payload.reason);
      return text(formatTitledText("Turn aborted", reason || null));
    }
    case "shutdown_complete": {
      const message = includeEvents ? text(formatTitledText("Shutdown complete")) : [];
      return [...message, { kind: "final" }];
    }
    case "entered_review_mode": {
      if (!includeEvents) return [];
      const summary = formatEnteredReview(payload);
      return text(formatTitledText("Entered review mode", summary));
    }
    case "exited_review_mode": {
      if (!includeEvents) return [];
      const summary = formatExitedReview(payload);
      return text(formatTitledText("Exited review mode", summary));
    }
    case "raw_response_item":
    case "item_started":
    case "item_completed":
      return [];
    default:
      return [];
  }
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function formatCommand(command: unknown): string {
  if (Array.isArray(command)) return command.map((c) => String(c)).join(" ");
  if (typeof command === "string") return command;
  return "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateJson(value: unknown, maxLen = 400): string {
  const raw = safeJson(value);
  return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw;
}

function normalizeMessageVerbosity(value: unknown): MessageVerbosity {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (typeof value === "number") {
    if (value <= 1) return 1;
    if (value <= 2) return 2;
  }
  return 3;
}

function formatTitledText(title: string, body?: string | null, opts?: { inline?: boolean }): string {
  const cleanTitle = title.trim();
  const hasBody = typeof body === "string" && body.trim().length > 0;
  if (!hasBody) return `*${cleanTitle}*`;
  const cleanBody = body.trim();
  const inline = opts?.inline ?? !cleanBody.includes("\n");
  const separator = inline ? " " : "\n";
  return `*${cleanTitle}*${separator}${cleanBody}`;
}

function formatTokenCount(payload: Record<string, unknown>): string | null {
  const info = payload.info;
  if (!info || typeof info !== "object") return null;
  const total = (info as { total_token_usage?: unknown }).total_token_usage;
  const last = (info as { last_token_usage?: unknown }).last_token_usage;
  const ctxWindow = numberOrNull((info as { model_context_window?: unknown }).model_context_window);
  if (!total || typeof total !== "object") return null;

  const parts: string[] = [];
  const t = total as {
    total_tokens?: unknown;
    input_tokens?: unknown;
    cached_input_tokens?: unknown;
    output_tokens?: unknown;
    reasoning_output_tokens?: unknown;
  };
  if (typeof t.total_tokens === "number") parts.push(`total=${t.total_tokens}`);
  if (typeof t.input_tokens === "number") {
    const cached = typeof t.cached_input_tokens === "number" && t.cached_input_tokens > 0 ? ` (cached ${t.cached_input_tokens})` : "";
    parts.push(`input=${t.input_tokens}${cached}`);
  }
  if (typeof t.output_tokens === "number") parts.push(`output=${t.output_tokens}`);
  if (typeof t.reasoning_output_tokens === "number" && t.reasoning_output_tokens > 0) {
    parts.push(`reasoning=${t.reasoning_output_tokens}`);
  }

  const lastParts: string[] = [];
  if (last && typeof last === "object") {
    const l = last as { total_tokens?: unknown };
    if (typeof l.total_tokens === "number") lastParts.push(`last total=${l.total_tokens}`);
  }

  if (parts.length === 0 && lastParts.length === 0) return null;

  let text = `Token usage: ${parts.join(", ")}`;
  if (lastParts.length > 0) text += ` | ${lastParts.join(", ")}`;
  if (ctxWindow !== null) text += ` | context window ${ctxWindow}`;
  return text;
}

function formatSessionConfigured(payload: Record<string, unknown>): string {
  const model = stringOrEmpty(payload.model);
  const provider = stringOrEmpty(payload.model_provider_id);
  const cwd = stringOrEmpty(payload.cwd);
  const parts = [];
  if (model) parts.push(model);
  if (provider) parts.push(`provider=${provider}`);
  if (cwd) parts.push(`cwd=${cwd}`);
  return parts.join(" | ");
}

function formatMcpStartupUpdate(payload: Record<string, unknown>): { title: string; detail: string } {
  const server = stringOrEmpty(payload.server) || "server";
  const statusObj = (payload as { status?: unknown }).status;
  let status = "";
  if (typeof statusObj === "string") {
    status = statusObj;
  } else if (statusObj && typeof statusObj === "object") {
    const state = stringOrEmpty((statusObj as { state?: unknown }).state);
    status = state;
    if (state === "failed") {
      const error = stringOrEmpty((statusObj as { error?: unknown }).error);
      if (error) status += ` (${error})`;
    }
  }
  return { title: `MCP ${server}`, detail: status || "status unknown" };
}

function formatMcpStartupComplete(payload: Record<string, unknown>): { title: string; detail: string } {
  const ready = Array.isArray(payload.ready) ? payload.ready.length : 0;
  const failed = Array.isArray(payload.failed) ? payload.failed.length : 0;
  const cancelled = Array.isArray(payload.cancelled) ? payload.cancelled.length : 0;
  return { title: "MCP startup", detail: `ready=${ready}, failed=${failed}, cancelled=${cancelled}` };
}

function formatMcpInvocation(invocation: unknown): string | null {
  if (!invocation || typeof invocation !== "object") return null;
  const server = stringOrEmpty((invocation as { server?: unknown }).server);
  const tool = stringOrEmpty((invocation as { tool?: unknown }).tool);
  if (!server && !tool) return null;
  const args = (invocation as { arguments?: unknown }).arguments;
  const argsText = args === undefined ? "" : ` ${truncateJson(args, 300)}`;
  return `MCP ${server}.${tool}${argsText}`;
}

function decodeBase64ToString(chunk: unknown): string | null {
  if (typeof chunk !== "string") return null;
  try {
    return Buffer.from(chunk, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function formatMcpToolResult(result: unknown, invocation: unknown): string | null {
  const target = formatMcpInvocation(invocation);
  if (result && typeof result === "object") {
    if ("Ok" in (result as Record<string, unknown>)) {
      const ok = (result as { Ok?: unknown }).Ok;
      if (ok && typeof ok === "object" && Array.isArray((ok as { content?: unknown }).content)) {
        const textBlocks = (ok as { content: unknown[] }).content
          .map((c) => formatMcpContentBlock(c))
          .filter((c): c is string => Boolean(c))
          .join("\n");
        if (textBlocks) return target ? `${target}: ${textBlocks}` : textBlocks;
      }
      const fallback = truncateJson(ok, 800);
      return target ? `${target}: ${fallback}` : fallback;
    }
    if ("Err" in (result as Record<string, unknown>)) {
      const err = stringOrEmpty((result as { Err?: unknown }).Err);
      const text = err ? `Error: ${err}` : "Error";
      return target ? `${target}: ${text}` : text;
    }
  }
  if (typeof result === "string") return target ? `${target}: ${result}` : result;
  return target ? `${target}: (no result)` : null;
}

function formatMcpContentBlock(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const t = stringOrEmpty((block as { type?: unknown }).type);
  if (t === "text" && typeof (block as { text?: unknown }).text === "string") {
    return (block as { text: string }).text;
  }
  return truncateJson(block, 200);
}

function formatPatchApprovalRequest(payload: Record<string, unknown>): string | null {
  const changes = payload.changes;
  const count = changes && typeof changes === "object" ? Object.keys(changes as Record<string, unknown>).length : 0;
  const reason = stringOrEmpty(payload.reason);
  const grantRoot = stringOrEmpty(payload.grant_root);
  const parts = [`${count} file(s)`];
  if (grantRoot) parts.push(`grant ${grantRoot}`);
  if (reason) parts.push(`reason: ${reason}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function countMapEntries(value: unknown): number {
  return value && typeof value === "object" ? Object.keys(value as Record<string, unknown>).length : 0;
}

function formatPatchApplyBegin(payload: Record<string, unknown>): string {
  const count = countMapEntries(payload.changes);
  const auto = (payload as { auto_approved?: unknown }).auto_approved === true;
  return `${count} file(s)${auto ? " [auto-approved]" : ""}`;
}

function formatPatchApplyEnd(payload: Record<string, unknown>): string {
  const count = countMapEntries(payload.changes);
  const success = (payload as { success?: unknown }).success === true;
  const stderr = stringOrEmpty(payload.stderr);
  const stdout = stringOrEmpty(payload.stdout);
  const details = stderr || stdout;
  const base = `${success ? "succeeded" : "failed"} (${count} file(s))`;
  return details ? `${base}: ${details}` : base;
}

function formatMcpListTools(payload: Record<string, unknown>): string {
  const tools = payload.tools && typeof payload.tools === "object" ? Object.keys(payload.tools as Record<string, unknown>).length : 0;
  const resources =
    payload.resources && typeof payload.resources === "object"
      ? Object.values(payload.resources as Record<string, unknown[]>)
          .map((v) => (Array.isArray(v) ? v.length : 0))
          .reduce((a, b) => a + b, 0)
      : 0;
  const templates =
    payload.resource_templates && typeof payload.resource_templates === "object"
      ? Object.values(payload.resource_templates as Record<string, unknown[]>)
          .map((v) => (Array.isArray(v) ? v.length : 0))
          .reduce((a, b) => a + b, 0)
      : 0;
  return `${tools} tool(s), ${resources} resource(s), ${templates} template(s)`;
}

function formatCustomPrompts(payload: Record<string, unknown>): string {
  const prompts = Array.isArray(payload.custom_prompts) ? payload.custom_prompts : [];
  const names = prompts
    .map((p) => (p && typeof p === "object" ? stringOrEmpty((p as { name?: unknown }).name) : ""))
    .filter((n) => n.length > 0);
  if (names.length === 0) return "none";
  const preview = names.slice(0, 5).join(", ");
  const suffix = names.length > 5 ? ` (+${names.length - 5} more)` : "";
  return `${preview}${suffix}`;
}

function formatPlanUpdate(payload: Record<string, unknown>): string | null {
  const plan = Array.isArray(payload.plan) ? payload.plan : [];
  const explanation = stringOrEmpty(payload.explanation);
  const lines = plan
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      const step = stringOrEmpty((p as { step?: unknown }).step);
      const status = stringOrEmpty((p as { status?: unknown }).status).toLowerCase();
      const marker = status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
      return step ? `${marker} ${step}` : "";
    })
    .filter((l) => l.length > 0);

  if (lines.length === 0 && !explanation) return null;
  const header = formatTitledText("Plan update", explanation || null, { inline: false });
  if (lines.length === 0) return header;
  return [header, ...lines].join("\n");
}

function formatTurnAbortReason(reason: unknown): string | null {
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object" && typeof (reason as { type?: unknown }).type === "string") {
    return (reason as { type: string }).type;
  }
  return null;
}

function formatReviewTarget(target: unknown): string | null {
  if (!target || typeof target !== "object") return null;
  const t = stringOrEmpty((target as { type?: unknown }).type);
  if (t === "uncommittedChanges") return "uncommitted changes";
  if (t === "baseBranch") {
    const branch = stringOrEmpty((target as { branch?: unknown }).branch);
    return branch ? `base branch ${branch}` : "base branch";
  }
  if (t === "commit") {
    const sha = stringOrEmpty((target as { sha?: unknown }).sha);
    const title = stringOrEmpty((target as { title?: unknown }).title);
    const suffix = title ? ` (${title})` : "";
    return sha ? `commit ${sha}${suffix}` : "commit";
  }
  if (t === "custom") {
    const instructions = stringOrEmpty((target as { instructions?: unknown }).instructions);
    return instructions ? `custom: ${instructions}` : "custom instructions";
  }
  return null;
}

function formatEnteredReview(payload: Record<string, unknown>): string | null {
  const target = formatReviewTarget(payload.target);
  const hint = stringOrEmpty(payload.user_facing_hint);
  const parts: string[] = [];
  if (target) parts.push(`for ${target}`);
  if (hint) parts.push(hint);
  if (parts.length === 0) return null;
  return parts.join(" - ");
}

function formatExitedReview(payload: Record<string, unknown>): string | null {
  const reviewOutput = payload.review_output;
  if (!reviewOutput || typeof reviewOutput !== "object") return null;
  const findings = Array.isArray((reviewOutput as { findings?: unknown }).findings)
    ? (reviewOutput as { findings: unknown[] }).findings.length
    : 0;
  const correctness = stringOrEmpty((reviewOutput as { overall_correctness?: unknown }).overall_correctness);
  const base = findings > 0 ? `findings: ${findings}` : "no findings";
  return correctness ? `${base} - ${correctness}` : base;
}

function extractCommandFromToolArgs(name: string, argsText: string): string | null {
  const lower = name.toLowerCase();
  if (!argsText) return null;
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    if ((lower === "shell_command" || lower === "shell") && typeof (parsed as { command?: unknown }).command === "string") {
      return (parsed as { command: string }).command;
    }
    if (lower === "apply_patch" && typeof (parsed as { patch?: unknown }).patch === "string") {
      return "apply_patch";
    }
  } catch {
    return null;
  }
  return null;
}

// Re-export helpers for controller usage.

function sanitizeFencedCodeBlockInner(text: string): string {
  // Prevent accidental closure of fenced blocks.
  return text.replaceAll("```", "``\u200b`");
}

function formatToolPairMessage(opts: { callText: string | null; outputText: string; maxMessageChars: number }): string {
  const maxMessageChars = Math.max(64, Math.floor(opts.maxMessageChars));
  const maxInnerChars = Math.max(0, maxMessageChars - 6 /* ``` + ``` */ - 2 /* surrounding newlines */);

  const call = opts.callText?.trimEnd();
  const output = opts.outputText.trimEnd();
  const combined = call ? `${call}\n${output}` : output;

  const redacted = redactText(combined);
  const sanitized = sanitizeFencedCodeBlockInner(redacted);
  const clippedInner = sanitized.length > maxInnerChars ? sanitized.slice(0, maxInnerChars) : sanitized;

  return "```" + "\n" + clippedInner + "\n" + "```";
}
