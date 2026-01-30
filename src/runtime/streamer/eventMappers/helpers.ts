import { t, type UserLanguage } from "../../../locales/index.js";
import type { StreamFragment, MessageVerbosity, EventMsgPayloadOptions } from "../types.js";

// ============================================================================
// Helper Functions
// ============================================================================

export function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function firstNonEmptyString(values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return "";
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncateJson(value: unknown, maxLen = 400): string {
  const raw = safeJson(value);
  return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw;
}

export function truncateLogLine(text: string, maxLen: number): string {
  const limit = Math.max(0, Math.floor(maxLen));
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

export function formatCommitJsonMessage(raw: string, lang: UserLanguage): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence && fence[1]) candidate = fence[1].trim();
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const commitMessage = String(parsed.commit_message ?? parsed.commitMessage ?? "").trim();
    const branchName = String(parsed.branch_name ?? parsed.branchName ?? "").trim();
    const summary = String(parsed.summary ?? parsed.description ?? "").trim();
    if (!commitMessage || !branchName) return null;
    const summaryLine = summary ? summary : t("commit.proposal.summary_empty", lang);
    return [
      t("commit.proposal.title", lang),
      t("commit.proposal.branch", lang, { branch: branchName }),
      t("commit.proposal.commit", lang, { message: commitMessage }),
      t("commit.proposal.summary", lang, { summary: summaryLine }),
    ].join("\n");
  } catch {
    return null;
  }
}

export function normalizeMessageVerbosity(value: unknown): MessageVerbosity {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (typeof value === "number") {
    if (value <= 1) return 1;
    if (value <= 2) return 2;
  }
  return 3;
}

export function formatTitledText(title: string, body?: string | null, opts?: { inline?: boolean }): string {
  const cleanTitle = title.trim();
  const hasBody = typeof body === "string" && body.trim().length > 0;
  if (!hasBody) return `*${cleanTitle}*`;
  const cleanBody = body.trim();
  const inline = opts?.inline ?? !cleanBody.includes("\n");
  const separator = inline ? " " : "\n";
  return `*${cleanTitle}*${separator}${cleanBody}`;
}

export function formatCommand(command: unknown): string {
  if (Array.isArray(command)) return command.map((c) => String(c)).join(" ");
  if (typeof command === "string") return command;
  return "";
}

export function decodeBase64ToString(chunk: unknown): string | null {
  if (typeof chunk !== "string") return null;
  try {
    return Buffer.from(chunk, "base64").toString("utf8");
  } catch {
    return null;
  }
}

// Normalize agent messages from different providers (local event_msg vs. cloud item.* JSONL).
export function normalizeAgentMessage(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const msg = firstNonEmptyString([
    (obj as { message?: unknown }).message,
    (obj as { text?: unknown }).text,
    (obj as { content?: unknown }).content,
  ]);
  return msg || null;
}

export function extractTitleFromPayload(
  payload: Record<string, unknown>,
): { title: string | null; content: string | null } {
  if (
    payload &&
    typeof payload === "object" &&
    (payload as { type?: unknown }).type === "agent_reasoning" &&
    typeof (payload as { text?: unknown }).text === "string"
  ) {
    const text = (payload as { text: string }).text;
    // Get the first occurrence of **xxx**
    const match = text.match(/\*\*(.*?)\*\*/);
    const title = match && typeof match[1] === "string" ? match[1] : null;
    // Remove the matched **title** from the text for content
    let content: string | null = text;
    if (title !== null) {
      // Strip the first **title** (including the "**") and any whitespace/newlines directly after
      content = content.replace(/\*\*.*?\*\*\s*/, "");
    }
    content = content.trim();
    if (content.length === 0) content = null;
    return { title, content };
  }
  return { title: null, content: null };
}

export function getTextFromContentItems(content: unknown): string {
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

export function extractMcpResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") out.push(text);
    }
    return out.join("");
  }
  const text = (result as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export function extractCommandFromToolArgs(name: string, argsText: string): string | null {
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

// ============================================================================
// Session Configuration Formatters
// ============================================================================

export function formatSessionConfigured(payload: Record<string, unknown>): string {
  const model = stringOrEmpty(payload.model);
  const provider = stringOrEmpty(payload.model_provider_id);
  const cwd = stringOrEmpty(payload.cwd);
  const parts = [];
  if (model) parts.push(model);
  if (provider) parts.push(`provider=${provider}`);
  if (cwd) parts.push(`cwd=${cwd}`);
  return parts.join(" | ");
}

// ============================================================================
// MCP Formatters
// ============================================================================

export function formatMcpStartupUpdate(payload: Record<string, unknown>, lang: UserLanguage): { title: string; detail: string } {
  const server = stringOrEmpty(payload.server) || t("streamer.mcp_server", lang);
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
  return { title: `MCP ${server}`, detail: status || t("streamer.mcp_status_unknown", lang) };
}

export function formatMcpStartupComplete(payload: Record<string, unknown>, lang: UserLanguage): { title: string; detail: string } {
  const ready = Array.isArray(payload.ready) ? payload.ready.length : 0;
  const failed = Array.isArray(payload.failed) ? payload.failed.length : 0;
  const cancelled = Array.isArray(payload.cancelled) ? payload.cancelled.length : 0;
  return {
    title: t("streamer.mcp_startup", lang),
    detail: [
      `${t("streamer.mcp_startup_ready", lang)}=${ready}`,
      `${t("streamer.mcp_startup_failed", lang)}=${failed}`,
      `${t("streamer.mcp_startup_cancelled", lang)}=${cancelled}`,
    ].join(", "),
  };
}

export function formatMcpInvocation(invocation: unknown): string | null {
  if (!invocation || typeof invocation !== "object") return null;
  const server = stringOrEmpty((invocation as { server?: unknown }).server);
  const tool = stringOrEmpty((invocation as { tool?: unknown }).tool);
  if (!server && !tool) return null;
  const args = (invocation as { arguments?: unknown }).arguments;
  const argsText = args === undefined ? "" : ` ${truncateJson(args, 300)}`;
  return `MCP ${server}.${tool}${argsText}`;
}

export function formatMcpContentBlock(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const type = stringOrEmpty((block as { type?: unknown }).type);
  if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
    return (block as { text: string }).text;
  }
  return truncateJson(block, 200);
}

export function formatMcpToolResult(result: unknown, invocation: unknown, lang: UserLanguage): string | null {
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
      const errorLabel = t("streamer.error", lang);
      const text = err ? `${errorLabel}: ${err}` : errorLabel;
      return target ? `${target}: ${text}` : text;
    }
  }
  if (typeof result === "string") return target ? `${target}: ${result}` : result;
  return target ? `${target}: ${t("streamer.no_result", lang)}` : null;
}

export function formatMcpListTools(payload: Record<string, unknown>, lang: UserLanguage): string {
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
  return t("streamer.mcp_list_summary", lang, { tools, resources, templates });
}

// ============================================================================
// Patch & Review Formatters
// ============================================================================

function countMapEntries(value: unknown): number {
  return value && typeof value === "object" ? Object.keys(value as Record<string, unknown>).length : 0;
}

export function formatPatchApprovalRequest(payload: Record<string, unknown>, lang: UserLanguage): string | null {
  const changes = payload.changes;
  const count = changes && typeof changes === "object" ? Object.keys(changes as Record<string, unknown>).length : 0;
  const reason = stringOrEmpty(payload.reason);
  const grantRoot = stringOrEmpty(payload.grant_root);
  const parts = [t("streamer.files_count", lang, { count })];
  if (grantRoot) parts.push(t("streamer.patch_grant", lang, { root: grantRoot }));
  if (reason) parts.push(t("streamer.reason", lang, { reason }));
  return parts.length > 0 ? parts.join(", ") : null;
}

export function formatPatchApplyBegin(payload: Record<string, unknown>, lang: UserLanguage): string {
  const count = countMapEntries(payload.changes);
  const auto = (payload as { auto_approved?: unknown }).auto_approved === true;
  return `${t("streamer.files_count", lang, { count })}${auto ? t("streamer.patch_auto_approved", lang) : ""}`;
}

export function formatPatchApplyEnd(payload: Record<string, unknown>, lang: UserLanguage): string {
  const count = countMapEntries(payload.changes);
  const success = (payload as { success?: unknown }).success === true;
  const stderr = stringOrEmpty(payload.stderr);
  const stdout = stringOrEmpty(payload.stdout);
  const details = stderr || stdout;
  const base = success
    ? t("streamer.patch_apply_succeeded", lang, { count })
    : t("streamer.patch_apply_failed", lang, { count });
  return details ? `${base}: ${details}` : base;
}

export function formatCustomPrompts(payload: Record<string, unknown>, lang: UserLanguage): string {
  const prompts = Array.isArray(payload.custom_prompts) ? payload.custom_prompts : [];
  const names = prompts
    .map((p) => (p && typeof p === "object" ? stringOrEmpty((p as { name?: unknown }).name) : ""))
    .filter((n) => n.length > 0);
  if (names.length === 0) return t("streamer.custom_prompts_none", lang);
  const preview = names.slice(0, 5).join(", ");
  const suffix = names.length > 5 ? t("streamer.custom_prompts_more", lang, { count: names.length - 5 }) : "";
  return `${preview}${suffix}`;
}

export function formatTurnAbortReason(reason: unknown): string | null {
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object" && typeof (reason as { type?: unknown }).type === "string") {
    return (reason as { type: string }).type;
  }
  return null;
}

export function formatReviewTarget(target: unknown, lang: UserLanguage): string | null {
  if (!target || typeof target !== "object") return null;
  const targetType = stringOrEmpty((target as { type?: unknown }).type);
  if (targetType === "uncommittedChanges") return t("streamer.review_target_uncommitted", lang);
  if (targetType === "baseBranch") {
    const branch = stringOrEmpty((target as { branch?: unknown }).branch);
    const base = t("streamer.review_target_base_branch", lang);
    return branch ? `${base} ${branch}` : base;
  }
  if (targetType === "commit") {
    const sha = stringOrEmpty((target as { sha?: unknown }).sha);
    const title = stringOrEmpty((target as { title?: unknown }).title);
    const suffix = title ? ` (${title})` : "";
    const label = t("streamer.review_target_commit", lang);
    return sha ? `${label} ${sha}${suffix}` : label;
  }
  if (targetType === "custom") {
    const instructions = stringOrEmpty((target as { instructions?: unknown }).instructions);
    return instructions
      ? t("streamer.review_target_custom", lang, { instructions })
      : t("streamer.review_target_custom_instructions", lang);
  }
  return null;
}

export function formatEnteredReview(payload: Record<string, unknown>, lang: UserLanguage): string | null {
  const target = formatReviewTarget(payload.target, lang);
  const hint = stringOrEmpty(payload.user_facing_hint);
  const parts: string[] = [];
  if (target) parts.push(t("streamer.review_for", lang, { target }));
  if (hint) parts.push(hint);
  if (parts.length === 0) return null;
  return parts.join(" - ");
}

export function formatExitedReview(payload: Record<string, unknown>, lang: UserLanguage): string | null {
  const reviewOutput = payload.review_output;
  if (!reviewOutput || typeof reviewOutput !== "object") return null;
  const findings = Array.isArray((reviewOutput as { findings?: unknown }).findings)
    ? (reviewOutput as { findings: unknown[] }).findings.length
    : 0;
  const correctness = stringOrEmpty((reviewOutput as { overall_correctness?: unknown }).overall_correctness);
  const base = findings > 0
    ? t("streamer.review_findings", lang, { count: findings })
    : t("streamer.review_no_findings", lang);
  return correctness ? `${base} - ${correctness}` : base;
}

// ============================================================================
// Tool Pair Formatting (for controller usage)
// ============================================================================

import { redactText } from "../../redact.js";

function sanitizeFencedCodeBlockInner(text: string): string {
  // Prevent accidental closure of fenced blocks.
  return text.replaceAll("```", "``\u200b`");
}

export function formatToolPairMessage(opts: { callText: string | null; outputText: string; maxMessageChars: number }): string {
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
