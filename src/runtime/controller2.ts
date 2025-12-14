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
import type { SessionRow, WizardStateRow } from "./store.js";
import { nowMs } from "./util.js";

const REVIEW_PROMPT = "Run codex review";
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
  ) {}

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
      const sessions = await listSessionsForChat({
        db: this.db,
        platform: "telegram",
        chatId,
        statuses: listIntent.statuses,
        limit: 20,
      });
	      await this.telegram.sendMessage({
	        chatId,
	        messageThreadId: forumThreadId,
	        replyToMessageId: message.message_id,
	        text: formatSessionList("telegram", sessions),
	        priority: "user",
	      });
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
          const statuses = parseSessionStatusFilter(rest.slice("sessions".length).trim());
          const sessions = await listSessionsForChat({
            db: this.db,
            platform: "telegram",
            chatId,
            statuses,
            limit: 20,
          });
	          await this.telegram.sendMessage({
	            chatId,
	            messageThreadId: forumThreadId,
	            replyToMessageId: message.message_id,
	            text: formatSessionList("telegram", sessions),
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
    if (message.is_topic_message !== true) return undefined;
    const id = message.message_thread_id;
    if (typeof id !== "number" || id <= 0) return undefined;
    return id;
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

	    await this.telegram.sendMessage({
	      chatId,
	      text: "Choose a project:",
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

      await this.telegram.answerCallbackQuery(cb.id, "Starting review…");
      try {
        await this.handleSessionMessage(session as SessionRow, userId, REVIEW_PROMPT);
      } catch (e) {
        this.logger.warn(
          `[tg] review callback failed chat=${chatId} user=${userId} session=${sessionId}: ${String(e)}`,
        );
	        await this.telegram.sendMessage({
	          chatId,
	          messageThreadId: this.telegramForumThreadIdFromMessage(cb.message),
	          replyToMessageId: cb.message?.message_id,
	          text: `Error: ${redactText(e instanceof Error ? e.message : String(e))}`,
	          priority: "user",
	        });
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
        const sessions = await listSessionsForChat({
          db: this.db,
          platform: "slack",
          workspaceId: teamId,
          chatId: channelId,
          statuses: listIntent.statuses,
          limit: 20,
        });
        await this.slack.postEphemeral({
          channel: channelId,
          user: userId,
          text: formatSessionList("slack", sessions),
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

    await this.slack.postEphemeral({
      channel: channelId,
      user: userId,
      text: "Choose a project to start a Codex session:",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Choose a project:" },
          accessory: {
            type: "static_select",
            action_id: "project_select",
            placeholder: { type: "plain_text", text: "Select a project" },
            options,
          },
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

function parseListSessionsIntentFromTelegram(text: string): { statuses?: SessionStatus[] } | null {
  const cmd = parseTelegramCommand(text);
  if (!cmd) return null;
  if (cmd.command === "sessions") return { statuses: parseSessionStatusFilter(cmd.args) };
  if (cmd.command === "codex") {
    const rest = cmd.args.trim();
    if (!rest.toLowerCase().startsWith("sessions")) return null;
    return { statuses: parseSessionStatusFilter(rest.slice("sessions".length).trim()) };
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

function parseListSessionsIntentFromSlack(text: string): { statuses?: SessionStatus[] } | null {
  const m = text.match(/\bsessions\b(.*)$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  return { statuses: parseSessionStatusFilter(rest) };
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

function formatSessionList(platform: "telegram" | "slack", sessions: SessionRow[]): string {
  if (sessions.length === 0) return "No sessions in this chat yet.";
  const header = `Sessions (${sessions.length}, newest first):`;
  const lines = sessions.map((s) => formatSessionLine(platform, s));
  return `${header}\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

function formatSessionLine(platform: "telegram" | "slack", s: SessionRow): string {
  const createdAt = toIso(s.created_at);
  const codex = s.codex_session_id ? shortId(s.codex_session_id) : "-";
  const workspace = platform === "slack" ? (s.workspace_id ? ` workspace=${s.workspace_id}` : "") : "";
  return `id=${shortId(s.id)} status=${s.status} project=${s.project_id} space=${s.space_id} codex=${codex}${workspace} created=${createdAt}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function toIso(ms: unknown): string {
  const n = typeof ms === "number" ? ms : typeof ms === "bigint" ? Number(ms) : typeof ms === "string" ? Number(ms) : 0;
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n).toISOString();
}
