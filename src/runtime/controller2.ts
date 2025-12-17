import type { AppConfig, ProjectEntry } from "./config.js";
import type { Db } from "./db.js";
import type { SessionStatus } from "./db.js";
import type { Logger } from "./log.js";
import type { SessionManager } from "./sessionManager.js";
import { generateCodexTitle } from "./codex.js";
import {
  TelegramClient,
  type TelegramCallbackQuery,
  type TelegramChat,
  type TelegramMessage,
  type TelegramMessageEntity,
  type TelegramUpdate,
} from "./platform/telegram.js";
import { SlackClient } from "./platform/slack.js";
import { redactText } from "./redact.js";
import type { SendToSessionFn } from "./messaging.js";
import { validateAndResolveProjectPath } from "./security.js";
import {
  clearWizardState,
  countPendingMessages,
  enqueuePendingMessage,
  getSessionBySpace,
  getWizardState,
  listSessionsForChat,
  setWizardState,
  updateSession,
} from "./store.js";
import type { SessionListPage, SessionRow, WizardStateRow } from "./store.js";
import { nowMs } from "./util.js";

const REVIEW_PROMPT = "Run codex review";
const COMMIT_PROMPT = "Stage all current changes and commit them with a clear, meaningful git commit message summarizing the diff.";
const SESSION_LIST_PAGE_SIZE = 20;
const TELEGRAM_DM_SESSION_FALLBACK_WINDOW_MS = 15 * 60 * 1000;
type TelegramReplyContext = { replyToMessageId: number; messageThreadId?: number; chat: TelegramChat };

export class BotController {
  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly sessionManager: SessionManager,
    private readonly telegram: TelegramClient | null,
    private readonly slack: SlackClient | null,
    private readonly sendToSession: SendToSessionFn,
    private readonly reviewCommitDisabled: Set<string>,
  ) {}

  private markReviewCommitDisabled(sessionId: string) {
    this.reviewCommitDisabled.add(sessionId);
  }

  private async disableReviewCommitButtonsTelegram(opts: {
    chatId: string;
    messageId: number;
    text?: string;
    note?: string;
  }) {
    if (!this.telegram) return;
    const note = (opts.note ?? "").trim();
    const baseText = typeof opts.text === "string" ? opts.text : "";
    const updatedText =
      note.length > 0 && !baseText.includes(note) ? `${baseText}${baseText.trim() ? "\n" : ""}${note}` : baseText;

    const shouldEditText = updatedText.length > 0 || note.length > 0;

    if (shouldEditText) {
      try {
        await this.telegram.editMessageText({
          chatId: opts.chatId,
          messageId: opts.messageId,
          text: updatedText || note,
          replyMarkup: null,
          priority: "user",
        });
        return;
      } catch (e) {
        this.logger.debug(`[tg] failed to edit message text chat=${opts.chatId} message=${opts.messageId}: ${String(e)}`);
      }
    }

    try {
      await this.telegram.editMessageReplyMarkup({
        chatId: opts.chatId,
        messageId: opts.messageId,
        replyMarkup: null,
        priority: "user",
      });
    } catch (e) {
      this.logger.debug(
        `[tg] failed to clear reply markup chat=${opts.chatId} message=${opts.messageId}: ${String(e)}`,
      );
    }
  }

  private async disableReviewCommitButtonsSlack(opts: { channelId: string; ts: string; text?: string; note?: string }) {
    if (!this.slack) return;
    const note = (opts.note ?? "").trim();
    const baseText = typeof opts.text === "string" ? opts.text : "";
    const updatedText =
      note.length > 0 && !baseText.includes(note) ? `${baseText}${baseText ? "\n" : ""}${note}` : baseText || note;

    if (updatedText.length === 0) {
      try {
        await this.slack.updateMessage({
          channel: opts.channelId,
          ts: opts.ts,
          text: "",
          blocks: undefined,
        });
      } catch (e) {
        this.logger.debug(`[slack] failed to clear buttons channel=${opts.channelId} ts=${opts.ts}: ${String(e)}`);
      }
      return;
    }

    try {
      await this.slack.updateMessage({
        channel: opts.channelId,
        ts: opts.ts,
        text: updatedText || note || "",
        blocks: undefined,
      });
    } catch (e) {
      this.logger.debug(`[slack] failed to clear buttons channel=${opts.channelId} ts=${opts.ts}: ${String(e)}`);
    }
  }

  private projectById(projectId: string): ProjectEntry {
    const p = this.config.projects.find((x) => x.id === projectId);
    if (!p) throw new Error(`Unknown project id: ${projectId}`);
    return p;
  }

  private slackAccessDecision(
    workspaceId: string | null,
    channelId: string,
    userId: string,
  ): { allowed: boolean; reason?: string } {
    const sec = this.config.security;
    if (sec.slack_allow_workspace_ids.length > 0) {
      if (!workspaceId) return { allowed: false, reason: "missing workspace_id" };
      if (!sec.slack_allow_workspace_ids.includes(workspaceId)) {
        return { allowed: false, reason: `workspace not allowed (${workspaceId})` };
      }
    }
    if (sec.slack_allow_channel_ids.length > 0 && !sec.slack_allow_channel_ids.includes(channelId)) {
      return { allowed: false, reason: `channel not allowed (${channelId})` };
    }
    if (sec.slack_allow_user_ids.length > 0 && !sec.slack_allow_user_ids.includes(userId)) {
      return { allowed: false, reason: `user not allowed (${userId})` };
    }
    return { allowed: true };
  }

  private async telegramAccessDecision(chatId: string, userId: string): Promise<{ allowed: boolean; reason?: string }> {
    const sec = this.config.security;
    if (sec.telegram_allow_chat_ids.length > 0 && !telegramChatIdMatchesAllowlist(chatId, sec.telegram_allow_chat_ids)) {
      return { allowed: false, reason: `chat not allowed (${chatId})` };
    }
    if (sec.telegram_allow_user_ids.length > 0 && !sec.telegram_allow_user_ids.includes(userId)) {
      return { allowed: false, reason: `user not allowed (${userId})` };
    }
    if (sec.telegram_require_admin) {
      if (!this.telegram) return { allowed: false, reason: "telegram not configured" };
      try {
        const member = await this.telegram.getChatMember(chatId, userId);
        if (member.status === "administrator" || member.status === "creator") return { allowed: true };
        return { allowed: false, reason: `not admin (status=${member.status})` };
      } catch (e) {
        return { allowed: false, reason: `admin check failed (${String(e)})` };
      }
    }
    return { allowed: true };
  }

  // --- Telegram ---

  async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    if (!this.telegram) return;

    this.logger.debug(
      `[tg] update received update_id=${String(update.update_id)} keys=${Object.keys(update as any).join(",")}`,
    );

    if (update.callback_query) {
      try {
        await this.handleTelegramCallback(update.callback_query);
      } catch (e) {
        this.logger.warn("telegram callback handler error", e);
        const chat = update.callback_query.message?.chat;
        const chatId = chat ? String(chat.id) : null;
        const replyToMessageId = update.callback_query.message?.message_id;
        if (chatId && typeof replyToMessageId === "number") {
          const msg = e instanceof Error ? e.message : String(e);
	          try {
	            await this.telegram.sendMessage({
	              chatId,
	              messageThreadId: this.telegramForumThreadIdFromMessage(update.callback_query.message ?? undefined),
	              replyToMessageId,
	              text: `Error: ${redactText(msg)}`,
	              priority: "user",
	            });
	          } catch {}
	        }
      }
      return;
    }

    const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
    if (!message) {
      this.logger.debug(`[tg] update ${String(update.update_id)} ignored (no message/callback_query)`);
      return;
    }
    const actorUserId =
      typeof message.from?.id === "number"
        ? String(message.from.id)
        : typeof message.sender_chat?.id === "number"
          ? String(message.sender_chat.id)
          : null;
    if (!actorUserId) {
      this.logger.warn(
        `[tg] message ignored (missing from/sender_chat) chat=${String(message.chat?.id ?? "?")} message_id=${String(
          message.message_id ?? "?",
        )}`,
      );
      return;
    }
    try {
      await this.handleTelegramMessage(message, actorUserId);
    } catch (e) {
      this.logger.warn("telegram message handler error", e);
      const chatId = String(message.chat.id);
      const msg = e instanceof Error ? e.message : String(e);
	      try {
	        await this.telegram.sendMessage({
	          chatId,
	          messageThreadId: this.telegramForumThreadIdFromMessage(message),
	          replyToMessageId: message.message_id,
	          text: `Error: ${redactText(msg)}`,
	          priority: "user",
	        });
	      } catch {}
	    }
  }

  private async handleTelegramMessage(message: TelegramMessage, userId: string) {
    if (!this.telegram) return;
    const chatId = String(message.chat.id);
    const forumThreadId = this.telegramForumThreadIdFromMessage(message);
    const text = (message.text ?? "").trim();
    this.logger.debug(
      `[tg] message received chat=${chatId} user=${userId} message_id=${String(message.message_id)} thread=${String(
        message.message_thread_id ?? "-",
      )} reply_to=${String(message.reply_to_message?.message_id ?? "-")} text=${JSON.stringify(safeSnippet(text))}`,
    );
    if (!text) return;

    try {
      await this.telegram.setMessageReaction({ chatId, messageId: message.message_id, emoji: "👍" });
    } catch (e) {
      this.logger.debug(
        `[tg] set reaction failed chat=${chatId} message_id=${String(message.message_id)}: ${String(e)}`,
      );
      try {
        await this.telegram.sendMessageSingle({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: "👍",
          priority: "user",
        });
      } catch (sendErr) {
        this.logger.debug(
          `[tg] thumbs up fallback send failed chat=${chatId} message_id=${String(message.message_id)}: ${String(sendErr)}`,
        );
      }
    }

    const listIntent = parseListSessionsIntentFromTelegram(text);
    if (listIntent) {
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(`[tg] rejected list sessions chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
	        await this.telegram.sendMessage({
	          chatId,
	          messageThreadId: forumThreadId,
	          replyToMessageId: message.message_id,
	          text: "Not authorized.",
	          priority: "user",
	        });
	        return;
	      }
      const sessionPage = await listSessionsForChat({
        db: this.db,
        platform: "telegram",
        chatId,
        statuses: listIntent.statuses,
        limit: SESSION_LIST_PAGE_SIZE,
        page: listIntent.page,
      });
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: message.message_id,
        text: formatSessionList("telegram", { ...sessionPage, filterLabel: formatSessionFilterLabel(listIntent.statuses) }),
        priority: "user",
      });
      return;
    }

    const settingsIntent = parseSettingsIntentFromTelegram(text);
    if (settingsIntent) {
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(`[tg] rejected settings chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: "Not authorized.",
          priority: "user",
        });
        return;
      }
      const result = applySettingsCommand(this.config, settingsIntent);
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: message.message_id,
        text: result,
        priority: "user",
      });
      return;
    }

    const stopIntent = parseStopIntentFromTelegram(text);
    if (stopIntent) {
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(`[tg] rejected stop chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: "Not authorized.",
          priority: "user",
        });
        return;
      }
      const target = stopIntent.sessionId
        ? await this.db.selectFrom("sessions").selectAll().where("id", "=", stopIntent.sessionId).executeTakeFirst()
        : await this.findLatestActiveTelegramSession(chatId);
      if (!target || target.platform !== "telegram" || target.chat_id !== chatId) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: "No active session found.",
          priority: "user",
        });
        return;
      }
      if (target.status !== "starting" && target.status !== "running") {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: "Session already finished.",
          priority: "user",
        });
        return;
      }
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: message.message_id,
        text: "Stopping session…",
        priority: "user",
      });
      await this.sessionManager.killSession(target.id, "Stopping session via /stop.");
      return;
    }

    // Allow "@bot sessions" style listing too.
    const botUsername = this.telegram.botUsername;
    if (botUsername) {
      const mention = `@${botUsername}`.toLowerCase();
      const lower = text.toLowerCase();
      if (lower.startsWith(mention)) {
        const rest = text.slice(mention.length).trim();
        if (rest.toLowerCase().startsWith("sessions")) {
          const access = await this.telegramAccessDecision(chatId, userId);
          if (!access.allowed) {
            this.logger.warn(`[tg] rejected list sessions chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
	            await this.telegram.sendMessage({
	              chatId,
	              messageThreadId: forumThreadId,
	              replyToMessageId: message.message_id,
	              text: "Not authorized.",
	              priority: "user",
	            });
	        return;
	      }
          const args = parseListSessionsArgs(rest.slice("sessions".length).trim());
          const sessionPage = await listSessionsForChat({
            db: this.db,
            platform: "telegram",
            chatId,
            statuses: args.statuses,
            limit: SESSION_LIST_PAGE_SIZE,
            page: args.page,
          });
	          await this.telegram.sendMessage({
	            chatId,
	            messageThreadId: forumThreadId,
	            replyToMessageId: message.message_id,
            text: formatSessionList("telegram", {
              ...sessionPage,
              filterLabel: formatSessionFilterLabel(args.statuses),
            }),
            priority: "user",
          });
          return;
        }

        if (rest.toLowerCase().startsWith("settings")) {
          const access = await this.telegramAccessDecision(chatId, userId);
          if (!access.allowed) {
            this.logger.warn(`[tg] rejected mention settings chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
            await this.telegram.sendMessage({
              chatId,
              messageThreadId: forumThreadId,
              replyToMessageId: message.message_id,
              text: "Not authorized.",
              priority: "user",
            });
            return;
          }
          const result = applySettingsCommand(this.config, parseSettingsArgs(rest.slice("settings".length)) ?? { kind: "list" });
          await this.telegram.sendMessage({
            chatId,
            messageThreadId: forumThreadId,
            replyToMessageId: message.message_id,
            text: result,
            priority: "user",
          });
          return;
        }
      }
    }

    // Session routing.
    const spaceIds = this.telegramSpaceIdsFromMessage(message);
    for (const spaceId of spaceIds) {
      const session = await getSessionBySpace(this.db, "telegram", chatId, spaceId);
      if (!session) continue;

      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected session message chat=${chatId} user=${userId} space=${spaceId} session=${session.id} reason=${access.reason ?? "-"}`,
        );
	        await this.telegram.sendMessage({
	          chatId,
	          messageThreadId: forumThreadId,
	          replyToMessageId: message.message_id,
	          text: "Not authorized.",
	          priority: "user",
	        });
	        return;
	      }
      this.logger.debug(`[tg] routed to session id=${session.id} status=${session.status} space=${spaceId}`);
      await updateSession(this.db, session.id, { last_user_message_at: nowMs() });
      await this.handleSessionMessage(session, userId, text);
      return;
    }
    if (spaceIds.length > 0) {
      this.logger.debug(`[tg] no session for space=${spaceIds.join(",")} chat=${chatId} user=${userId}`);
    }

    // Messages outside of topics/threads should fall back to the latest active session.
    if (spaceIds.length === 0) {
      const chatType = message.chat.type;
      this.logger.debug(`[tg] fallback check chat=${chatId} type=${chatType}`);
      if (chatType === "private" || chatType === "group" || chatType === "supergroup") {
        const fallbackSession = await this.findRecentTelegramSession(chatId);
        if (fallbackSession) {
          const access = await this.telegramAccessDecision(chatId, userId);
          if (!access.allowed) {
            this.logger.warn(
              `[tg] rejected fallback chat=${chatId} user=${userId} session=${fallbackSession.id} reason=${access.reason ?? "-"}`,
            );
            await this.telegram.sendMessage({
              chatId,
              messageThreadId: forumThreadId,
              replyToMessageId: message.message_id,
              text: "Not authorized.",
              priority: "user",
            });
            return;
          }
          const mode = chatType === "private" ? "dm" : "group";
          this.logger.debug(
            `[tg] ${mode} fallback routed session=${fallbackSession.id} status=${fallbackSession.status} chat=${chatId} user=${userId}`,
          );
          await updateSession(this.db, fallbackSession.id, { last_user_message_at: nowMs() });
          await this.handleSessionMessage(fallbackSession, userId, text);
          return;
        }
      }
    }

    // Wizard start.
    if (this.telegram.isMentionOrCommand(message)) {
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(`[tg] rejected wizard start chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
	        await this.telegram.sendMessage({
	          chatId,
	          messageThreadId: forumThreadId,
	          replyToMessageId: message.message_id,
	          text: "Not authorized.",
	          priority: "user",
	        });
	        return;
	      }
      this.logger.debug(`[tg] starting wizard chat=${chatId} user=${userId}`);
      await this.startTelegramWizard(chatId, userId, message.message_id, forumThreadId);
      return;
    }

    // Wizard continuation.
    const wizard = await getWizardState(this.db, "telegram", chatId, userId);
    if (!wizard) {
      this.logger.debug(`[tg] message ignored (no wizard/session match) chat=${chatId} user=${userId}`);
      return;
    }
    const access = await this.telegramAccessDecision(chatId, userId);
    if (!access.allowed) {
      this.logger.warn(`[tg] rejected wizard continuation chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
	      await this.telegram.sendMessage({
	        chatId,
	        messageThreadId: forumThreadId,
	        replyToMessageId: message.message_id,
	        text: "Not authorized.",
	        priority: "user",
	      });
	      return;
	    }
    this.logger.debug(`[tg] wizard continuation state=${wizard.state} chat=${chatId} user=${userId}`);
    await this.continueTelegramWizard(wizard, text, {
      replyToMessageId: message.message_id,
      messageThreadId: forumThreadId,
      chat: message.chat,
    });
  }

  private telegramSpaceIdsFromMessage(message: TelegramMessage): string[] {
    const out: string[] = [];
    if (typeof message.message_thread_id === "number" && message.message_thread_id > 0) {
      out.push(String(message.message_thread_id));
    }
    if (message.reply_to_message) {
      const replyId = String(message.reply_to_message.message_id);
      if (!out.includes(replyId)) out.push(replyId);
    }
    return out;
  }

  private telegramForumThreadIdFromMessage(message?: TelegramMessage): number | undefined {
    if (!message) return undefined;
    // Telegram may omit `is_topic_message` on callback_query.message even when `message_thread_id` is present.
    // Prefer the thread id whenever it exists.
    // Docs: https://core.telegram.org/bots/api#message (message_thread_id)
    //       https://core.telegram.org/bots/api#callbackquery (message)
    const id = message.message_thread_id;
    if (typeof id !== "number" || id <= 0) return undefined;
    return id;
  }

  private async findRecentTelegramSession(chatId: string): Promise<SessionRow | null> {
    const candidate = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("platform", "=", "telegram")
      .where("chat_id", "=", chatId)
      .where("status", "in", ["starting", "running", "finished", "error"])
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!candidate) return null;
    if (candidate.status === "starting" || candidate.status === "running") {
      return candidate as SessionRow;
    }
    if (!candidate.codex_session_id) return null;
    const lastActivity =
      candidate.last_user_message_at ?? candidate.finished_at ?? candidate.updated_at ?? candidate.created_at ?? null;
    if (!lastActivity) return null;
    if (nowMs() - lastActivity > TELEGRAM_DM_SESSION_FALLBACK_WINDOW_MS) return null;
    return candidate as SessionRow;
  }

  private async findLatestActiveTelegramSession(chatId: string): Promise<SessionRow | null> {
    const candidate = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("platform", "=", "telegram")
      .where("chat_id", "=", chatId)
      .where("status", "in", ["starting", "running"])
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return candidate ? (candidate as SessionRow) : null;
  }

  private async startTelegramWizard(chatId: string, userId: string, replyToMessageId: number, messageThreadId?: number) {
    if (!this.telegram) return;
    await setWizardState(this.db, {
      id: crypto.randomUUID(),
      platform: "telegram",
      chat_id: chatId,
      user_id: userId,
      state: "await_project",
      project_id: null,
      custom_path_candidate: null,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    const menuText = buildMenuText("telegram");
    await this.telegram.sendMessage({
      chatId,
      text: menuText,
      messageThreadId,
      replyToMessageId,
      replyMarkup: this.telegram.projectKeyboard(this.config.projects),
      priority: "user",
    });
  }

  private async handleTelegramCallback(cb: TelegramCallbackQuery) {
    if (!this.telegram) return;
    const data = cb.data ?? "";
    this.logger.debug(
      `[tg] callback received user=${String(cb.from.id)} chat=${String(cb.message?.chat?.id ?? "?")} data=${JSON.stringify(
        safeSnippet(data),
      )}`,
    );
    if (data.startsWith("kill:")) {
      const sessionId = data.slice("kill:".length);
      const chat = cb.message?.chat;
      const chatId = chat ? String(chat.id) : null;
      const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
      if (!chatId || !sessionId) {
        await this.telegram.answerCallbackQuery(cb.id, "Session not found.");
        return;
      }
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected kill callback chat=${chatId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        await this.telegram.answerCallbackQuery(cb.id, "Not authorized.");
        return;
      }
      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "telegram" || session.chat_id !== chatId) {
        await this.telegram.answerCallbackQuery(cb.id, "Session not found.");
        return;
      }
      if (session.status !== "starting" && session.status !== "running") {
        await this.telegram.answerCallbackQuery(cb.id, "Session already finished.");
        return;
      }

      await this.telegram.answerCallbackQuery(cb.id, "Stopping session…");
      await this.sessionManager.killSession(sessionId, "Stopping session at user request.");
      return;
    }

    if (data.startsWith("review:")) {
      const sessionId = data.slice("review:".length);
      const chat = cb.message?.chat;
      const chatId = chat ? String(chat.id) : null;
      const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
      const messageId = cb.message?.message_id ?? null;
      // @ts-ignore
      const messageText = cb.message?.text ?? cb.message?.caption ?? undefined;
      if (!chatId || !sessionId) {
        await this.telegram.answerCallbackQuery(cb.id, "Session not found.");
        return;
      }
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected review callback chat=${chatId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        await this.telegram.answerCallbackQuery(cb.id, "Not authorized.");
        return;
      }
      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "telegram" || session.chat_id !== chatId) {
        await this.telegram.answerCallbackQuery(cb.id, "Session not found.");
        return;
      }

      this.markReviewCommitDisabled(sessionId);
      if (messageId !== null) {
        await this.disableReviewCommitButtonsTelegram({
          chatId,
          messageId,
          text: messageText,
          note: "[Clock] Started Review",
        });
      }

      await this.telegram.answerCallbackQuery(cb.id, "Starting review…");
      try {
        await this.handleSessionMessage(session as SessionRow, userId, REVIEW_PROMPT);
      } catch (e) {
        this.logger.warn(
          `[tg] review callback failed chat=${chatId} user=${userId} session=${sessionId}: ${String(e)}`,
        );
        try {
          await this.telegram.sendMessage({
            chatId,
            messageThreadId: this.telegramForumThreadIdFromMessage(cb.message),
            replyToMessageId: cb.message?.message_id,
            text: `Error: ${redactText(e instanceof Error ? e.message : String(e))}`,
            priority: "user",
          });
        } catch {}
      }
      return;
    }

    if (data.startsWith("commit:")) {
      const sessionId = data.slice("commit:".length);
      const chat = cb.message?.chat;
      const chatId = chat ? String(chat.id) : null;
      const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
      const messageId = cb.message?.message_id ?? null;
      // @ts-ignore
      const messageText = cb.message?.text ?? cb.message?.caption ?? undefined;
      if (!chatId || !sessionId) {
        await this.telegram.answerCallbackQuery(cb.id, "Session not found.");
        return;
      }
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected commit callback chat=${chatId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        await this.telegram.answerCallbackQuery(cb.id, "Not authorized.");
        return;
      }
      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "telegram" || session.chat_id !== chatId) {
        await this.telegram.answerCallbackQuery(cb.id, "Session not found.");
        return;
      }

      this.markReviewCommitDisabled(sessionId);
      if (messageId !== null) {
        await this.disableReviewCommitButtonsTelegram({ chatId, messageId, text: messageText });
      }

      await this.telegram.answerCallbackQuery(cb.id, "Committing changes…");
      try {
        await this.handleSessionMessage(session as SessionRow, userId, COMMIT_PROMPT);
      } catch (e) {
        this.logger.warn(
          `[tg] commit callback failed chat=${chatId} user=${userId} session=${sessionId}: ${String(e)}`,
        );
        try {
          await this.telegram.sendMessage({
            chatId,
            messageThreadId: this.telegramForumThreadIdFromMessage(cb.message),
            replyToMessageId: cb.message?.message_id,
            text: `Error: ${redactText(e instanceof Error ? e.message : String(e))}`,
            priority: "user",
          });
        } catch {}
      }
      return;
    }

    if (!data.startsWith("proj:")) {
      await this.telegram.answerCallbackQuery(cb.id);
      return;
    }
    const projectId = data.slice("proj:".length);
    const project = this.projectById(projectId);

    const chat = cb.message?.chat;
    const chatId = chat ? String(chat.id) : null;
    const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
    if (!chatId) {
      await this.telegram.answerCallbackQuery(cb.id, "Unsupported callback context.");
      return;
    }
    const access = await this.telegramAccessDecision(chatId, userId);
    if (!access.allowed) {
      this.logger.warn(
        `[tg] rejected callback chat=${chatId} user=${userId} project=${projectId} reason=${access.reason ?? "-"}`,
      );
      await this.telegram.answerCallbackQuery(cb.id, "Not authorized.");
      return;
    }

    await setWizardState(this.db, {
      id: crypto.randomUUID(),
      platform: "telegram",
      chat_id: chatId,
      user_id: userId,
      state: project.path === "*" ? "await_custom_path" : "await_initial_prompt",
      project_id: projectId,
      custom_path_candidate: null,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    await this.telegram.answerCallbackQuery(cb.id);

    const forumThreadId = this.telegramForumThreadIdFromMessage(cb.message);
	    await this.telegram.sendMessage({
	      chatId,
	      messageThreadId: forumThreadId,
	      replyToMessageId: cb.message?.message_id,
	      text: project.path === "*" ? "Send a custom project path." : "Send the initial prompt for this session.",
	      priority: "user",
	    });
	  }

  private async continueTelegramWizard(wizard: WizardStateRow, text: string, ctx: TelegramReplyContext) {
    if (!this.telegram) return;

	    if (wizard.state === "await_project") {
	      await this.telegram.sendMessage({
	        chatId: wizard.chat_id,
	        messageThreadId: ctx.messageThreadId,
	        replyToMessageId: ctx.replyToMessageId,
	        text: "Please choose a project using the buttons.",
	        priority: "user",
	      });
	      return;
	    }

	    if (!wizard.project_id) {
	      await clearWizardState(this.db, "telegram", wizard.chat_id, wizard.user_id);
	      await this.telegram.sendMessage({
	        chatId: wizard.chat_id,
	        messageThreadId: ctx.messageThreadId,
	        replyToMessageId: ctx.replyToMessageId,
	        text: "Wizard state expired. Mention me again to restart.",
	        priority: "user",
	      });
	      return;
	    }

    const project = this.projectById(wizard.project_id);

    if (wizard.state === "await_custom_path") {
      // Validate immediately; store resolved path so it won't change later.
      const resolved = await validateAndResolveProjectPath(this.config, project, text);
      await setWizardState(this.db, {
        ...wizard,
        state: "await_initial_prompt",
        custom_path_candidate: resolved.project_path_resolved,
        updated_at: nowMs(),
      });
	      await this.telegram.sendMessage({
	        chatId: wizard.chat_id,
	        messageThreadId: ctx.messageThreadId,
	        replyToMessageId: ctx.replyToMessageId,
	        text: "Path accepted. Now send the initial prompt.",
	        priority: "user",
	      });
	      return;
	    }

    if (wizard.state === "await_initial_prompt") {
      const resolved = await validateAndResolveProjectPath(this.config, project, wizard.custom_path_candidate);

      try {
        await this.sessionManager.assertCanStartNewSession({ platform: "telegram", chatId: wizard.chat_id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const hint = msg.includes("max concurrent sessions")
          ? "\n\nTip: try /sessions active to see running sessions."
          : "";
	        await this.telegram.sendMessage({
	          chatId: wizard.chat_id,
	          messageThreadId: ctx.messageThreadId,
	          replyToMessageId: ctx.replyToMessageId,
	          text: `Error: ${redactText(msg)}${hint}`,
	          priority: "user",
	        });
	        return;
	      }

      const { spaceId, announce, topicId, topicEmoji, topicCustomEmojiId } = await this.createTelegramSessionSpace({
        chat: ctx.chat,
        projectName: resolved.project_name,
        anchorMessageId: ctx.replyToMessageId,
        anchorMessageThreadId: ctx.messageThreadId,
      });

      let sessionId: string;
      try {
        sessionId = await this.sessionManager.startNewSession({
          platform: "telegram",
          workspaceId: null,
          chatId: wizard.chat_id,
          spaceId,
          spaceEmoji: topicEmoji ?? null,
          userId: wizard.user_id,
          projectId: resolved.project_id,
          projectPathResolved: resolved.project_path_resolved,
          initialPrompt: text,
        });
      } catch (e) {
        await clearWizardState(this.db, "telegram", wizard.chat_id, wizard.user_id);
        const msg = e instanceof Error ? e.message : String(e);
        const hint = msg.includes("max concurrent sessions")
          ? "\n\nTip: try /sessions active to see running sessions."
          : "";
	        if (topicId) {
	          await this.telegram.sendMessage({
	            chatId: wizard.chat_id,
	            messageThreadId: topicId,
	            text: `Error: ${redactText(msg)}${hint}`,
	            priority: "user",
	          });
	        } else {
	          await this.telegram.sendMessage({
	            chatId: wizard.chat_id,
	            messageThreadId: ctx.messageThreadId,
	            replyToMessageId: Number(spaceId),
	            text: `Error: ${redactText(msg)}${hint}`,
	            priority: "user",
	          });
	        }
	        return;
	      }

      await clearWizardState(this.db, "telegram", wizard.chat_id, wizard.user_id);

      if (topicId) {
        await this.pinTelegramTopicHeader({
          chatId: wizard.chat_id,
          topicId,
          initialPrompt: text,
          sessionId,
        });
      }

      if (announce) {
        // Best-effort nudge for users who aren't in the topic view.
        const emoji = topicEmoji ?? "🧠";
        const announceText = `Session started. Check the new topic starting with ${emoji}.`;
        const entity =
          topicCustomEmojiId && topicEmoji
            ? buildTelegramCustomEmojiEntity(announceText, topicEmoji, topicCustomEmojiId)
            : null;
        try {
	          await this.telegram.sendMessageSingle({
	            chatId: wizard.chat_id,
	            messageThreadId: ctx.messageThreadId,
	            replyToMessageId: ctx.replyToMessageId,
	            text: announceText,
	            entities: entity ? [entity] : undefined,
	            priority: "user",
	          });
	        } catch {
	          await this.telegram.sendMessage({
	            chatId: wizard.chat_id,
	            messageThreadId: ctx.messageThreadId,
	            replyToMessageId: ctx.replyToMessageId,
	            text: announceText,
	            priority: "user",
	          });
	        }
	      }

      if (topicId && topicEmoji) {
        void this.updateTelegramTopicTitleAsync({
          chatId: wizard.chat_id,
          topicId,
          topicEmoji,
          projectName: resolved.project_name,
          projectPathResolved: resolved.project_path_resolved,
          initialPrompt: text,
        });
      }
    }
  }

  private async createTelegramSessionSpace(opts: {
    chat: TelegramChat;
    projectName: string;
    anchorMessageId: number;
    anchorMessageThreadId?: number;
  }): Promise<{ spaceId: string; announce: boolean; topicId?: number; topicEmoji?: string; topicCustomEmojiId?: string }> {
    if (!this.telegram) throw new Error("Telegram not configured");
    const chatId = String(opts.chat.id);

    // Channels (and anonymous-admin posts) don't support forum topics; keep everything as replies.
	    if (opts.chat.type === "channel") {
	      await this.telegram.sendMessageSingle({
	        chatId,
	        replyToMessageId: opts.anchorMessageId,
	        text: "Session created. I’ll reply here with output…",
	        priority: "user",
	      });
	      return { spaceId: String(opts.anchorMessageId), announce: false };
	    }

    if (this.config.telegram?.use_topics && opts.chat.type === "supergroup" && opts.chat.is_forum) {
      const picked = await this.pickTelegramTopicEmoji();
      const topicEmoji = picked.emoji;
      const topicCustomEmojiId = picked.customEmojiId;
      try {
        const initialName = clipForumTopicName(`${topicEmoji} Codex: ${opts.projectName}`);
        const topicId = await this.telegram.createForumTopic(chatId, initialName, topicCustomEmojiId);
        return { spaceId: String(topicId), announce: true, topicId, topicEmoji, topicCustomEmojiId };
      } catch (e) {
        this.logger.warn(
          `[tg] createForumTopic failed chat=${chatId} (ensure Topics are enabled and the bot can_manage_topics); falling back to reply thread: ${String(
            e,
          )}`,
        );
        // Fall through to reply-thread.
      }
    }

	    const root = await this.telegram.sendMessageSingle({
	      chatId,
	      messageThreadId: opts.anchorMessageThreadId,
	      replyToMessageId: opts.anchorMessageId,
	      text: "Session created. Reply to this message to continue.",
	      priority: "user",
	    });
	    return { spaceId: String(root.message_id), announce: false };
	  }

  private async pinTelegramTopicHeader(opts: {
    chatId: string;
    topicId: number;
    initialPrompt: string;
    sessionId: string;
  }) {
    if (!this.telegram) return;
    const message = this.formatTelegramTopicHeaderMessage(opts.initialPrompt, opts.sessionId);
    try {
      const msg = await this.telegram.sendMessageSingleStrict({
        chatId: opts.chatId,
        messageThreadId: opts.topicId,
        text: message.text,
        parseMode: message.parseMode,
        replyMarkup: { inline_keyboard: [[{ text: "Stop", callback_data: `kill:${opts.sessionId}` }]] },
        priority: "user",
      });
      await this.telegram.pinChatMessage(opts.chatId, msg.message_id);
    } catch (e) {
      this.logger.warn(
        `[tg] failed to pin topic header chat=${opts.chatId} topic=${opts.topicId} session=${opts.sessionId}: ${String(e)}`,
      );
    }
  }

  private formatTelegramTopicHeaderMessage(initialPrompt: string, sessionId: string): { text: string; parseMode: "HTML" } {
    const maxChars = this.config.telegram?.max_chars ?? 4096;
    const promptLabel = "<b>Prompt:</b>\n";
    const sessionBlock = `\n\n<b>Session id:</b>\n<pre>${escapeHtml(sessionId)}</pre>`;
    const baseOverhead = promptLabel.length + "<pre></pre>".length + sessionBlock.length;
    const promptBudget = Math.max(0, maxChars - baseOverhead);

    const normalizedPrompt = initialPrompt.trim() || "(empty prompt)";
    const escapedPromptFull = escapeHtml(normalizedPrompt);
    const clippedEscaped = truncateHtmlEscapedWithEllipsis(escapedPromptFull, promptBudget);
    let text = `${promptLabel}<pre>${clippedEscaped}</pre>${sessionBlock}`;

    if (text.length > maxChars) {
      const overflow = text.length - maxChars;
      const retryBudget = Math.max(0, promptBudget - overflow);
      const retryClipped = truncateHtmlEscapedWithEllipsis(escapedPromptFull, retryBudget);
      text = `${promptLabel}<pre>${retryClipped}</pre>${sessionBlock}`;
    }

    if (text.length > maxChars) {
      text = `<b>Session id:</b>\n<pre>${escapeHtml(sessionId)}</pre>`;
    }

    return { text, parseMode: "HTML" };
  }

  private async pickTelegramTopicEmoji(): Promise<{ emoji: string; customEmojiId?: string }> {
    const fallback: { emoji: string; customEmojiId?: string } = { emoji: pickTopicEmoji() };
    if (!this.telegram) return fallback;

    try {
      const stickers = await this.telegram.getForumTopicIconStickers();
      const candidates = stickers
        .map((s) => ({
          emoji: typeof s.emoji === "string" && s.emoji.length > 0 ? s.emoji : null,
          customEmojiId: typeof s.custom_emoji_id === "string" && s.custom_emoji_id.length > 0 ? s.custom_emoji_id : null,
        }))
        .filter((x): x is { emoji: string; customEmojiId: string } => !!x.emoji && !!x.customEmojiId);

      if (candidates.length === 0) return fallback;
      const idx = Math.floor(Math.random() * candidates.length);
      const picked = candidates[idx];
      return picked ? { emoji: picked.emoji, customEmojiId: picked.customEmojiId } : fallback;
    } catch (e) {
      this.logger.debug(`[tg] getForumTopicIconStickers failed: ${String(e)}`);
      return fallback;
    }
  }

  private async updateTelegramTopicTitleAsync(opts: {
    chatId: string;
    topicId: number;
    topicEmoji: string;
    projectName: string;
    projectPathResolved: string;
    initialPrompt: string;
  }) {
    if (!this.telegram) return;
    try {
      const emojiPrefix = `${opts.topicEmoji} `;
      const maxNameChars = 128;
      const maxTitleChars = Math.max(16, maxNameChars - emojiPrefix.length);

      const title = await generateCodexTitle({
        config: this.config,
        logger: this.logger,
        cwd: opts.projectPathResolved,
        projectName: opts.projectName,
        initialPrompt: opts.initialPrompt,
        maxTitleChars,
        timeoutMs: 20_000,
      });
      if (!title) return;

      const nextName = clipForumTopicName(`${emojiPrefix}${title}`);
      await this.telegram.editForumTopic(opts.chatId, opts.topicId, nextName);
    } catch (e) {
      this.logger.warn(
        `[tg] async topic title update failed chat=${opts.chatId} topic=${String(opts.topicId)}: ${String(e)}`,
      );
    }
  }

  // --- Slack ---

  async handleSlackEvent(body: any): Promise<void> {
    if (!this.slack) return;
    if (body?.type !== "event_callback" || !body.event) return;

    const ev = body.event;
    const teamId = typeof body.team_id === "string" ? body.team_id : null;

    if (ev.type === "app_mention") {
      const channelId = ev.channel as string | undefined;
      const userId = ev.user as string | undefined;
      if (!channelId || !userId) return;
      const access = this.slackAccessDecision(teamId, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(`[slack] rejected app_mention channel=${channelId} user=${userId} reason=${access.reason ?? "-"}`);
        return;
      }

      const text = typeof ev.text === "string" ? ev.text : "";
      this.logger.debug(
        `[slack] app_mention received workspace=${String(teamId ?? "-")} channel=${channelId} user=${userId} text=${JSON.stringify(
          safeSnippet(text),
        )}`,
      );
      const listIntent = parseListSessionsIntentFromSlack(text);
      if (listIntent) {
        const sessionPage = await listSessionsForChat({
          db: this.db,
          platform: "slack",
          workspaceId: teamId,
          chatId: channelId,
          statuses: listIntent.statuses,
          limit: SESSION_LIST_PAGE_SIZE,
          page: listIntent.page,
        });
        await this.slack.postEphemeral({
          channel: channelId,
          user: userId,
          text: formatSessionList("slack", { ...sessionPage, filterLabel: formatSessionFilterLabel(listIntent.statuses) }),
        });
        return;
      }

      const settingsIntent = parseSettingsIntentFromSlack(text);
      if (settingsIntent) {
        const result = applySettingsCommand(this.config, settingsIntent);
        await this.slack.postEphemeral({
          channel: channelId,
          user: userId,
          text: result,
        });
        return;
      }

      await this.startSlackWizard(teamId, channelId, userId);
      return;
    }

    if (ev.type === "message") {
      if (ev.subtype) return;
      const channelId = ev.channel as string | undefined;
      const userId = ev.user as string | undefined;
      const text = typeof ev.text === "string" ? ev.text.trim() : "";
      if (!channelId || !userId || !text) return;
      const access = this.slackAccessDecision(teamId, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(`[slack] rejected message channel=${channelId} user=${userId} reason=${access.reason ?? "-"}`);
        return;
      }

      const spaceId =
        this.config.slack?.session_mode === "thread"
          ? typeof ev.thread_ts === "string"
            ? ev.thread_ts
            : null
          : channelId;
      if (!spaceId) return;

      this.logger.debug(
        `[slack] message received workspace=${String(teamId ?? "-")} channel=${channelId} user=${userId} space=${spaceId} text=${JSON.stringify(
          safeSnippet(text),
        )}`,
      );

      const session = await getSessionBySpace(this.db, "slack", channelId, spaceId);
      if (!session) {
        this.logger.debug(`[slack] no session for space=${spaceId} channel=${channelId}`);
        return;
      }
      this.logger.debug(
        `[slack] routed message channel=${channelId} user=${userId} space=${spaceId} session=${session.id} text=${JSON.stringify(
          safeSnippet(text),
        )}`,
      );
      await updateSession(this.db, session.id, { last_user_message_at: nowMs() });
      await this.handleSessionMessage(session, userId, text);
    }
  }

  async handleSlackInteraction(payload: any): Promise<void> {
    if (!this.slack) return;
    this.logger.debug(`[slack] interaction received type=${String(payload?.type ?? "?")}`);
    try {
      if (payload?.type === "block_actions") {
        await this.handleSlackBlockActions(payload);
        return;
      }
      if (payload?.type === "view_submission" && payload.view?.callback_id === "codex_wizard") {
        await this.handleSlackViewSubmission(payload);
        return;
      }
    } catch (e) {
      this.logger.warn("slack interaction error", e);
      const channel =
        (payload?.channel?.id as string | undefined) ??
        (payload?.view?.private_metadata ? (safeParseMeta(payload.view.private_metadata)?.channelId as string | undefined) : undefined);
      const user =
        (payload?.user?.id as string | undefined) ??
        (payload?.view?.private_metadata ? (safeParseMeta(payload.view.private_metadata)?.userId as string | undefined) : undefined);
      if (channel && user) {
        await this.slack.postEphemeral({ channel, user, text: `Error: ${String(e)}` });
      }
    }
  }

  private async startSlackWizard(teamId: string | null, channelId: string, userId: string) {
    if (!this.slack) return;
    await setWizardState(this.db, {
      id: crypto.randomUUID(),
      platform: "slack",
      chat_id: channelId,
      user_id: userId,
      state: "await_project",
      project_id: null,
      custom_path_candidate: null,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    const options = this.config.projects.map((p) => ({
      text: { type: "plain_text", text: p.name },
      value: p.id,
    }));

    const menuText = buildMenuText("slack");
    const commandExamples = buildCommandExamples("slack");

    await this.slack.postEphemeral({
      channel: channelId,
      user: userId,
      text: menuText,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Choose a project to start a Codex session:" },
          accessory: {
            type: "static_select",
            action_id: "project_select",
            placeholder: { type: "plain_text", text: "Select a project" },
            options,
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: commandExamples },
        },
      ],
    });
  }

  private async handleSlackBlockActions(payload: any) {
    if (!this.slack) return;
    const action = payload.actions?.[0];
    if (!action) return;

    if (action.action_id === "kill_session") {
      const sessionId = typeof action.value === "string" ? action.value : null;
      const channelId = payload.channel?.id as string | undefined;
      const userId = payload.user?.id as string | undefined;
      const teamId = payload.team?.id as string | undefined;
      if (!sessionId || !channelId || !userId) return;

      const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[slack] rejected kill action channel=${channelId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        return;
      }

      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "slack" || session.chat_id !== channelId) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: "Session not found." });
        return;
      }
      if (session.status !== "starting" && session.status !== "running") {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: "Session already finished." });
        return;
      }

      await this.slack.postEphemeral({ channel: channelId, user: userId, text: "Stopping session…" });
      await this.sessionManager.killSession(sessionId, "Stopping session at user request.");
      return;
    }

    if (action.action_id === "review_session") {
      const sessionId = typeof action.value === "string" ? action.value : null;
      const channelId = payload.channel?.id as string | undefined;
      const userId = payload.user?.id as string | undefined;
      const teamId = payload.team?.id as string | undefined;
      const ts = (payload.message?.ts ?? payload.container?.message_ts) as string | undefined;
      const messageText = typeof payload.message?.text === "string" ? payload.message.text : undefined;
      if (!sessionId || !channelId || !userId) return;

      const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[slack] rejected review action channel=${channelId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        return;
      }

      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "slack" || session.chat_id !== channelId) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: "Session not found." });
        return;
      }

      this.markReviewCommitDisabled(sessionId);
      if (ts) await this.disableReviewCommitButtonsSlack({ channelId, ts, text: messageText, note: "[Clock] Started Review" });

      const threadTs = this.config.slack?.session_mode === "thread" ? session.space_id : undefined;
      await this.slack.postEphemeral({ channel: channelId, user: userId, thread_ts: threadTs, text: "Starting review…" });
      try {
        await this.handleSessionMessage(session as SessionRow, userId, REVIEW_PROMPT);
      } catch (e) {
        this.logger.warn(
          `[slack] review action failed channel=${channelId} user=${userId} session=${sessionId}: ${String(e)}`,
        );
        await this.slack.postEphemeral({
          channel: channelId,
          user: userId,
          thread_ts: threadTs,
          text: `Error: ${String(e)}`,
        });
      }
      return;
    }

    if (action.action_id === "commit_session") {
      const sessionId = typeof action.value === "string" ? action.value : null;
      const channelId = payload.channel?.id as string | undefined;
      const userId = payload.user?.id as string | undefined;
      const teamId = payload.team?.id as string | undefined;
      const ts = (payload.message?.ts ?? payload.container?.message_ts) as string | undefined;
      const messageText = typeof payload.message?.text === "string" ? payload.message.text : undefined;
      if (!sessionId || !channelId || !userId) return;

      const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[slack] rejected commit action channel=${channelId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        return;
      }

      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "slack" || session.chat_id !== channelId) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: "Session not found." });
        return;
      }

      this.markReviewCommitDisabled(sessionId);
      if (ts) await this.disableReviewCommitButtonsSlack({ channelId, ts, text: messageText });

      const threadTs = this.config.slack?.session_mode === "thread" ? session.space_id : undefined;
      await this.slack.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: "Committing changes…",
      });
      try {
        await this.handleSessionMessage(session as SessionRow, userId, COMMIT_PROMPT);
      } catch (e) {
        this.logger.warn(
          `[slack] commit action failed channel=${channelId} user=${userId} session=${sessionId}: ${String(e)}`,
        );
        await this.slack.postEphemeral({
          channel: channelId,
          user: userId,
          thread_ts: threadTs,
          text: `Error: ${String(e)}`,
        });
      }
      return;
    }

    if (action.action_id !== "project_select") return;

    const projectId = action.selected_option?.value as string | undefined;
    const triggerId = payload.trigger_id as string | undefined;
    const channelId = payload.channel?.id as string | undefined;
    const userId = payload.user?.id as string | undefined;
    const teamId = payload.team?.id as string | undefined;
    if (!projectId || !triggerId || !channelId || !userId) return;
    const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
    if (!access.allowed) {
      this.logger.warn(
        `[slack] rejected block_actions channel=${channelId} user=${userId} reason=${access.reason ?? "-"}`,
      );
      return;
    }

    const project = this.projectById(projectId);

    await setWizardState(this.db, {
      id: crypto.randomUUID(),
      platform: "slack",
      chat_id: channelId,
      user_id: userId,
      state: project.path === "*" ? "await_custom_path" : "await_initial_prompt",
      project_id: projectId,
      custom_path_candidate: null,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    await this.slack.openModal(triggerId, this.buildSlackWizardModal({ project, channelId, userId, teamId: teamId ?? null }));
  }

  private buildSlackWizardModal(opts: { project: ProjectEntry; channelId: string; userId: string; teamId: string | null }) {
    const blocks: any[] = [];

    if (opts.project.path === "*") {
      blocks.push({
        type: "input",
        block_id: "custom_path",
        label: { type: "plain_text", text: "Project path" },
        element: { type: "plain_text_input", action_id: "input" },
        hint: { type: "plain_text", text: "Must be within allowed roots if restrict_paths=true." },
      });
    }

    blocks.push({
      type: "input",
      block_id: "prompt",
      label: { type: "plain_text", text: "Initial prompt" },
      element: { type: "plain_text_input", action_id: "input", multiline: true },
    });

    return {
      type: "modal",
      callback_id: "codex_wizard",
      private_metadata: JSON.stringify({
        projectId: opts.project.id,
        channelId: opts.channelId,
        userId: opts.userId,
        teamId: opts.teamId,
      }),
      title: { type: "plain_text", text: "Codex Session" },
      submit: { type: "plain_text", text: "Start" },
      close: { type: "plain_text", text: "Cancel" },
      blocks,
    };
  }

  private async handleSlackViewSubmission(payload: any) {
    if (!this.slack) return;
    const metaRaw = payload.view?.private_metadata as string | undefined;
    if (!metaRaw) return;
    const meta = JSON.parse(metaRaw) as { projectId: string; channelId: string; userId: string; teamId: string | null };
    const access = this.slackAccessDecision(meta.teamId, meta.channelId, meta.userId);
    if (!access.allowed) {
      this.logger.warn(
        `[slack] rejected view_submission channel=${meta.channelId} user=${meta.userId} reason=${access.reason ?? "-"}`,
      );
      return;
    }
    const values = payload.view.state?.values as Record<string, any> | undefined;

    const prompt = values?.prompt?.input?.value as string | undefined;
    const customPath = values?.custom_path?.input?.value as string | undefined;
    if (!prompt) return;

    const project = this.projectById(meta.projectId);
    const resolved = await validateAndResolveProjectPath(this.config, project, project.path === "*" ? customPath ?? null : null);

    // Create session thread root.
    const rootTs = await this.slack.postMessage({ channel: meta.channelId, text: "Session starting…" });
    if (!rootTs) throw new Error("Failed to create Slack thread");

    await clearWizardState(this.db, "slack", meta.channelId, meta.userId);

    await this.sessionManager.startNewSession({
      platform: "slack",
      workspaceId: meta.teamId,
      chatId: meta.channelId,
      spaceId: rootTs,
      spaceEmoji: null,
      userId: meta.userId,
      projectId: resolved.project_id,
      projectPathResolved: resolved.project_path_resolved,
      initialPrompt: prompt,
    });
  }

  // --- Shared session handling ---

  private async handleSessionMessage(session: SessionRow, userId: string, text: string) {
    if (session.status === "running" || session.status === "starting") {
      await enqueuePendingMessage(this.db, {
        id: crypto.randomUUID(),
        session_id: session.id,
        user_id: userId,
        message_text: text,
      });
      const n = await countPendingMessages(this.db, session.id);
      this.logger.debug(`[session] queued message session=${session.id} from=${userId} pending=${n}`);
      await this.sendToSession(session.id, { text: `Queued (${n}). I’ll run this when the current turn finishes.`, priority: "user" });
      return;
    }
    this.logger.debug(`[session] resuming session=${session.id} from=${userId}`);
    await this.sessionManager.resumeSession(session, text);
  }
}

function safeParseMeta(metaRaw: string): { channelId?: string; userId?: string } | null {
  try {
    const v = JSON.parse(metaRaw) as unknown;
    if (!v || typeof v !== "object") return null;
    const channelId = typeof (v as any).channelId === "string" ? (v as any).channelId : undefined;
    const userId = typeof (v as any).userId === "string" ? (v as any).userId : undefined;
    return { channelId, userId };
  } catch {
    return null;
  }
}

type SessionListIntent = { statuses?: SessionStatus[]; page: number };

function parseListSessionsArgs(text: string): SessionListIntent {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const remaining: string[] = [];
  let page: number | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const lower = token.toLowerCase();
    const eqMatch = lower.match(/^(?:page|p)=(\d+)$/);
    if (eqMatch) {
      const n = Number(eqMatch[1]);
      if (Number.isFinite(n) && n > 0) {
        page = n;
        continue;
      }
    }

    if (lower === "page" || lower === "p") {
      const next = tokens[i + 1];
      const n = next ? Number(next) : NaN;
      if (Number.isFinite(n) && n > 0) {
        page = n;
        i++;
        continue;
      }
    }

    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n > 0) {
        page = n;
        continue;
      }
    }

    remaining.push(token);
  }

  const statuses = parseSessionStatusFilter(remaining.join(" "));
  return { statuses, page: page ?? 1 };
}

function parseListSessionsIntentFromTelegram(text: string): SessionListIntent | null {
  const cmd = parseTelegramCommand(text);
  if (!cmd) return null;
  if (cmd.command === "sessions") return parseListSessionsArgs(cmd.args);
  if (cmd.command === "codex") {
    const rest = cmd.args.trim();
    if (!rest.toLowerCase().startsWith("sessions")) return null;
    return parseListSessionsArgs(rest.slice("sessions".length).trim());
  }
  return null;
}

function parseTelegramCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  const head = parts[0] ?? "";
  const raw = head.slice(1);
  if (!raw) return null;
  const at = raw.indexOf("@");
  const command = (at >= 0 ? raw.slice(0, at) : raw).toLowerCase();
  const args = parts.slice(1).join(" ").trim();
  return { command, args };
}

function parseListSessionsIntentFromSlack(text: string): SessionListIntent | null {
  const m = text.match(/\bsessions\b(.*)$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  return parseListSessionsArgs(rest);
}

type SettingsCommand =
  | { kind: "list" }
  | { kind: "set"; target: string; value: string }
  | { kind: "unset"; target: string };

function parseSettingsIntentFromTelegram(text: string): SettingsCommand | null {
  const cmd = parseTelegramCommand(text);
  if (!cmd) return null;
  if (cmd.command === "settings") return parseSettingsArgs(cmd.args);
  if (cmd.command !== "codex") return null;
  const rest = cmd.args.trim();
  if (!rest.toLowerCase().startsWith("settings")) return null;
  return parseSettingsArgs(rest.slice("settings".length));
}

function parseSettingsIntentFromSlack(text: string): SettingsCommand | null {
  const m = text.match(/\bsettings\b(.*)$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  return parseSettingsArgs(rest);
}

type StopCommand = { sessionId?: string };

function parseStopIntentFromTelegram(text: string): StopCommand | null {
  const cmd = parseTelegramCommand(text);
  if (!cmd) return null;
  if (cmd.command === "stop") {
    const id = cmd.args.trim();
    return id ? { sessionId: id } : {};
  }
  if (cmd.command !== "codex") return null;
  const rest = cmd.args.trim();
  if (!rest.toLowerCase().startsWith("stop")) return null;
  const remainder = rest.slice("stop".length).trim();
  return remainder ? { sessionId: remainder.split(/\s+/)[0] } : {};
}

function parseSettingsArgs(args: string): SettingsCommand | null {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "list" };
  const parts = trimmed.split(/\s+/);
  const head = (parts.shift() ?? "").toLowerCase();
  if (!head) return { kind: "list" };
  if (head === "list") return { kind: "list" };

  if (head === "mcp") {
    const sub = (parts.shift() ?? "").toLowerCase();
    if (!sub) return { kind: "list" };
    if (sub === "set" && parts.length >= 2) {
      const target = `mcp.${parts.shift()!}`;
      return { kind: "set", target, value: parts.join(" ") };
    }
    if (sub === "unset" && parts.length >= 1) {
      return { kind: "unset", target: `mcp.${parts.join(" ")}` };
    }
    return { kind: "list" };
  }

  if (head === "set" && parts.length >= 2) {
    const target = parts.shift()!;
    return { kind: "set", target, value: parts.join(" ") };
  }
  if (head === "unset" && parts.length >= 1) {
    return { kind: "unset", target: parts.join(" ") };
  }

  // Shorthand: `settings foo bar` -> treat as set
  if (parts.length >= 1) return { kind: "set", target: head, value: parts.join(" ") };
  return { kind: "list" };
}

function applySettingsCommand(config: AppConfig, cmd: SettingsCommand): string {
  if (cmd.kind === "list") return formatSettingsSummary(config);

  const parsed = resolveSettingTarget(cmd.target);
  if (!parsed) return `Unknown setting "${cmd.target}".\nSupported: ${formatSupportedSettingKeys()}`;

  if (parsed.type === "bool") {
    if (cmd.kind !== "set") return `Use "settings set ${parsed.label} <on|off>" to change it.`;
    const value = parseBool(cmd.value);
    if (value === null) return `Expected true/false value for ${parsed.label}.`;
    const prev = config.codex[parsed.key];
    (config.codex as any)[parsed.key] = value;
    return `${parsed.label} updated (${String(prev)} -> ${String(value)}). Runtime-only; affects new Codex runs. Use "settings" to view current values.`;
  }

  if (parsed.type === "number") {
    if (cmd.kind !== "set") return `Use "settings set ${parsed.label} <number>" to change it.`;
    const n = Number(cmd.value);
    if (!Number.isFinite(n)) return `Expected a number for ${parsed.label}.`;
    const next = Math.floor(n);
    if (next < parsed.min) return `${parsed.label} must be >= ${parsed.min}.`;
    const prev = config.codex[parsed.key];
    (config.codex as any)[parsed.key] = next;
    return `${parsed.label} updated (${String(prev)} -> ${String(next)}). Runtime-only; affects new Codex runs. Use "settings" to view current values.`;
  }

  if (parsed.type === "string") {
    if (cmd.kind !== "set") return `Use "settings set ${parsed.label} <value>" to change it.`;
    const next = cmd.value.trim();
    if (!next) return `${parsed.label} cannot be empty.`;
    const prev = config.codex[parsed.key];
    (config.codex as any)[parsed.key] = next;
    return `${parsed.label} updated (${prev ?? "(empty)"} -> ${next}). Runtime-only; affects new Codex runs. Use "settings" to view current values.`;
  }

  if (parsed.type === "env") {
    const key = parsed.envKey;
    if (cmd.kind === "unset") {
      if (!(key in config.codex.env)) return `Env \`${key}\` is already unset.`;
      delete config.codex.env[key];
      return `${parsed.label} removed. Runtime-only; affects new Codex runs. Use "settings" to view current values.`;
    }
    const value = cmd.value.trim();
    if (!value) return `${parsed.label} cannot be empty.`;
    const prev = config.codex.env[key];
    config.codex.env[key] = value;
    const current = formatEnvValue(value);
    const suffix = prev ? ` (was ${formatEnvValue(prev)})` : "";
    return `${parsed.label} set to ${current}${suffix}. Runtime-only; affects new Codex runs. Use "settings" to view current values.`;
  }

  return "Unsupported settings command.";
}

function parseSessionStatusFilter(text: string): SessionStatus[] | undefined {
  const t = text.toLowerCase();
  if (!t) return undefined;
  if (/\bactive\b/.test(t)) return ["starting", "running"];
  if (/\brunning\b/.test(t)) return ["running"];
  if (/\bstarting\b/.test(t)) return ["starting"];
  if (/\bfinished\b/.test(t)) return ["finished"];
  if (/\berror\b/.test(t)) return ["error"];
  if (/\bkilled\b/.test(t)) return ["killed"];
  return undefined;
}

function formatSessionFilterLabel(statuses?: SessionStatus[]): string | undefined {
  if (!statuses || statuses.length === 0) return undefined;
  const set = new Set(statuses);
  if (set.size === 2 && set.has("starting") && set.has("running")) return "active";
  if (set.size === 1) return Array.from(set)[0];
  return undefined;
}

function buildMenuText(platform: "telegram" | "slack"): string {
  const commands =
    platform === "telegram"
      ? [
          "- /sessions - list recent sessions (add 'active' to filter, 'page 2' for older ones)",
          "- /settings - list/tweak Codex + MCP config",
        ]
      : [
          '- Mention me with "sessions" to list recent sessions (add "active" or "page 2")',
          '- Mention me with "settings" to list/tweak Codex + MCP config',
        ];
  const examples = buildCommandExamples(platform);
  const lines = [`Choose a project to start a Codex session.`, ...commands, "", examples];
  return lines.join("\n");
}

function buildCommandExamples(platform: "telegram" | "slack"): string {
  const sessions = platform === "telegram" ? "/sessions active" : "@bot sessions active";
  const sessionsPage = platform === "telegram" ? "/sessions page 2" : "@bot sessions page 2";
  const settings = platform === "telegram" ? "/settings" : "@bot settings";
  const prefix = platform === "telegram" ? "" : "@bot ";
  const envSet = `${prefix}settings set mcp.SEARCH http://localhost:3000`;
  const envUnset = `${prefix}settings unset mcp.SEARCH`;
  return [
    "Examples:",
    `- \`${sessions}\``,
    `- \`${sessionsPage}\``,
    `- \`${settings}\``,
    `- \`${prefix}settings set codex.timeout_seconds 1800\``,
    `- \`${envSet}\``,
    `- \`${envUnset}\``,
  ].join("\n");
}

type BoolSettingKey = "full_auto" | "dangerously_bypass_approvals_and_sandbox" | "skip_git_repo_check";
type NumberSettingKey = "timeout_seconds" | "poll_interval_ms" | "max_catchup_lines";
type StringSettingKey = "binary" | "sessions_dir";

function resolveSettingTarget(
  raw: string,
):
  | { type: "bool"; key: BoolSettingKey; label: string }
  | { type: "number"; key: NumberSettingKey; label: string; min: number }
  | { type: "string"; key: StringSettingKey; label: string }
  | { type: "env"; envKey: string; label: string }
  | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  if (lower === "full_auto" || lower === "codex.full_auto") return { type: "bool", key: "full_auto", label: "`codex.full_auto`" };
  if (lower === "dangerously_bypass_approvals_and_sandbox" || lower === "codex.dangerously_bypass_approvals_and_sandbox")
    return { type: "bool", key: "dangerously_bypass_approvals_and_sandbox", label: "`codex.dangerously_bypass_approvals_and_sandbox`" };
  if (lower === "skip_git_repo_check" || lower === "codex.skip_git_repo_check")
    return { type: "bool", key: "skip_git_repo_check", label: "`codex.skip_git_repo_check`" };

  if (lower === "timeout_seconds" || lower === "codex.timeout_seconds")
    return { type: "number", key: "timeout_seconds", label: "`codex.timeout_seconds`", min: 10 };
  if (lower === "poll_interval_ms" || lower === "codex.poll_interval_ms")
    return { type: "number", key: "poll_interval_ms", label: "`codex.poll_interval_ms`", min: 100 };
  if (lower === "max_catchup_lines" || lower === "codex.max_catchup_lines")
    return { type: "number", key: "max_catchup_lines", label: "`codex.max_catchup_lines`", min: 1 };

  if (lower === "binary" || lower === "codex.binary") return { type: "string", key: "binary", label: "`codex.binary`" };
  if (lower === "sessions_dir" || lower === "codex.sessions_dir")
    return { type: "string", key: "sessions_dir", label: "`codex.sessions_dir`" };

  if (lower.startsWith("codex.env.")) {
    const key = trimmed.slice("codex.env.".length).trim();
    if (!key) return null;
    return { type: "env", envKey: key, label: `Env \`${key}\`` };
  }

  if (lower.startsWith("env.")) {
    const key = trimmed.slice("env.".length).trim();
    if (!key) return null;
    return { type: "env", envKey: key, label: `Env \`${key}\`` };
  }

  if (lower.startsWith("mcp.")) {
    const key = trimmed.slice("mcp.".length).trim();
    if (!key) return null;
    const envKey = normalizeEnvKey(key, { forceMcp: true });
    if (!envKey) return null;
    return { type: "env", envKey, label: `MCP \`${envKey}\`` };
  }

  return null;
}

function formatSupportedSettingKeys(): string {
  return [
    "`codex.full_auto`",
    "`codex.dangerously_bypass_approvals_and_sandbox`",
    "`codex.skip_git_repo_check`",
    "`codex.timeout_seconds`",
    "`codex.poll_interval_ms`",
    "`codex.max_catchup_lines`",
    "`codex.binary`",
    "`codex.sessions_dir`",
    "`codex.env.<KEY>`",
    "`mcp.<NAME>`",
  ].join(", ");
}

function formatSettingsSummary(config: AppConfig): string {
  const lines = [
    "Settings (runtime only; not saved to config.toml):",
    `- \`codex.binary\`: ${config.codex.binary}`,
    `- \`codex.sessions_dir\`: ${config.codex.sessions_dir}`,
    `- \`codex.timeout_seconds\`: ${String(config.codex.timeout_seconds)}`,
    `- \`codex.poll_interval_ms\`: ${String(config.codex.poll_interval_ms)}`,
    `- \`codex.max_catchup_lines\`: ${String(config.codex.max_catchup_lines)}`,
    `- \`codex.full_auto\`: ${String(config.codex.full_auto)}`,
    `- \`codex.dangerously_bypass_approvals_and_sandbox\`: ${String(config.codex.dangerously_bypass_approvals_and_sandbox)}`,
    `- \`codex.skip_git_repo_check\`: ${String(config.codex.skip_git_repo_check)}`,
  ];

  const envEntries = Object.entries(config.codex.env);
  if (envEntries.length === 0) lines.push("- env overrides: (none)");
  else {
    lines.push("- env overrides:");
    for (const [k, v] of envEntries) lines.push(`  - \`${k}\` = ${formatEnvValue(v)}`);
  }

  const mcpEntries = envEntries.filter(([k]) => k.toUpperCase().startsWith("MCP_"));
  if (mcpEntries.length === 0) lines.push("- MCP env: (none)");
  else {
    lines.push("- MCP env:");
    for (const [k, v] of mcpEntries) lines.push(`  - \`${k}\` = ${formatEnvValue(v)}`);
  }

  lines.push("", "Examples:", "- settings set codex.timeout_seconds 1800", "- settings set mcp.SEARCH http://localhost:3000", "- settings unset mcp.SEARCH");
  return lines.join("\n");
}

function formatEnvValue(value: string): string {
  const redacted = redactText(value);
  if (!redacted) return "(empty)";
  if (redacted.length > 80) return `${redacted.slice(0, 60)}… (${redacted.length} chars)`;
  return redacted;
}

function parseBool(input: string): boolean | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  if (["1", "true", "yes", "y", "on"].includes(t)) return true;
  if (["0", "false", "no", "n", "off"].includes(t)) return false;
  return null;
}

function normalizeEnvKey(raw: string, opts?: { forceMcp?: boolean }): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const normalized = trimmed.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (opts?.forceMcp) {
    const upper = normalized.toUpperCase();
    return upper.startsWith("MCP_") ? upper : `MCP_${upper}`;
  }
  return normalized;
}

function telegramChatIdMatchesAllowlist(chatId: string, allowIds: string[]): boolean {
  if (allowIds.length === 0) return true;
  const c = chatId.trim();
  const candidates = new Set<string>([c]);

  if (c.startsWith("-100") && c.length > 4) candidates.add(c.slice(4));
  if (c.startsWith("-") && c.length > 1) candidates.add(c.slice(1));

  for (const raw of allowIds) {
    const a = String(raw).trim();
    if (candidates.has(a)) return true;
  }
  return false;
}

function safeSnippet(text: string, maxLen = 200): string {
  const redacted = redactText(text);
  const oneLine = redacted.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}…`;
}

function truncateWithEllipsis(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return text.slice(0, 1);
  return `${text.slice(0, maxLen - 1)}…`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateHtmlEscapedWithEllipsis(escapedText: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (escapedText.length <= maxLen) return escapedText;
  if (maxLen === 1) return "…";

  const budget = maxLen - 1;
  let prefix = escapedText.slice(0, budget);
  const lastAmp = prefix.lastIndexOf("&");
  const lastSemi = prefix.lastIndexOf(";");
  if (lastAmp > lastSemi) prefix = prefix.slice(0, lastAmp);
  return `${prefix}…`;
}

function buildTelegramCustomEmojiEntity(text: string, emoji: string, customEmojiId: string): TelegramMessageEntity | null {
  const offset = text.lastIndexOf(emoji);
  if (offset < 0) return null;
  return { type: "custom_emoji", offset, length: emoji.length, custom_emoji_id: customEmojiId };
}

const TOPIC_EMOJIS = [
  "🧠",
  "🛠️",
  "🚀",
  "🧩",
  "🧪",
  "🧰",
  "📌",
  "📎",
  "📝",
  "🔎",
  "🧭",
  "⚙️",
  "🧵",
  "🗂️",
  "🗒️",
  "📦",
  "🛰️",
  "🧯",
  "🧱",
  "🔧",
  "🔨",
  "🪄",
  "🧿",
  "🧷",
  "🧬",
  "📡",
  "🧑‍💻",
  "🕵️",
  "🧾",
  "🗳️",
];

function pickTopicEmoji(): string {
  if (TOPIC_EMOJIS.length === 0) return "🧠";
  const idx = Math.floor(Math.random() * TOPIC_EMOJIS.length);
  return TOPIC_EMOJIS[idx] ?? "🧠";
}

function clipForumTopicName(name: string): string {
  const oneLine = name.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 128) return oneLine;
  return oneLine.slice(0, 128).trimEnd();
}

function buildSessionsCommand(platform: "telegram" | "slack", filterLabel: string | undefined, page: number): string {
  const parts = [platform === "telegram" ? "/sessions" : "@bot sessions"];
  if (filterLabel) parts.push(filterLabel);
  if (page > 1) parts.push("page", String(page));
  return parts.join(" ");
}

function formatSessionList(
  platform: "telegram" | "slack",
  opts: SessionListPage & { filterLabel?: string },
): string {
  const filterSuffix = opts.filterLabel ? ` (${opts.filterLabel})` : "";
  if (opts.sessions.length === 0) {
    if (opts.page <= 1) return "No sessions in this chat yet.";
    const prev = opts.page > 1 ? buildSessionsCommand(platform, opts.filterLabel, opts.page - 1) : null;
    const hint = prev ? ` Try ${prev}.` : "";
    return `No sessions${filterSuffix} on page ${opts.page}.${hint}`;
  }

  const header = `Sessions${filterSuffix} (page ${opts.page}, ${opts.limit} per page, newest first):`;
  const lines = opts.sessions.map((s) => formatSessionLine(platform, s));
  const nav: string[] = [];
  if (opts.page > 1) nav.push(buildSessionsCommand(platform, opts.filterLabel, opts.page - 1));
  if (opts.hasMore) nav.push(buildSessionsCommand(platform, opts.filterLabel, opts.page + 1));
  const navText = nav.length > 0 ? `\n\nNavigation: \`${nav.join("` | `")}\`` : "";
  return `${header}\n${lines.map((l) => `- ${l}`).join("\n")}${navText}`;
}

function formatSessionLine(platform: "telegram" | "slack", s: SessionRow): string {
  const emoji = formatSessionEmoji(platform, s);
  const url = formatSessionLink(platform, s);
  const emojiLabel = url ? formatEmojiLink(platform, emoji, url) : emoji;
  const age = formatRelativeAge(s.created_at);
  return `${emojiLabel} ${s.status} ${s.project_id} ${age}`;
}

function formatSessionEmoji(platform: "telegram" | "slack", s: SessionRow): string {
  const stored = (s.space_emoji ?? "").trim();
  if (stored) return stored;
  return platform === "telegram" ? "🧠" : "💬";
}

function formatEmojiLink(platform: "telegram" | "slack", emoji: string, url: string): string {
  if (platform === "slack") return `<${url}|${emoji}>`;
  return `[${emoji}](${url})`;
}

function formatSessionLink(platform: "telegram" | "slack", s: SessionRow): string | null {
  if (platform === "telegram") return buildTelegramTopicUrl(s.chat_id, s.space_id);
  return buildSlackPermalink(s.workspace_id, s.chat_id, s.space_id);
}

function buildTelegramTopicUrl(chatId: string, spaceId: string): string | null {
  const normalizedChat = normalizeTelegramChatIdForUrl(chatId);
  const topic = spaceId.trim();
  if (!normalizedChat || !topic) return null;
  const chatPart = encodeURIComponent(normalizedChat);
  const topicPart = encodeURIComponent(topic);
  return `https://t.me/c/${chatPart}/${topicPart}`;
}

function normalizeTelegramChatIdForUrl(chatId: string): string | null {
  const trimmed = chatId.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("-100") && trimmed.length > 4) return trimmed.slice(4);
  if (trimmed.startsWith("-") && trimmed.length > 1) return trimmed.slice(1);
  return trimmed;
}

function buildSlackPermalink(workspaceId: string | null, channelId: string, spaceId: string): string | null {
  if (!workspaceId) return null;
  const base = `https://app.slack.com/client/${encodeURIComponent(workspaceId)}/${encodeURIComponent(channelId)}`;
  const threadTs = spaceId.trim();
  if (!threadTs || threadTs === channelId) return base;
  return `${base}/thread/${encodeURIComponent(channelId)}-${encodeURIComponent(threadTs)}`;
}

function formatRelativeAge(createdAt: unknown): string {
  const ts = toNumber(createdAt);
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const diffMs = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}hr${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 18) return `${months}mo ago`;

  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return NaN;
}
