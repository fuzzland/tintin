import crypto from "node:crypto";
import type { AppConfig, ProjectEntry } from "../config.js";
import type { Db, SessionAgent } from "../db.js";
import type { Logger } from "../log.js";
import { SessionStartError, type SessionManager } from "../sessionManager.js";
import {
  TelegramClient,
  type TelegramCallbackQuery,
  type TelegramChat,
  type TelegramMessage,
  type TelegramUpdate,
} from "../platform/telegram.js";
import { getAgentAdapter } from "../agents.js";
import { redactText } from "../redact.js";
import { validateAndResolveProjectPath } from "../security.js";
import { nowMs } from "../util.js";
import { getOtherLanguage, isUserLanguage, t, type UserLanguage } from "../../locales/index.js";
import {
  normalizeLanguageToken,
  parseCloudCommand,
  parseLanguageCommandFromTelegram,
  parseListSessionsIntentFromTelegram,
  parseSettingsIntentFromTelegram,
  truncateText,
} from "./commands.js";
import {
  applyCloudSettingsCommand,
  applyIdentitySettingsCommand,
  applySettingsCommand,
  formatSettingsSummary,
} from "./settings.js";
import {
  agentShortName,
  buildMenuText,
  detectAgentFromTelegramMessageText,
  formatSessionFilterLabel,
  formatSessionList,
} from "./sessions.js";
import {
  buildTelegramCustomEmojiEntity,
  clipForumTopicName,
  escapeHtml,
  pickTopicEmoji,
  safeSnippet,
  truncateHtmlEscapedWithEllipsis,
} from "./utils.js";
import {
  clearWizardState,
  getSessionBySpace,
  getWizardState,
  listSessionsForChat,
  setUserLanguage,
  setWizardState,
  updateSession,
} from "../store.js";
import {
  getOrCreateIdentity,
  listSecrets,
} from "../cloud/store.js";
import type { CloudCommand } from "./commands.js";
import type { CommitProposalAction, SharedInteractionAction } from "./types.js";
import type { SessionRow, WizardStateRow } from "../store.js";

export type TelegramAccessDecision = { allowed: boolean; reason?: string };

export type HandleCloudHelp = (opts: {
  platform: "telegram";
  chatId: string;
  userId: string;
  workspaceId: null;
  replyToMessageId?: number;
  messageThreadId?: number;
}) => Promise<void>;

export type HandleCloudCommand = (opts: {
  platform: "telegram";
  command: CloudCommand;
  chatId: string;
  workspaceId: null;
  userId: string;
  isDirect: boolean;
  spaceId: string;
  replyToMessageId?: number;
  messageThreadId?: number;
}) => Promise<boolean>;

export type HandleSharedInteractionAction = (opts: {
  platform: "telegram";
  action: SharedInteractionAction;
  chatId: string;
  userId: string;
  workspaceId: null;
  messageId?: string;
  messageText?: string;
  interactionId?: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  isDirect?: boolean;
}) => Promise<boolean>;

export interface TelegramHandlerDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  telegram: TelegramClient | null;
  sessionManager: SessionManager;
  lookupTelegramSessionByReply: ((chatId: string, messageId: number) => string | null) | null;
  resolveUserLanguage: (platform: "telegram" | "slack", userId: string) => Promise<UserLanguage>;
  telegramAccessDecision: (chatId: string, userId: string) => Promise<TelegramAccessDecision>;
  sendCloudHelp: HandleCloudHelp;
  handleCloudCommand: HandleCloudCommand;
  handleSharedInteractionAction: HandleSharedInteractionAction;
  handleSessionMessage: (session: SessionRow, userId: string, text: string) => Promise<void>;
  projectById: (projectId: string) => ProjectEntry;
}

type TelegramReplyContext = { replyToMessageId: number; messageThreadId?: number; chat: TelegramChat };

const SESSION_LIST_PAGE_SIZE = 20;

export class TelegramHandler {
  constructor(private readonly deps: TelegramHandlerDeps) {}

  async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    if (!this.deps.telegram) return;

    this.deps.logger.debug(
      `[tg] update received update_id=${String(update.update_id)} keys=${Object.keys(update as any).join(",")}`,
    );

    if (update.callback_query) {
      try {
        await this.handleTelegramCallback(update.callback_query);
      } catch (e) {
        this.deps.logger.warn("telegram callback handler error", e);
        const chat = update.callback_query.message?.chat;
        const chatId = chat ? String(chat.id) : null;
        const replyToMessageId = update.callback_query.message?.message_id;
        if (chatId && typeof replyToMessageId === "number") {
          const msg = e instanceof Error ? e.message : String(e);
          const actorId = update.callback_query.from?.id;
          const lang = actorId ? await this.deps.resolveUserLanguage("telegram", String(actorId)) : "en";
          try {
            await this.deps.telegram.sendMessage({
              chatId,
              messageThreadId: this.telegramForumThreadIdFromMessage(update.callback_query.message ?? undefined),
              replyToMessageId,
              text: t("error.generic", lang, { message: redactText(msg) }),
              priority: "user",
            });
          } catch {}
        }
      }
      return;
    }

    const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
    if (!message) {
      this.deps.logger.debug(`[tg] update ${String(update.update_id)} ignored (no message/callback_query)`);
      return;
    }
    const actorUserId =
      typeof message.from?.id === "number"
        ? String(message.from.id)
        : typeof message.sender_chat?.id === "number"
          ? String(message.sender_chat.id)
          : null;
    if (!actorUserId) {
      this.deps.logger.warn(
        `[tg] message ignored (missing from/sender_chat) chat=${String(message.chat?.id ?? "?")} message_id=${String(
          message.message_id ?? "?",
        )}`,
      );
      return;
    }
    try {
      await this.handleTelegramMessage(message, actorUserId);
    } catch (e) {
      this.deps.logger.warn("telegram message handler error", e);
      const chatId = String(message.chat.id);
      const msg = e instanceof Error ? e.message : String(e);
      try {
        const lang = await this.deps.resolveUserLanguage("telegram", actorUserId);
        await this.deps.telegram.sendMessage({
          chatId,
          messageThreadId: this.telegramForumThreadIdFromMessage(message),
          replyToMessageId: message.message_id,
          text: t("error.generic", lang, { message: redactText(msg) }),
          priority: "user",
        });
      } catch {}
    }
  }

  buildRunActionTelegramKeyboard(sessionId: string, runId: string, lang: UserLanguage, viewUrl?: string | null, vscodeUrl?: string | null) {
    const rows: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
      [
        { text: t("button.stop", lang), callback_data: `kill:${sessionId}` },
        { text: t("button.status", lang), callback_data: `run_status:${runId}` },
      ],
    ];
    const linkRow: Array<{ text: string; url: string }> = [];
    if (viewUrl) linkRow.push({ text: t("button.view", lang), url: viewUrl });
    if (vscodeUrl) linkRow.push({ text: t("button.vscode", lang), url: vscodeUrl });
    if (linkRow.length > 0) rows.push(linkRow);
    return { inline_keyboard: rows };
  }

  parseTelegramInteractionAction(data: string): SharedInteractionAction | null {
    if (data.startsWith("lang:")) {
      const next = data.slice("lang:".length);
      return isUserLanguage(next) ? { kind: "lang", value: next } : null;
    }
    if (data.startsWith("kill:")) {
      const sessionId = data.slice("kill:".length);
      return sessionId ? { kind: "kill", sessionId } : null;
    }
    if (data.startsWith("review:")) {
      const sessionId = data.slice("review:".length);
      return sessionId ? { kind: "review", sessionId } : null;
    }
    if (data.startsWith("commit:")) {
      const sessionId = data.slice("commit:".length);
      return sessionId ? { kind: "commit", sessionId } : null;
    }
    if (data.startsWith("run_status:")) {
      const runId = data.slice("run_status:".length).trim();
      return runId ? { kind: "run_status", runId } : null;
    }
    if (data.startsWith("stop_sandbox:")) {
      const sessionId = data.slice("stop_sandbox:".length);
      return sessionId ? { kind: "stop_sandbox", sessionId } : null;
    }
    if (data.startsWith("cpr:")) {
      const rest = data.slice("cpr:".length);
      const [proposalId, actionRaw] = rest.split(":");
      const action = (actionRaw ?? "").trim() as CommitProposalAction;
      if (!proposalId || (action !== "cancel" && action !== "push" && action !== "pr")) return null;
      return { kind: "commit_proposal", proposalId, action };
    }
    return null;
  }

  async disableReviewCommitButtonsTelegram(opts: { chatId: string; messageId: number; text?: string; note?: string }) {
    if (!this.deps.telegram) return;
    const note = (opts.note ?? "").trim();
    const baseText = typeof opts.text === "string" ? opts.text : "";
    const updatedText =
      note.length > 0 && !baseText.includes(note) ? `${baseText}${baseText.trim() ? "\n" : ""}${note}` : baseText;

    const shouldEditText = updatedText.length > 0 || note.length > 0;

    if (shouldEditText) {
      try {
        await this.deps.telegram.editMessageText({
          chatId: opts.chatId,
          messageId: opts.messageId,
          text: updatedText || note,
          replyMarkup: null,
          priority: "user",
        });
        return;
      } catch (e) {
        this.deps.logger.debug(`[tg] failed to edit message text chat=${opts.chatId} message=${opts.messageId}: ${String(e)}`);
      }
    }

    try {
      await this.deps.telegram.editMessageReplyMarkup({
        chatId: opts.chatId,
        messageId: opts.messageId,
        replyMarkup: null,
        priority: "user",
      });
    } catch (e) {
      this.deps.logger.debug(
        `[tg] failed to clear reply markup chat=${opts.chatId} message=${opts.messageId}: ${String(e)}`,
      );
    }
  }

  telegramSpaceIdsFromMessage(message: TelegramMessage): string[] {
    const out: string[] = [];
    if (typeof message.message_id === "number") out.push(String(message.message_id));
    if (typeof message.message_thread_id === "number" && message.message_thread_id > 0) {
      out.push(String(message.message_thread_id));
    }
    if (message.reply_to_message) {
      const replyId = String(message.reply_to_message.message_id);
      if (!out.includes(replyId)) out.push(replyId);
    }
    return out;
  }

  telegramForumThreadIdFromMessage(message?: TelegramMessage): number | undefined {
    if (!message) return undefined;
    const id = message.message_thread_id;
    if (typeof id !== "number" || id <= 0) return undefined;
    return id;
  }

  isTelegramTopicSession(session: { platform: string; space_emoji: string | null }): boolean {
    return session.platform === "telegram" && typeof session.space_emoji === "string" && session.space_emoji.trim().length > 0;
  }

  private resolveSessionLanguage(session: SessionRow): UserLanguage {
    return isUserLanguage(session.language) ? session.language : "en";
  }

  private async handleTelegramMessage(message: TelegramMessage, userId: string) {
    if (!this.deps.telegram) return;
    const chatId = String(message.chat.id);
    const forumThreadId = this.telegramForumThreadIdFromMessage(message);
    const text = (message.text ?? "").trim();
    const cloudEnabled = Boolean(this.deps.config.cloud?.enabled);
    this.deps.logger.debug(
      `[tg] message received chat=${chatId} user=${userId} message_id=${String(message.message_id)} thread=${String(
        message.message_thread_id ?? "-",
      )} reply_to=${String(message.reply_to_message?.message_id ?? "-")} text=${JSON.stringify(safeSnippet(text))}`,
    );
    if (!text) return;
    const lang = await this.deps.resolveUserLanguage("telegram", userId);

    try {
      await this.deps.telegram.setMessageReaction({ chatId, messageId: message.message_id, emoji: "👍" });
    } catch (e) {
      this.deps.logger.debug(
        `[tg] set reaction failed chat=${chatId} message_id=${String(message.message_id)}: ${String(e)}`,
      );
      try {
        await this.deps.telegram.sendMessageSingle({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: "👍",
          priority: "user",
        });
      } catch (sendErr) {
        this.deps.logger.debug(
          `[tg] thumbs up fallback send failed chat=${chatId} message_id=${String(message.message_id)}: ${String(sendErr)}`,
        );
      }
    }

    const listIntent = parseListSessionsIntentFromTelegram(text);
    if (listIntent) {
      const access = await this.deps.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.deps.logger.warn(`[tg] rejected list sessions chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
        await this.deps.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: t("error.not_authorized", lang),
          priority: "user",
        });
        return;
      }
      const sessionPage = await listSessionsForChat({
        db: this.deps.db,
        platform: "telegram",
        chatId,
        statuses: listIntent.statuses,
        limit: SESSION_LIST_PAGE_SIZE,
        page: listIntent.page,
      });
      await this.deps.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: message.message_id,
        text: formatSessionList("telegram", lang, { ...sessionPage, filterLabel: formatSessionFilterLabel(listIntent.statuses) }),
        priority: "user",
      });
      return;
    }

    const settingsIntent = parseSettingsIntentFromTelegram(text);
    if (settingsIntent) {
      const access = await this.deps.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.deps.logger.warn(`[tg] rejected settings chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
        await this.deps.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: t("error.not_authorized", lang),
          priority: "user",
        });
        return;
      }
      const identity = await getOrCreateIdentity(this.deps.db, { platform: "telegram", workspaceId: null, userId });
      if (settingsIntent.cmd.kind === "list") {
        let cloudKeyStatus: { openai: boolean; anthropic: boolean } | null = null;
        if (this.deps.config.cloud?.enabled) {
          const secrets = await listSecrets(this.deps.db, identity.id);
          const names = new Set(secrets.map((s) => s.name));
          cloudKeyStatus = {
            openai: names.has("OPENAI_API_KEY"),
            anthropic: names.has("ANTHROPIC_API_KEY"),
          };
        }
        const result = formatSettingsSummary(this.deps.config, settingsIntent.defaultAgent, "telegram", lang, identity, cloudKeyStatus);
        await this.deps.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: result,
          priority: "user",
        });
        return;
      }
      const cloudResult = await applyCloudSettingsCommand({
        config: this.deps.config,
        db: this.deps.db,
        cmd: settingsIntent.cmd,
        identityId: identity.id,
        lang,
      });
      const identityResult = await applyIdentitySettingsCommand({
        config: this.deps.config,
        db: this.deps.db,
        cmd: settingsIntent.cmd,
        identityId: identity.id,
        lang,
      });
      const result =
        identityResult ??
        cloudResult ??
        applySettingsCommand(this.deps.config, settingsIntent.cmd, settingsIntent.defaultAgent, "telegram", lang);
      await this.deps.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: message.message_id,
        text: result,
        priority: "user",
      });
      return;
    }

    const languageCmd = parseLanguageCommandFromTelegram(text);
    if (languageCmd) {
      await this.handleLanguageCommandTelegram({
        message,
        userId,
        rawArg: languageCmd.raw,
      });
      return;
    }

    const cloudCmd = text.startsWith("/") ? parseCloudCommand(text) : null;
    if (cloudCmd) {
      await this.deps.handleCloudCommand({
        platform: "telegram",
        command: cloudCmd,
        chatId,
        workspaceId: null,
        userId,
        isDirect: message.chat.type === "private",
        spaceId: String(message.message_id),
        replyToMessageId: message.message_id,
        messageThreadId: forumThreadId,
      });
      return;
    }

    const spaceIds = this.telegramSpaceIdsFromMessage(message);
    for (const spaceId of spaceIds) {
      const session = await getSessionBySpace(this.deps.db, "telegram", chatId, spaceId);
      if (!session) continue;

      const access = await this.deps.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.deps.logger.warn(
          `[tg] rejected session message chat=${chatId} user=${userId} space=${spaceId} session=${session.id} reason=${access.reason ?? "-"}`,
        );
        await this.deps.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: t("error.not_authorized", lang),
          priority: "user",
        });
        return;
      }
      this.deps.logger.debug(`[tg] routed to session id=${session.id} status=${session.status} space=${spaceId}`);
      await updateSession(this.deps.db, session.id, { last_user_message_at: nowMs() });
      await this.deps.handleSessionMessage(session, userId, text);
      return;
    }
    if (spaceIds.length > 0) {
      this.deps.logger.debug(`[tg] no session for space=${spaceIds.join(",")} chat=${chatId} user=${userId}`);
    }

    if (this.deps.lookupTelegramSessionByReply && message.reply_to_message?.message_id) {
      const replyId = message.reply_to_message.message_id;
      const mappedSessionId = this.deps.lookupTelegramSessionByReply(chatId, replyId);
      if (mappedSessionId) {
        const session = await this.deps.db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", mappedSessionId)
          .executeTakeFirst();
        if (session && session.platform === "telegram" && session.chat_id === chatId) {
          const access = await this.deps.telegramAccessDecision(chatId, userId);
          if (!access.allowed) {
            this.deps.logger.warn(
              `[tg] rejected reply session chat=${chatId} user=${userId} session=${session.id} reason=${access.reason ?? "-"}`,
            );
            await this.deps.telegram.sendMessage({
              chatId,
              messageThreadId: forumThreadId,
              replyToMessageId: message.message_id,
              text: t("error.not_authorized", lang),
              priority: "user",
            });
            return;
          }
          this.deps.logger.debug(`[tg] reply mapped to session id=${session.id} status=${session.status} reply_to=${replyId}`);
          await updateSession(this.deps.db, session.id, { last_user_message_at: nowMs() });
          await this.deps.handleSessionMessage(session, userId, text);
          return;
        }
        this.deps.logger.debug(`[tg] reply mapped to missing session id=${mappedSessionId} reply_to=${replyId}`);
      }
    }

    if (cloudEnabled && text.startsWith("/")) {
      await this.deps.sendCloudHelp({
        platform: "telegram",
        chatId,
        userId,
        workspaceId: null,
        replyToMessageId: message.message_id,
        messageThreadId: forumThreadId,
      });
      return;
    }

    if (text.startsWith("/") && this.deps.telegram.isMentionOrCommand(message)) {
      const access = await this.deps.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.deps.logger.warn(`[tg] rejected wizard start chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
        await this.deps.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: t("error.not_authorized", lang),
          priority: "user",
        });
        return;
      }
      this.deps.logger.debug(`[tg] starting wizard chat=${chatId} user=${userId}`);
      const agent = detectAgentFromTelegramMessageText(text);
      try {
        getAgentAdapter(agent).requireConfig(this.deps.config);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.deps.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: t("error.generic", lang, { message: redactText(msg) }),
          priority: "user",
        });
        return;
      }
      await this.startTelegramWizard(chatId, userId, message.message_id, forumThreadId, agent);
      return;
    }

    const wizard = await getWizardState(this.deps.db, "telegram", chatId, userId);
    if (!wizard) {
      this.deps.logger.debug(`[tg] message ignored (no wizard/session match) chat=${chatId} user=${userId}`);
      return;
    }
    const access = await this.deps.telegramAccessDecision(chatId, userId);
    if (!access.allowed) {
      this.deps.logger.warn(`[tg] rejected wizard continuation chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
      await this.deps.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: message.message_id,
        text: t("error.not_authorized", lang),
        priority: "user",
      });
      return;
    }
    this.deps.logger.debug(`[tg] wizard continuation state=${wizard.state} chat=${chatId} user=${userId}`);
    await this.continueTelegramWizard(wizard, text, {
      replyToMessageId: message.message_id,
      messageThreadId: forumThreadId,
      chat: message.chat,
    });
  }

  private async handleLanguageCommandTelegram(opts: { message: TelegramMessage; userId: string; rawArg: string }) {
    if (!this.deps.telegram) return;
    const chatId = String(opts.message.chat.id);
    const forumThreadId = this.telegramForumThreadIdFromMessage(opts.message);
    const fallbackLang = await this.deps.resolveUserLanguage("telegram", opts.userId);
    const access = await this.deps.telegramAccessDecision(chatId, opts.userId);
    if (!access.allowed) {
      await this.deps.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: opts.message.message_id,
        text: t("error.not_authorized", fallbackLang),
        priority: "user",
      });
      return;
    }

    const raw = opts.rawArg.trim();
    const requested = raw ? normalizeLanguageToken(raw) : null;
    if (raw && !requested) {
      const text = `${t("lang.invalid", fallbackLang)}\n${t("lang.usage", fallbackLang, { cmd: "/lang en" })}`;
      await this.deps.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: opts.message.message_id,
        text,
        priority: "user",
      });
      return;
    }

    const spaceIds = this.telegramSpaceIdsFromMessage(opts.message);
    let session: SessionRow | null = null;
    for (const spaceId of spaceIds) {
      const found = await getSessionBySpace(this.deps.db, "telegram", chatId, spaceId);
      if (found) {
        session = found;
        break;
      }
    }
    if (!session) {
      const nextLang = requested ?? getOtherLanguage(fallbackLang);
      await setUserLanguage(this.deps.db, "telegram", opts.userId, nextLang);
      await this.deps.db
        .updateTable("sessions")
        .set({ language: nextLang, updated_at: nowMs() })
        .where("platform", "=", "telegram")
        .where("chat_id", "=", chatId)
        .where("created_by_user_id", "=", opts.userId)
        .where("status", "in", ["starting", "running"])
        .execute();
      const confirmKey = nextLang === "zh" ? "lang.default_set_zh" : "lang.default_set_en";
      await this.deps.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: opts.message.message_id,
        text: t(confirmKey, nextLang),
        priority: "user",
      });
      return;
    }

    const currentLang = this.resolveSessionLanguage(session);
    const nextLang = requested ?? getOtherLanguage(currentLang);
    await updateSession(this.deps.db, session.id, { language: nextLang });
    await setUserLanguage(this.deps.db, "telegram", opts.userId, nextLang);
    const confirmKey = nextLang === "zh" ? "lang.switched_zh" : "lang.switched_en";
    await this.deps.telegram.sendMessage({
      chatId,
      messageThreadId: forumThreadId,
      replyToMessageId: opts.message.message_id,
      text: t(confirmKey, nextLang),
      priority: "user",
    });
  }

  private async startTelegramWizard(
    chatId: string,
    userId: string,
    replyToMessageId: number,
    messageThreadId: number | undefined,
    agent: SessionAgent,
  ) {
    if (!this.deps.telegram) return;
    await setWizardState(this.deps.db, {
      id: crypto.randomUUID(),
      agent,
      platform: "telegram",
      chat_id: chatId,
      user_id: userId,
      state: "await_project",
      project_id: null,
      custom_path_candidate: null,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    const lang = await this.deps.resolveUserLanguage("telegram", userId);
    const menuText = buildMenuText("telegram", agent, lang);
    const keyboard = this.deps.telegram.projectKeyboard(this.deps.config.projects);
    await this.deps.telegram.sendMessage({
      chatId,
      text: menuText,
      messageThreadId,
      replyToMessageId,
      replyMarkup: keyboard,
      priority: "user",
    });
  }

  private async handleTelegramCallback(cb: TelegramCallbackQuery) {
    if (!this.deps.telegram) return;
    const data = cb.data ?? "";
    this.deps.logger.debug(
      `[tg] callback received user=${String(cb.from.id)} chat=${String(cb.message?.chat?.id ?? "?")} data=${JSON.stringify(
        safeSnippet(data),
      )}`,
    );
    const action = this.parseTelegramInteractionAction(data);
    if (action) {
      const chat = cb.message?.chat;
      const chatId = chat ? String(chat.id) : "";
      const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
      const messageId = cb.message?.message_id ? String(cb.message.message_id) : undefined;
      // @ts-ignore
      const messageText = cb.message?.text ?? cb.message?.caption ?? undefined;
      const actorLang = await this.deps.resolveUserLanguage("telegram", String(cb.from.id));
      if (!chatId && action.kind !== "lang") {
        await this.deps.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }
      const handled = await this.deps.handleSharedInteractionAction({
        platform: "telegram",
        action,
        chatId,
        userId,
        workspaceId: null,
        messageId,
        messageText,
        interactionId: cb.id,
        replyToMessageId: cb.message?.message_id,
        messageThreadId: this.telegramForumThreadIdFromMessage(cb.message),
        isDirect: chat?.type === "private",
      });
      if (handled) return;
    }

    if (!data.startsWith("proj:")) {
      await this.deps.telegram.answerCallbackQuery(cb.id);
      return;
    }
    const actorLang = await this.deps.resolveUserLanguage("telegram", String(cb.from.id));
    const projectId = data.slice("proj:".length);
    const project = this.deps.projectById(projectId);

    const chat = cb.message?.chat;
    const chatId = chat ? String(chat.id) : null;
    const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
    if (!chatId) {
      await this.deps.telegram.answerCallbackQuery(cb.id, t("callback.unsupported_context", actorLang));
      return;
    }
    const access = await this.deps.telegramAccessDecision(chatId, userId);
    if (!access.allowed) {
      this.deps.logger.warn(
        `[tg] rejected callback chat=${chatId} user=${userId} project=${projectId} reason=${access.reason ?? "-"}`,
      );
      await this.deps.telegram.answerCallbackQuery(cb.id, t("error.not_authorized", actorLang));
      return;
    }

    const existing = await getWizardState(this.deps.db, "telegram", chatId, userId);
    const agent: SessionAgent = existing?.agent ?? "codex";

    await setWizardState(this.deps.db, {
      id: crypto.randomUUID(),
      agent,
      platform: "telegram",
      chat_id: chatId,
      user_id: userId,
      state: project.path === "*" ? "await_custom_path" : "await_initial_prompt",
      project_id: projectId,
      custom_path_candidate: null,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    await this.deps.telegram.answerCallbackQuery(cb.id);

    const forumThreadId = this.telegramForumThreadIdFromMessage(cb.message);
    const lang = await this.deps.resolveUserLanguage("telegram", userId);
    await this.deps.telegram.sendMessage({
      chatId,
      messageThreadId: forumThreadId,
      replyToMessageId: cb.message?.message_id,
      text:
        project.path === "*"
          ? t("wizard.send_custom_path", lang)
          : t("wizard.send_prompt", lang),
      priority: "user",
    });
  }

  private async continueTelegramWizard(wizard: WizardStateRow, text: string, ctx: TelegramReplyContext) {
    if (!this.deps.telegram) return;
    const lang = await this.deps.resolveUserLanguage("telegram", wizard.user_id);

    if (wizard.state === "await_project") {
      await this.deps.telegram.sendMessage({
        chatId: wizard.chat_id,
        messageThreadId: ctx.messageThreadId,
        replyToMessageId: ctx.replyToMessageId,
        text: t("wizard.choose_project_buttons", lang),
        priority: "user",
      });
      return;
    }

    if (!wizard.project_id) {
      await clearWizardState(this.deps.db, "telegram", wizard.chat_id, wizard.user_id);
      await this.deps.telegram.sendMessage({
        chatId: wizard.chat_id,
        messageThreadId: ctx.messageThreadId,
        replyToMessageId: ctx.replyToMessageId,
        text: t("wizard.expired", lang),
        priority: "user",
      });
      return;
    }

    const project = this.deps.projectById(wizard.project_id);

    if (wizard.state === "await_custom_path") {
      const resolved = await validateAndResolveProjectPath(this.deps.config, project, text);
      await setWizardState(this.deps.db, {
        ...wizard,
        state: "await_initial_prompt",
        custom_path_candidate: resolved.project_path_resolved,
        updated_at: nowMs(),
      });
      await this.deps.telegram.sendMessage({
        chatId: wizard.chat_id,
        messageThreadId: ctx.messageThreadId,
        replyToMessageId: ctx.replyToMessageId,
        text: t("wizard.path_accepted", lang),
        priority: "user",
      });
      return;
    }

    if (wizard.state === "await_initial_prompt") {
      const resolved = await validateAndResolveProjectPath(this.deps.config, project, wizard.custom_path_candidate);

      try {
        await this.deps.sessionManager.assertCanStartNewSession({ platform: "telegram", chatId: wizard.chat_id });
      } catch (e) {
        let hint = "";
        let text: string;
        if (e instanceof SessionStartError) {
          if (e.code === "max_concurrent") {
            text = t("session.limit_concurrent", lang, { limit: e.limit });
            hint = `\n\n${t("session.max_concurrent_hint", lang, { cmd: "/sessions active" })}`;
          } else {
            text = t("session.limit_total", lang, { limit: e.limit });
          }
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          text = t("error.generic", lang, { message: redactText(msg) });
        }
        await this.deps.telegram.sendMessage({
          chatId: wizard.chat_id,
          messageThreadId: ctx.messageThreadId,
          replyToMessageId: ctx.replyToMessageId,
          text: `${text}${hint}`,
          priority: "user",
        });
        return;
      }

      const { spaceId, announce, topicId, topicEmoji, topicCustomEmojiId } = await this.createTelegramSessionSpace({
        chat: ctx.chat,
        projectName: resolved.project_name,
        anchorMessageId: ctx.replyToMessageId,
        anchorMessageThreadId: ctx.messageThreadId,
        agent: wizard.agent,
        lang,
      });

      let sessionId: string;
      try {
        sessionId = await this.deps.sessionManager.startNewSession({
          platform: "telegram",
          workspaceId: null,
          chatId: wizard.chat_id,
          spaceId,
          spaceEmoji: topicEmoji ?? null,
          userId: wizard.user_id,
          projectId: resolved.project_id,
          projectPathResolved: resolved.project_path_resolved,
          initialPrompt: text,
          agent: wizard.agent,
        });
      } catch (e) {
        await clearWizardState(this.deps.db, "telegram", wizard.chat_id, wizard.user_id);
        let hint = "";
        let text: string;
        if (e instanceof SessionStartError) {
          if (e.code === "max_concurrent") {
            text = t("session.limit_concurrent", lang, { limit: e.limit });
            hint = `\n\n${t("session.max_concurrent_hint", lang, { cmd: "/sessions active" })}`;
          } else {
            text = t("session.limit_total", lang, { limit: e.limit });
          }
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          text = t("error.generic", lang, { message: redactText(msg) });
        }
        if (topicId) {
          await this.deps.telegram.sendMessage({
            chatId: wizard.chat_id,
            messageThreadId: topicId,
            text: `${text}${hint}`,
            priority: "user",
          });
        } else {
          await this.deps.telegram.sendMessage({
            chatId: wizard.chat_id,
            messageThreadId: ctx.messageThreadId,
            replyToMessageId: Number(spaceId),
            text: `${text}${hint}`,
            priority: "user",
          });
        }
        return;
      }

      await clearWizardState(this.deps.db, "telegram", wizard.chat_id, wizard.user_id);

      if (topicId) {
        await this.pinTelegramTopicHeader({
          chatId: wizard.chat_id,
          topicId,
          initialPrompt: text,
          sessionId,
          lang,
        });
      }

      if (announce) {
        const emoji = topicEmoji ?? "🧠";
        const announceText = t("session.started_topic_hint", lang, { emoji });
        const entity =
          topicCustomEmojiId && topicEmoji
            ? buildTelegramCustomEmojiEntity(announceText, topicEmoji, topicCustomEmojiId)
            : null;
        try {
          await this.deps.telegram.sendMessageSingle({
            chatId: wizard.chat_id,
            messageThreadId: ctx.messageThreadId,
            replyToMessageId: ctx.replyToMessageId,
            text: announceText,
            entities: entity ? [entity] : undefined,
            priority: "user",
          });
        } catch {
          await this.deps.telegram.sendMessage({
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
          agent: wizard.agent,
        });
      }
    }
  }

  private async createTelegramSessionSpace(opts: {
    chat: TelegramChat;
    projectName: string;
    anchorMessageId: number;
    anchorMessageThreadId?: number;
    agent: SessionAgent;
    lang: UserLanguage;
  }): Promise<{ spaceId: string; announce: boolean; topicId?: number; topicEmoji?: string; topicCustomEmojiId?: string }> {
    if (!this.deps.telegram) throw new Error("Telegram not configured");
    const chatId = String(opts.chat.id);

    if (opts.chat.type === "channel") {
      await this.deps.telegram.sendMessageSingle({
        chatId,
        replyToMessageId: opts.anchorMessageId,
        text: t("session.created", opts.lang),
        priority: "user",
      });
      return { spaceId: String(opts.anchorMessageId), announce: false };
    }

    if (this.deps.config.telegram?.use_topics && opts.chat.type === "supergroup" && opts.chat.is_forum) {
      const picked = await this.pickTelegramTopicEmoji();
      const topicEmoji = picked.emoji;
      const topicCustomEmojiId = picked.customEmojiId;
      try {
        const initialName = clipForumTopicName(`${topicEmoji} ${agentShortName(opts.agent)}: ${opts.projectName}`);
        const topicId = await this.deps.telegram.createForumTopic(chatId, initialName, topicCustomEmojiId);
        return { spaceId: String(topicId), announce: true, topicId, topicEmoji, topicCustomEmojiId };
      } catch (e) {
        this.deps.logger.warn(
          `[tg] createForumTopic failed chat=${chatId} (ensure Topics are enabled and the bot can_manage_topics); falling back to reply thread: ${String(
            e,
          )}`,
        );
      }
    }

    const root = await this.deps.telegram.sendMessageSingle({
      chatId,
      messageThreadId: opts.anchorMessageThreadId,
      replyToMessageId: opts.anchorMessageId,
      text: t("session.created_reply", opts.lang),
      priority: "user",
    });
    return { spaceId: String(root.message_id), announce: false };
  }

  private async pinTelegramTopicHeader(opts: {
    chatId: string;
    topicId: number;
    initialPrompt: string;
    sessionId: string;
    lang: UserLanguage;
  }) {
    if (!this.deps.telegram) return;
    const message = this.formatTelegramTopicHeaderMessage(opts.initialPrompt, opts.sessionId, opts.lang);
    try {
      const msg = await this.deps.telegram.sendMessageSingleStrict({
        chatId: opts.chatId,
        messageThreadId: opts.topicId,
        text: message.text,
        parseMode: message.parseMode,
        replyMarkup: {
          inline_keyboard: [[{ text: t("button.stop", opts.lang), callback_data: `kill:${opts.sessionId}` }]],
        },
        priority: "user",
      });
      await this.deps.telegram.pinChatMessage(opts.chatId, msg.message_id);
    } catch (e) {
      this.deps.logger.warn(
        `[tg] failed to pin topic header chat=${opts.chatId} topic=${opts.topicId} session=${opts.sessionId}: ${String(e)}`,
      );
    }
  }

  private formatTelegramTopicHeaderMessage(
    initialPrompt: string,
    sessionId: string,
    lang: UserLanguage,
  ): { text: string; parseMode: "HTML" } {
    const maxChars = this.deps.config.telegram?.max_chars ?? 4096;
    const promptLabel = `<b>${t("session.prompt_label", lang)}</b>\n`;
    const sessionBlock = `\n\n<b>${t("session.id_label", lang)}</b>\n<pre>${escapeHtml(sessionId)}</pre>`;
    const baseOverhead = promptLabel.length + "<pre></pre>".length + sessionBlock.length;
    const promptBudget = Math.max(0, maxChars - baseOverhead);

    const normalizedPrompt = initialPrompt.trim() || t("session.empty_prompt", lang);
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
      text = `<b>${t("session.id_label", lang)}</b>\n<pre>${escapeHtml(sessionId)}</pre>`;
    }

    return { text, parseMode: "HTML" };
  }

  private async pickTelegramTopicEmoji(): Promise<{ emoji: string; customEmojiId?: string }> {
    const fallback: { emoji: string; customEmojiId?: string } = { emoji: pickTopicEmoji() };
    if (!this.deps.telegram) return fallback;

    try {
      const stickers = await this.deps.telegram.getForumTopicIconStickers();
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
      this.deps.logger.debug(`[tg] getForumTopicIconStickers failed: ${String(e)}`);
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
    agent: SessionAgent;
  }) {
    if (!this.deps.telegram) return;
    try {
      const emojiPrefix = `${opts.topicEmoji} `;
      const maxNameChars = 128;
      const maxTitleChars = Math.max(16, maxNameChars - emojiPrefix.length);

      const adapter = getAgentAdapter(opts.agent);
      adapter.requireConfig(this.deps.config);
      const title = truncateText(`${agentShortName(opts.agent)}: ${opts.projectName}`, maxTitleChars);
      const nextName = clipForumTopicName(`${emojiPrefix}${title}`);
      await this.deps.telegram.editForumTopic(opts.chatId, opts.topicId, nextName);
    } catch (e) {
      this.deps.logger.debug(`[tg] editForumTopic failed: ${String(e)}`);
    }
  }
}
