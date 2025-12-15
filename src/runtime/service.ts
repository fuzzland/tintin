import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { sleep, TaskQueue } from "./util.js";
import { TelegramClient } from "./platform/telegram.js";
import { SlackClient, verifySlackSignature } from "./platform/slack.js";
import { BotController } from "./controller2.js";
import { JsonlStreamer } from "./streamer.js";
import { SessionManager } from "./sessionManager.js";
import type { SendToSessionFn } from "./messaging.js";
import type { TelegramMessage } from "./platform/telegram.js";
import http from "node:http";
import { PlaywrightMcpManager } from "./playwrightMcp.js";

export interface BotServiceDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
}

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

export async function createBotService(deps: BotServiceDeps) {
  const { config, db, logger } = deps;

  const queue = new TaskQueue(16);
  const firstMessageSent = new Set<string>();
  const firstMessageSending = new Set<string>();
  const reviewCommitDisabled = new Set<string>();
  const lastTelegramMessageId = new Map<string, number>();
  const lastSlackMessage = new Map<string, { ts: string; text: string }>();
  const planTelegramMessageId = new Map<string, number>();
  const planSlackMessageTs = new Map<string, string>();

  const telegram = config.telegram ? new TelegramClient(config.telegram, logger) : null;
  const slack = config.slack ? new SlackClient(config.slack, logger) : null;
  const playwrightMcp = config.playwright_mcp?.enabled ? new PlaywrightMcpManager(config.playwright_mcp, logger) : null;

  if (telegram) await telegram.init();
  if (playwrightMcp) {
    process.once("exit", () => void playwrightMcp.stop());
    process.once("SIGINT", () => void playwrightMcp.stop());
    process.once("SIGTERM", () => void playwrightMcp.stop());
  }

  const isFencedCodeBlock = (text: string): boolean => {
    const t = text.trim();
    return t.startsWith("```") && t.endsWith("```");
  };

  const buildTelegramInlineKeyboard = (opts: { sessionId: string; includeKill: boolean; includeReview: boolean; includeCommit: boolean }) => {
    const row: Array<{ text: string; callback_data: string }> = [];
    if (opts.includeKill) row.push({ text: "Stop", callback_data: `kill:${opts.sessionId}` });
    if (opts.includeReview) row.push({ text: "Review", callback_data: `review:${opts.sessionId}` });
    if (opts.includeCommit) row.push({ text: "Commit", callback_data: `commit:${opts.sessionId}` });
    return row.length > 0 ? { inline_keyboard: [row] } : undefined;
  };

  const buildSlackButtons = (opts: { sessionId: string; includeKill: boolean; includeReview: boolean; includeCommit: boolean }) => {
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

  const attachReviewAndCommitButtonsToLastMessage = async (sessionId: string, session: { platform: string; chat_id: string }) => {
    if (session.platform === "telegram") {
      if (!telegram) return false;
      const chatId = Number(session.chat_id);
      const messageId = lastTelegramMessageId.get(sessionId);
      if (!messageId || Number.isNaN(chatId)) return false;
      try {
        await telegram.editMessageReplyMarkup({
          chatId,
          messageId,
          replyMarkup: buildTelegramInlineKeyboard({ sessionId, includeKill: false, includeReview: true, includeCommit: true }),
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
          blocks: buildSlackButtons({ sessionId, includeKill: false, includeReview: true, includeCommit: true }),
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
    session: { platform: string; chat_id: string; space_id: string },
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
        let sent: TelegramMessage | null = null;
        if (config.telegram?.use_topics) {
          try {
            sent = await telegram.sendMessageSingleStrict({
              chatId,
              messageThreadId: space,
              text,
              parseMode: "HTML",
              priority: "user",
              forcePrimary: true,
            });
          } catch {
            sent = await telegram.sendMessageSingleStrict({
              chatId,
              replyToMessageId: space,
              text,
              parseMode: "HTML",
              priority: "user",
              forcePrimary: true,
            });
          }
        } else {
          sent = await telegram.sendMessageSingleStrict({
            chatId,
            replyToMessageId: space,
            text,
            parseMode: "HTML",
            priority: "user",
            forcePrimary: true,
          });
        }
        if (sent) planTelegramMessageId.set(sessionId, sent.message_id);
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
    const actionsDisabled = reviewCommitDisabled.has(sessionId);
    if (message.type === "plan_update") {
      await upsertPlanMessage(sessionId, session, message.plan, message.explanation);
      return;
    }
    if (message.type === "image") {
      const caption = message.caption ?? `Playwright screenshot: ${message.path}`;
      const priority = message.priority ?? "user";
      try {
        if (session.platform === "telegram") {
          if (!telegram) return;
          const chatId = Number(session.chat_id);
          const space = Number(session.space_id);
          if (Number.isNaN(chatId) || Number.isNaN(space)) return;
          const send = async (opts: { messageThreadId?: number; replyToMessageId?: number }) => {
            try {
              await telegram.sendPhoto({
                chatId,
                messageThreadId: opts.messageThreadId,
                replyToMessageId: opts.replyToMessageId,
                filename: message.filename,
                file: message.file,
                mimeType: message.mimeType,
                caption,
                priority,
              });
            } catch {
              await telegram.sendDocument({
                chatId,
                messageThreadId: opts.messageThreadId,
                replyToMessageId: opts.replyToMessageId,
                filename: message.filename,
                file: message.file,
                mimeType: message.mimeType,
                caption,
                priority,
              });
            }
          };
          if (config.telegram?.use_topics) {
            try {
              await send({ messageThreadId: space });
            } catch {
              await send({ replyToMessageId: space });
            }
          } else {
            await send({ replyToMessageId: space });
          }
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
      (session.status === "starting" || session.status === "running") &&
      !(session.platform === "telegram" && config.telegram?.use_topics);
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
            : buildTelegramInlineKeyboard({ sessionId, includeKill: false, includeReview: true, includeCommit: true });
          const priority = "user" as const;
          try {
            if (config.telegram?.use_topics) {
              try {
                const sent = await telegram.sendMessageSingleStrict({
                  chatId,
                  messageThreadId: space,
                  text: fallbackText,
                  replyMarkup,
                  priority,
                  forcePrimary: true,
                });
                lastTelegramMessageId.set(sessionId, sent.message_id);
              } catch {
                const sent = await telegram.sendMessageSingleStrict({
                  chatId,
                  replyToMessageId: space,
                  text: fallbackText,
                  replyMarkup,
                  priority,
                  forcePrimary: true,
                });
                lastTelegramMessageId.set(sessionId, sent.message_id);
              }
            } else {
              const sent = await telegram.sendMessageSingleStrict({
                chatId,
                replyToMessageId: space,
                text: fallbackText,
                replyMarkup,
                priority,
                forcePrimary: true,
              });
              lastTelegramMessageId.set(sessionId, sent.message_id);
            }
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
                : buildSlackButtons({ sessionId, includeKill: false, includeReview: true, includeCommit: true }),
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
        });

        if (isFencedCodeBlock(text)) {
          const parseMode = "Markdown" as const;
          let sent: TelegramMessage | null = null;
          if (config.telegram?.use_topics) {
            try {
              sent = await telegram.sendMessageSingleStrict({
                chatId,
                messageThreadId: space,
                text,
                parseMode,
                replyMarkup,
                priority,
                forcePrimary: true,
              });
            } catch {
              try {
                sent = await telegram.sendMessageSingleStrict({
                  chatId,
                  replyToMessageId: space,
                  text,
                  parseMode,
                  replyMarkup,
                  priority,
                  forcePrimary: true,
                });
              } catch {
                sent = await telegram.sendMessageSingleStrict({
                  chatId,
                  text,
                  parseMode,
                  replyMarkup,
                  priority,
                  forcePrimary: true,
                });
              }
            }
          } else {
            try {
              sent = await telegram.sendMessageSingleStrict({
                chatId,
                replyToMessageId: space,
                text,
                parseMode,
                replyMarkup,
                priority,
                forcePrimary: true,
              });
            } catch {
              sent = await telegram.sendMessageSingleStrict({
                chatId,
                text,
                parseMode,
                replyMarkup,
                priority,
                forcePrimary: true,
              });
            }
          }
          if (sent) lastTelegramMessageId.set(sessionId, sent.message_id);
          messageSent = true;
          if (isFinal && !actionsDisabled) await attachReviewAndCommitButtonsToLastMessage(sessionId, session);
          return;
        }

        let sent: TelegramMessage | null = null;
        if (config.telegram?.use_topics) {
          try {
            sent = await telegram.sendMessageStrict({
              chatId,
              messageThreadId: space,
              text,
              replyMarkup,
              priority,
              forcePrimary: true,
            });
          } catch {
            try {
              sent = await telegram.sendMessageStrict({
                chatId,
                replyToMessageId: space,
                text,
                replyMarkup,
                priority,
                forcePrimary: true,
              });
            } catch {
              sent = await telegram.sendMessage({ chatId, text, replyMarkup, priority, forcePrimary: true });
            }
          }
        } else {
          try {
            sent = await telegram.sendMessageStrict({
              chatId,
              replyToMessageId: space,
              text,
              replyMarkup,
              priority,
              forcePrimary: true,
            });
          } catch {
            sent = await telegram.sendMessage({ chatId, text, replyMarkup, priority, forcePrimary: true });
          }
        }
        if (sent) lastTelegramMessageId.set(sessionId, sent.message_id);
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

  const sessionManager = new SessionManager(
    config,
    db,
    logger,
    sendToSession,
    async (id) => streamer.drainSession(id),
    playwrightMcp,
  );
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
  );

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
