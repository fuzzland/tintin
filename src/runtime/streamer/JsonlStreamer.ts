import * as crypto from "node:crypto";
import { open } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import type { Db, SessionAgent } from "../db.js";
import type { Logger } from "../log.js";
import { getAgentAdapter } from "../agents.js";
import type { SendToSessionFn } from "../messaging.js";
import { redactText } from "../redact.js";
import { nowMs, sleep } from "../util.js";
import { listRunningSessions, listSessionOffsets, upsertSessionOffset } from "../store.js";
import type { SessionRow } from "../store.js";
import { getIdentity } from "../cloud/store.js";
import { PlaywrightMcpManager } from "../playwrightMcp.js";
import { isUserLanguage, t, type UserLanguage } from "../../locales/index.js";
import { isHyperbrowserAvailable, isShellSearchCommand, resolveSearchPolicy } from "../searchPolicy.js";
import { PlanUpdateHandler, parsePlanUpdatePayload } from "./PlanUpdateHandler.js";
import { ToolCallManager } from "./ToolCallManager.js";
import {
  PlaywrightScreenshotManager,
  extractPlaywrightInlineScreenshot,
  extractPlaywrightInlineScreenshotFromClaudeToolResult,
  extractPlaywrightInlineScreenshotFromMcpResult,
  parseMcpFunctionName,
} from "./PlaywrightScreenshotManager.js";
import { EVENT_MAPPERS } from "./eventMappers/index.js";
import {
  extractCommandFromToolArgs,
  extractMcpResultText,
  formatCommand,
  formatToolPairMessage,
  normalizeAgentMessage,
  normalizeMessageVerbosity,
  numberOrNull,
  stringOrEmpty,
  truncateLogLine,
} from "./eventMappers/helpers.js";

interface BufferState {
  text: string;
  lastFlushMs: number;
}

export type MessageVerbosity = 1 | 2 | 3;

export type StreamFragment =
  | { kind: "text"; text: string; continuous?: boolean; separate?: boolean }
  | { kind: "tool_call"; text: string }
  | { kind: "tool_output"; text: string }
  | { kind: "plan_update"; plan: Array<{ step: string; status: string }>; explanation?: string }
  | { kind: "final" };

const USER_PRIORITY_BURST_MESSAGES = 5;
const CLOUD_PROJECT_PREFIX = "cloud:";
const MAX_DEBUG_EVENT_CHARS = 2000;

export class JsonlStreamer {
  private readonly buffers = new Map<string, BufferState>();
  private readonly toolCalls = new ToolCallManager();
  private readonly planUpdates = new PlanUpdateHandler();
  private readonly playwrightScreenshots: PlaywrightScreenshotManager;
  private readonly lastTurnKeySeen = new Map<string, number>();
  private readonly turnHasUserFacingOutput = new Map<string, number>();
  private readonly lastTurnFallbackText = new Map<string, { turnKey: number; text: string }>();
  private readonly pendingUserPriority = new Map<string, number>();
  private readonly lastUserMessageAtSeen = new Map<string, number | null>();
  private readonly chatgptAuthWarned = new Set<string>();
  private readonly searchPolicyWarned = new Set<string>();
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly sendToSession: SendToSessionFn,
    private readonly playwrightMcp: PlaywrightMcpManager | null,
  ) {
    this.playwrightScreenshots = new PlaywrightScreenshotManager(playwrightMcp, sendToSession, logger);
  }

  private resolveSessionLanguage(session: { language?: string | null }): UserLanguage {
    const language = session.language;
    return typeof language === "string" && isUserLanguage(language) ? language : "en";
  }

  private async resolveSessionLanguageById(sessionId: string): Promise<UserLanguage> {
    const row = await this.db
      .selectFrom("sessions")
      .select(["language"])
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row ? this.resolveSessionLanguage(row) : "en";
  }

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
    const lang = await this.resolveSessionLanguageById(sessionId);
    const sent = await this.playwrightScreenshots.maybeSendPendingScreenshot(
      sessionId,
      lang,
      this.currentTurnKey(sessionId),
    );
    if (sent) this.markUserFacingOutput(sessionId);
    await this.flushIfNeeded(sessionId, true);
  }

  private async loop() {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (e) {
        this.logger.error("streamer loop error", e);
      }
      await sleep(this.pollIntervalMs());
    }
  }

  private pollIntervalMs(): number {
    const intervals: number[] = [];
    for (const agent of ["codex", "claude_code"] as const) {
      const adapter = getAgentAdapter(agent);
      if (!adapter.isConfigured(this.config)) continue;
      const n = adapter.pollIntervalMs(this.config);
      if (typeof n === "number" && Number.isFinite(n) && n > 0) intervals.push(n);
    }
    if (intervals.length > 0) return Math.min(...intervals);
    return this.config.codex.poll_interval_ms;
  }

  private async resolveMessageVerbosity(session: SessionRow): Promise<MessageVerbosity> {
    const fallback = normalizeMessageVerbosity(this.config.bot.message_verbosity);
    try {
      const identity = await getIdentity(this.db, {
        platform: session.platform,
        workspaceId: session.workspace_id ?? null,
        userId: session.created_by_user_id,
      });
      if (!identity || identity.message_verbosity === null || identity.message_verbosity === undefined) {
        return fallback;
      }
      const resolved = normalizeMessageVerbosity(identity.message_verbosity);
      return resolved;
    } catch {
      return fallback;
    }
  }

  private async pollOnce(onlySessionIds?: string[]) {
    const sessions = await listRunningSessions(this.db);
    const runningSessionIds = new Set<string>();
    for (const session of sessions) {
      if (onlySessionIds && !onlySessionIds.includes(session.id)) continue;
      runningSessionIds.add(session.id);
      const lang = this.resolveSessionLanguage(session);
      if (isCloudProjectId(session.project_id)) this.playwrightScreenshots.markCloudSession(session.id);
      else this.playwrightScreenshots.unmarkCloudSession(session.id);
      this.noteUserActivity(session.id, session.last_user_message_at, session.created_at);
      this.ensureTurnState(session.id);
      if (!session.codex_session_id) continue;
      const messageVerbosity = await this.resolveMessageVerbosity(session);
      const adapter = getAgentAdapter(session.agent);
      let agentConfig: { max_catchup_lines: number } | null = null;
      try {
        agentConfig = adapter.requireConfig(this.config) as { max_catchup_lines: number };
      } catch (e) {
        this.logger.warn(`[streamer] agent not configured, skipping session=${session.id} agent=${session.agent}: ${String(e)}`);
        continue;
      }

      const sessionsRoot = adapter.resolveSessionsRoot(session.codex_cwd, this.config);
      const homeDir = adapter.resolveHomeDir(sessionsRoot);

      const offsets = await listSessionOffsets(this.db, session.id);
      if (offsets.length === 0) {
        const files = await adapter.findSessionJsonlFiles({
          sessionsRoot,
          homeDir,
          cwd: session.codex_cwd,
          sessionId: session.codex_session_id,
          timeoutMs: 1,
          pollMs: 1,
        });
        if (files.length === 0) continue;
        for (const f of files) {
          const initialOffset = await computeCatchupOffsetBytes(f, agentConfig.max_catchup_lines).catch(() => 0);
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
            this.logCloudCodexEvent(session, obj, trimmed);
            void this.maybeCapturePlaywrightScreenshot(session.id, obj as Record<string, unknown>, lang);
            await this.maybeHandleChatgptAuthError(session, obj as Record<string, unknown>);
            const shellCommand = extractShellCommandFromEvent(obj as Record<string, unknown>);
            if (shellCommand) {
              await this.maybeWarnSearchFallback(session, shellCommand);
            }
            const fallbackText = this.extractFallbackText(obj, lang);
            if (fallbackText) this.recordFallbackText(session.id, fallbackText);

            const planFragment = this.planUpdates.parsePlanUpdate(obj, session.id);
            if (planFragment) {
              fragments.push(planFragment);
              continue;
            }

            if (this.planUpdates.shouldSuppressPlanOutput(obj, session.id)) continue;

            const mapper = EVENT_MAPPERS[session.agent];
            fragments.push(
              ...mapper(obj, {
                includeUserMessages: session.platform !== "telegram" && session.platform !== "websocket",
                verbosity: messageVerbosity,
                lang,
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

          if (frag.kind === "plan_update") {
            await this.flushIfNeeded(session.id, true);
            await this.sendToSession(session.id, {
              type: "plan_update",
              plan: frag.plan,
              explanation: frag.explanation,
              priority: "user",
            });
            this.markUserFacingOutput(session.id);
            continue;
          }

          if (frag.kind === "text") {
            if (frag.separate) {
              await this.flushIfNeeded(session.id, true);
            }
            this.append(session.id, frag.text, { continuous: frag.continuous });
            continue;
          }

          if (frag.kind === "tool_call") {
            this.toolCalls.push(session.id, frag.text);
            continue;
          }

          if (frag.kind === "tool_output") {
            const callText = this.toolCalls.shift(session.id);

            await this.flushIfNeeded(session.id, true);
            const maxChars = this.config.telegram?.max_chars ?? this.config.slack?.max_chars ?? 3500;
            const msg = formatToolPairMessage({
              callText,
              outputText: frag.text,
              maxMessageChars: maxChars,
            });
            await this.sendToSession(session.id, { text: msg, priority: this.takeSendPriority(session.id) });
            this.markUserFacingOutput(session.id);
          }
        }
      }

      if (finalize) {
        const turnKey = this.currentTurnKey(session.id);
        const hasUserOutput = turnKey !== null && this.turnHasUserFacingOutput.get(session.id) === turnKey;
        const buffered = (this.buffers.get(session.id)?.text ?? "").trim().length > 0;
        if (!hasUserOutput && !buffered && turnKey !== null) {
          const fallback = this.lastTurnFallbackText.get(session.id);
          const fallbackText =
            fallback && fallback.turnKey === turnKey && fallback.text.trim().length > 0 ? fallback.text.trim() : null;
          const textToSend = fallbackText ?? t("session.complete", lang);
          this.logger.info(
            `[streamer][final-fallback] session=${session.id} turn=${turnKey} text_source=${fallbackText ? "fallback" : "complete"}`,
          );
          await this.sendToSession(session.id, { text: textToSend, final: true, priority: "user" });
          this.markUserFacingOutput(session.id);
        }
        const sent = await this.playwrightScreenshots.maybeSendPendingScreenshot(
          session.id,
          lang,
          this.currentTurnKey(session.id),
        );
        if (sent) this.markUserFacingOutput(session.id);
        await this.flushIfNeeded(session.id, true, { final: true });
      } else {
        await this.flushIfNeeded(session.id, false);
      }
    }
    if (!onlySessionIds) this.cleanupPriorityState(runningSessionIds);
    for (const warned of Array.from(this.chatgptAuthWarned)) {
      if (!runningSessionIds.has(warned)) this.chatgptAuthWarned.delete(warned);
    }
    for (const warned of Array.from(this.searchPolicyWarned)) {
      if (!runningSessionIds.has(warned)) this.searchPolicyWarned.delete(warned);
    }
  }

  private append(sessionId: string, text: string, opts?: { continuous?: boolean }) {
    const s = this.buffers.get(sessionId) ?? { text: "", lastFlushMs: 0 };
    const continuous = opts?.continuous ?? false;
    const next = s.text ? (continuous ? `${s.text}${text}` : `${s.text}\n${text}`) : text;
    this.buffers.set(sessionId, { ...s, text: next });
  }

  private ensureTurnState(sessionId: string) {
    const turnKey = this.currentTurnKey(sessionId);
    if (turnKey === null) return;
    const prev = this.lastTurnKeySeen.get(sessionId);
    if (prev === turnKey) return;
    this.lastTurnKeySeen.set(sessionId, turnKey);
    this.turnHasUserFacingOutput.delete(sessionId);
    this.lastTurnFallbackText.delete(sessionId);
  }

  private markUserFacingOutput(sessionId: string) {
    const turnKey = this.currentTurnKey(sessionId);
    if (turnKey === null) return;
    this.turnHasUserFacingOutput.set(sessionId, turnKey);
  }

  private recordFallbackText(sessionId: string, text: string) {
    const turnKey = this.currentTurnKey(sessionId);
    if (turnKey === null) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.lastTurnFallbackText.set(sessionId, { turnKey, text: truncateLogLine(trimmed, 4000) });
  }

  private extractFallbackText(obj: unknown, lang: UserLanguage): string | null {
    if (!obj || typeof obj !== "object") return null;
    const type = stringOrEmpty((obj as { type?: unknown }).type);
    const payload = (obj as { payload?: unknown }).payload;

    if (type === "event_msg" && payload && typeof payload === "object") {
      const evType = stringOrEmpty((payload as { type?: unknown }).type);
      if (evType === "agent_message") {
        return normalizeAgentMessage(payload);
      }
    }

    if (typeof type === "string" && type.startsWith("item.") && (obj as { item?: unknown }).item) {
      const item = (obj as { item: unknown }).item;
      if (!item || typeof item !== "object") return null;
      const detailsType = stringOrEmpty((item as { type?: unknown }).type);
      if (detailsType === "agent_message") {
        return normalizeAgentMessage(item);
      }
      if (detailsType === "command_execution") {
        const output = stringOrEmpty((item as { aggregated_output?: unknown }).aggregated_output);
        if (output) return output;
        const exit = numberOrNull((item as { exit_code?: unknown }).exit_code);
        if (exit !== null) return t("streamer.command_exit", lang, { code: exit });
      }
      if (detailsType === "mcp_tool_call") {
        const output = extractMcpResultText((item as { result?: unknown }).result);
        const err = stringOrEmpty((item as { error?: unknown }).error);
        if (output && err) return `${output}\n${t("streamer.error", lang)}: ${err}`;
        if (output) return output;
        if (err) return `${t("streamer.error", lang)}: ${err}`;
      }
    }

    return null;
  }

  private async maybeHandleChatgptAuthError(session: SessionRow, obj: Record<string, unknown>) {
    if (this.chatgptAuthWarned.has(session.id)) return;
    const message = stringOrEmpty((obj as { message?: unknown }).message) || stringOrEmpty((obj as { error?: unknown }).error);
    if (!message) return;
    const normalized = message.toLowerCase();
    const isAuth401 =
      normalized.includes("unexpected status 401") ||
      normalized.includes("401 unauthorized") ||
      normalized.includes("chatgpt auth missing") ||
      normalized.includes("chatgpt auth expired");
    if (!isAuth401) return;
    this.chatgptAuthWarned.add(session.id);
    try {
      const lang = this.resolveSessionLanguage(session);
      const cmd = session.platform === "telegram" ? "/connect chatgpt" : "connect chatgpt";
      await this.sendToSession(session.id, {
        text: t("chatgpt.auth_failed", lang, { cmd: `\`${cmd}\`` }),
        priority: "user",
      });
      this.markUserFacingOutput(session.id);
    } catch {
      /* ignore */
    }
    // Keep tokens for manual retry; user can choose to /connect chatgpt to replace.
  }

  private async maybeWarnSearchFallback(session: SessionRow, command: string) {
    if (this.searchPolicyWarned.has(session.id)) return;
    const policy = resolveSearchPolicy(this.config);
    if (policy.mode !== "hyperbrowser_first" || !policy.warn_on_shell) return;
    const hyperbrowserAvailable = isHyperbrowserAvailable(this.config);
    if (!hyperbrowserAvailable) return;
    if (!isShellSearchCommand(command)) return;
    this.searchPolicyWarned.add(session.id);
    try {
      const lang = this.resolveSessionLanguage(session);
      await this.sendToSession(session.id, {
        text: t("search.policy_warning", lang),
        priority: "user",
      });
      this.markUserFacingOutput(session.id);
    } catch {
      /* ignore */
    }
  }

  private async maybeCapturePlaywrightScreenshot(
    sessionId: string,
    obj: Record<string, unknown>,
    lang: UserLanguage,
  ) {
    if (!this.playwrightMcp || !this.config.playwright_mcp?.enabled) return;
    const turnKey = this.currentTurnKey(sessionId);
    const type = (obj as { type?: unknown }).type;

    // Claude Code JSONL stream: tool calls and results are embedded in message.content blocks.
    if (type === "assistant" || type === "user") {
      const message = (obj as { message?: unknown }).message;
      if (!message || typeof message !== "object") return;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) return;

      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const blockType = stringOrEmpty((block as { type?: unknown }).type);

        if (type === "assistant" && blockType === "tool_use") {
          const name = stringOrEmpty((block as { name?: unknown }).name);
          const parsed = parseMcpFunctionName(name);
          if (!parsed || parsed.server.toLowerCase() !== "playwright") continue;
          const callId = stringOrEmpty((block as { id?: unknown }).id);
          if (!callId) continue;
          this.playwrightScreenshots.rememberPlaywrightCall(sessionId, callId, parsed.tool);
          if (parsed.tool === "browser_close") {
            const sent = await this.playwrightScreenshots.maybeSendPendingScreenshot(sessionId, lang, turnKey);
            if (sent) this.markUserFacingOutput(sessionId);
          }
          continue;
        }

        if (type === "user" && blockType === "tool_result") {
          const callId = stringOrEmpty((block as { tool_use_id?: unknown }).tool_use_id);
          if (!callId) continue;
          if (this.playwrightScreenshots.hasCapturedPlaywrightCall(sessionId, callId)) continue;

          const tool = this.playwrightScreenshots.consumePlaywrightCall(sessionId, callId);
          if (!tool) continue;

          if (turnKey !== null && this.playwrightScreenshots.wasScreenshotSentForTurn(sessionId, turnKey)) {
            this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
            continue;
          }

          if (tool === "browser_close") {
            const sent = await this.playwrightScreenshots.maybeSendPendingScreenshot(sessionId, lang, turnKey);
            if (sent) this.markUserFacingOutput(sessionId);
            this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
            continue;
          }

          if (tool === "browser_take_screenshot" && turnKey !== null) {
            const extracted = extractPlaywrightInlineScreenshotFromClaudeToolResult((block as { content?: unknown }).content);
            if (extracted) {
              const ok = await this.playwrightScreenshots.sendScreenshotFromToolOutput(sessionId, turnKey, extracted, lang);
              if (ok) {
                this.markUserFacingOutput(sessionId);
                this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
                continue;
              }
            }
            this.playwrightScreenshots.markPendingScreenshot(sessionId, turnKey);
            this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
            continue;
          }

          // Any other Playwright tool call: mark a screenshot for this turn.
          this.playwrightScreenshots.markPendingScreenshot(sessionId, turnKey);
          this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
        }
      }

      return;
    }

    if (type === "response_item") {
      const payload = (obj as { payload?: unknown }).payload;
      if (!payload || typeof payload !== "object") return;
      const payloadType = stringOrEmpty((payload as { type?: unknown }).type);
      const callId = stringOrEmpty((payload as { call_id?: unknown }).call_id);
      if (payloadType === "function_call") {
        const name = stringOrEmpty((payload as { name?: unknown }).name);
        const parsed = parseMcpFunctionName(name);
        if (parsed && parsed.server.toLowerCase() === "playwright" && callId) {
          this.playwrightScreenshots.rememberPlaywrightCall(sessionId, callId, parsed.tool);
          if (parsed.tool === "browser_close") {
            const sent = await this.playwrightScreenshots.maybeSendPendingScreenshot(sessionId, lang, turnKey);
            if (sent) this.markUserFacingOutput(sessionId);
          }
        }
        return;
      }
      if (payloadType === "function_call_output" && callId) {
        if (this.playwrightScreenshots.hasCapturedPlaywrightCall(sessionId, callId)) return;
        const tool = this.playwrightScreenshots.consumePlaywrightCall(sessionId, callId);
        if (!tool) return;

        if (turnKey !== null && this.playwrightScreenshots.wasScreenshotSentForTurn(sessionId, turnKey)) {
          this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
          return;
        }

        if (tool === "browser_take_screenshot" && turnKey !== null) {
          const extracted = extractPlaywrightInlineScreenshot((payload as { output?: unknown }).output);
          if (extracted) {
            const ok = await this.playwrightScreenshots.sendScreenshotFromToolOutput(sessionId, turnKey, extracted, lang);
            if (ok) {
              this.markUserFacingOutput(sessionId);
              this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
              return;
            }
          }
          this.playwrightScreenshots.markPendingScreenshot(sessionId, turnKey);
          this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
          return;
        }

        if (tool !== "browser_close") {
          this.playwrightScreenshots.markPendingScreenshot(sessionId, turnKey);
        }
        this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
        return;
      }
      return;
    }

    const payload = (obj as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") return;
    const invocation = (payload as { invocation?: unknown }).invocation;
    if (!invocation || typeof invocation !== "object") return;
    const server = stringOrEmpty((invocation as { server?: unknown }).server).toLowerCase();
    if (server !== "playwright") return;
    const tool = stringOrEmpty((invocation as { tool?: unknown }).tool);
    const callId = stringOrEmpty((invocation as { call_id?: unknown }).call_id);
    if (this.playwrightScreenshots.hasCapturedPlaywrightCall(sessionId, callId)) return;
    if (tool === "browser_close") {
      const sent = await this.playwrightScreenshots.maybeSendPendingScreenshot(sessionId, lang, turnKey);
      if (sent) this.markUserFacingOutput(sessionId);
      this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
      return;
    }

    if (tool === "browser_take_screenshot" && turnKey !== null) {
      const extracted = extractPlaywrightInlineScreenshotFromMcpResult((payload as { result?: unknown }).result);
      if (extracted) {
        const ok = await this.playwrightScreenshots.sendScreenshotFromToolOutput(sessionId, turnKey, extracted, lang);
        if (ok) {
          this.markUserFacingOutput(sessionId);
          this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
          return;
        }
      }
      this.playwrightScreenshots.markPendingScreenshot(sessionId, turnKey);
      this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
      return;
    }

    this.playwrightScreenshots.consumePlaywrightCall(sessionId, callId);
    if (tool !== "browser_close") this.playwrightScreenshots.markPendingScreenshot(sessionId, turnKey);
    this.playwrightScreenshots.markCapturedPlaywrightCall(sessionId, callId);
  }

  private currentTurnKey(sessionId: string): number | null {
    const v = this.lastUserMessageAtSeen.get(sessionId);
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  }


  private async flushIfNeeded(sessionId: string, force: boolean, opts?: { final?: boolean }) {
    const s = this.buffers.get(sessionId);
    const isFinal = opts?.final === true;
    if (!s || s.text.trim().length === 0) {
      if (isFinal) {
        await this.sendToSession(sessionId, { type: "finalize", priority: "user" });
      }
      return;
    }
    const now = nowMs();
    const should = force || s.text.length >= 1600 || now - s.lastFlushMs >= 1000;
    if (!should) return;
    const payload = s.text.trim();
    this.buffers.set(sessionId, { text: "", lastFlushMs: now });
    await this.sendToSession(sessionId, {
      text: payload,
      final: isFinal,
      priority: isFinal ? "user" : this.takeSendPriority(sessionId),
    });
    this.markUserFacingOutput(sessionId);
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
      this.toolCalls.clear(id);
      this.planUpdates.clear(id);
      this.playwrightScreenshots.clear(id);
      this.lastTurnKeySeen.delete(id);
      this.turnHasUserFacingOutput.delete(id);
      this.lastTurnFallbackText.delete(id);
    }
  }

  private logCloudCodexEvent(session: SessionRow, obj: unknown, rawLine: string) {
    if (session.agent !== "codex") return;
    if (!isCloudProjectId(session.project_id)) return;
    if (!obj || typeof obj !== "object") return;

    const type = stringOrEmpty((obj as { type?: unknown }).type);
    const payload = (obj as { payload?: unknown }).payload;
    const payloadType = payload && typeof payload === "object" ? stringOrEmpty((payload as { type?: unknown }).type) : "";
    const isErrorEvent =
      type === "error" || type === "turn.failed" || type === "thread.failed" || payloadType === "error";
    if (this.config.bot.log_level !== "debug" && !isErrorEvent) return;
    const eventTs = eventTimestamp(obj as Record<string, unknown>);
    const ts = new Date().toISOString();
    const redacted = redactText(rawLine);
    const clipped = truncateLogLine(redacted, MAX_DEBUG_EVENT_CHARS);

    const parts = [
      `ts=${ts}`,
      `session=${session.id}`,
      `type=${type || "unknown"}`,
      payloadType ? `payload=${payloadType}` : null,
      eventTs !== null ? `event_ts=${eventTs}` : null,
      clipped ? `raw=${clipped}` : null,
    ].filter(Boolean);
    const log = isErrorEvent ? this.logger.warn.bind(this.logger) : this.logger.debug.bind(this.logger);
    log(`[cloud][codex][event] ${parts.join(" ")}`);
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

function isCloudProjectId(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(CLOUD_PROJECT_PREFIX);
}

function eventTimestamp(obj: Record<string, unknown>): number | null {
  const direct = (obj as { timestamp?: unknown }).timestamp;
  if (typeof direct === "number") return direct;
  const payload = (obj as { payload?: unknown }).payload;
  if (payload && typeof payload === "object") {
    const payloadTs = (payload as { timestamp?: unknown }).timestamp;
    if (typeof payloadTs === "number") return payloadTs;
  }
  return null;
}

function extractShellCommandFromEvent(obj: Record<string, unknown>): string | null {
  const type = stringOrEmpty((obj as { type?: unknown }).type);
  if (type === "response_item") {
    const payload = (obj as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") return null;
    const itemType = stringOrEmpty((payload as { type?: unknown }).type);
    if (itemType === "function_call") {
      const name = stringOrEmpty((payload as { name?: unknown }).name);
      const argsText = typeof (payload as { arguments?: unknown }).arguments === "string" ? (payload as { arguments: string }).arguments : "";
      if (!name || !argsText) return null;
      return extractCommandFromToolArgs(name, argsText);
    }
    if (itemType === "local_shell_call") {
      const action = (payload as { action?: unknown }).action;
      if (!action || typeof action !== "object") return null;
      const cmd = stringOrEmpty((action as { command?: unknown }).command);
      return cmd || null;
    }
    return null;
  }

  if (type === "exec_command_begin" || type === "exec_command_end" || type === "exec_command_output_delta") {
    const payload = (obj as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") return null;
    const cmd = formatCommand((payload as { command?: unknown }).command);
    return cmd || null;
  }

  if (type.startsWith("item.")) {
    const item = (obj as { item?: unknown }).item;
    if (!item || typeof item !== "object") return null;
    const detailsType = stringOrEmpty((item as { type?: unknown }).type);
    if (detailsType === "command_execution") {
      const cmd = stringOrEmpty((item as { command?: unknown }).command);
      return cmd || null;
    }
  }

  return null;
}

// Re-export helpers for controller usage.
