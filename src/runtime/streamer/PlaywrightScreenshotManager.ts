import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../log.js";
import type { SendToSessionFn } from "../messaging.js";
import type { PlaywrightMcpManager } from "../playwrightMcp.js";
import { t, type UserLanguage } from "../../locales/index.js";

/**
 * Screenshot data extracted from tool output.
 */
export interface ExtractedScreenshot {
  file: Buffer;
  mimeType: string;
  filename: string;
  savedPath?: string;
}

/**
 * PlaywrightScreenshotManager - Manages Playwright browser screenshot capture and sending.
 *
 * Tracks Playwright tool calls and their outputs to capture screenshots at the right time.
 * Ensures only one screenshot is sent per user turn to avoid flooding the chat.
 */
export class PlaywrightScreenshotManager {
  // Map of sessionId -> Map of callId -> tool name
  private readonly playwrightCallIds = new Map<string, Map<string, string>>();
  // Set of sessionId -> Set of captured call IDs (to avoid duplicates)
  private readonly playwrightCapturedCallIds = new Map<string, Set<string>>();
  // Map of sessionId -> turn key for pending screenshot
  private readonly playwrightScreenshotPendingTurn = new Map<string, number>();
  // Map of sessionId -> turn key currently being sent
  private readonly playwrightScreenshotSendingTurn = new Map<string, number>();
  // Map of sessionId -> turn key for which screenshot was sent
  private readonly playwrightScreenshotSentTurn = new Map<string, number>();
  // Set of cloud session IDs (no auto-screenshots for cloud runs)
  private readonly playwrightCloudSessions = new Set<string>();

  constructor(
    private readonly playwrightMcp: PlaywrightMcpManager | null,
    private readonly sendToSession: SendToSessionFn,
    private readonly logger: Logger,
  ) {}

  /**
   * Mark a session as a cloud session (no auto-screenshots).
   */
  markCloudSession(sessionId: string): void {
    this.playwrightCloudSessions.add(sessionId);
  }

  /**
   * Unmark a session as a cloud session.
   */
  unmarkCloudSession(sessionId: string): void {
    this.playwrightCloudSessions.delete(sessionId);
  }

  /**
   * Check if a session is a cloud session.
   */
  isCloudSession(sessionId: string): boolean {
    return this.playwrightCloudSessions.has(sessionId);
  }

  /**
   * Clear all tracked state for a session.
   */
  clear(sessionId: string): void {
    this.playwrightCallIds.delete(sessionId);
    this.playwrightCapturedCallIds.delete(sessionId);
    this.playwrightScreenshotPendingTurn.delete(sessionId);
    this.playwrightScreenshotSendingTurn.delete(sessionId);
    this.playwrightScreenshotSentTurn.delete(sessionId);
    this.playwrightCloudSessions.delete(sessionId);
  }

  /**
   * Clear all sessions except those in the keep set.
   */
  clearExcept(keepIds: Set<string>): void {
    for (const id of this.playwrightCallIds.keys()) {
      if (!keepIds.has(id)) this.clear(id);
    }
    for (const id of this.playwrightCapturedCallIds.keys()) {
      if (!keepIds.has(id)) this.clear(id);
    }
    for (const id of this.playwrightScreenshotPendingTurn.keys()) {
      if (!keepIds.has(id)) this.clear(id);
    }
    for (const id of this.playwrightScreenshotSendingTurn.keys()) {
      if (!keepIds.has(id)) this.clear(id);
    }
    for (const id of this.playwrightScreenshotSentTurn.keys()) {
      if (!keepIds.has(id)) this.clear(id);
    }
    for (const id of this.playwrightCloudSessions.keys()) {
      if (!keepIds.has(id)) this.clear(id);
    }
  }

  /**
   * Remember a Playwright tool call by its call ID.
   */
  rememberPlaywrightCall(sessionId: string, callId: string, tool: string): void {
    const perSession = this.playwrightCallIds.get(sessionId) ?? new Map<string, string>();
    perSession.set(callId, tool);
    this.playwrightCallIds.set(sessionId, perSession);
  }

  /**
   * Consume (remove and return) a Playwright call by its ID.
   */
  consumePlaywrightCall(sessionId: string, callId: string): string | null {
    if (!callId) return null;
    const perSession = this.playwrightCallIds.get(sessionId);
    if (!perSession) return null;
    const tool = perSession.get(callId) ?? null;
    if (tool) perSession.delete(callId);
    if (perSession.size === 0) this.playwrightCallIds.delete(sessionId);
    return tool;
  }

  /**
   * Check if a call ID has already been captured (screenshot sent).
   */
  hasCapturedPlaywrightCall(sessionId: string, callId: string | null): boolean {
    if (!callId) return false;
    const set = this.playwrightCapturedCallIds.get(sessionId);
    return set ? set.has(callId) : false;
  }

  /**
   * Mark a call ID as captured.
   */
  markCapturedPlaywrightCall(sessionId: string, callId: string | null): void {
    if (!callId) return;
    const set = this.playwrightCapturedCallIds.get(sessionId) ?? new Set<string>();
    set.add(callId);
    this.playwrightCapturedCallIds.set(sessionId, set);
  }

  /**
   * Mark that a screenshot is pending for this turn.
   */
  markPendingScreenshot(sessionId: string, turnKey: number | null): void {
    if (this.playwrightCloudSessions.has(sessionId)) return;
    if (turnKey === null) return;
    if (this.playwrightScreenshotSentTurn.get(sessionId) === turnKey) return;
    this.playwrightScreenshotPendingTurn.set(sessionId, turnKey);
  }

  /**
   * Check if a screenshot was already sent for this turn.
   */
  wasScreenshotSentForTurn(sessionId: string, turnKey: number): boolean {
    return this.playwrightScreenshotSentTurn.get(sessionId) === turnKey;
  }

  /**
   * Capture and send a screenshot for a session.
   */
  async captureAndSendScreenshot(
    sessionId: string,
    lang: UserLanguage,
    callId?: string,
    tool?: string,
  ): Promise<boolean> {
    if (!this.playwrightMcp) return false;
    try {
      const result = await this.playwrightMcp.takeScreenshot({
        sessionId,
        callId: callId || undefined,
        tool: tool || undefined,
      });
      if (result?.savedPath) {
        const buf = await readFile(result.savedPath);
        const caption = tool
          ? t("image.playwright_screenshot_tool", lang, { tool })
          : t("image.playwright_screenshot", lang);
        await this.sendToSession(sessionId, {
          type: "image",
          path: result.savedPath,
          file: buf,
          filename: path.basename(result.savedPath),
          mimeType: result.mimeType,
          caption,
          priority: "user",
        });
        return true;
      }
    } catch (e) {
      this.logger.debug(`[streamer] screenshot error: ${String(e)}`);
    }
    return false;
  }

  /**
   * Send a pending screenshot if one is queued for this turn.
   */
  async maybeSendPendingScreenshot(sessionId: string, lang: UserLanguage, turnKey: number | null): Promise<boolean> {
    if (!this.playwrightMcp) return false;
    if (this.playwrightCloudSessions.has(sessionId)) return false;
    if (turnKey === null) return false;
    if (this.playwrightScreenshotSentTurn.get(sessionId) === turnKey) return false;
    if (this.playwrightScreenshotSendingTurn.get(sessionId) === turnKey) return false;
    if (this.playwrightScreenshotPendingTurn.get(sessionId) !== turnKey) return false;

    this.playwrightScreenshotSendingTurn.set(sessionId, turnKey);
    try {
      const ok = await this.captureAndSendScreenshot(sessionId, lang, undefined, "auto");
      if (ok) {
        this.playwrightScreenshotSentTurn.set(sessionId, turnKey);
        this.playwrightScreenshotPendingTurn.delete(sessionId);
        return true;
      }
      return false;
    } finally {
      this.playwrightScreenshotSendingTurn.delete(sessionId);
    }
  }

  /**
   * Send a screenshot extracted from tool output.
   */
  async sendScreenshotFromToolOutput(
    sessionId: string,
    turnKey: number,
    screenshot: ExtractedScreenshot,
    lang: UserLanguage,
  ): Promise<boolean> {
    if (this.playwrightScreenshotSentTurn.get(sessionId) === turnKey) return true;
    if (this.playwrightScreenshotSendingTurn.get(sessionId) === turnKey) return false;

    this.playwrightScreenshotSendingTurn.set(sessionId, turnKey);
    try {
      await this.sendToSession(sessionId, {
        type: "image",
        path: screenshot.savedPath ?? screenshot.filename,
        file: screenshot.file,
        filename: screenshot.filename,
        mimeType: screenshot.mimeType,
        caption: t("image.playwright_screenshot", lang),
        priority: "user",
      });
      this.playwrightScreenshotSentTurn.set(sessionId, turnKey);
      this.playwrightScreenshotPendingTurn.delete(sessionId);
      return true;
    } catch {
      return false;
    } finally {
      this.playwrightScreenshotSendingTurn.delete(sessionId);
    }
  }

}

// Helper functions for extracting screenshots from tool output

/**
 * Parse an MCP function name in the format "mcp__server__tool".
 */
export function parseMcpFunctionName(name: string): { server: string; tool: string } | null {
  if (typeof name !== "string") return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  const [prefix, server, ...rest] = parts;
  const tool = rest.join("__");
  if (prefix !== "mcp" || !server || !tool) return null;
  return { server, tool };
}

/**
 * Extract a screenshot from Codex function_call_output.
 */
export function extractPlaywrightInlineScreenshot(
  output: unknown,
): ExtractedScreenshot | null {
  if (!Array.isArray(output)) return null;

  let mimeType: string | null = null;
  let file: Buffer | null = null;
  let savedPath: string | null = null;

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const type = stringOrEmpty((item as { type?: unknown }).type);

    if (type === "input_text" && typeof (item as { text?: unknown }).text === "string") {
      const text = (item as { text: string }).text;
      const linked = extractFirstMarkdownLinkPath(text);
      if (linked) savedPath = linked;
      const saved = extractSavedPathFromText(text);
      if (saved) savedPath = saved;
    }

    if (type === "input_image" && typeof (item as { image_url?: unknown }).image_url === "string") {
      const parsed = parseDataUrl((item as { image_url: string }).image_url);
      if (!parsed) continue;
      mimeType = parsed.mimeType;
      file = parsed.data;
    }
  }

  if (!file || !mimeType) return null;
  const filename = savedPath ? path.basename(savedPath) : `playwright-${crypto.randomUUID()}.png`;
  return { file, mimeType, filename, savedPath: savedPath ?? undefined };
}

/**
 * Extract a screenshot from MCP tool result.
 */
export function extractPlaywrightInlineScreenshotFromMcpResult(
  result: unknown,
): ExtractedScreenshot | null {
  if (!result || typeof result !== "object") return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  let mimeType: string | null = null;
  let file: Buffer | null = null;
  let savedPath: string | null = null;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const type = stringOrEmpty((item as { type?: unknown }).type);

    if (type === "text" && typeof (item as { text?: unknown }).text === "string") {
      const text = (item as { text: string }).text;
      const linked = extractFirstMarkdownLinkPath(text);
      if (linked) savedPath = linked;
      const saved = extractSavedPathFromText(text);
      if (saved) savedPath = saved;
    }

    if (type === "image" && typeof (item as { data?: unknown }).data === "string" && typeof (item as { mimeType?: unknown }).mimeType === "string") {
      try {
        file = Buffer.from((item as { data: string }).data, "base64");
        mimeType = (item as { mimeType: string }).mimeType;
      } catch {
        // ignore
      }
    }
  }

  if (!file || !mimeType) return null;
  const filename = savedPath ? path.basename(savedPath) : `playwright-${crypto.randomUUID()}.png`;
  return { file, mimeType, filename, savedPath: savedPath ?? undefined };
}

/**
 * Extract a screenshot from Claude Code tool_result content.
 */
export function extractPlaywrightInlineScreenshotFromClaudeToolResult(
  content: unknown,
): ExtractedScreenshot | null {
  if (!Array.isArray(content)) return null;

  let mimeType: string | null = null;
  let file: Buffer | null = null;
  let savedPath: string | null = null;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const type = stringOrEmpty((item as { type?: unknown }).type);

    if (type === "text" && typeof (item as { text?: unknown }).text === "string") {
      const text = (item as { text: string }).text;
      const linked = extractFirstMarkdownLinkPath(text);
      if (linked) savedPath = linked;
      const saved = extractSavedPathFromText(text);
      if (saved) savedPath = saved;
      continue;
    }

    if (type === "image") {
      // MCP-style: { type: "image", data: "<base64>", mimeType: "image/png" }
      if (typeof (item as { data?: unknown }).data === "string" && typeof (item as { mimeType?: unknown }).mimeType === "string") {
        try {
          file = Buffer.from((item as { data: string }).data, "base64");
          mimeType = (item as { mimeType: string }).mimeType;
        } catch {
          // ignore
        }
        continue;
      }

      // Anthropic-style: { type: "image", source: { type: "base64", media_type: "image/png", data: "<base64>" } }
      const source = (item as { source?: unknown }).source;
      if (source && typeof source === "object") {
        const st = stringOrEmpty((source as { type?: unknown }).type);
        const mediaType = stringOrEmpty((source as { media_type?: unknown }).media_type);
        const data = (source as { data?: unknown }).data;
        if (st === "base64" && mediaType && typeof data === "string") {
          try {
            file = Buffer.from(data, "base64");
            mimeType = mediaType;
          } catch {
            // ignore
          }
        }
      }
    }
  }

  if (!file || !mimeType) return null;
  const filename = savedPath ? path.basename(savedPath) : `playwright-${crypto.randomUUID()}.png`;
  return { file, mimeType, filename, savedPath: savedPath ?? undefined };
}

// Private helper functions

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractFirstMarkdownLinkPath(text: string): string | null {
  const re = /\[[^\]]*]\(([^)]+)\)/g;
  for (const match of text.matchAll(re)) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    if (raw.startsWith("/")) return raw;
  }
  return null;
}

function extractSavedPathFromText(text: string): string | null {
  const m = text.match(/save it as\s+([^\s]+)\s*$/im);
  if (m && typeof m[1] === "string") {
    const p = m[1].trim();
    if (p.startsWith("/")) return p;
  }
  return null;
}

function parseDataUrl(url: string): { mimeType: string; data: Buffer } | null {
  const m = url.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return null;
  try {
    return { mimeType: m[1]!, data: Buffer.from(m[2]!, "base64") };
  } catch {
    return null;
  }
}
