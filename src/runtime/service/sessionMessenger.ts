import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { SendToSessionFn, SessionMessage } from "../messaging.js";
import type { TelegramClient, TelegramMessage } from "../platform/telegram.js";
import type { SlackClient } from "../platform/slack.js";
import type { IMessagingPlatform, InteractiveMarkup } from "../platform/base.js";
import type { SessionRow } from "../store.js";
import type { WebSocketManager } from "../websocket/manager.js";
import type { ServerMessage } from "../websocket/types.js";
import { t, type UserLanguage } from "../../locales/index.js";
import { mergeTextIntoSlackBlocks } from "../message/slack.js";

type SessionLanguageResolver = (session: { language?: string | null }) => UserLanguage;

type SessionMessengerDeps = {
  config: AppConfig;
  db: Db;
  logger: Logger;
  telegram: TelegramClient | null;
  slack: SlackClient | null;
  getWsManager: () => WebSocketManager | null;
  isTelegramTopicSession: (session: { platform: string; space_emoji: string | null }) => boolean;
  resolveSessionLanguage: SessionLanguageResolver;
  getTelegramReplyMarkup: (markup?: InteractiveMarkup) => { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined;
  getSlackBlocks: (markup?: InteractiveMarkup) => unknown[] | undefined;
  maybeUploadScreenshot: (sessionId: string, message: { file: Buffer; filename: string; mimeType?: string; caption?: string }) => Promise<void>;
  maybeHandleCommitProposalMessage: (sessionId: string, message: SessionMessage) => Promise<boolean>;
  suppressFinalizeForSession: Set<string>;
  reviewCommitDisabled: Set<string>;
};

type SessionMessenger = {
  sendToSession: SendToSessionFn;
  lookupTelegramSessionId: (chatId: string | number, messageId: number) => string | null;
};

export function createSessionMessenger(deps: SessionMessengerDeps): SessionMessenger {
  const firstMessageSent = new Set<string>();
  const firstMessageSending = new Set<string>();
  const lastTelegramMessageId = new Map<string, number>();
  const telegramMessageToSession = new Map<string, string>();
  const lastSlackMessage = new Map<string, { ts: string; text: string }>();
  const planTelegramMessageId = new Map<string, number>();
  const planSlackMessageTs = new Map<string, string>();

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
    currentLang?: UserLanguage;
  }) => {
    const lang = opts.currentLang ?? "en";
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    const actionRow: Array<{ text: string; callback_data: string }> = [];
    if (opts.includeKill) actionRow.push({ text: t("button.stop", lang), callback_data: `kill:${opts.sessionId}` });
    if (opts.includeStopSandbox) {
      actionRow.push({ text: t("button.stop_sandbox", lang), callback_data: `stop_sandbox:${opts.sessionId}` });
    }
    if (opts.includeReview) actionRow.push({ text: t("button.review", lang), callback_data: `review:${opts.sessionId}` });
    if (opts.includeCommit) actionRow.push({ text: t("button.commit", lang), callback_data: `commit:${opts.sessionId}` });
    if (actionRow.length > 0) rows.push(actionRow);
    return rows.length > 0 ? { inline_keyboard: rows } : undefined;
  };

  const buildSlackButtons = (opts: {
    sessionId: string;
    includeKill: boolean;
    includeReview: boolean;
    includeCommit: boolean;
    includeStopSandbox: boolean;
    currentLang?: UserLanguage;
  }) => {
    const lang = opts.currentLang ?? "en";
    const elements: any[] = [];
    if (opts.includeKill) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: t("button.stop", lang) },
        style: "danger",
        action_id: "kill_session",
        value: opts.sessionId,
      });
    }
    if (opts.includeStopSandbox) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: t("button.stop_sandbox", lang) },
        style: "danger",
        action_id: "stop_sandbox",
        value: opts.sessionId,
      });
    }
    if (opts.includeReview) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: t("button.review", lang) },
        action_id: "review_session",
        value: opts.sessionId,
      });
    }
    if (opts.includeCommit) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: t("button.commit", lang) },
        action_id: "commit_session",
        value: opts.sessionId,
      });
    }
    return elements.length > 0 ? [{ type: "actions", elements }] : undefined;
  };

  const buildSessionActionMarkup = (
    platform: "telegram" | "slack",
    opts: {
      sessionId: string;
      includeKill: boolean;
      includeReview: boolean;
      includeCommit: boolean;
      includeStopSandbox: boolean;
      currentLang?: UserLanguage;
    },
  ): InteractiveMarkup | undefined => {
    if (platform === "telegram") {
      const replyMarkup = buildTelegramInlineKeyboard(opts);
      return replyMarkup ? { type: "inline_keyboard", payload: replyMarkup } : undefined;
    }
    const blocks = buildSlackButtons(opts);
    return blocks ? { type: "blocks", payload: blocks } : undefined;
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

  const sendSessionImage = async (opts: {
    sessionId: string;
    session: SessionRow;
    telegramTopicSession: boolean;
    message: Extract<SessionMessage, { type: "image" }>;
    caption: string;
    priority: "user" | "background";
  }) => {
    const platformClient: IMessagingPlatform | null =
      opts.session.platform === "telegram" ? deps.telegram : opts.session.platform === "slack" ? deps.slack : null;
    if (!platformClient) return;

    const isTelegram = opts.session.platform === "telegram";
    const workspaceId = opts.session.workspace_id ?? null;
    const threadId = isTelegram ? (opts.telegramTopicSession ? opts.session.space_id : undefined) : undefined;
    const replyToMessageId = isTelegram && !opts.telegramTopicSession ? opts.session.space_id : undefined;
    const uploadOpts = {
      chatId: opts.session.chat_id,
      threadId,
      replyToMessageId,
      filename: opts.message.filename,
      file: opts.message.file,
      mimeType: opts.message.mimeType,
      caption: opts.caption,
      priority: opts.priority,
      workspaceId,
    };

    let result: { messageId: string } | null = null;
    try {
      result = await platformClient.sendPhoto(uploadOpts);
    } catch {
      result = await platformClient.sendDocument(uploadOpts);
    }

    if (isTelegram && result?.messageId) {
      const chatId = Number(opts.session.chat_id);
      const messageId = Number(result.messageId);
      if (Number.isFinite(chatId) && Number.isFinite(messageId)) {
        // Do not update last text message pointer for media messages.
        telegramMessageToSession.set(telegramMessageKey(chatId, messageId), opts.sessionId);
      }
    }
  };

  const sendSessionCompleteNotice = async (opts: {
    sessionId: string;
    session: {
      platform: string;
      chat_id: string;
      space_id: string;
      space_emoji: string | null;
      project_id: string | null;
      language?: string | null;
      workspace_id?: string | null;
    };
    actionsDisabled: boolean;
  }) => {
    const { sessionId, session, actionsDisabled } = opts;
    const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
    const lang = deps.resolveSessionLanguage(session);
    const text = t("session.complete", lang);

    if (session.platform === "telegram") {
      if (!deps.telegram) return;
      const chatId = Number(session.chat_id);
      const space = Number(session.space_id);
      if (Number.isNaN(chatId) || Number.isNaN(space)) return;
      const markup = buildSessionActionMarkup("telegram", {
        sessionId,
        includeKill: false,
        includeReview: !actionsDisabled,
        includeCommit: !actionsDisabled,
        includeStopSandbox: !actionsDisabled && isCloudSession,
        currentLang: lang,
      });
      const replyMarkup = deps.getTelegramReplyMarkup(markup);
      const messageId = lastTelegramMessageId.get(sessionId);
      if (!messageId) {
        return;
      }
      try {
        await deps.telegram.editMessageReplyMarkup({
          chatId,
          messageId,
          replyMarkup,
          priority: "user",
        });
      } catch {
        return;
      }
      return;
    }

    if (session.platform === "slack") {
      if (!deps.slack) return;
      const channel = session.chat_id;
      const threadTs = undefined;
      const workspaceId = session.workspace_id ?? null;
      const markup = buildSessionActionMarkup("slack", {
        sessionId,
        includeKill: false,
        includeReview: !actionsDisabled,
        includeCommit: !actionsDisabled,
        includeStopSandbox: !actionsDisabled && isCloudSession,
        currentLang: lang,
      });
      const last = lastSlackMessage.get(sessionId);
      if (last) {
        const blocks = buildSlackBlocksWithText(last.text, deps.getSlackBlocks(markup));
        try {
          await deps.slack.updateMessage({ channel, ts: last.ts, text: last.text, blocks, workspaceId });
          return;
        } catch {
          return;
        }
      }
    }
  };

  const escapeHtml = (input: string): string => {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  const buildSlackBlocksWithText = (text: string, blocks?: unknown[]): unknown[] | undefined => {
    return mergeTextIntoSlackBlocks(text, blocks);
  };

  const normalizePlanStatus = (raw: string): "pending" | "in_progress" | "completed" => {
    const s = raw.trim().toLowerCase();
    if (s === "completed" || s === "done" || s === "finished") return "completed";
    if (s === "in_progress" || s === "in progress" || s === "active" || s === "running") return "in_progress";
    return "pending";
  };

  const formatPlanMessageTelegramHtml = (opts: {
    lang: UserLanguage;
    plan: Array<{ step: string; status: string }>;
    explanation?: string;
  }): string => {
    const maxChars = deps.config.telegram?.max_chars ?? 4096;
    const header = `<b>${escapeHtml(t("plan.title", opts.lang))}</b>`;
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
    const trailer = `<i>${escapeHtml(t("plan.truncated", opts.lang))}</i>`;
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

  const formatPlanMessageSlack = (opts: {
    lang: UserLanguage;
    plan: Array<{ step: string; status: string }>;
    explanation?: string;
  }): string => {
    const maxChars = deps.config.slack?.max_chars ?? 3000;
    const explanation = (opts.explanation ?? "").trim();
    const lines: string[] = [`*${t("plan.title", opts.lang)}*`];
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
    const trailer = t("plan.truncated", opts.lang);
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
    session: {
      platform: string;
      chat_id: string;
      space_id: string;
      space_emoji: string | null;
      workspace_id?: string | null;
    },
    lang: UserLanguage,
    plan: Array<{ step: string; status: string }>,
    explanation?: string,
  ) => {
    if (session.platform === "telegram") {
      if (!deps.telegram) return;
      const chatId = Number(session.chat_id);
      const space = Number(session.space_id);
      if (Number.isNaN(chatId) || Number.isNaN(space)) return;
      const text = formatPlanMessageTelegramHtml({ plan, explanation, lang });
      const existing = planTelegramMessageId.get(sessionId);
      if (existing) {
        try {
          await deps.telegram.editMessageText({
            chatId,
            messageId: existing,
            text,
            parseMode: "HTML",
            priority: "user",
          });
          return;
        } catch {
          planTelegramMessageId.delete(sessionId);
        }
      }

      try {
        const sent = await deps.telegram.sendMessageSingleStrict(
          deps.isTelegramTopicSession(session)
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
          // Do not update last text message pointer for plan updates.
          telegramMessageToSession.set(telegramMessageKey(chatId, sent.message_id), sessionId);
        }
      } catch {
        // Ignore plan send failures.
      }
      return;
    }

    if (session.platform === "slack") {
      if (!deps.slack) return;
      const channel = session.chat_id;
      const threadTs = undefined;
      const workspaceId = session.workspace_id ?? null;
      const text = formatPlanMessageSlack({ plan, explanation, lang });
      const existing = planSlackMessageTs.get(sessionId);
      if (existing) {
        try {
          await deps.slack.updateMessage({ channel, ts: existing, text, workspaceId });
          return;
        } catch {
          planSlackMessageTs.delete(sessionId);
        }
      }
      try {
        const posted = await deps.slack.postMessageDetailed({
          channel,
          thread_ts: threadTs,
          text,
          blocksOnLastChunk: false,
          priority: "user",
          workspaceId,
        });
        if (posted.lastTs) planSlackMessageTs.set(sessionId, posted.lastTs);
      } catch {
        // Ignore plan send failures.
      }
    }
  };

  const sendToSession: SendToSessionFn = async (sessionId, message) => {
    const session = await deps.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
    if (!session) return;
    const lang = deps.resolveSessionLanguage(session);

    const wsManager = deps.getWsManager();
    if (wsManager?.hasSubscribers(sessionId)) {
      let wsMessage: ServerMessage | null = null;
      if (message.type === "finalize") {
        wsMessage = { type: "done", sessionId };
      } else if (message.type === "plan_update") {
        wsMessage = {
          type: "plan_update",
          sessionId,
          plan: message.plan.map((p) => ({ step: p.step, status: p.status as any })),
          explanation: message.explanation,
        };
      } else if (message.type === "image") {
        wsMessage = {
          type: "tool_output",
          sessionId,
          name: "screenshot",
          output: message.caption ?? message.filename,
        };
      } else if (typeof message.text === "string") {
        wsMessage = { type: "chunk", sessionId, content: message.text };
        if (message.final) {
          wsManager.broadcastToSession(sessionId, wsMessage);
          wsMessage = { type: "done", sessionId };
        }
      }
      if (wsMessage) {
        wsManager.broadcastToSession(sessionId, wsMessage);
      }
    }

    if (session.platform === "websocket") {
      return;
    }

    const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
    const handledCommitProposal = await deps.maybeHandleCommitProposalMessage(sessionId, message);
    if (handledCommitProposal) return;
    const actionsDisabled = deps.reviewCommitDisabled.has(sessionId);
    const telegramTopicSession = deps.isTelegramTopicSession(session);
    if (message.type === "finalize") {
      if (deps.suppressFinalizeForSession.has(sessionId)) {
        deps.suppressFinalizeForSession.delete(sessionId);
        return;
      }
      await sendSessionCompleteNotice({ sessionId, session, actionsDisabled });
      return;
    }
    if (message.type === "plan_update") {
      await upsertPlanMessage(sessionId, session, lang, message.plan, message.explanation);
      return;
    }
    if (message.type === "image") {
      const caption = message.caption ?? t("image.playwright_screenshot", lang);
      const priority = message.priority ?? "user";
      void deps.maybeUploadScreenshot(sessionId, {
        file: message.file,
        filename: message.filename,
        mimeType: message.mimeType,
        caption,
      }).catch((e) => deps.logger.warn(`screenshot upload failed session=${sessionId}: ${String(e)}`));
      try {
        await sendSessionImage({ sessionId, session, telegramTopicSession, message, caption, priority });
        return;
      } catch (e) {
        deps.logger.warn(`send image failed session=${sessionId}: ${String(e)}`);
      }
      await sendToSession(sessionId, { text: `${caption}\n${t("image.saved_at", lang, { path: message.path })}`, priority: "user" });
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
        if (deps.suppressFinalizeForSession.has(sessionId)) {
          deps.suppressFinalizeForSession.delete(sessionId);
          messageSent = true;
          return;
        }
        await sendSessionCompleteNotice({ sessionId, session, actionsDisabled });
        messageSent = true;
        return;
      }

      if (session.platform === "telegram") {
        if (!deps.telegram) return;
        const chatId = Number(session.chat_id);
        const space = Number(session.space_id);
        if (Number.isNaN(chatId) || Number.isNaN(space)) return;
        const priority = message.priority ?? "background";
        const markup = buildSessionActionMarkup("telegram", {
          sessionId,
          includeKill: includeKillButton,
          includeReview: includeReviewButton,
          includeCommit: includeCommitButton,
          includeStopSandbox: false,
          currentLang: lang,
        });
        const replyMarkup = deps.getTelegramReplyMarkup(markup);

        if (isFencedCodeBlock(text)) {
          const parseMode = "Markdown" as const;
          let sent: TelegramMessage | null = null;
          try {
            sent = await deps.telegram.sendMessageSingleStrict(
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
            sent = await deps.telegram.sendMessageSingleStrict({ chatId, text, parseMode, replyMarkup, priority, forcePrimary: true });
          }
          if (sent) trackTelegramMessage(sessionId, chatId, sent.message_id);
          messageSent = true;
          return;
        }

        let sent: TelegramMessage | null = null;
        try {
          sent = await deps.telegram.sendMessageStrict(
            telegramTopicSession
              ? { chatId, messageThreadId: space, text, replyMarkup, priority, forcePrimary: true }
              : { chatId, replyToMessageId: space, text, replyMarkup, priority, forcePrimary: true },
          );
        } catch {
          sent = await deps.telegram.sendMessage({ chatId, text, replyMarkup, priority, forcePrimary: true });
        }
        if (sent) {
          trackTelegramMessage(sessionId, chatId, sent.message_id);
          if (isFinal) {
            deps.suppressFinalizeForSession.add(sessionId);
            await sendSessionCompleteNotice({ sessionId, session, actionsDisabled });
          }
        }
        messageSent = true;
        return;
      }

      if (session.platform === "slack") {
        if (!deps.slack) return;
        const channel = session.chat_id;
        const threadTs = undefined;
        const workspaceId = session.workspace_id ?? null;
        const priority = message.priority ?? "background";
        const markup = buildSessionActionMarkup("slack", {
          sessionId,
          includeKill: includeKillButton,
          includeReview: includeReviewButton,
          includeCommit: includeCommitButton,
          includeStopSandbox: false,
          currentLang: lang,
        });
        const blocks = buildSlackBlocksWithText(text, deps.getSlackBlocks(markup));
        try {
          const posted = await deps.slack.postMessageDetailed({
            channel,
            thread_ts: threadTs,
            text,
            blocks,
            blocksOnLastChunk: false,
            priority,
            workspaceId,
          });
          if (posted.lastTs && posted.lastText !== null) {
            lastSlackMessage.set(sessionId, { ts: posted.lastTs, text: posted.lastText });
          }
          deps.logger.debug(`[session][slack] posted message session=${sessionId} ts=${posted.lastTs ?? "?"}`);
          if (isFinal) {
            deps.suppressFinalizeForSession.add(sessionId);
            await sendSessionCompleteNotice({ sessionId, session, actionsDisabled });
          }
          messageSent = true;
        } catch (e) {
          deps.logger.warn(`[session][slack] post failed session=${sessionId}: ${String(e)}`);
          if (blocks) {
            try {
              const posted = await deps.slack.postMessageDetailed({
                channel,
                thread_ts: threadTs,
                text,
                blocks: undefined,
                blocksOnLastChunk: false,
                priority,
                workspaceId,
              });
              if (posted.lastTs && posted.lastText !== null) {
                lastSlackMessage.set(sessionId, { ts: posted.lastTs, text: posted.lastText });
              }
              deps.logger.debug(
                `[session][slack] posted message without blocks session=${sessionId} ts=${posted.lastTs ?? "?"}`,
              );
              if (isFinal) {
                deps.suppressFinalizeForSession.add(sessionId);
                await sendSessionCompleteNotice({ sessionId, session, actionsDisabled });
              }
              messageSent = true;
            } catch (err) {
              deps.logger.error(`[session][slack] post without blocks failed session=${sessionId}: ${String(err)}`);
            }
          }
        }
      }
    } finally {
      if (claimedFirst) {
        firstMessageSending.delete(sessionId);
        if (messageSent) firstMessageSent.add(sessionId);
      }
    }
  };

  return {
    sendToSession,
    lookupTelegramSessionId: (chatId, messageId) => telegramMessageToSession.get(telegramMessageKey(chatId, messageId)) ?? null,
  };
}
