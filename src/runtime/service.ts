import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { sleep, TaskQueue } from "./util.js";
import { TelegramClient } from "./platform/telegram.js";
import { SlackClient, verifySlackSignature } from "./platform/slack.js";
import { BotController, type CommitProposal, type CommitProposalStore } from "./controller2.js";
import { CloudManager } from "./cloud/manager.js";
import { handleOAuthCallback } from "./cloud/oauth.js";
import { handleGithubAppCallback } from "./cloud/githubApp.js";
import { handleProxyRequest } from "./cloud/proxy.js";
import { JsonlStreamer, mapEventToFragments } from "./streamer.js";
import { SessionManager } from "./sessionManager.js";
import type { SendToSessionFn } from "./messaging.js";
import type { TelegramMessage } from "./platform/telegram.js";
import { getAgentAdapter } from "./agents.js";
import {
  addCloudRunScreenshot,
  getCloudRun,
  getCloudRunBySession,
  listCloudRunScreenshots,
  listCloudRunsForIdentity,
  listSecrets,
  getSecret,
  setSecret,
  deleteSecret,
} from "./cloud/store.js";
import { uploadScreenshot, signScreenshotUrl } from "./cloud/s3.js";
import { verifyUiToken, type UiTokenPayload } from "./cloud/uiTokens.js";
import { buildRunArtifactsFromJsonl } from "./cloud/uiArtifacts.js";
import { encryptSecret } from "./cloud/secrets.js";
import http from "node:http";
import { PlaywrightMcpManager } from "./playwrightMcp.js";
import { appendFile, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface BotServiceDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
}

type CloudConnectMetadata = {
  platform: "telegram" | "slack";
  chat_id: string;
  user_id: string;
};

function readHeader(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

function sendText(res: http.ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendSse(res: http.ServerResponse, data: unknown, event?: string) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readNewJsonlLines(filePath: string, offset: number): Promise<{ lines: string[]; newOffset: number }> {
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

async function listJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path.join(dir, e.name));
  files.sort();
  return files;
}

function contentTypeForPath(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function parseCloudConnectMetadata(metadataJson: string | null): CloudConnectMetadata | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as any;
    const platform = parsed?.platform;
    const chatId = parsed?.chat_id;
    const userId = parsed?.user_id;
    if ((platform !== "slack" && platform !== "telegram") || typeof chatId !== "string" || typeof userId !== "string") {
      return null;
    }
    return { platform, chat_id: chatId, user_id: userId };
  } catch {
    return null;
  }
}

export async function createBotService(deps: BotServiceDeps) {
  const { config, db, logger } = deps;

  /**
   * Determines whether a session is a Telegram forum topic session.
   *
   * In Tintin, Telegram topic-backed sessions are identified by a non-empty `space_emoji`:
   * it is only set when Tintin successfully creates a forum topic and picks an icon.
   */
  const isTelegramTopicSession = (session: { platform: string; space_emoji: string | null }): boolean => {
    return (
      session.platform === "telegram" && typeof session.space_emoji === "string" && session.space_emoji.trim().length > 0
    );
  };

  const uiConfig = config.cloud?.ui ?? null;

  const extractPlaywrightTool = (caption?: string): string | null => {
    if (!caption) return null;
    const match = caption.match(/Playwright\\s+(.+?)\\s+screenshot/i);
    if (!match) return null;
    const tool = match[1]?.trim();
    if (!tool || tool.toLowerCase() === "screenshot") return null;
    return tool;
  };

  const sanitizeFilename = (name: string): string => {
    return name.replace(/[^A-Za-z0-9_.-]+/g, "-");
  };

  const maybeUploadScreenshot = async (sessionId: string, message: { file: Buffer; filename: string; mimeType?: string; caption?: string }) => {
    if (!config.cloud?.enabled || !uiConfig) return;
    if (!uiConfig.s3_bucket || !uiConfig.s3_region || !uiConfig.token_secret) return;
    const run = await getCloudRunBySession(db, sessionId);
    if (!run) return;
    const safePrefix = uiConfig.s3_prefix.replace(/\/+$/g, "");
    const key = `${safePrefix}/${run.id}/${Date.now()}-${sanitizeFilename(message.filename)}`;
    await uploadScreenshot(uiConfig, { key, body: message.file, contentType: message.mimeType });
    await addCloudRunScreenshot(db, {
      runId: run.id,
      sessionId,
      s3Key: key,
      mimeType: message.mimeType ?? null,
      tool: extractPlaywrightTool(message.caption),
    });
  };

  const queue = new TaskQueue(16);
  const firstMessageSent = new Set<string>();
  const firstMessageSending = new Set<string>();
  const reviewCommitDisabled = new Set<string>();
  const lastTelegramMessageId = new Map<string, number>();
  const telegramMessageToSession = new Map<string, string>();
  const lastSlackMessage = new Map<string, { ts: string; text: string }>();
  const planTelegramMessageId = new Map<string, number>();
  const planSlackMessageTs = new Map<string, string>();

  type PendingCommitProposal = {
    sessionId: string;
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    spaceId: string;
    isTelegramTopic: boolean;
    gitUserName: string | null;
    gitUserEmail: string | null;
    buffer: string;
  };

  const pendingCommitProposals = new Map<string, PendingCommitProposal>();
  const commitProposals = new Map<string, CommitProposal>();

  const telegram = config.telegram ? new TelegramClient(config.telegram, logger) : null;
  const slack = config.slack ? new SlackClient(config.slack, logger) : null;
  const playwrightMcp = config.playwright_mcp?.enabled ? new PlaywrightMcpManager(config.playwright_mcp, logger) : null;

  if (telegram) await telegram.init();
  if (playwrightMcp) {
    process.once("exit", () => void playwrightMcp.stop());
    process.once("SIGINT", () => void playwrightMcp.stop());
    process.once("SIGTERM", () => void playwrightMcp.stop());
  }

  const notifyGithubConnected = async (metadataJson: string | null) => {
    const metadata = parseCloudConnectMetadata(metadataJson);
    if (!metadata) return;
    const text = "GitHub connected. Run `repos` to list repositories.";
    try {
      if (metadata.platform === "telegram") {
        if (!telegram) return;
        const chatId = Number(metadata.chat_id);
        if (!Number.isFinite(chatId)) return;
        await telegram.sendMessage({ chatId, text, priority: "user" });
        return;
      }
      if (!slack) return;
      let channel = metadata.chat_id;
      if (!channel.startsWith("D")) {
        channel = await slack.openConversation({ users: [metadata.user_id] });
      }
      await slack.postMessageDetailed({ channel, text });
    } catch (e) {
      logger.warn(`Failed to send GitHub connect message: ${String(e)}`);
    }
  };

  const isFencedCodeBlock = (text: string): boolean => {
    const t = text.trim();
    return t.startsWith("```") && t.endsWith("```");
  };

  const buildTelegramInlineKeyboard = (opts: {
    sessionId: string;
    includeKill: boolean;
    includeReview: boolean;
    includeCommit: boolean;
    includeStopSandbox: boolean;
  }) => {
    const row: Array<{ text: string; callback_data: string }> = [];
    if (opts.includeKill) row.push({ text: "Stop", callback_data: `kill:${opts.sessionId}` });
    if (opts.includeStopSandbox) row.push({ text: "Stop Sandbox", callback_data: `stop_sandbox:${opts.sessionId}` });
    if (opts.includeReview) row.push({ text: "Review", callback_data: `review:${opts.sessionId}` });
    if (opts.includeCommit) row.push({ text: "Commit", callback_data: `commit:${opts.sessionId}` });
    return row.length > 0 ? { inline_keyboard: [row] } : undefined;
  };

  const buildSlackButtons = (opts: {
    sessionId: string;
    includeKill: boolean;
    includeReview: boolean;
    includeCommit: boolean;
    includeStopSandbox: boolean;
  }) => {
    const elements: any[] = [];
    if (opts.includeKill) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "Stop" },
        style: "danger",
        action_id: "kill_session",
        value: opts.sessionId,
      });
    }
    if (opts.includeStopSandbox) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "Stop Sandbox" },
        style: "danger",
        action_id: "stop_sandbox",
        value: opts.sessionId,
      });
    }
    if (opts.includeReview) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "Review" },
        action_id: "review_session",
        value: opts.sessionId,
      });
    }
    if (opts.includeCommit) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "Commit" },
        action_id: "commit_session",
        value: opts.sessionId,
      });
    }
    return elements.length > 0 ? [{ type: "actions", elements }] : undefined;
  };

  const buildCommitProposalTelegramKeyboard = (proposalId: string) => ({
    inline_keyboard: [
      [
        { text: "Cancel", callback_data: `cpr:${proposalId}:cancel` },
        { text: "Commit & Push", callback_data: `cpr:${proposalId}:push` },
      ],
      [{ text: "Create PR", callback_data: `cpr:${proposalId}:pr` }],
    ],
  });

  const buildCommitProposalSlackBlocks = (proposalId: string) => [
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Cancel" }, style: "danger", action_id: "commit_cancel", value: proposalId },
        {
          type: "button",
          text: { type: "plain_text", text: "Commit & Push" },
          action_id: "commit_push",
          value: proposalId,
        },
        { type: "button", text: { type: "plain_text", text: "Create PR" }, action_id: "commit_pr", value: proposalId },
      ],
    },
  ];

  const extractCommitProposalPayload = (
    raw: string,
  ): { commitMessage: string; branchName: string; summary: string } | null => {
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
      return { commitMessage, branchName, summary };
    } catch {
      return null;
    }
  };

  const formatCommitProposalText = (proposal: CommitProposal) => {
    const summary = proposal.summary?.trim();
    const summaryLine = summary ? summary : "_(no summary provided)_";
    return [
      "*Commit proposal*",
      `*Branch*: \`${proposal.branchName}\``,
      `*Commit*: \`${proposal.commitMessage}\``,
      `*Summary*: ${summaryLine}`,
      "",
      "Choose an action:",
    ].join("\n");
  };

  const sendCommitProposalMessage = async (opts: {
    pending: PendingCommitProposal;
    text: string;
    proposalId: string;
  }) => {
    if (opts.pending.platform === "telegram") {
      if (!telegram) return;
      const chatId = Number(opts.pending.chatId);
      const space = Number(opts.pending.spaceId);
      if (Number.isNaN(chatId)) return;
      const replyMarkup = buildCommitProposalTelegramKeyboard(opts.proposalId);
      if (opts.pending.isTelegramTopic && Number.isFinite(space)) {
        await telegram.sendMessage({
          chatId,
          messageThreadId: Number(space),
          text: opts.text,
          replyMarkup,
          priority: "user",
        });
        return;
      }
      if (Number.isFinite(space)) {
        await telegram.sendMessage({
          chatId,
          replyToMessageId: Number(space),
          text: opts.text,
          replyMarkup,
          priority: "user",
        });
        return;
      }
      await telegram.sendMessage({ chatId, text: opts.text, replyMarkup, priority: "user" });
      return;
    }

    if (opts.pending.platform === "slack") {
      if (!slack) return;
      const threadTs = config.slack?.session_mode === "thread" ? opts.pending.spaceId : undefined;
      await slack.postMessageDetailed({
        channel: opts.pending.chatId,
        thread_ts: threadTs,
        text: opts.text,
        blocks: buildCommitProposalSlackBlocks(opts.proposalId),
        blocksOnLastChunk: false,
      });
    }
  };

  const sendCommitProposalNotice = async (pending: PendingCommitProposal, text: string) => {
    if (pending.platform === "telegram") {
      if (!telegram) return;
      const chatId = Number(pending.chatId);
      const space = Number(pending.spaceId);
      if (Number.isNaN(chatId)) return;
      if (pending.isTelegramTopic && Number.isFinite(space)) {
        await telegram.sendMessage({ chatId, messageThreadId: Number(space), text, priority: "user" });
        return;
      }
      if (Number.isFinite(space)) {
        await telegram.sendMessage({ chatId, replyToMessageId: Number(space), text, priority: "user" });
        return;
      }
      await telegram.sendMessage({ chatId, text, priority: "user" });
      return;
    }
    if (pending.platform === "slack") {
      if (!slack) return;
      const threadTs = config.slack?.session_mode === "thread" ? pending.spaceId : undefined;
      await slack.postMessageDetailed({
        channel: pending.chatId,
        thread_ts: threadTs,
        text,
        blocksOnLastChunk: false,
      });
    }
  };

  const sendCommitProposalError = async (pending: PendingCommitProposal, reason: string) => {
    const text = `*Commit proposal failed.* ${reason}`;
    await sendCommitProposalNotice(pending, text);
  };

  const commitProposalStore: CommitProposalStore = {
    startProposal: (opts) => {
      pendingCommitProposals.set(opts.sessionId, { ...opts, buffer: "" });
    },
    getProposal: (id) => commitProposals.get(id) ?? null,
    consumeProposal: (id) => {
      const proposal = commitProposals.get(id) ?? null;
      if (proposal) commitProposals.delete(id);
      return proposal;
    },
    clearPendingForSession: (sessionId) => {
      pendingCommitProposals.delete(sessionId);
    },
  };

  const maybeHandleCommitProposalMessage = async (sessionId: string, message: { type?: string; text?: string; final?: boolean }) => {
    const pending = pendingCommitProposals.get(sessionId);
    if (!pending) return false;
    if (message.type === "finalize") return false;
    if (message.type === "plan_update" || message.type === "image") return true;
    const text = typeof message.text === "string" ? message.text : "";
    if (text || message.final) {
      pending.buffer = pending.buffer ? `${pending.buffer}\n${text}` : text;
      if (pending.buffer.length > 40_000) {
        pendingCommitProposals.delete(sessionId);
        await sendCommitProposalError(pending, "Output too large. Try again.");
        return true;
      }
      const parsed = extractCommitProposalPayload(pending.buffer);
      if (parsed) {
        pendingCommitProposals.delete(sessionId);
        const proposal: CommitProposal = {
          id: crypto.randomUUID(),
          sessionId: pending.sessionId,
          platform: pending.platform,
          chatId: pending.chatId,
          userId: pending.userId,
          commitMessage: parsed.commitMessage,
          branchName: parsed.branchName,
          summary: parsed.summary,
          gitUserName: pending.gitUserName,
          gitUserEmail: pending.gitUserEmail,
          createdAt: Date.now(),
        };
        commitProposals.set(proposal.id, proposal);
        const text = formatCommitProposalText(proposal);
        await sendCommitProposalMessage({ pending, text, proposalId: proposal.id });
        return true;
      }
      if (message.final) {
        pendingCommitProposals.delete(sessionId);
        await sendCommitProposalError(pending, "Could not parse a JSON proposal. Try again.");
        return true;
      }
    }
    return true;
  };

  const telegramMessageKey = (chatId: string | number, messageId: number) => `${String(chatId)}:${String(messageId)}`;
  const trackTelegramMessage = (sessionId: string, chatId: number, messageId: number) => {
    const prev = lastTelegramMessageId.get(sessionId);
    if (prev) {
      telegramMessageToSession.delete(telegramMessageKey(chatId, prev));
    }
    lastTelegramMessageId.set(sessionId, messageId);
    telegramMessageToSession.set(telegramMessageKey(chatId, messageId), sessionId);
  };

  const attachReviewAndCommitButtonsToLastMessage = async (
    sessionId: string,
    session: { platform: string; chat_id: string; project_id: string | null },
  ) => {
    const includeStopSandbox = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
    if (session.platform === "telegram") {
      if (!telegram) return false;
      const chatId = Number(session.chat_id);
      const messageId = lastTelegramMessageId.get(sessionId);
      if (!messageId || Number.isNaN(chatId)) return false;
      try {
        await telegram.editMessageReplyMarkup({
          chatId,
          messageId,
          replyMarkup: buildTelegramInlineKeyboard({
            sessionId,
            includeKill: false,
            includeReview: true,
            includeCommit: true,
            includeStopSandbox,
          }),
          priority: "user",
        });
        return true;
      } catch {
        return false;
      }
    }

    if (session.platform === "slack") {
      if (!slack) return false;
      const channel = session.chat_id;
      const last = lastSlackMessage.get(sessionId);
      if (!last) return false;
      try {
        await slack.updateMessage({
          channel,
          ts: last.ts,
          text: last.text,
          blocks: buildSlackButtons({
            sessionId,
            includeKill: false,
            includeReview: true,
            includeCommit: true,
            includeStopSandbox,
          }),
        });
        return true;
      } catch {
        return false;
      }
    }

    return false;
  };

  const escapeHtml = (input: string): string => {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  const normalizePlanStatus = (raw: string): "pending" | "in_progress" | "completed" => {
    const s = raw.trim().toLowerCase();
    if (s === "completed" || s === "done" || s === "finished") return "completed";
    if (s === "in_progress" || s === "in progress" || s === "active" || s === "running") return "in_progress";
    return "pending";
  };

  const formatPlanMessageTelegramHtml = (opts: {
    plan: Array<{ step: string; status: string }>;
    explanation?: string;
  }): string => {
    const maxChars = config.telegram?.max_chars ?? 4096;
    const header = "<b>Plan</b>";
    const explanation = (opts.explanation ?? "").trim();
    const lines: string[] = [header];
    if (explanation) lines.push(`<i>${escapeHtml(explanation)}</i>`);
    lines.push("");

    for (const item of opts.plan) {
      const step = (item.step ?? "").trim();
      if (!step) continue;
      const status = normalizePlanStatus(item.status ?? "");
      const escaped = escapeHtml(step);
      if (status === "completed") lines.push(`• <s>${escaped}</s>`);
      else if (status === "in_progress") lines.push(`• <b>${escaped}</b>`);
      else lines.push(`• ${escaped}`);
    }

    const base = lines.join("\n").trim();
    if (base.length <= maxChars) return base;

    const out: string[] = [];
    let len = 0;
    const trailer = "<i>(truncated)</i>";
    for (const line of lines) {
      const extra = (out.length > 0 ? 1 : 0) + line.length;
      if (len + extra > maxChars) break;
      out.push(line);
      len += extra;
    }
    const trailerExtra = (out.length > 0 ? 1 : 0) + trailer.length;
    while (out.length > 0 && len + trailerExtra > maxChars) {
      const removed = out.pop()!;
      len -= removed.length + (out.length > 0 ? 1 : 0);
    }
    if (out.length === 0) return trailer.slice(0, maxChars);
    if (len + trailerExtra <= maxChars) out.push(trailer);
    return out.join("\n").trim();
  };

  const formatPlanMessageSlack = (opts: { plan: Array<{ step: string; status: string }>; explanation?: string }): string => {
    const maxChars = config.slack?.max_chars ?? 3000;
    const explanation = (opts.explanation ?? "").trim();
    const lines: string[] = ["*Plan*"];
    if (explanation) lines.push(`_${explanation}_`);
    lines.push("");

    for (const item of opts.plan) {
      const step = (item.step ?? "").trim();
      if (!step) continue;
      const status = normalizePlanStatus(item.status ?? "");
      if (status === "completed") lines.push(`• ~${step}~`);
      else if (status === "in_progress") lines.push(`• *${step}*`);
      else lines.push(`• ${step}`);
    }

    const base = lines.join("\n").trim();
    if (base.length <= maxChars) return base;

    const out: string[] = [];
    let len = 0;
    const trailer = "… (truncated)";
    for (const line of lines) {
      const extra = (out.length > 0 ? 1 : 0) + line.length;
      if (len + extra > maxChars) break;
      out.push(line);
      len += extra;
    }
    const trailerExtra = (out.length > 0 ? 1 : 0) + trailer.length;
    while (out.length > 0 && len + trailerExtra > maxChars) {
      const removed = out.pop()!;
      len -= removed.length + (out.length > 0 ? 1 : 0);
    }
    if (out.length === 0) return trailer.slice(0, maxChars);
    if (len + trailerExtra <= maxChars) out.push(trailer);
    return out.join("\n").trim();
  };

  const upsertPlanMessage = async (
    sessionId: string,
    session: { platform: string; chat_id: string; space_id: string; space_emoji: string | null },
    plan: Array<{ step: string; status: string }>,
    explanation?: string,
  ) => {
    if (session.platform === "telegram") {
      if (!telegram) return;
      const chatId = Number(session.chat_id);
      const space = Number(session.space_id);
      if (Number.isNaN(chatId) || Number.isNaN(space)) return;
      const text = formatPlanMessageTelegramHtml({ plan, explanation });
      const existing = planTelegramMessageId.get(sessionId);
      if (existing) {
        try {
          await telegram.editMessageText({ chatId, messageId: existing, text, parseMode: "HTML", priority: "user" });
          return;
        } catch {
          planTelegramMessageId.delete(sessionId);
        }
      }

      try {
        const sent = await telegram.sendMessageSingleStrict(
          isTelegramTopicSession(session)
            ? {
                chatId,
                messageThreadId: space,
                text,
                parseMode: "HTML",
                priority: "user",
                forcePrimary: true,
              }
            : {
                chatId,
                replyToMessageId: space,
                text,
                parseMode: "HTML",
                priority: "user",
                forcePrimary: true,
              },
        );
        if (sent) {
          planTelegramMessageId.set(sessionId, sent.message_id);
          trackTelegramMessage(sessionId, chatId, sent.message_id);
        }
      } catch {
        // Ignore plan send failures.
      }
      return;
    }

    if (session.platform === "slack") {
      if (!slack) return;
      const channel = session.chat_id;
      const threadTs = config.slack?.session_mode === "thread" ? session.space_id : undefined;
      const text = formatPlanMessageSlack({ plan, explanation });
      const existing = planSlackMessageTs.get(sessionId);
      if (existing) {
        try {
          await slack.updateMessage({ channel, ts: existing, text });
          return;
        } catch {
          planSlackMessageTs.delete(sessionId);
        }
      }
      try {
        const posted = await slack.postMessageDetailed({ channel, thread_ts: threadTs, text, blocksOnLastChunk: false });
        if (posted.lastTs) planSlackMessageTs.set(sessionId, posted.lastTs);
      } catch {
        // Ignore plan send failures.
      }
    }
  };

  const sendToSession: SendToSessionFn = async (sessionId, message) => {
    const session = await db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
    if (!session) return;
    const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
    const handledCommitProposal = await maybeHandleCommitProposalMessage(sessionId, message);
    if (handledCommitProposal) return;
    const actionsDisabled = reviewCommitDisabled.has(sessionId);
    const telegramTopicSession = isTelegramTopicSession(session);
    if (message.type === "finalize") {
      const updated = actionsDisabled ? false : await attachReviewAndCommitButtonsToLastMessage(sessionId, session);
      if (updated) return;
      const fallbackText = "Session complete.";
      if (session.platform === "telegram") {
        if (!telegram) return;
        const chatId = Number(session.chat_id);
        const space = Number(session.space_id);
        if (Number.isNaN(chatId) || Number.isNaN(space)) return;
        const replyMarkup = actionsDisabled
          ? undefined
          : buildTelegramInlineKeyboard({
              sessionId,
              includeKill: false,
              includeReview: true,
              includeCommit: true,
              includeStopSandbox: isCloudSession,
            });
        const priority = "user" as const;
        try {
          const sent = await telegram.sendMessageSingleStrict(
            telegramTopicSession
              ? { chatId, messageThreadId: space, text: fallbackText, replyMarkup, priority, forcePrimary: true }
              : { chatId, replyToMessageId: space, text: fallbackText, replyMarkup, priority, forcePrimary: true },
          );
          trackTelegramMessage(sessionId, chatId, sent.message_id);
        } catch {
          // Ignore fallback failures.
        }
      } else if (session.platform === "slack") {
        if (!slack) return;
        const channel = session.chat_id;
        const threadTs = config.slack?.session_mode === "thread" ? session.space_id : undefined;
        try {
          const posted = await slack.postMessageDetailed({
            channel,
            thread_ts: threadTs,
            text: fallbackText,
            blocks: actionsDisabled
              ? undefined
              : buildSlackButtons({
                  sessionId,
                  includeKill: false,
                  includeReview: true,
                  includeCommit: true,
                  includeStopSandbox: isCloudSession,
                }),
            blocksOnLastChunk: false,
          });
          if (posted.lastTs && posted.lastText !== null) {
            lastSlackMessage.set(sessionId, { ts: posted.lastTs, text: posted.lastText });
          }
        } catch {
          // Ignore fallback failures.
        }
      }
      return;
    }
    if (message.type === "plan_update") {
      await upsertPlanMessage(sessionId, session, message.plan, message.explanation);
      return;
    }
    if (message.type === "image") {
      const caption = message.caption ?? `Playwright screenshot: ${message.path}`;
      const priority = message.priority ?? "user";
      void maybeUploadScreenshot(sessionId, {
        file: message.file,
        filename: message.filename,
        mimeType: message.mimeType,
        caption,
      }).catch((e) => logger.warn(`screenshot upload failed session=${sessionId}: ${String(e)}`));
      try {
        if (session.platform === "telegram") {
          if (!telegram) return;
          const chatId = Number(session.chat_id);
          const space = Number(session.space_id);
          if (Number.isNaN(chatId) || Number.isNaN(space)) return;
          const send = async (opts: { messageThreadId?: number; replyToMessageId?: number }) => {
            try {
              const sent = await telegram.sendPhoto({
                chatId,
                messageThreadId: opts.messageThreadId,
                replyToMessageId: opts.replyToMessageId,
                filename: message.filename,
                file: message.file,
                mimeType: message.mimeType,
                caption,
                priority,
              });
              trackTelegramMessage(sessionId, chatId, sent.message_id);
            } catch {
              const sent = await telegram.sendDocument({
                chatId,
                messageThreadId: opts.messageThreadId,
                replyToMessageId: opts.replyToMessageId,
                filename: message.filename,
                file: message.file,
                mimeType: message.mimeType,
                caption,
                priority,
              });
              trackTelegramMessage(sessionId, chatId, sent.message_id);
            }
          };
          await send(telegramTopicSession ? { messageThreadId: space } : { replyToMessageId: space });
          return;
        }
        if (session.platform === "slack") {
          if (!slack) return;
          const threadTs = config.slack?.session_mode === "thread" ? session.space_id : undefined;
          await slack.uploadFile({
            channel: session.chat_id,
            thread_ts: threadTs,
            filename: message.filename,
            file: message.file,
            mimeType: message.mimeType,
            initial_comment: caption,
          });
          return;
        }
      } catch (e) {
        logger.warn(`send image failed session=${sessionId}: ${String(e)}`);
      }
      await sendToSession(sessionId, { text: `${caption}\nSaved at: ${message.path}`, priority: "user" });
      return;
    }
    const text = message.text;
    const isFinal = message.final === true;
    const isFirst = !firstMessageSent.has(sessionId) && !firstMessageSending.has(sessionId);
    const claimedFirst = isFirst;
    if (claimedFirst) firstMessageSending.add(sessionId);
    const includeKillButton =
      isFirst &&
      !isFinal &&
      !isCloudSession &&
      (session.status === "starting" || session.status === "running") &&
      !(session.platform === "telegram" && telegramTopicSession);
    const includeReviewButton = false;
    const includeCommitButton = false;

    let messageSent = false;
    try {
      if (isFinal && text.trim().length === 0) {
        const updated = actionsDisabled ? false : await attachReviewAndCommitButtonsToLastMessage(sessionId, session);
        if (updated) return;

        const fallbackText = "Session complete.";
        if (session.platform === "telegram") {
          if (!telegram) return;
          const chatId = Number(session.chat_id);
          const space = Number(session.space_id);
          if (Number.isNaN(chatId) || Number.isNaN(space)) return;
          const replyMarkup = actionsDisabled
            ? undefined
            : buildTelegramInlineKeyboard({
                sessionId,
                includeKill: false,
                includeReview: true,
                includeCommit: true,
                includeStopSandbox: isCloudSession,
              });
          const priority = "user" as const;
          try {
            const sent = await telegram.sendMessageSingleStrict(
              telegramTopicSession
                ? { chatId, messageThreadId: space, text: fallbackText, replyMarkup, priority, forcePrimary: true }
                : { chatId, replyToMessageId: space, text: fallbackText, replyMarkup, priority, forcePrimary: true },
            );
            trackTelegramMessage(sessionId, chatId, sent.message_id);
            messageSent = true;
          } catch {
            // Ignore fallback failures.
          }
        } else if (session.platform === "slack") {
          if (!slack) return;
          const channel = session.chat_id;
          const threadTs = config.slack?.session_mode === "thread" ? session.space_id : undefined;
          try {
            const posted = await slack.postMessageDetailed({
              channel,
              thread_ts: threadTs,
              text: fallbackText,
              blocks: actionsDisabled
                ? undefined
                : buildSlackButtons({
                    sessionId,
                    includeKill: false,
                    includeReview: true,
                    includeCommit: true,
                    includeStopSandbox: isCloudSession,
                  }),
              blocksOnLastChunk: false,
            });
            if (posted.lastTs && posted.lastText !== null) {
              lastSlackMessage.set(sessionId, { ts: posted.lastTs, text: posted.lastText });
            }
            messageSent = true;
          } catch {
            // Ignore fallback failures.
          }
        }
        return;
      }

      if (session.platform === "telegram") {
        if (!telegram) return;
        const chatId = Number(session.chat_id);
        const space = Number(session.space_id);
        if (Number.isNaN(chatId) || Number.isNaN(space)) return;
        const priority = message.priority ?? "background";
        const replyMarkup = buildTelegramInlineKeyboard({
          sessionId,
          includeKill: includeKillButton,
          includeReview: includeReviewButton,
          includeCommit: includeCommitButton,
          includeStopSandbox: false,
        });

        if (isFencedCodeBlock(text)) {
          const parseMode = "Markdown" as const;
          let sent: TelegramMessage | null = null;
          try {
            sent = await telegram.sendMessageSingleStrict(
              telegramTopicSession
                ? {
                    chatId,
                    messageThreadId: space,
                    text,
                    parseMode,
                    replyMarkup,
                    priority,
                    forcePrimary: true,
                  }
                : {
                    chatId,
                    replyToMessageId: space,
                    text,
                    parseMode,
                    replyMarkup,
                    priority,
                    forcePrimary: true,
                  },
            );
          } catch {
            sent = await telegram.sendMessageSingleStrict({ chatId, text, parseMode, replyMarkup, priority, forcePrimary: true });
          }
          if (sent) trackTelegramMessage(sessionId, chatId, sent.message_id);
          messageSent = true;
          if (isFinal && !actionsDisabled) await attachReviewAndCommitButtonsToLastMessage(sessionId, session);
          return;
        }

        let sent: TelegramMessage | null = null;
        try {
          sent = await telegram.sendMessageStrict(
            telegramTopicSession
              ? { chatId, messageThreadId: space, text, replyMarkup, priority, forcePrimary: true }
              : { chatId, replyToMessageId: space, text, replyMarkup, priority, forcePrimary: true },
          );
        } catch {
          sent = await telegram.sendMessage({ chatId, text, replyMarkup, priority, forcePrimary: true });
        }
        if (sent) trackTelegramMessage(sessionId, chatId, sent.message_id);
        messageSent = true;
        if (isFinal && !actionsDisabled) await attachReviewAndCommitButtonsToLastMessage(sessionId, session);
        return;
      }

      if (session.platform === "slack") {
        if (!slack) return;
        const channel = session.chat_id;
        const threadTs = config.slack?.session_mode === "thread" ? session.space_id : undefined;
        const blocks = buildSlackButtons({
          sessionId,
          includeKill: includeKillButton,
          includeReview: includeReviewButton,
          includeCommit: includeCommitButton,
          includeStopSandbox: false,
        });
        const posted = await slack.postMessageDetailed({ channel, thread_ts: threadTs, text, blocks, blocksOnLastChunk: false });
        if (posted.lastTs && posted.lastText !== null) {
          lastSlackMessage.set(sessionId, { ts: posted.lastTs, text: posted.lastText });
        }
        messageSent = true;
        if (isFinal && !actionsDisabled) await attachReviewAndCommitButtonsToLastMessage(sessionId, session);
      }
    } finally {
      if (claimedFirst) {
        firstMessageSending.delete(sessionId);
        if (messageSent) firstMessageSent.add(sessionId);
      }
    }
  };

  const streamer = new JsonlStreamer(config, db, logger, sendToSession, playwrightMcp);
  streamer.start();

  const cloudManager = config.cloud?.enabled ? new CloudManager(config, db, logger, null) : null;
  const sessionManager = new SessionManager(
    config,
    db,
    logger,
    sendToSession,
    async (id) => streamer.drainSession(id),
    playwrightMcp,
    cloudManager ? async (sessionId, status) => cloudManager.handleSessionFinished(sessionId, status) : undefined,
  );
  if (cloudManager) cloudManager.attachSessionManager(sessionManager);
  if (cloudManager) await cloudManager.start();
  await sessionManager.reconcileStaleSessions();
  const controller = new BotController(
    config,
    db,
    logger,
    sessionManager,
    telegram,
    slack,
    sendToSession,
    reviewCommitDisabled,
    cloudManager,
    commitProposalStore,
    telegram
      ? (chatId, messageId) => telegramMessageToSession.get(telegramMessageKey(chatId, messageId)) ?? null
      : null,
  );

  const extractUiToken = (req: http.IncomingMessage, url: URL): string | null => {
    const header = readHeader(req, "authorization");
    if (header && header.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
    const fromQuery = url.searchParams.get("token");
    return fromQuery && fromQuery.length > 0 ? fromQuery : null;
  };

  const requireUiAuth = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): UiTokenPayload | null => {
    if (!uiConfig || !uiConfig.token_secret) {
      sendText(res, 503, "UI auth not configured");
      return null;
    }
    const token = extractUiToken(req, url);
    if (!token) {
      sendText(res, 401, "missing token");
      return null;
    }
    const payload = verifyUiToken(uiConfig, token);
    if (!payload) {
      sendText(res, 401, "invalid token");
      return null;
    }
    return payload;
  };

  const requireRunAccess = async (
    payload: UiTokenPayload,
    runId: string,
    res: http.ServerResponse,
  ): Promise<Awaited<ReturnType<typeof getCloudRun>> | null> => {
    const run = await getCloudRun(db, runId);
    if (!run) {
      sendText(res, 404, "run not found");
      return null;
    }
    if (payload.scope === "run" && payload.run_id !== runId) {
      sendText(res, 403, "forbidden");
      return null;
    }
    if (payload.scope === "identity" && payload.identity_id !== run.identity_id) {
      sendText(res, 403, "forbidden");
      return null;
    }
    return run;
  };

  const resolveRunLogFiles = async (sessionId: string, session: { agent: string; codex_cwd: string; codex_session_id: string | null }) => {
    if (config.cloud?.workspaces_dir) {
      const logsDir = path.join(config.cloud.workspaces_dir, "logs", sessionId);
      const fromLogs = await listJsonlFiles(logsDir);
      if (fromLogs.length > 0) return fromLogs;
    }
    if (!session.codex_session_id) return [];
    const adapter = getAgentAdapter(session.agent as any);
    const sessionsRoot = adapter.resolveSessionsRoot(session.codex_cwd, config);
    const homeDir = adapter.resolveHomeDir(sessionsRoot);
    return await adapter.findSessionJsonlFiles({
      sessionsRoot,
      homeDir,
      cwd: session.codex_cwd,
      sessionId: session.codex_session_id,
      timeoutMs: 2_000,
      pollMs: 200,
    });
  };

  if (telegram && config.telegram?.mode === "poll") {
    logger.info(
      `Telegram polling enabled (timeout=${config.telegram.poll_timeout_seconds}s rate=${config.telegram.rate_limit_msgs_per_sec} msg/s)`,
    );
    let offset: number | undefined;
    (async () => {
      while (true) {
        try {
          const updates = await telegram.getUpdates({ offset });
          for (const update of updates) {
            offset = update.update_id + 1;
            queue.enqueue(async () => {
              try {
                await controller.handleTelegramUpdate(update);
              } catch (e) {
                logger.error("Telegram poll handler error", e);
              }
            });
          }
        } catch (e) {
          logger.error("Telegram poll error", e);
          await sleep(1000);
        }
      }
    })().catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.method) {
      sendText(res, 400, "bad request");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? `${config.bot.host}:${config.bot.port}`}`);
    const pathname = url.pathname;

    try {
      if (req.method === "GET" && pathname === "/healthz") {
        sendText(res, 200, "ok");
        return;
      }

      const pathParts = pathname.split("/").filter(Boolean);
      if (pathParts[0] === "api" && pathParts[1] === "cloud" && pathParts[2] === "agent") {
        if (req.method !== "POST" || pathParts[3] !== "logs") {
          sendText(res, 404, "not found");
          return;
        }
        if (!cloudManager || !config.cloud?.enabled) {
          sendText(res, 404, "cloud not enabled");
          return;
        }
        const sessionId = pathParts[4] ?? "";
        if (!sessionId) {
          sendText(res, 400, "missing session id");
          return;
        }
        const authHeader = readHeader(req, "authorization");
        const tokenHeader = readHeader(req, "x-tintin-agent-token");
        const token =
          authHeader && authHeader.toLowerCase().startsWith("bearer ")
            ? authHeader.slice("bearer ".length).trim()
            : tokenHeader ?? "";
        if (!token || !cloudManager.verifyAgentToken(sessionId, token)) {
          sendText(res, 403, "forbidden");
          return;
        }
        const payload = await readRequestBody(req);
        if (!payload) {
          sendText(res, 204, "ok");
          return;
        }
        const logPath = await cloudManager.getOrCreateAgentLogPath(sessionId);
        if (!logPath) {
          sendText(res, 500, "log path unavailable");
          return;
        }
        await appendFile(logPath, payload);
        sendText(res, 200, "ok");
        return;
      }

      if (pathParts[0] === "api" && pathParts[1] === "cloud") {
        const payload = requireUiAuth(req, res, url);
        if (!payload) return;

        if (pathParts[2] === "secrets") {
          if (payload.scope !== "identity") {
            sendText(res, 403, "identity token required");
            return;
          }
          if (!config.cloud?.secrets_key) {
            sendText(res, 503, "secrets not configured");
            return;
          }
          if (req.method === "GET" && pathParts.length === 3) {
            const secrets = await listSecrets(db, payload.identity_id);
            sendJson(res, 200, { secrets });
            return;
          }
          if (req.method === "POST" && pathParts.length === 3) {
            const rawBody = await readRequestBody(req);
            let parsed: any = {};
            if (rawBody && rawBody.trim().length > 0) {
              try {
                parsed = JSON.parse(rawBody);
              } catch {
                sendText(res, 400, "invalid json");
                return;
              }
            }
            const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
            const valueRaw = typeof parsed.value === "string" ? parsed.value : "";
            const value = valueRaw.trim();
            const modeRaw = typeof parsed.mode === "string" ? parsed.mode.toLowerCase() : "set";
            if (!name) {
              sendText(res, 400, "missing name");
              return;
            }
            if (!value) {
              sendText(res, 400, "missing value");
              return;
            }
            if (!["set", "create", "update"].includes(modeRaw)) {
              sendText(res, 400, "invalid mode");
              return;
            }
            const existing = await getSecret(db, payload.identity_id, name);
            if (modeRaw === "create" && existing) {
              sendText(res, 409, "secret already exists");
              return;
            }
            if (modeRaw === "update" && !existing) {
              sendText(res, 404, "secret not found");
              return;
            }
            const encrypted = encryptSecret(value, config.cloud.secrets_key);
            await setSecret(db, { identityId: payload.identity_id, name, encryptedValue: encrypted });
            sendJson(res, existing ? 200 : 201, { status: existing ? "updated" : "created" });
            return;
          }
          if (req.method === "DELETE" && pathParts.length === 4) {
            let name = pathParts[3] ?? "";
            try {
              name = decodeURIComponent(name);
            } catch {
              // keep raw
            }
            if (!name) {
              sendText(res, 400, "missing name");
              return;
            }
            const deleted = await deleteSecret(db, payload.identity_id, name);
            sendJson(res, 200, { deleted });
            return;
          }
        }

        if (req.method === "GET" && pathParts[2] === "runs" && pathParts.length === 3) {
          if (payload.scope === "run") {
            const run = await getCloudRun(db, payload.run_id);
            if (!run) {
              sendJson(res, 200, { runs: [], nextCursor: null });
              return;
            }
            sendJson(res, 200, { runs: [run], nextCursor: null });
            return;
          }
          const limitRaw = url.searchParams.get("limit");
          const cursorRaw = url.searchParams.get("cursor");
          const limit = limitRaw ? Number(limitRaw) : undefined;
          const before = cursorRaw ? Number(cursorRaw) : undefined;
          const runs = await listCloudRunsForIdentity(db, {
            identityId: payload.identity_id,
            limit: Number.isFinite(limit) ? limit : undefined,
            before: Number.isFinite(before) ? before : undefined,
          });
          const nextCursor = runs.length > 0 ? runs[runs.length - 1]!.created_at : null;
          sendJson(res, 200, { runs, nextCursor });
          return;
        }

        if (req.method === "GET" && pathParts[2] === "runs" && pathParts.length >= 4) {
          const runId = pathParts[3] ?? "";
          if (!runId) {
            sendText(res, 400, "missing run id");
            return;
          }

          if (pathParts[4] === "events") {
            const run = await requireRunAccess(payload, runId, res);
            if (!run) return;
            if (!run.session_id) {
              sendText(res, 404, "run has no session");
              return;
            }
            const session = await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst();
            if (!session) {
              sendText(res, 404, "session not found");
              return;
            }
            const once = url.searchParams.get("once") === "1";
            const pollRaw = url.searchParams.get("poll");
            const pollParsed = pollRaw ? Number(pollRaw) : NaN;
            const pollMs =
              Number.isFinite(pollParsed) && pollParsed > 0
                ? Math.max(50, Math.min(Math.floor(pollParsed), 2000))
                : 500;

            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
            });
            res.flushHeaders();
            sendSse(res, { ok: true }, "ready");

            let closed = false;
            req.on("close", () => {
              closed = true;
            });

            const offsets = new Map<string, number>();
            while (!closed) {
              let hadNew = false;
              const files = await resolveRunLogFiles(run.session_id, session);
              for (const file of files) {
                const prevOffset = offsets.get(file) ?? 0;
                const { lines, newOffset } = await readNewJsonlLines(file, prevOffset);
                if (lines.length === 0) {
                  offsets.set(file, newOffset);
                  continue;
                }
                offsets.set(file, newOffset);
                hadNew = true;
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  let obj: unknown;
                  try {
                    obj = JSON.parse(trimmed);
                  } catch {
                    continue;
                  }
                  const fragments = mapEventToFragments(session.agent, obj, {
                    includeUserMessages: true,
                    verbosity: 3,
                  });
                  for (const frag of fragments) {
                    if (frag.kind === "final") continue;
                    if (frag.kind === "plan_update") {
                      sendSse(res, { kind: "plan_update", plan: frag.plan, explanation: frag.explanation });
                      continue;
                    }
                    sendSse(res, frag);
                  }
                }
              }
              if (once && !hadNew) {
                const current = await db
                  .selectFrom("sessions")
                  .select(["status"])
                  .where("id", "=", run.session_id)
                  .executeTakeFirst();
                if (!current || (current.status !== "running" && current.status !== "starting")) break;
              }
              await sleep(pollMs);
            }
            res.end();
            return;
          }

          if (pathParts[4] === "artifacts") {
            const run = await requireRunAccess(payload, runId, res);
            if (!run) return;
            if (!run.session_id) {
              sendJson(res, 200, { diffs: [], commands: [] });
              return;
            }
            const session = await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst();
            if (!session) {
              sendJson(res, 200, { diffs: [], commands: [] });
              return;
            }
            const files = await resolveRunLogFiles(run.session_id, session);
            let baselineResolver: ((filePath: string) => Promise<string | null>) | undefined;
            if (config.cloud?.provider === "local" && config.cloud?.workspaces_dir) {
              let root: string | null = null;
              if (run.snapshot_id) {
                root = path.join(config.cloud.workspaces_dir, "snapshots", run.snapshot_id);
              } else if (run.workspace_id) {
                root = path.join(config.cloud.workspaces_dir, run.workspace_id);
              }
              if (root) {
                const mount = run.primary_repo_id
                  ? await db
                      .selectFrom("cloud_run_repos")
                      .select(["mount_path"])
                      .where("run_id", "=", run.id)
                      .where("repo_id", "=", run.primary_repo_id)
                      .executeTakeFirst()
                  : null;
                const repoRoot = mount ? path.join(root, mount.mount_path) : root;
                baselineResolver = async (filePath: string) => {
                  const full = path.join(repoRoot, filePath);
                  if (!full.startsWith(repoRoot)) return null;
                  return await readFile(full, "utf8").catch(() => null);
                };
              }
            }
            const artifacts = await buildRunArtifactsFromJsonl(files, session.agent, {
              baselineResolver,
              fallbackPatch: run.diff_patch ?? null,
              fallbackTimestamp: run.finished_at ?? null,
            });
            sendJson(res, 200, artifacts);
            return;
          }

          if (pathParts.length === 4) {
            const run = await requireRunAccess(payload, runId, res);
            if (!run) return;
            const identity = await db.selectFrom("identities").selectAll().where("id", "=", run.identity_id).executeTakeFirst();
            const repos = await db
              .selectFrom("cloud_run_repos")
              .innerJoin("repos", "repos.id", "cloud_run_repos.repo_id")
              .select([
                "repos.id",
                "repos.name",
                "repos.url",
                "repos.default_branch",
                "cloud_run_repos.mount_path",
              ])
              .where("cloud_run_repos.run_id", "=", run.id)
              .execute();
            const session = run.session_id
              ? await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst()
              : null;
            sendJson(res, 200, { run, identity, repos, session });
            return;
          }
        }

        if (req.method === "GET" && pathParts[2] === "screenshots") {
          const runId = url.searchParams.get("runId") ?? "";
          if (!runId) {
            sendText(res, 400, "missing runId");
            return;
          }
          const run = await requireRunAccess(payload, runId, res);
          if (!run) return;
          if (!uiConfig || !uiConfig.s3_bucket || !uiConfig.s3_region) {
            sendText(res, 503, "S3 not configured");
            return;
          }
          const rows = await listCloudRunScreenshots(db, runId);
          const items = [];
          for (const row of rows) {
            try {
              const url = await signScreenshotUrl(uiConfig, row.s3_key);
              items.push({
                id: row.id,
                url,
                tool: row.tool,
                mime_type: row.mime_type,
                created_at: row.created_at,
              });
            } catch (e) {
              logger.warn(`sign screenshot failed id=${row.id}: ${String(e)}`);
            }
          }
          sendJson(res, 200, { screenshots: items });
          return;
        }
      }

      if (config.cloud?.proxy?.enabled) {
        if (pathname.startsWith(config.cloud.proxy.openai_path)) {
          await handleProxyRequest({
            req,
            res,
            config,
            db,
            logger,
            kind: "openai",
            pathPrefix: config.cloud.proxy.openai_path,
            url,
          });
          return;
        }
        if (pathname.startsWith(config.cloud.proxy.anthropic_path)) {
          await handleProxyRequest({
            req,
            res,
            config,
            db,
            logger,
            kind: "anthropic",
            pathPrefix: config.cloud.proxy.anthropic_path,
            url,
          });
          return;
        }
      }

      if (config.cloud?.enabled && req.method === "GET" && pathname === config.cloud.oauth.callback_path) {
        const installationId = url.searchParams.get("installation_id");
        const state = url.searchParams.get("state") ?? "";
        if (installationId) {
          if (!state) {
            sendText(res, 400, "Missing GitHub App state");
            return;
          }
          try {
            const result = await handleGithubAppCallback({ db, cloud: config.cloud, installationId, state });
            await notifyGithubConnected(result.metadataJson);
            sendText(res, 200, "Connected. Return to the chat.");
          } catch (e) {
            sendText(res, 400, `GitHub App connect failed: ${String(e)}`);
          }
          return;
        }
        const provider = url.searchParams.get("provider") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (!provider || !code || !state) {
          sendText(res, 400, "Missing OAuth parameters");
          return;
        }
        try {
          const result = await handleOAuthCallback({ db, cloud: config.cloud, provider, code, state });
          if (result.provider === "github") {
            await notifyGithubConnected(result.metadataJson);
          }
          sendText(res, 200, "Connected. Return to the chat.");
        } catch (e) {
          sendText(res, 400, `OAuth failed: ${String(e)}`);
        }
        return;
      }

      // Telegram webhook
      if (telegram && config.telegram?.mode === "webhook" && req.method === "POST" && pathname === config.telegram?.webhook_path) {
        const secretHeader = readHeader(req, "x-telegram-bot-api-secret-token");
        if (!secretHeader) {
          logger.warn("Telegram webhook unauthorized (missing secret header)");
          sendText(res, 401, "unauthorized");
          return;
        }
        if (secretHeader !== config.telegram?.webhook_secret_token) {
          logger.warn("Telegram webhook unauthorized (bad secret header)");
          sendText(res, 401, "unauthorized");
          return;
        }
        const bodyText = await readRequestBody(req);
        let body: any;
        try {
          body = JSON.parse(bodyText);
        } catch {
          logger.warn("Telegram webhook bad JSON");
          sendText(res, 400, "bad request");
          return;
        }
        const updateId = typeof body?.update_id === "number" ? body.update_id : "?";
        const keys = body && typeof body === "object" ? Object.keys(body).filter((k) => k !== "update_id").join(",") : "-";
        logger.debug(`[tg] webhook update_id=${updateId} keys=${keys}`);
        queue.enqueue(async () => {
          try {
            await controller.handleTelegramUpdate(body as any);
          } catch (e) {
            logger.error("Telegram update handler error", e);
          }
        });
        sendText(res, 200, "ok");
        return;
      }

      // Slack Events API
      if (slack && req.method === "POST" && pathname === config.slack?.events_path) {
        const bodyText = await readRequestBody(req);
        const ok = verifySlackSignature({
          signingSecret: config.slack!.signing_secret,
          timestampHeader: readHeader(req, "x-slack-request-timestamp"),
          signatureHeader: readHeader(req, "x-slack-signature"),
          body: bodyText,
        });
        if (!ok) {
          logger.warn("Slack events unauthorized (bad signature)");
          sendText(res, 401, "unauthorized");
          return;
        }
        const body = JSON.parse(bodyText) as any;
        if (body.type === "url_verification" && typeof body.challenge === "string") {
          sendJson(res, 200, { challenge: body.challenge });
          return;
        }
        const evType = body?.event?.type ?? body?.type ?? "?";
        logger.debug(`[slack] events type=${String(evType)}`);
        queue.enqueue(async () => {
          try {
            await controller.handleSlackEvent(body);
          } catch (e) {
            logger.error("Slack event handler error", e);
          }
        });
        sendText(res, 200, "ok");
        return;
      }

      // Slack Interactivity
      if (slack && req.method === "POST" && pathname === config.slack?.interactions_path) {
        const bodyText = await readRequestBody(req);
        const ok = verifySlackSignature({
          signingSecret: config.slack!.signing_secret,
          timestampHeader: readHeader(req, "x-slack-request-timestamp"),
          signatureHeader: readHeader(req, "x-slack-signature"),
          body: bodyText,
        });
        if (!ok) {
          logger.warn("Slack interactions unauthorized (bad signature)");
          sendText(res, 401, "unauthorized");
          return;
        }
        const params = new URLSearchParams(bodyText);
        const payloadRaw = params.get("payload");
        if (!payloadRaw) {
          sendText(res, 400, "bad request");
          return;
        }
        const payload = JSON.parse(payloadRaw) as any;

        // Respond quickly; do real work async.
        logger.debug(`[slack] interaction type=${String(payload?.type ?? "?")}`);
        queue.enqueue(async () => {
          try {
            await controller.handleSlackInteraction(payload);
          } catch (e) {
            logger.error("Slack interaction handler error", e);
          }
        });

        if (payload.type === "view_submission") {
          sendJson(res, 200, { response_action: "clear" });
          return;
        }
        sendText(res, 200, "");
        return;
      }

      if (uiConfig && req.method === "GET" && pathname.startsWith(uiConfig.path)) {
        const uiRoot = path.join(config.config_dir, "frontend", "dist");
        const relRaw = pathname.slice(uiConfig.path.length) || "/";
        const relPath = relRaw === "/" ? "/index.html" : relRaw;
        const filePath = path.join(uiRoot, relPath);
        if (!filePath.startsWith(uiRoot)) {
          sendText(res, 403, "forbidden");
          return;
        }
        let data: Buffer | null = null;
        let target = filePath;
        try {
          data = await readFile(filePath);
        } catch {
          try {
            target = path.join(uiRoot, "index.html");
            data = await readFile(target);
          } catch {
            data = null;
          }
        }
        if (!data) {
          sendText(res, 404, "not found");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", contentTypeForPath(target));
        res.end(data);
        return;
      }

      sendText(res, 404, "not found");
    } catch (err) {
      logger.error("HTTP handler error", err);
      sendText(res, 500, "internal error");
    }
  });

  return {
    async start() {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(config.bot.port, config.bot.host, () => {
          server.off("error", onError);
          logger.info(`Listening on http://${config.bot.host}:${config.bot.port}`);
          resolve();
        });
      });
    },
  };
}
