import crypto from "node:crypto";
import path from "node:path";
import type { AppConfig, ProjectEntry } from "./config.js";
import type { Db, SessionAgent, SessionStatus } from "./db.js";
import type { Logger } from "./log.js";
import { SessionStartError, type SessionManager } from "./sessionManager.js";
import type { CloudManager } from "./cloud/manager.js";
import { getAgentAdapter } from "./agents.js";
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
import { startOAuthFlow } from "./cloud/oauth.js";
import { ensureGithubAppToken, startGithubAppFlow } from "./cloud/githubApp.js";
import { computeGithubDisconnectImpact, executeGithubDisconnect } from "./cloud/githubDisconnect.js";
import { fetchGithubInstallationRepos, fetchGithubRepos, fetchGitlabRepos } from "./cloud/repos.js";
import { encryptSecret } from "./cloud/secrets.js";
import { generateSetupSpecFromPath } from "./cloud/lift.js";
import { hashSetupSpec, stringifySetupSpec } from "./cloud/setupSpec.js";
import { buildCloneUrl, runGitClone } from "./cloud/git.js";
import { LocalCloudProvider } from "./cloud/localProvider.js";
import { createUiToken } from "./cloud/uiTokens.js";
import { getCloudRunBySession } from "./cloud/store.js";
import {
  getCloudRun,
  getLatestSetupSpec,
  listGithubInstallationsForIdentity,
  createPendingAction,
  consumePendingAction,
  getGithubInstallation,
  getOrCreateIdentity,
  getSharedRepo,
  listCloudRunsForPlayground,
  listCloudRunsForRepo,
  listConnections,
  listReposForIdentity,
  listSecrets,
  listSharedRepos,
  replaceGithubInstallationRepos,
  setIdentityActiveRepo,
  setIdentityBranchNameRule,
  setIdentityGitUserEmail,
  setIdentityGitUserName,
  setIdentityKeepaliveMinutes,
  setIdentityMessageVerbosity,
  setSecret,
  shareRepo,
  unshareRepo,
  deleteSecret,
  putSetupSpec,
} from "./cloud/store.js";
import {
  clearWizardState,
  countPendingMessages,
  enqueuePendingMessage,
  getUserLanguage,
  getSessionBySpace,
  getWizardState,
  listSessionsForChat,
  setUserLanguage,
  setWizardState,
  updateSession,
} from "./store.js";
import type { SessionListPage, SessionRow, WizardStateRow } from "./store.js";
import { nowMs } from "./util.js";
import {
  completeChatgptOAuth,
  getChatgptAccountForIdentity,
  parseAuthorizationInput as parseChatgptAuthInput,
  revokeChatgptAccount,
  startChatgptOAuth,
} from "./chatgpt/oauth.js";
import { getLanguageLabel, getOtherLanguage, isUserLanguage, t, type UserLanguage } from "../locales/index.js";

const REVIEW_PROMPT = "Run codex review";
const COMMIT_PROMPT = "Stage all current changes and commit them with a clear, meaningful git commit message summarizing the diff.";
const buildCommitProposalPrompt = (branchRule: string | null): string => {
  const trimmedRule = (branchRule ?? "").trim();
  const ruleLine = trimmedRule
    ? `Branch name rule (user-provided): ${trimmedRule}`
    : "Branch name rule: (not set). Choose a short, descriptive branch name.";
  return [
    "Prepare a git commit proposal for the current repo state.",
    "Review the working tree and staged changes.",
    ruleLine,
    "Respond with a single-line JSON object only (no markdown, no backticks) with keys:",
    'commit_message, branch_name, summary',
    "The commit_message should be concise and imperative. The summary should be 1-2 sentences.",
  ].join("\n");
};
const SESSION_LIST_PAGE_SIZE = 20;
const PLAYGROUND_REPO_ID = "__playground__";
type TelegramReplyContext = { replyToMessageId: number; messageThreadId?: number; chat: TelegramChat };
type IdentityRepo = Awaited<ReturnType<typeof listReposForIdentity>>[number];

export type CommitProposalAction = "cancel" | "push" | "pr";

export interface CommitProposal {
  id: string;
  sessionId: string;
  platform: "telegram" | "slack";
  chatId: string;
  userId: string;
  commitMessage: string;
  branchName: string;
  summary: string;
  gitUserName: string | null;
  gitUserEmail: string | null;
  createdAt: number;
}

export interface CommitProposalStore {
  startProposal: (opts: {
    sessionId: string;
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    spaceId: string;
    isTelegramTopic: boolean;
    gitUserName: string | null;
    gitUserEmail: string | null;
  }) => void;
  getProposal: (id: string) => CommitProposal | null;
  consumeProposal: (id: string) => CommitProposal | null;
  clearPendingForSession: (sessionId: string) => void;
}

export class BotController {
  private readonly lastRepoListByIdentity = new Map<string, string[]>();
  private readonly lastSnapshotListByIdentity = new Map<string, string[]>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly sessionManager: SessionManager,
    private readonly telegram: TelegramClient | null,
    private readonly slack: SlackClient | null,
    private readonly sendToSession: SendToSessionFn,
    private readonly reviewCommitDisabled: Set<string>,
    private readonly cloudManager: CloudManager | null,
    private readonly commitProposalStore: CommitProposalStore | null,
    private readonly lookupTelegramSessionByReply: ((chatId: string, messageId: number) => string | null) | null,
  ) {}

  private markReviewCommitDisabled(sessionId: string) {
    this.reviewCommitDisabled.add(sessionId);
  }

  private async isCloudSession(session: SessionRow): Promise<boolean> {
    if (typeof session.project_id === "string" && session.project_id.startsWith("cloud:")) return true;
    // Fallback: look up cloud run by session_id to handle older records or missing prefix.
    const run = await getCloudRunBySession(this.db, session.id);
    return Boolean(run);
  }

  private buildCloudUiLink(runId: string, identityId: string, isDirect: boolean): string | null {
    const cloud = this.config.cloud;
    const ui = cloud?.ui;
    if (!cloud?.enabled || !ui || !ui.token_secret || !cloud.public_base_url) return null;
    const base = cloud.public_base_url.replace(/\/+$/g, "");
    const path = ui.path.startsWith("/") ? ui.path : `/${ui.path}`;
    const token = isDirect
      ? createUiToken(ui, { scope: "identity", identity_id: identityId })
      : createUiToken(ui, { scope: "run", run_id: runId });
    return `${base}${path}/${runId}?token=${encodeURIComponent(token)}`;
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
          const actorId = update.callback_query.from?.id;
          const lang = actorId ? await this.resolveUserLanguage("telegram", String(actorId)) : "en";
          try {
            await this.telegram.sendMessage({
              chatId,
              messageThreadId: this.telegramForumThreadIdFromMessage(update.callback_query.message ?? undefined),
              replyToMessageId,
              text: t("error.generic", lang, { message: redactText(msg) }),
              replyMarkup: this.buildLanguageToggleTelegram(lang),
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
        const lang = await this.resolveUserLanguage("telegram", actorUserId);
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: this.telegramForumThreadIdFromMessage(message),
          replyToMessageId: message.message_id,
          text: t("error.generic", lang, { message: redactText(msg) }),
          replyMarkup: this.buildLanguageToggleTelegram(lang),
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
    const cloudEnabled = Boolean(this.config.cloud?.enabled);
    this.logger.debug(
      `[tg] message received chat=${chatId} user=${userId} message_id=${String(message.message_id)} thread=${String(
        message.message_thread_id ?? "-",
      )} reply_to=${String(message.reply_to_message?.message_id ?? "-")} text=${JSON.stringify(safeSnippet(text))}`,
    );
    if (!text) return;
    const lang = await this.resolveUserLanguage("telegram", userId);

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
          text: t("error.not_authorized", lang),
          replyMarkup: this.buildLanguageToggleTelegram(lang),
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
        text: formatSessionList("telegram", lang, { ...sessionPage, filterLabel: formatSessionFilterLabel(listIntent.statuses) }),
        replyMarkup: this.buildLanguageToggleTelegram(lang),
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
          text: t("error.not_authorized", lang),
          replyMarkup: this.buildLanguageToggleTelegram(lang),
          priority: "user",
        });
        return;
      }
      const identity = await getOrCreateIdentity(this.db, { platform: "telegram", workspaceId: null, userId });
      if (settingsIntent.cmd.kind === "list") {
        let cloudKeyStatus: { openai: boolean; anthropic: boolean } | null = null;
        if (this.config.cloud?.enabled) {
          const secrets = await listSecrets(this.db, identity.id);
          const names = new Set(secrets.map((s) => s.name));
          cloudKeyStatus = {
            openai: names.has("OPENAI_API_KEY"),
            anthropic: names.has("ANTHROPIC_API_KEY"),
          };
        }
        const result = formatSettingsSummary(this.config, settingsIntent.defaultAgent, "telegram", lang, identity, cloudKeyStatus);
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: result,
          replyMarkup: this.buildLanguageToggleTelegram(lang),
          priority: "user",
        });
        return;
      }
      const cloudResult = await applyCloudSettingsCommand({
        config: this.config,
        db: this.db,
        cmd: settingsIntent.cmd,
        identityId: identity.id,
        lang,
      });
      const identityResult = await applyIdentitySettingsCommand({
        config: this.config,
        db: this.db,
        cmd: settingsIntent.cmd,
        identityId: identity.id,
        lang,
      });
      const result =
        identityResult ??
        cloudResult ??
        applySettingsCommand(this.config, settingsIntent.cmd, settingsIntent.defaultAgent, "telegram", lang);
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: forumThreadId,
        replyToMessageId: message.message_id,
        text: result,
        replyMarkup: this.buildLanguageToggleTelegram(lang),
        priority: "user",
      });
      return;
    }

    const cloudCmd = text.startsWith("/") ? parseCloudCommand(text) : null;
    if (cloudCmd) {
      await this.handleCloudCommand({
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
          text: t("error.not_authorized", lang),
          replyMarkup: this.buildLanguageToggleTelegram(lang),
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

    if (this.lookupTelegramSessionByReply && message.reply_to_message?.message_id) {
      const replyId = message.reply_to_message.message_id;
      const mappedSessionId = this.lookupTelegramSessionByReply(chatId, replyId);
      if (mappedSessionId) {
        const session = await this.db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", mappedSessionId)
          .executeTakeFirst();
        if (session && session.platform === "telegram" && session.chat_id === chatId) {
          const access = await this.telegramAccessDecision(chatId, userId);
          if (!access.allowed) {
            this.logger.warn(
              `[tg] rejected reply session chat=${chatId} user=${userId} session=${session.id} reason=${access.reason ?? "-"}`,
            );
            await this.telegram.sendMessage({
              chatId,
              messageThreadId: forumThreadId,
              replyToMessageId: message.message_id,
              text: t("error.not_authorized", lang),
              replyMarkup: this.buildLanguageToggleTelegram(lang),
              priority: "user",
            });
            return;
          }
          this.logger.debug(`[tg] reply mapped to session id=${session.id} status=${session.status} reply_to=${replyId}`);
          await updateSession(this.db, session.id, { last_user_message_at: nowMs() });
          await this.handleSessionMessage(session, userId, text);
          return;
        }
        this.logger.debug(`[tg] reply mapped to missing session id=${mappedSessionId} reply_to=${replyId}`);
      }
    }

    if (cloudEnabled && text.startsWith("/")) {
      await this.sendCloudHelp({
        platform: "telegram",
        chatId,
        userId,
        replyToMessageId: message.message_id,
        messageThreadId: forumThreadId,
      });
      return;
    }

    // Wizard start.
    if (text.startsWith("/") && this.telegram.isMentionOrCommand(message)) {
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(`[tg] rejected wizard start chat=${chatId} user=${userId} reason=${access.reason ?? "-"}`);
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: t("error.not_authorized", lang),
          replyMarkup: this.buildLanguageToggleTelegram(lang),
          priority: "user",
        });
        return;
      }
      this.logger.debug(`[tg] starting wizard chat=${chatId} user=${userId}`);
      const agent = detectAgentFromTelegramMessageText(text);
      try {
        getAgentAdapter(agent).requireConfig(this.config);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: forumThreadId,
          replyToMessageId: message.message_id,
          text: t("error.generic", lang, { message: redactText(msg) }),
          replyMarkup: this.buildLanguageToggleTelegram(lang),
          priority: "user",
        });
        return;
      }
      await this.startTelegramWizard(chatId, userId, message.message_id, forumThreadId, agent);
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
        text: t("error.not_authorized", lang),
        replyMarkup: this.buildLanguageToggleTelegram(lang),
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

  private isTelegramTopicSession(session: { platform: string; space_emoji: string | null }): boolean {
    return session.platform === "telegram" && typeof session.space_emoji === "string" && session.space_emoji.trim().length > 0;
  }

  private resolveSessionLanguage(session: SessionRow): UserLanguage {
    return isUserLanguage(session.language) ? session.language : "en";
  }

  private async resolveUserLanguage(platform: "telegram" | "slack", userId: string): Promise<UserLanguage> {
    return await getUserLanguage(this.db, platform, userId);
  }

  private buildLanguageToggleTelegram(lang: UserLanguage) {
    const nextLang = getOtherLanguage(lang);
    return {
      inline_keyboard: [[{ text: getLanguageLabel(nextLang), callback_data: `lang:${nextLang}` }]],
    };
  }

  private buildLanguageToggleSlackBlocks(lang: UserLanguage) {
    const nextLang = getOtherLanguage(lang);
    return [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: getLanguageLabel(nextLang) },
            action_id: "switch_language",
            value: nextLang,
          },
        ],
      },
    ];
  }

  private async sendSessionMessageMarkdown(session: SessionRow, text: string) {
    const lang = this.resolveSessionLanguage(session);
    if (session.platform === "telegram") {
      if (!this.telegram) return;
      const chatId = Number(session.chat_id);
      const space = Number(session.space_id);
      if (Number.isNaN(chatId) || Number.isNaN(space)) return;
      await this.telegram.sendMessage(
        this.isTelegramTopicSession(session)
          ? { chatId, messageThreadId: space, text, priority: "user", replyMarkup: this.buildLanguageToggleTelegram(lang) }
          : { chatId, replyToMessageId: space, text, priority: "user", replyMarkup: this.buildLanguageToggleTelegram(lang) },
      );
      return;
    }
    if (session.platform === "slack") {
      if (!this.slack) return;
      const threadTs = this.config.slack?.session_mode === "thread" ? session.space_id : undefined;
      await this.slack.postMessageDetailed({
        channel: session.chat_id,
        thread_ts: threadTs,
        text,
        blocks: this.buildLanguageToggleSlackBlocks(lang),
        blocksOnLastChunk: false,
      });
    }
  }

  private async sendCloudMessage(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    text: string;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
    ephemeral?: boolean;
  }) {
    const lang = await this.resolveUserLanguage(opts.platform, opts.userId);
    if (opts.platform === "telegram") {
      if (!this.telegram) return;
      await this.telegram.sendMessage({
        chatId: Number(opts.chatId),
        text: opts.text,
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
        replyMarkup: this.buildLanguageToggleTelegram(lang),
        priority: "user",
      });
      return;
    }
    if (!this.slack) return;
    const isDm = opts.chatId.startsWith("D");
    const ephemeral = opts.ephemeral ?? !isDm;
    if (ephemeral && !isDm) {
      await this.slack.postEphemeral({
        channel: opts.chatId,
        user: opts.userId,
        text: opts.text,
        blocks: this.buildLanguageToggleSlackBlocks(lang),
      });
      return;
    }
    await this.slack.postMessageDetailed({
      channel: opts.chatId,
      thread_ts: opts.slackThreadTs,
      text: opts.text,
      blocks: this.buildLanguageToggleSlackBlocks(lang),
    });
  }

  private buildRunActionTelegramKeyboard(
    sessionId: string,
    runId: string,
    lang: UserLanguage,
    viewUrl?: string | null,
    vscodeUrl?: string | null,
  ) {
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
    rows.push([{ text: getLanguageLabel(getOtherLanguage(lang)), callback_data: `lang:${getOtherLanguage(lang)}` }]);
    return { inline_keyboard: rows };
  }

  private buildRunActionSlackBlocks(
    sessionId: string,
    runId: string,
    lang: UserLanguage,
    viewUrl?: string | null,
    vscodeUrl?: string | null,
  ) {
    const elements: Array<{
      type: string;
      text: { type: string; text: string };
      action_id: string;
      style?: string;
      value?: string;
      url?: string;
    }> = [
      {
        type: "button",
        text: { type: "plain_text", text: t("button.stop", lang) },
        style: "danger",
        action_id: "kill_session",
        value: sessionId,
      },
      { type: "button", text: { type: "plain_text", text: t("button.status", lang) }, action_id: "run_status", value: runId },
    ];
    if (viewUrl) {
      elements.push({ type: "button", text: { type: "plain_text", text: t("button.view", lang) }, action_id: "view_run", url: viewUrl });
    }
    if (vscodeUrl) {
      elements.push({ type: "button", text: { type: "plain_text", text: t("button.vscode", lang) }, action_id: "open_vscode", url: vscodeUrl });
    }
    elements.push({
      type: "button",
      text: { type: "plain_text", text: getLanguageLabel(getOtherLanguage(lang)) },
      action_id: "switch_language",
      value: getOtherLanguage(lang),
    });
    return [{ type: "actions", elements }];
  }

  private async sendCloudRunStartedMessage(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    text: string;
    sessionId: string;
    runId: string;
    viewUrl?: string | null;
    vscodeUrl?: string | null;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }) {
    const lang = await this.resolveUserLanguage(opts.platform, opts.userId);
    if (opts.platform === "telegram") {
      if (!this.telegram) return;
      await this.telegram.sendMessage({
        chatId: Number(opts.chatId),
        text: opts.text,
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
        replyMarkup: this.buildRunActionTelegramKeyboard(opts.sessionId, opts.runId, lang, opts.viewUrl, opts.vscodeUrl),
        priority: "user",
      });
      return;
    }
    if (!this.slack) return;
    await this.slack.postMessageDetailed({
      channel: opts.chatId,
      thread_ts: opts.slackThreadTs,
      text: opts.text,
      blocks: this.buildRunActionSlackBlocks(opts.sessionId, opts.runId, lang, opts.viewUrl, opts.vscodeUrl),
      blocksOnLastChunk: false,
    });
  }

  private async sendCloudRunStatus(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    workspaceId: string | null;
    runId: string;
    isDirect: boolean;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }) {
    const lang = await this.resolveUserLanguage(opts.platform, opts.userId);
    if (!this.cloudManager || !this.config.cloud?.enabled) {
      await this.sendCloudMessage({ ...opts, text: t("cloud.disabled", lang) });
      return;
    }
    const identity = await getOrCreateIdentity(this.db, {
      platform: opts.platform,
      workspaceId: opts.workspaceId,
      userId: opts.userId,
    });
    const run = await getCloudRun(this.db, opts.runId);
    if (!run || run.identity_id !== identity.id) {
      await this.sendCloudMessage({ ...opts, text: t("run.not_found", lang) });
      return;
    }
    const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
    const text = link
      ? t("run.status_with_link", lang, { id: run.id, status: run.status, url: link })
      : t("run.status_line", lang, { id: run.id, status: run.status });
    await this.sendCloudMessage({ ...opts, text });
  }

  private async handleCommitProposalAction(opts: {
    proposal: CommitProposal;
    session: SessionRow;
    action: CommitProposalAction;
  }): Promise<void> {
    if (!this.commitProposalStore) return;
    const isCloudSession = await this.isCloudSession(opts.session);
    const lang = this.resolveSessionLanguage(opts.session);
    if (!this.cloudManager || !isCloudSession) {
      await this.sendSessionMessageMarkdown(opts.session, t("commit.cloud_unavailable", lang));
      return;
    }

    this.commitProposalStore.consumeProposal(opts.proposal.id);

    if (opts.action === "cancel") {
      await this.sendSessionMessageMarkdown(opts.session, t("commit.proposal.canceled", lang));
      return;
    }

    await this.sendSessionMessageMarkdown(opts.session, t("commit.committing", lang));
    try {
      await this.cloudManager.commitAndPushRun({
        sessionId: opts.session.id,
        commitMessage: opts.proposal.commitMessage,
        branchName: opts.proposal.branchName,
        gitUserName: opts.proposal.gitUserName,
        gitUserEmail: opts.proposal.gitUserEmail,
      });
    } catch (e) {
      await this.sendSessionMessageMarkdown(opts.session, t("commit.failed", lang, {
        error: redactText(e instanceof Error ? e.message : String(e)),
      }));
      return;
    }

    if (opts.action === "push") {
      const lines = [
        t("commit.pushed.title", lang),
        t("commit.pushed.branch", lang, { branch: opts.proposal.branchName }),
        t("commit.pushed.commit", lang, { message: opts.proposal.commitMessage }),
      ];
      await this.sendSessionMessageMarkdown(opts.session, lines.join("\n"));
      return;
    }

    try {
      const pr = await this.cloudManager.createPullRequestForRun({
        sessionId: opts.session.id,
        branchName: opts.proposal.branchName,
        title: opts.proposal.commitMessage,
        body: opts.proposal.summary ? `Summary:\n${opts.proposal.summary}` : undefined,
      });
      const lines = [
        t("commit.pr.created.title", lang),
        t("commit.pr.created.branch", lang, { branch: opts.proposal.branchName }),
        t("commit.pr.created.base", lang, { base: pr.base }),
        pr.url ? t("commit.pr.created.link", lang, { url: pr.url }) : t("commit.pr.created.no_link", lang),
      ];
      await this.sendSessionMessageMarkdown(opts.session, lines.join("\n"));
    } catch (e) {
      const lines = [
        t("commit.pr.failed.title", lang),
        t("commit.pr.failed.branch", lang, { branch: opts.proposal.branchName }),
        t("commit.pr.failed.error", lang, { error: redactText(e instanceof Error ? e.message : String(e)) }),
      ];
      await this.sendSessionMessageMarkdown(opts.session, lines.join("\n"));
    }
  }

  private async sendCloudHelp(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }) {
    const lang = await this.resolveUserLanguage(opts.platform, opts.userId);
    await this.sendCloudMessage({
      ...opts,
      text: buildCloudHelpText(opts.platform, lang),
    });
  }

  private resolveRepoTarget(identityId: string, repos: IdentityRepo[], rawTarget: string): IdentityRepo | null {
    const target = rawTarget.trim();
    const index = parseRepoIndex(target);
    if (index !== null) {
      const list = this.lastRepoListByIdentity.get(identityId) ?? repos.map((r) => r.id);
      const repoId = list[index - 1];
      if (repoId) {
        const match = repos.find((r) => r.id === repoId);
        if (match) return match;
      }
    }
    return repos.find((r) => r.id === target || r.name === target) ?? null;
  }

  private findSecretMetaByName(secrets: { name: string; created_at: number; updated_at: number }[], name: string) {
    const target = name.trim();
    if (!target) return null;
    return secrets.find((s) => s.name === target) ?? null;
  }

  private async handleCloudCommand(opts: {
    platform: "telegram" | "slack";
    command: CloudCommand;
    chatId: string;
    workspaceId: string | null;
    userId: string;
    isDirect: boolean;
    spaceId: string;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }): Promise<boolean> {
    const lang = await this.resolveUserLanguage(opts.platform, opts.userId);
    if (!this.cloudManager || !this.config.cloud?.enabled) {
      await this.sendCloudMessage({
        platform: opts.platform,
        chatId: opts.chatId,
        userId: opts.userId,
        text: t("cloud.disabled", lang),
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
        slackThreadTs: opts.slackThreadTs,
      });
      return true;
    }

    const identity = await getOrCreateIdentity(this.db, {
      platform: opts.platform,
      workspaceId: opts.workspaceId,
      userId: opts.userId,
    });

    if (!opts.isDirect && !identity.onboarded_at) {
      await this.sendCloudMessage({
        platform: opts.platform,
        chatId: opts.chatId,
        userId: opts.userId,
        text: t("cloud.setup_required", lang),
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
        slackThreadTs: opts.slackThreadTs,
      });
      return true;
    }

    const reply = async (text: string, ephemeral?: boolean) => {
      await this.sendCloudMessage({
        platform: opts.platform,
        chatId: opts.chatId,
        userId: opts.userId,
        text,
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
        slackThreadTs: opts.slackThreadTs,
        ephemeral,
      });
    };
    const replyText = async (key: Parameters<typeof t>[0], params?: Record<string, string | number>, ephemeral?: boolean) => {
      await reply(t(key, lang, params), ephemeral);
    };
    const cmdPrefix = opts.platform === "telegram" ? "/" : "";
    const formatCmd = (value: string) => `\`${cmdPrefix}${value}\``;

    const cloud = this.config.cloud;
    if (!cloud) {
      await replyText("cloud.config_missing");
      return true;
    }

    switch (opts.command.kind) {
      case "connect": {
        if (!opts.isDirect) {
          await replyText("connect.dm_only", { cmd: formatCmd("connect") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "connect" }>;
        const provider = cmd.provider;
        const metadataJson = JSON.stringify({
          platform: opts.platform,
          chat_id: opts.chatId,
          user_id: opts.userId,
          space_id: opts.spaceId,
        });
        try {
          if (provider === "chatgpt") {
            if (!this.config.chatgpt_oauth) {
              await replyText("connect.chatgpt.not_configured");
              return true;
            }
            if (cmd.subcommand === "status") {
              const account = await getChatgptAccountForIdentity({ db: this.db, config: this.config, identityId: identity.id });
              if (!account) {
                await replyText("connect.chatgpt.none", undefined, true);
                return true;
              }
              const lines = [
                t("connect.chatgpt.status.title", lang),
                t("connect.chatgpt.status.account_id", lang, { id: account.chatgptUserId }),
                account.email
                  ? t("connect.chatgpt.status.email", lang, { email: account.email })
                  : t("connect.chatgpt.status.email_unknown", lang),
                t("connect.chatgpt.status.expires", lang, { ts: new Date(account.expiresAt).toISOString() }),
                account.workspaceId
                  ? t("connect.chatgpt.status.workspace", lang, { workspace: account.workspaceId })
                  : t("connect.chatgpt.status.workspace_none", lang),
              ];
              await reply(lines.join("\n"), true);
              return true;
            }
            if (cmd.subcommand === "revoke") {
              this.logger.info(
                `[chatgpt][oauth] revoke requested platform=${opts.platform} chat=${opts.chatId} user=${opts.userId} identity=${identity.id}`,
              );
              await revokeChatgptAccount({ db: this.db, identityId: identity.id });
              this.logger.info(`[chatgpt][oauth] revoked identity=${identity.id}`);
              await replyText("connect.chatgpt.unlinked", undefined, true);
              return true;
            }
            // Manual paste flow: /connect chatgpt <redirect-url>
            if (cmd.payload) {
              const parsed = parseChatgptAuthInput(cmd.payload);
              if (!parsed.code || !parsed.state) {
                await replyText("connect.chatgpt.paste_redirect");
                return true;
              }
              try {
                this.logger.info(
                  `[chatgpt][oauth] manual redirect received platform=${opts.platform} chat=${opts.chatId} user=${opts.userId} identity=${identity.id} state=${parsed.state}`,
                );
                await completeChatgptOAuth({
                  db: this.db,
                  config: this.config,
                  code: parsed.code,
                  state: parsed.state,
                  expectedIdentityId: identity.id,
                  logger: this.logger,
                });
                this.logger.info(
                  `[chatgpt][oauth] linked account platform=${opts.platform} chat=${opts.chatId} identity=${identity.id} state=${parsed.state}`,
                );
                await replyText("connect.chatgpt.connected", { cmd: formatCmd("connect chatgpt status") }, true);
              } catch (e) {
                await replyText("connect.chatgpt.failed", { error: String(e) });
              }
              return true;
            }
            const { authorizeUrl } = await startChatgptOAuth({
              db: this.db,
              config: this.config,
              identityId: identity.id,
              metadataJson,
            });
            const lines = [
              t("connect.chatgpt.signin.title", lang),
              t("connect.chatgpt.signin.open_link", lang),
              authorizeUrl,
              "",
              t("connect.chatgpt.signin.instructions", lang),
              `- ${formatCmd("connect chatgpt <paste-full-redirect-url>")}`,
            ];
            await reply(lines.join("\n"), true);
            return true;
          }
          if (!cloud?.public_base_url) {
            await replyText("cloud.public_base_missing");
            return true;
          }
          if (provider === "github") {
            const connections = (await listConnections(this.db, identity.id)).filter((c) => c.type === "github_app");
            const activeConnections: Array<{
              connection: (typeof connections)[number];
              installation: Awaited<ReturnType<typeof getGithubInstallation>>;
            }> = [];
            const staleConnections: typeof connections = [];
            const connectedStatuses = new Set(["active", "suspended", "disconnecting"]);
            for (const conn of connections) {
              const installationId = conn.installation_id ?? null;
              if (!installationId) {
                staleConnections.push(conn);
                continue;
              }
              const installation = await getGithubInstallation(this.db, installationId);
              if (!installation || !connectedStatuses.has(installation.status)) {
                staleConnections.push(conn);
                continue;
              }
              activeConnections.push({ connection: conn, installation });
            }
            if (staleConnections.length > 0) {
              await this.db
                .deleteFrom("connections")
                .where(
                  "id",
                  "in",
                  staleConnections.map((c) => c.id),
                )
                .execute();
              this.logger.info(
                `[cloud] cleaned stale github_app connections identity=${identity.id} count=${staleConnections.length}`,
              );
            }
            if (activeConnections.length > 0) {
              activeConnections.sort((a, b) => (b.connection.updated_at ?? 0) - (a.connection.updated_at ?? 0));
              if (activeConnections.length === 1) {
                const existing = activeConnections[0]!;
                const installationId = existing.connection.installation_id ?? null;
                const connectedAt = existing.connection.updated_at ? new Date(existing.connection.updated_at).toISOString() : null;
                const lines = [t("github.already_connected.title", lang)];
                if (existing.installation?.account_login) {
                  const accountType = existing.installation.account_type ?? "unknown";
                  lines.push(t("github.already_connected.account", lang, { login: existing.installation.account_login, type: accountType }));
                } else {
                  lines.push(t("github.already_connected.account_unknown", lang));
                }
                if (existing.installation?.status && existing.installation.status !== "active") {
                  lines.push(t("github.already_connected.status", lang, { status: existing.installation.status }));
                }
                if (installationId) lines.push(t("github.already_connected.installation_id", lang, { id: installationId }));
                if (connectedAt) lines.push(t("github.already_connected.connected_at", lang, { ts: connectedAt }));
                await reply(lines.join("\n"), true);
                return true;
              }
              const lines = [t("github.already_connected.title", lang), t("github.already_connected.active_installations", lang)];
              for (const item of activeConnections) {
                const installationId = item.connection.installation_id ?? "unknown";
                const login = item.installation?.account_login ?? "unknown";
                const accountType = item.installation?.account_type ?? "unknown";
                const status = item.installation?.status ?? "unknown";
                lines.push(t("github.already_connected.installation_item", lang, { id: installationId, login, type: accountType, status }));
              }
              lines.push("", t("github.already_connected.disconnect_hint", lang, { cmd: formatCmd("disconnect github --installation <id>") }));
              await reply(lines.join("\n"), true);
              return true;
            }
            if (!cloud.github_app) {
              await replyText("github.missing_config");
              return true;
            }
            const { authorizeUrl } = await startGithubAppFlow({
              db: this.db,
              cloud,
              identityId: identity.id,
              redirectBase: cloud.public_base_url,
              metadataJson,
            });
            await replyText("github.install_link", { url: authorizeUrl }, true);
            return true;
          }
          const { authorizeUrl } = await startOAuthFlow({
            db: this.db,
            cloud,
            provider,
            identityId: identity.id,
            redirectBase: cloud.public_base_url,
            metadataJson,
          });
          await replyText("oauth.authorize_link", { provider, url: authorizeUrl }, true);
        } catch (e) {
          await replyText("connect.failed", { error: String(e) });
        }
        return true;
      }
      case "disconnect": {
        if (!opts.isDirect) {
          await replyText("disconnect.dm_only", { cmd: formatCmd("disconnect github") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "disconnect" }>;
        const provider = cmd.provider;
        if (provider !== "github") {
          await replyText("disconnect.not_supported", { provider });
          return true;
        }
        if (!cloud.github_app) {
          await replyText("github.missing_config");
          return true;
        }
        const confirmToken = (cmd.confirmToken ?? "").trim();
        if (confirmToken) {
          const tokenHash = crypto.createHash("sha256").update(confirmToken, "utf8").digest("hex");
          const pending = await consumePendingAction(this.db, {
            action: "github_disconnect",
            identityId: identity.id,
            tokenHash,
          });
          if (!pending) {
            await replyText("disconnect.token.invalid");
            return true;
          }
          let payload: { installationIds?: string[] } = {};
          try {
            payload = JSON.parse(pending.payload_json ?? "{}") as { installationIds?: string[] };
          } catch {
            await replyText("disconnect.token.payload_invalid");
            return true;
          }
          const installationIds = Array.isArray(payload.installationIds)
            ? payload.installationIds.filter((id) => typeof id === "string" && id.trim().length > 0)
            : [];
          if (installationIds.length === 0) {
            await replyText("disconnect.token.missing_targets");
            return true;
          }
          const results: string[] = [];
          for (const installationId of installationIds) {
            try {
              const impact = await executeGithubDisconnect({
                db: this.db,
                cloud,
                logger: this.logger,
                installationId,
                identityId: identity.id,
                cloudManager: this.cloudManager,
              });
              results.push(
                t("disconnect.result_item", lang, {
                  installationId,
                  repos: impact.repos,
                  runs: impact.runs,
                  sessions: impact.sessions,
                  screenshots: impact.screenshots,
                }),
              );
            } catch (e) {
              await replyText("disconnect.failed_for_installation", { installationId, error: String(e) });
              return true;
            }
          }
          const lines = [t("disconnect.success_title", lang), ...results];
          await reply(lines.join("\n"), true);
          return true;
        }

        const installations = await listGithubInstallationsForIdentity(this.db, identity.id);
        if (installations.length === 0) {
          await replyText("disconnect.none_installed");
          return true;
        }
        let targetIds: string[] = [];
        if (cmd.all) {
          targetIds = installations.map((row) => row.installation_id);
        } else if (cmd.installationId) {
          const match = installations.find((row) => row.installation_id === cmd.installationId);
          if (!match) {
            await replyText("disconnect.installation_not_found", { id: cmd.installationId });
            return true;
          }
          targetIds = [match.installation_id];
        } else if (installations.length === 1) {
          targetIds = [installations[0]!.installation_id];
        } else {
          const lines = [t("disconnect.multiple_found", lang), ""];
          for (const row of installations) {
            const login = row.account_login ?? "unknown";
            lines.push(t("disconnect.multiple_option", lang, { cmd: formatCmd(`disconnect github --installation ${row.installation_id}`), login }));
          }
          lines.push(`- ${formatCmd("disconnect github --all")}`);
          await reply(lines.join("\n"), true);
          return true;
        }

        const impacts = [];
        for (const installationId of targetIds) {
          impacts.push(await computeGithubDisconnectImpact(this.db, installationId));
        }
        const token = crypto.randomBytes(6).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
        await createPendingAction(this.db, {
          action: "github_disconnect",
          identityId: identity.id,
          tokenHash,
          payloadJson: JSON.stringify({ installationIds: targetIds }),
          ttlMs: 10 * 60 * 1000,
        });
        const lines = [
          t("disconnect.confirm_title", lang),
          t("disconnect.uninstall_notice", lang),
          "",
          t("disconnect.targets", lang),
          ...impacts.map((impact) => {
            return t("disconnect.result_item", lang, {
              installationId: impact.installationId,
              repos: impact.repos,
              runs: impact.runs,
              sessions: impact.sessions,
              screenshots: impact.screenshots,
            });
          }),
          "",
          t("disconnect.confirm_with", lang, { cmd: formatCmd(`disconnect github confirm ${token}`) }),
        ];
        await reply(lines.join("\n"), true);
        return true;
      }
      case "connections": {
        const conns = await listConnections(this.db, identity.id);
        if (conns.length === 0) {
          await replyText("connections.none");
          return true;
        }
        const lines = conns.map((c) => t("connections.item", lang, { type: c.type }));
        await reply(lines.join("\n"));
        return true;
      }
      case "repos": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "repos" }>;
        const conns = await listConnections(this.db, identity.id);
        for (const conn of conns) {
          try {
            if (conn.type === "github_app") {
              if (!cloud.github_app) {
                this.logger.warn("[cloud] github_app not configured; cannot refresh repos.");
              } else if (!conn.installation_id) {
                this.logger.warn("[cloud] github_app connection missing installation_id; cannot refresh repos.");
              } else {
                const token = await ensureGithubAppToken({
                  db: this.db,
                  config: cloud.github_app,
                  secretKey: cloud.secrets_key,
                  connection: conn,
                  forceRefresh: true,
                });
                const repos = await fetchGithubInstallationRepos({ token: token.token, apiBaseUrl: cloud.github_app.api_base_url });
                await replaceGithubInstallationRepos(this.db, {
                  installationId: conn.installation_id,
                  repos: repos.map((r) => ({
                    providerRepoId: r.providerRepoId,
                    name: r.name,
                    url: r.url,
                    defaultBranch: r.defaultBranch,
                    archived: r.archived,
                    private: r.private,
                    permissionsJson: r.permissionsJson ?? null,
                  })),
                });
                for (const r of repos) {
                  await this.db
                    .selectFrom("repos")
                    .select(["id"])
                    .where("connection_id", "=", conn.id)
                    .where("provider_repo_id", "=", r.providerRepoId)
                    .executeTakeFirst()
                    .then(async (existing) => {
                      if (existing) return;
                      await this.db
                        .insertInto("repos")
                        .values({
                          id: crypto.randomUUID(),
                          connection_id: conn.id,
                          provider: "github",
                          provider_repo_id: r.providerRepoId,
                          name: r.name,
                          url: r.url,
                          default_branch: r.defaultBranch,
                          fingerprint: null,
                          created_at: nowMs(),
                          updated_at: nowMs(),
                        })
                        .execute();
                    });
                }
              }
            }
            if (conn.type === "github_oauth" && cloud.oauth.github) {
              const repos = await fetchGithubRepos({ token: conn.access_token, apiBaseUrl: cloud.oauth.github.api_base_url });
              for (const r of repos) {
                await this.db
                  .selectFrom("repos")
                  .select(["id"])
                  .where("connection_id", "=", conn.id)
                  .where("provider_repo_id", "=", r.providerRepoId)
                  .executeTakeFirst()
                  .then(async (existing) => {
                    if (existing) return;
                    await this.db
                      .insertInto("repos")
                      .values({
                        id: crypto.randomUUID(),
                        connection_id: conn.id,
                        provider: "github",
                        provider_repo_id: r.providerRepoId,
                        name: r.name,
                        url: r.url,
                        default_branch: r.defaultBranch,
                        fingerprint: null,
                        created_at: nowMs(),
                        updated_at: nowMs(),
                      })
                      .execute();
                  });
              }
            }
            if (conn.type === "gitlab" && cloud.oauth.gitlab) {
              const repos = await fetchGitlabRepos({ token: conn.access_token, apiBaseUrl: cloud.oauth.gitlab.api_base_url });
              for (const r of repos) {
                await this.db
                  .selectFrom("repos")
                  .select(["id"])
                  .where("connection_id", "=", conn.id)
                  .where("provider_repo_id", "=", r.providerRepoId)
                  .executeTakeFirst()
                  .then(async (existing) => {
                    if (existing) return;
                    await this.db.insertInto("repos").values({
                      id: crypto.randomUUID(),
                      connection_id: conn.id,
                      provider: "gitlab",
                      provider_repo_id: r.providerRepoId,
                      name: r.name,
                      url: r.url,
                      default_branch: r.defaultBranch,
                      fingerprint: null,
                      created_at: nowMs(),
                      updated_at: nowMs(),
                    }).execute();
                  });
              }
            }
          } catch (e) {
            this.logger.warn(`[cloud] repo refresh failed ${conn.type}: ${String(e)}`);
          }
        }
        let repos = await listReposForIdentity(this.db, identity.id);
        if (cmd.provider) {
          repos = repos.filter((r) => r.provider === cmd.provider);
        }
        if (cmd.search) {
          const needle = cmd.search.toLowerCase();
          repos = repos.filter((r) => r.name.toLowerCase().includes(needle));
        }
        const playgroundLabel = t("repo.playground_label", lang);
        const playgroundLine = t("repos.playground_line", lang, { label: playgroundLabel });
        this.lastRepoListByIdentity.set(identity.id, repos.map((r) => r.id));
        const title = t("repos.title", lang);
        const selectHint = t("repos.select_hint", lang, {
          select: formatCmd("repo select <number>"),
          playground: formatCmd("repo select playground"),
        });
        if (repos.length === 0) {
          const lines = [title, playgroundLine, "", selectHint];
          await reply(lines.join("\n"));
          return true;
        }
        const lines = [title, playgroundLine, ...repos.map((r, i) => `${i + 1}. \`${r.name}\``), "", selectHint];
        await reply(lines.join("\n"));
        return true;
      }
      case "repo_select": {
        const repos = await listReposForIdentity(this.db, identity.id);
        const cmd = opts.command as Extract<CloudCommand, { kind: "repo_select" }>;
        const target = cmd.target.trim();
        const playgroundLabel = t("repo.playground_label", lang);
        if (isPlaygroundTarget(target)) {
          await setIdentityActiveRepo(this.db, identity.id, PLAYGROUND_REPO_ID);
          await replyText("repo.active_set_playground", { label: playgroundLabel });
          return true;
        }
        const repo = this.resolveRepoTarget(identity.id, repos, target);
        if (!repo) {
          await replyText("repo.not_found_use_repos", { cmd: formatCmd("repos") });
          return true;
        }
        await setIdentityActiveRepo(this.db, identity.id, repo.id);
        await replyText("repo.active_set", { name: repo.name, id: repo.id });
        return true;
      }
      case "repo_current": {
        const playgroundLabel = t("repo.playground_label", lang);
        if (isPlaygroundRepoId(identity.active_repo_id)) {
          await replyText("repo.active_label", { label: playgroundLabel });
          return true;
        }
        if (!identity.active_repo_id) {
          await replyText("repo.none_active", {
            select: formatCmd("repo select <number>"),
            playground: formatCmd("repo select playground"),
          });
          return true;
        }
        const repos = await listReposForIdentity(this.db, identity.id);
        const repo = repos.find((r) => r.id === identity.active_repo_id);
        if (!repo) {
          await replyText("repo.active_not_found", { cmd: formatCmd("repo select <number>") });
          return true;
        }
        await replyText("repo.active_detail", { name: repo.name, id: repo.id });
        return true;
      }
      case "repo_share": {
        if (opts.isDirect) {
          await replyText("repo.share_dm_only", { cmd: formatCmd("repo share <number>") });
          return true;
        }
        const repos = await listReposForIdentity(this.db, identity.id);
        const cmd = opts.command as Extract<CloudCommand, { kind: "repo_share" }>;
        const repo = this.resolveRepoTarget(identity.id, repos, cmd.target);
        if (!repo) {
          await replyText("repo.not_found_use_repos", { cmd: formatCmd("repos") });
          return true;
        }
        const result = await shareRepo(this.db, {
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
          repoId: repo.id,
          sharedByIdentityId: identity.id,
        });
        if (result.alreadyShared) {
          await replyText("repo.already_shared");
          return true;
        }
        await replyText("repo.shared", { name: repo.name });
        return true;
      }
      case "repo_unshare": {
        if (opts.isDirect) {
          await replyText("repo.unshare_dm_only", { cmd: formatCmd("repo unshare <number>") });
          return true;
        }
        const repos = await listReposForIdentity(this.db, identity.id);
        const cmd = opts.command as Extract<CloudCommand, { kind: "repo_unshare" }>;
        const repo = this.resolveRepoTarget(identity.id, repos, cmd.target);
        if (!repo) {
          await replyText("repo.not_found");
          return true;
        }
        const shared = await getSharedRepo(this.db, {
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
          repoId: repo.id,
        });
        if (!shared) {
          await replyText("repo.not_shared");
          return true;
        }
        if (shared.shared_by_identity_id !== identity.id) {
          await replyText("repo.unshare_not_owner");
          return true;
        }
        await unshareRepo(this.db, {
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
          repoId: repo.id,
        });
        await replyText("repo.unshared", { name: repo.name });
        return true;
      }
      case "actions_list": {
        if (isPlaygroundRepoId(identity.active_repo_id)) {
          const runs = await listCloudRunsForPlayground(this.db, identity.id, 10);
          if (runs.length === 0) {
            await replyText("actions.none_runs");
            return true;
          }
          const lines = runs.map((r) => `- ${r.id} (${r.status})`);
          await reply(lines.join("\n"));
          return true;
        }
        if (!identity.active_repo_id) {
          await replyText("repo.none_active", {
            select: formatCmd("repo select <number>"),
            playground: formatCmd("repo select playground"),
          });
          return true;
        }
        const runs = await listCloudRunsForRepo(this.db, identity.active_repo_id, 10);
        if (runs.length === 0) {
          await replyText("actions.none_runs");
          return true;
        }
        const lines = runs.map((r) => `- ${r.id} (${r.status})`);
        await reply(lines.join("\n"));
        return true;
      }
      case "action_status": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "action_status" }>;
        const run = await getCloudRun(this.db, cmd.runId);
        if (!run || run.identity_id !== identity.id) {
          await replyText("run.not_found");
          return true;
        }
        const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
        await reply(
          link
            ? t("run.status_with_link", lang, { id: run.id, status: run.status, url: link })
            : t("run.status_line", lang, { id: run.id, status: run.status }),
        );
        return true;
      }
      case "action_pull": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "action_pull" }>;
        const run = await getCloudRun(this.db, cmd.runId);
        if (!run || run.identity_id !== identity.id) {
          await replyText("run.not_found");
          return true;
        }
        const summary = run.diff_summary ?? t("run.diff_none", lang);
        const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
        const tail = link ? `\nView: ${link}` : "";
        await reply(
          t("run.diff_summary", lang, {
            id: run.id,
            summary,
            cmd: `tinc pull --run ${run.id}`,
            view: tail,
          }),
        );
        return true;
      }
      case "snapshot_save": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_save" }>;
        try {
          const { snapshotId, runId } = await this.cloudManager.saveSnapshot({
            identityId: identity.id,
            note: cmd.note,
            sourceStatus: "manual",
          });
          await replyText("snapshot.saved", { snapshotId, runId });
        } catch (e) {
          await replyText("snapshot.save_failed", { error: String(e) });
        }
        return true;
      }
      case "snapshot_list": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_list" }>;
        const snapshots = await this.cloudManager.listSnapshots(identity.id, cmd.limit);
        if (snapshots.length === 0) {
          await replyText("snapshot.none");
          return true;
        }
        this.lastSnapshotListByIdentity.set(
          identity.id,
          snapshots.map((s) => s.id),
        );
        const formatSnapshot = (s: (typeof snapshots)[number], idx: number) => {
          const noteText = (s.note ?? "").split("\n")[0] ?? "";
          const noteClean = noteText.toLowerCase().startsWith("status:") ? "" : noteText.trim();
          const noteShort = noteClean.length > 0 ? truncateText(noteClean, 200) : t("snapshot.none_label", lang);
          const title = s.title?.trim().length ? truncateText(s.title.trim(), 120) : t("snapshot.none_label", lang);
          const status = humanStatus(s.source_status, lang);
          return [
            `${idx + 1}.`,
            `${t("snapshot.field_id", lang)} ${s.id}`,
            `${t("snapshot.field_title", lang)} ${title}`,
            `${t("snapshot.field_status", lang)} ${status}`,
            `${t("snapshot.field_note", lang)} ${noteShort}`,
            "---",
          ].join("\n");
        };
        const lines = snapshots.map(formatSnapshot);
        lines.push(t("snapshot.restore_hint", lang, { cmd: formatCmd("snapshot restore <index|snapshotId>") }));
        await reply(lines.join("\n"));
        return true;
      }
      case "snapshot_search": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_search" }>;
        if (!cmd.query.trim()) {
          await replyText("snapshot.search_query_required");
          return true;
        }
        const snapshots = await this.cloudManager.searchSnapshots(identity.id, cmd.query, 10);
        if (snapshots.length === 0) {
          await replyText("snapshot.search_none");
          return true;
        }
        this.lastSnapshotListByIdentity.set(
          identity.id,
          snapshots.map((s) => s.id),
        );
        const formatSnapshot = (s: (typeof snapshots)[number], idx: number) => {
          const noteText = (s.note ?? "").split("\n")[0] ?? "";
          const noteClean = noteText.toLowerCase().startsWith("status:") ? "" : noteText.trim();
          const noteShort = noteClean.length > 0 ? truncateText(noteClean, 200) : t("snapshot.none_label", lang);
          const title = s.title?.trim().length ? truncateText(s.title.trim(), 120) : t("snapshot.none_label", lang);
          const status = humanStatus(s.source_status, lang);
          return [
            `${idx + 1}.`,
            `${t("snapshot.field_id", lang)} ${s.id}`,
            `${t("snapshot.field_title", lang)} ${title}`,
            `${t("snapshot.field_status", lang)} ${status}`,
            `${t("snapshot.field_note", lang)} ${noteShort}`,
            "---",
          ].join("\n");
        };
        const lines = snapshots.map(formatSnapshot);
        lines.push(t("snapshot.restore_hint", lang, { cmd: formatCmd("snapshot restore <index|snapshotId>") }));
        await reply(lines.join("\n"));
        return true;
      }
      case "snapshot_restore": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_restore" }>;
        let snapshotId = cmd.target.trim();
        const idx = Number(snapshotId);
        if (Number.isInteger(idx)) {
          const last = this.lastSnapshotListByIdentity.get(identity.id);
          if (!last || idx < 1 || idx > last.length) {
            await replyText("snapshot.invalid_index");
            return true;
          }
          snapshotId = last[idx - 1]!;
        }
        const agent = cloud.default_agent === "claude_code" ? "claude_code" : "codex";
        if (agent === "claude_code" && !this.config.claude_code) {
          await replyText("agent.claude_code.not_configured");
          return true;
        }
        try {
          const result = await this.cloudManager.restoreSnapshot({
            identityId: identity.id,
            snapshotId,
            platform: opts.platform,
            workspaceId: opts.workspaceId,
            chatId: opts.chatId,
            spaceId: opts.spaceId,
            userId: opts.userId,
            agent,
          });
          const link = this.buildCloudUiLink(result.runId, identity.id, opts.isDirect);
          const vscodeUrl = await this.cloudManager.getVscodeUrl(result.sessionId);
          const text = t("snapshot.restored", lang, { snapshotId, runId: result.runId });
          await this.sendCloudRunStartedMessage({
            platform: opts.platform,
            chatId: opts.chatId,
            userId: opts.userId,
            text,
            sessionId: result.sessionId,
            runId: result.runId,
            viewUrl: link,
            vscodeUrl,
            replyToMessageId: opts.replyToMessageId,
            messageThreadId: opts.messageThreadId,
            slackThreadTs: opts.slackThreadTs,
          });
        } catch (e) {
          await replyText("snapshot.restore_failed", { error: String(e) });
        }
        return true;
      }
      case "snapshot_clear": {
        try {
          const count = await this.cloudManager.clearSnapshots(identity.id);
          await replyText("snapshot.clear_success", { count });
        } catch (e) {
          await replyText("snapshot.clear_failed", { error: String(e) });
        }
        return true;
      }
      case "action_run": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "action_run" }>;
        let repoIds = cmd.repoIds;
        let playground = false;
        if (repoIds.length === 0) {
          if (isPlaygroundRepoId(identity.active_repo_id)) {
            playground = true;
          } else if (identity.active_repo_id) {
            repoIds = [identity.active_repo_id];
          } else {
            const conns = await listConnections(this.db, identity.id);
            const hasGithub = conns.some((conn) => conn.type === "github_app" || conn.type === "github_oauth");
            if (!hasGithub) {
              playground = true;
            } else {
              await replyText("run.no_active_repo_or_repos", {
                select: formatCmd("repo select <number>"),
                playground: formatCmd("repo select playground"),
              });
              return true;
            }
          }
        }
        if (!playground) {
          const repos = await listReposForIdentity(this.db, identity.id);
          const repoIdSet = new Set(repos.map((r) => r.id));
          for (const id of repoIds) {
            if (!repoIdSet.has(id)) {
              await replyText("repo.not_found_or_accessible", { id });
              return true;
            }
          }
          if (!opts.isDirect) {
            const shared = await listSharedRepos(this.db, { platform: opts.platform, workspaceId: opts.workspaceId, chatId: opts.chatId });
            const sharedIds = new Set(shared.map((s) => s.repo_id));
            for (const id of repoIds) {
              if (!sharedIds.has(id)) {
                await replyText("repo.not_shared_in_chat", { id });
                return true;
              }
            }
          }
        }
        const agent = cloud.default_agent === "claude_code" ? "claude_code" : "codex";
        if (agent === "claude_code" && !this.config.claude_code) {
          await replyText("agent.claude_code.not_configured");
          return true;
        }
        const prompt = cmd.prompt.trim();
        if (!prompt) {
          await replyText("run.prompt_required");
          return true;
        }
        try {
          const result = await this.cloudManager.startRun({
            identityId: identity.id,
            platform: opts.platform,
            workspaceId: opts.workspaceId,
            chatId: opts.chatId,
            spaceId: opts.spaceId,
            userId: opts.userId,
            prompt,
            repoIds,
            agent,
            playground,
          });
          const link = this.buildCloudUiLink(result.runId, identity.id, opts.isDirect);
          const vscodeUrl = await this.cloudManager.getVscodeUrl(result.sessionId);
          const text = t("run.started", lang, { id: result.runId });
          await this.sendCloudRunStartedMessage({
            platform: opts.platform,
            chatId: opts.chatId,
            userId: opts.userId,
            text,
            sessionId: result.sessionId,
            runId: result.runId,
            viewUrl: link,
            vscodeUrl,
            replyToMessageId: opts.replyToMessageId,
            messageThreadId: opts.messageThreadId,
            slackThreadTs: opts.slackThreadTs,
          });
        } catch (e) {
          const msg = String(e);
          if (/ChatGPT auth missing or expired/i.test(msg) || /ChatGPT token unavailable/i.test(msg) || msg.includes("CHATGPT_AUTH_ERROR_PREFIX")) {
            await replyText("run.failed_auth", { cmd: formatCmd("connect chatgpt") });
          } else {
            await replyText("run.failed", { error: msg });
          }
        }
        return true;
      }
      case "setup_status": {
        if (isPlaygroundRepoId(identity.active_repo_id)) {
          await replyText("setup.playground_no_repo_manage");
          return true;
        }
        if (!identity.active_repo_id) {
          await replyText("repo.none_active_simple");
          return true;
        }
        const spec = await getLatestSetupSpec(this.db, identity.active_repo_id);
        if (!spec) {
          await replyText("setup.no_spec", { cmd: formatCmd("setup lift") });
          return true;
        }
        await replyText("setup.configured");
        return true;
      }
      case "setup_lift": {
        if (isPlaygroundRepoId(identity.active_repo_id)) {
          await replyText("setup.playground_no_repo_lift");
          return true;
        }
        if (!identity.active_repo_id) {
          await replyText("repo.none_active_simple");
          return true;
        }
        try {
          const repo = await this.db.selectFrom("repos").selectAll().where("id", "=", identity.active_repo_id).executeTakeFirstOrThrow();
          const conn = await this.db.selectFrom("connections").selectAll().where("id", "=", repo.connection_id).executeTakeFirstOrThrow();
          const provider = new LocalCloudProvider(cloud.workspaces_dir, this.logger);
          const workspace = await provider.createWorkspace({ prefix: "lift" });
          let cloneToken = conn.access_token;
          let cloneUser: string | undefined;
          if (conn.type === "github_app" && cloud.github_app) {
            const token = await ensureGithubAppToken({
              db: this.db,
              config: cloud.github_app,
              secretKey: cloud.secrets_key,
              connection: conn,
            });
            cloneToken = token.token;
            cloneUser = "x-access-token";
          }
          const clone = buildCloneUrl(repo.url, cloneToken, cloneUser ? { username: cloneUser } : undefined);
          await runGitClone({ url: clone.url, cwd: workspace.rootPath, targetDir: path.join(workspace.rootPath, "repo"), logger: this.logger });
          const spec = await generateSetupSpecFromPath(path.join(workspace.rootPath, "repo"));
          const yml = stringifySetupSpec(spec);
          const hash = hashSetupSpec(yml);
          await putSetupSpec(this.db, { repoId: repo.id, ymlBlob: yml, hash });
          await provider.terminateWorkspace(workspace);
          await replyText("setup.lift_saved");
        } catch (e) {
          await replyText("setup.lift_failed", { error: String(e) });
        }
        return true;
      }
      case "tinc_token": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("tinc token") });
          return true;
        }
        const ui = cloud.ui;
        if (!ui || !ui.token_secret) {
          await replyText("cloud.ui_token_missing");
          return true;
        }
        const token = createUiToken(ui, { scope: "identity", identity_id: identity.id });
        const baseRaw =
          cloud.public_base_url && cloud.public_base_url.trim().length > 0
            ? cloud.public_base_url
            : `http://localhost:${this.config.bot.port}`;
        const baseUrl = baseRaw.replace(/\/+$/g, "");
        const ttlMs = ui.token_ttl_ms;
        const ttl =
          typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
            ? ttlMs >= 60 * 60 * 1000
              ? `${(ttlMs / (60 * 60 * 1000)).toFixed(1)}h`
              : `${Math.max(1, Math.round(ttlMs / (60 * 1000)))}m`
            : null;
        const lines = [
          t("tinc.token.title", lang),
          "`" + token + "`",
          "",
          t("tinc.token.env_vars", lang),
          "`TINC_URL=" + baseUrl + "`",
          "`TINC_TOKEN=<token>`",
          "",
          t("tinc.token.example", lang),
          "`TINC_URL=" + baseUrl + " TINC_TOKEN=<token> tinc pull --run <id>`",
          ttl ? t("tinc.token.ttl", lang, { ttl }) : null,
        ].filter((line): line is string => Boolean(line));
        await reply(lines.join("\n"), true);
        return true;
      }
      case "secrets_set": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("secrets set") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_set" }>;
        if (!cmd.value) {
          await replyText("secrets.usage_set", { cmd: formatCmd("secrets set NAME VALUE") });
          return true;
        }
        try {
          const encrypted = encryptSecret(cmd.value, cloud.secrets_key);
          await setSecret(this.db, { identityId: identity.id, name: cmd.name, encryptedValue: encrypted });
          await replyText("secrets.saved", { name: cmd.name });
        } catch (e) {
          await replyText("secrets.save_failed", { error: String(e) });
        }
        return true;
      }
      case "secrets_create": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("secrets create") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_create" }>;
        if (!cmd.value) {
          await replyText("secrets.usage_create", { cmd: formatCmd("secrets create NAME VALUE") });
          return true;
        }
        const existing = await listSecrets(this.db, identity.id);
        if (this.findSecretMetaByName(existing, cmd.name)) {
          await replyText("secrets.exists", { name: cmd.name, cmd: formatCmd("secrets update") });
          return true;
        }
        try {
          const encrypted = encryptSecret(cmd.value, cloud.secrets_key);
          await setSecret(this.db, { identityId: identity.id, name: cmd.name, encryptedValue: encrypted });
          await replyText("secrets.created", { name: cmd.name });
        } catch (e) {
          await replyText("secrets.create_failed", { error: String(e) });
        }
        return true;
      }
      case "secrets_update": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("secrets update") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_update" }>;
        if (!cmd.value) {
          await replyText("secrets.usage_update", { cmd: formatCmd("secrets update NAME VALUE") });
          return true;
        }
        const existing = await listSecrets(this.db, identity.id);
        if (!this.findSecretMetaByName(existing, cmd.name)) {
          await replyText("secrets.not_found_use_create", { name: cmd.name, cmd: formatCmd("secrets create") });
          return true;
        }
        try {
          const encrypted = encryptSecret(cmd.value, cloud.secrets_key);
          await setSecret(this.db, { identityId: identity.id, name: cmd.name, encryptedValue: encrypted });
          await replyText("secrets.updated", { name: cmd.name });
        } catch (e) {
          await replyText("secrets.update_failed", { error: String(e) });
        }
        return true;
      }
      case "secrets_list": {
        const secrets = await listSecrets(this.db, identity.id);
        if (secrets.length === 0) {
          await replyText("secrets.none");
          return true;
        }
        await reply(secrets.map((s) => `- \`${s.name}\``).join("\n"));
        return true;
      }
      case "secrets_delete": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_delete" }>;
        const ok = await deleteSecret(this.db, identity.id, cmd.name);
        await reply(ok ? t("secrets.deleted", lang, { name: cmd.name }) : t("secrets.delete_not_found", lang));
        return true;
      }
    }
  }

  private async startTelegramWizard(
    chatId: string,
    userId: string,
    replyToMessageId: number,
    messageThreadId: number | undefined,
    agent: SessionAgent,
  ) {
    if (!this.telegram) return;
    await setWizardState(this.db, {
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

    const lang = await this.resolveUserLanguage("telegram", userId);
    const menuText = buildMenuText("telegram", agent, lang);
    const keyboard = this.telegram.projectKeyboard(this.config.projects);
    keyboard.inline_keyboard.push([{ text: getLanguageLabel(getOtherLanguage(lang)), callback_data: `lang:${getOtherLanguage(lang)}` }]);
    await this.telegram.sendMessage({
      chatId,
      text: menuText,
      messageThreadId,
      replyToMessageId,
      replyMarkup: keyboard,
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
    if (data.startsWith("lang:")) {
      const next = data.slice("lang:".length);
      if (!isUserLanguage(next)) {
        await this.telegram.answerCallbackQuery(cb.id);
        return;
      }
      const userId = String(cb.from.id);
      await setUserLanguage(this.db, "telegram", userId, next);
      await this.db
        .updateTable("sessions")
        .set({ language: next, updated_at: nowMs() })
        .where("platform", "=", "telegram")
        .where("created_by_user_id", "=", userId)
        .where("status", "in", ["starting", "running"])
        .execute();
      const confirmKey = next === "zh" ? "lang.switched_zh" : "lang.switched_en";
      await this.telegram.answerCallbackQuery(cb.id, t(confirmKey, next));
      return;
    }
    const actorLang = await this.resolveUserLanguage("telegram", String(cb.from.id));
    if (data.startsWith("kill:")) {
      const sessionId = data.slice("kill:".length);
      const chat = cb.message?.chat;
      const chatId = chat ? String(chat.id) : null;
      const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
      if (!chatId || !sessionId) {
        await this.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected kill callback chat=${chatId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        await this.telegram.answerCallbackQuery(cb.id, t("error.not_authorized", actorLang));
        return;
      }
      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "telegram" || session.chat_id !== chatId) {
        await this.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }
      if (session.status !== "starting" && session.status !== "running") {
        await this.telegram.answerCallbackQuery(cb.id, t("session.already_finished", actorLang));
        return;
      }

      const isCloudSession = await this.isCloudSession(session as SessionRow);
      if (isCloudSession && this.cloudManager) {
        await this.telegram.answerCallbackQuery(cb.id, t("run.stopping", actorLang));
        try {
          await this.cloudManager.stopSandboxForSession(sessionId);
          await this.sendSessionMessageMarkdown(session as SessionRow, t("run.stopped", this.resolveSessionLanguage(session as SessionRow)));
        } catch (e) {
          this.logger.warn(`[tg] stop run failed chat=${chatId} user=${userId} session=${sessionId}: ${String(e)}`);
          const lang = this.resolveSessionLanguage(session as SessionRow);
          await this.sendSessionMessageMarkdown(
            session as SessionRow,
            t("run.stop_failed", lang, {
              error: redactText(e instanceof Error ? e.message : String(e)),
            }),
          );
        }
        return;
      }

      await this.telegram.answerCallbackQuery(cb.id, t("session.stopping", actorLang));
      await this.sessionManager.killSession(sessionId, t("session.stop_requested", this.resolveSessionLanguage(session as SessionRow)));
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
        await this.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected review callback chat=${chatId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        await this.telegram.answerCallbackQuery(cb.id, t("error.not_authorized", actorLang));
        return;
      }
      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "telegram" || session.chat_id !== chatId) {
        await this.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }

      this.markReviewCommitDisabled(sessionId);
      if (messageId !== null) {
        await this.disableReviewCommitButtonsTelegram({
          chatId,
          messageId,
          text: messageText,
          note: t("review.started_note", this.resolveSessionLanguage(session as SessionRow)),
        });
      }

      await this.telegram.answerCallbackQuery(cb.id, t("session.starting_review", actorLang));
      try {
        await this.handleSessionMessage(session as SessionRow, userId, REVIEW_PROMPT);
      } catch (e) {
        this.logger.warn(
          `[tg] review callback failed chat=${chatId} user=${userId} session=${sessionId}: ${String(e)}`,
        );
        try {
          const lang = this.resolveSessionLanguage(session as SessionRow);
          await this.telegram.sendMessage({
            chatId,
            messageThreadId: this.telegramForumThreadIdFromMessage(cb.message),
            replyToMessageId: cb.message?.message_id,
            text: t("error.generic", lang, { message: redactText(e instanceof Error ? e.message : String(e)) }),
            replyMarkup: this.buildLanguageToggleTelegram(lang),
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
        await this.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected commit callback chat=${chatId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        await this.telegram.answerCallbackQuery(cb.id, t("error.not_authorized", actorLang));
        return;
      }
      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "telegram" || session.chat_id !== chatId) {
        await this.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }

      this.markReviewCommitDisabled(sessionId);
      if (messageId !== null) {
        await this.disableReviewCommitButtonsTelegram({ chatId, messageId, text: messageText });
      }

      const isCloudSession = await this.isCloudSession(session as SessionRow);
      if (isCloudSession && this.cloudManager && this.commitProposalStore) {
        const identity = await getOrCreateIdentity(this.db, {
          platform: session.platform,
          workspaceId: session.workspace_id ?? null,
          userId: session.created_by_user_id,
        });
        this.commitProposalStore.startProposal({
          sessionId,
          platform: "telegram",
          chatId,
          userId,
          spaceId: session.space_id,
          isTelegramTopic: this.isTelegramTopicSession(session),
          gitUserName: identity.git_user_name,
          gitUserEmail: identity.git_user_email,
        });
        await this.telegram.answerCallbackQuery(cb.id, t("commit.proposal.preparing", actorLang));
        try {
          await this.handleSessionMessage(session as SessionRow, userId, buildCommitProposalPrompt(identity.branch_name_rule));
        } catch (e) {
          this.logger.warn(
            `[tg] commit proposal failed chat=${chatId} user=${userId} session=${sessionId}: ${String(e)}`,
          );
          try {
            const lang = this.resolveSessionLanguage(session as SessionRow);
            await this.telegram.sendMessage({
              chatId,
              messageThreadId: this.telegramForumThreadIdFromMessage(cb.message),
              replyToMessageId: cb.message?.message_id,
              text: t("error.generic", lang, { message: redactText(e instanceof Error ? e.message : String(e)) }),
              replyMarkup: this.buildLanguageToggleTelegram(lang),
              priority: "user",
            });
          } catch {}
        }
        return;
      }

      await this.telegram.answerCallbackQuery(cb.id, t("session.committing", actorLang));
      try {
        await this.handleSessionMessage(session as SessionRow, userId, COMMIT_PROMPT);
      } catch (e) {
        this.logger.warn(
          `[tg] commit callback failed chat=${chatId} user=${userId} session=${sessionId}: ${String(e)}`,
        );
        try {
          const lang = this.resolveSessionLanguage(session as SessionRow);
          await this.telegram.sendMessage({
            chatId,
            messageThreadId: this.telegramForumThreadIdFromMessage(cb.message),
            replyToMessageId: cb.message?.message_id,
            text: t("error.generic", lang, { message: redactText(e instanceof Error ? e.message : String(e)) }),
            replyMarkup: this.buildLanguageToggleTelegram(lang),
            priority: "user",
          });
        } catch {}
      }
      return;
    }

    if (data.startsWith("run_status:")) {
      const runId = data.slice("run_status:".length).trim();
      const chat = cb.message?.chat;
      const chatId = chat ? String(chat.id) : null;
      const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
      if (!chatId || !runId) {
        await this.telegram.answerCallbackQuery(cb.id, t("run.not_found", actorLang));
        return;
      }
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected run status callback chat=${chatId} user=${userId} run=${runId} reason=${access.reason ?? "-"}`,
        );
        await this.telegram.answerCallbackQuery(cb.id, t("error.not_authorized", actorLang));
        return;
      }
      await this.telegram.answerCallbackQuery(cb.id, t("run.status_fetching", actorLang));
      await this.sendCloudRunStatus({
        platform: "telegram",
        chatId,
        userId,
        workspaceId: null,
        runId,
        isDirect: chat?.type === "private",
        replyToMessageId: cb.message?.message_id,
        messageThreadId: this.telegramForumThreadIdFromMessage(cb.message),
      });
      return;
    }

    if (data.startsWith("stop_sandbox:")) {
      const sessionId = data.slice("stop_sandbox:".length);
      const chat = cb.message?.chat;
      const chatId = chat ? String(chat.id) : null;
      const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
      if (!chatId || !sessionId) {
        await this.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected stop sandbox callback chat=${chatId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        await this.telegram.answerCallbackQuery(cb.id, t("error.not_authorized", actorLang));
        return;
      }
      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "telegram" || session.chat_id !== chatId) {
        await this.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }
      const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
      if (!this.cloudManager || !isCloudSession) {
        await this.telegram.answerCallbackQuery(cb.id, t("sandbox.stop_unavailable", actorLang));
        return;
      }
      await this.telegram.answerCallbackQuery(cb.id, t("sandbox.stopping", actorLang));
      try {
        await this.cloudManager.stopSandboxForSession(sessionId);
        await this.sendSessionMessageMarkdown(session as SessionRow, t("sandbox.stopped", this.resolveSessionLanguage(session as SessionRow)));
      } catch (e) {
        this.logger.warn(`[tg] stop sandbox failed chat=${chatId} user=${userId} session=${sessionId}: ${String(e)}`);
        const lang = this.resolveSessionLanguage(session as SessionRow);
        await this.sendSessionMessageMarkdown(
          session as SessionRow,
          t("sandbox.stop_failed", lang, {
            error: redactText(e instanceof Error ? e.message : String(e)),
          }),
        );
      }
      return;
    }

    if (data.startsWith("cpr:")) {
      const rest = data.slice("cpr:".length);
      const [proposalId, actionRaw] = rest.split(":");
      const action = (actionRaw ?? "").trim() as CommitProposalAction;
      const chat = cb.message?.chat;
      const chatId = chat ? String(chat.id) : null;
      const userId = chat && chat.type === "channel" ? String(chat.id) : String(cb.from.id);
      if (!chatId || !proposalId) {
        await this.telegram.answerCallbackQuery(cb.id, t("commit.proposal.not_found", actorLang));
        return;
      }
      const access = await this.telegramAccessDecision(chatId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[tg] rejected commit proposal callback chat=${chatId} user=${userId} proposal=${proposalId} reason=${access.reason ?? "-"}`,
        );
        await this.telegram.answerCallbackQuery(cb.id, t("error.not_authorized", actorLang));
        return;
      }
      if (action !== "cancel" && action !== "push" && action !== "pr") {
        await this.telegram.answerCallbackQuery(cb.id, t("action.unsupported", actorLang));
        return;
      }
      const proposal = this.commitProposalStore?.getProposal(proposalId) ?? null;
      if (!proposal) {
        await this.telegram.answerCallbackQuery(cb.id, t("commit.proposal.expired", actorLang));
        return;
      }
      if (proposal.platform !== "telegram" || proposal.chatId !== chatId || proposal.userId !== userId) {
        await this.telegram.answerCallbackQuery(cb.id, t("error.not_authorized", actorLang));
        return;
      }
      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", proposal.sessionId).executeTakeFirst();
      if (!session || session.platform !== "telegram" || session.chat_id !== chatId) {
        await this.telegram.answerCallbackQuery(cb.id, t("session.not_found", actorLang));
        return;
      }
      await this.telegram.answerCallbackQuery(cb.id, t("action.processing", actorLang));
      await this.handleCommitProposalAction({ proposal, session: session as SessionRow, action });
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
      await this.telegram.answerCallbackQuery(cb.id, t("callback.unsupported_context", actorLang));
      return;
    }
    const access = await this.telegramAccessDecision(chatId, userId);
    if (!access.allowed) {
      this.logger.warn(
        `[tg] rejected callback chat=${chatId} user=${userId} project=${projectId} reason=${access.reason ?? "-"}`,
      );
      await this.telegram.answerCallbackQuery(cb.id, t("error.not_authorized", actorLang));
      return;
    }

    const existing = await getWizardState(this.db, "telegram", chatId, userId);
    const agent: SessionAgent = existing?.agent ?? "codex";

    await setWizardState(this.db, {
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

    await this.telegram.answerCallbackQuery(cb.id);

    const forumThreadId = this.telegramForumThreadIdFromMessage(cb.message);
    const lang = await this.resolveUserLanguage("telegram", userId);
    await this.telegram.sendMessage({
      chatId,
      messageThreadId: forumThreadId,
      replyToMessageId: cb.message?.message_id,
      text:
        project.path === "*"
          ? t("wizard.send_custom_path", lang)
          : t("wizard.send_prompt", lang),
      replyMarkup: this.buildLanguageToggleTelegram(lang),
      priority: "user",
    });
  }

  private async continueTelegramWizard(wizard: WizardStateRow, text: string, ctx: TelegramReplyContext) {
    if (!this.telegram) return;
    const lang = await this.resolveUserLanguage("telegram", wizard.user_id);

	    if (wizard.state === "await_project") {
	      await this.telegram.sendMessage({
	        chatId: wizard.chat_id,
	        messageThreadId: ctx.messageThreadId,
	        replyToMessageId: ctx.replyToMessageId,
          text: t("wizard.choose_project_buttons", lang),
          replyMarkup: this.buildLanguageToggleTelegram(lang),
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
          text: t("wizard.expired", lang),
          replyMarkup: this.buildLanguageToggleTelegram(lang),
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
          text: t("wizard.path_accepted", lang),
          replyMarkup: this.buildLanguageToggleTelegram(lang),
	        priority: "user",
	      });
	      return;
	    }

    if (wizard.state === "await_initial_prompt") {
      const resolved = await validateAndResolveProjectPath(this.config, project, wizard.custom_path_candidate);

      try {
        await this.sessionManager.assertCanStartNewSession({ platform: "telegram", chatId: wizard.chat_id });
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
        await this.telegram.sendMessage({
          chatId: wizard.chat_id,
          messageThreadId: ctx.messageThreadId,
          replyToMessageId: ctx.replyToMessageId,
          text: `${text}${hint}`,
          replyMarkup: this.buildLanguageToggleTelegram(lang),
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
          agent: wizard.agent,
        });
      } catch (e) {
        await clearWizardState(this.db, "telegram", wizard.chat_id, wizard.user_id);
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
          await this.telegram.sendMessage({
            chatId: wizard.chat_id,
            messageThreadId: topicId,
            text: `${text}${hint}`,
            replyMarkup: this.buildLanguageToggleTelegram(lang),
            priority: "user",
          });
        } else {
          await this.telegram.sendMessage({
            chatId: wizard.chat_id,
            messageThreadId: ctx.messageThreadId,
            replyToMessageId: Number(spaceId),
            text: `${text}${hint}`,
            replyMarkup: this.buildLanguageToggleTelegram(lang),
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
          lang,
        });
      }

      if (announce) {
        // Best-effort nudge for users who aren't in the topic view.
        const emoji = topicEmoji ?? "🧠";
        const announceText = t("session.started_topic_hint", lang, { emoji });
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
              replyMarkup: this.buildLanguageToggleTelegram(lang),
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
    if (!this.telegram) throw new Error("Telegram not configured");
    const chatId = String(opts.chat.id);

    // Channels (and anonymous-admin posts) don't support forum topics; keep everything as replies.
    if (opts.chat.type === "channel") {
      await this.telegram.sendMessageSingle({
        chatId,
        replyToMessageId: opts.anchorMessageId,
        text: t("session.created", opts.lang),
        replyMarkup: this.buildLanguageToggleTelegram(opts.lang),
        priority: "user",
      });
      return { spaceId: String(opts.anchorMessageId), announce: false };
    }

    if (this.config.telegram?.use_topics && opts.chat.type === "supergroup" && opts.chat.is_forum) {
      const picked = await this.pickTelegramTopicEmoji();
      const topicEmoji = picked.emoji;
      const topicCustomEmojiId = picked.customEmojiId;
      try {
        const initialName = clipForumTopicName(`${topicEmoji} ${agentShortName(opts.agent)}: ${opts.projectName}`);
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
      text: t("session.created_reply", opts.lang),
      replyMarkup: this.buildLanguageToggleTelegram(opts.lang),
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
    if (!this.telegram) return;
    const message = this.formatTelegramTopicHeaderMessage(opts.initialPrompt, opts.sessionId, opts.lang);
    try {
      const msg = await this.telegram.sendMessageSingleStrict({
        chatId: opts.chatId,
        messageThreadId: opts.topicId,
        text: message.text,
        parseMode: message.parseMode,
        replyMarkup: {
          inline_keyboard: [
            [{ text: t("button.stop", opts.lang), callback_data: `kill:${opts.sessionId}` }],
            [{ text: getLanguageLabel(getOtherLanguage(opts.lang)), callback_data: `lang:${getOtherLanguage(opts.lang)}` }],
          ],
        },
        priority: "user",
      });
      await this.telegram.pinChatMessage(opts.chatId, msg.message_id);
    } catch (e) {
      this.logger.warn(
        `[tg] failed to pin topic header chat=${opts.chatId} topic=${opts.topicId} session=${opts.sessionId}: ${String(e)}`,
      );
    }
  }

  private formatTelegramTopicHeaderMessage(
    initialPrompt: string,
    sessionId: string,
    lang: UserLanguage,
  ): { text: string; parseMode: "HTML" } {
    const maxChars = this.config.telegram?.max_chars ?? 4096;
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
    agent: SessionAgent;
  }) {
    if (!this.telegram) return;
    try {
      const emojiPrefix = `${opts.topicEmoji} `;
      const maxNameChars = 128;
      const maxTitleChars = Math.max(16, maxNameChars - emojiPrefix.length);

      const adapter = getAgentAdapter(opts.agent);
      adapter.requireConfig(this.config);
      const sessionsRoot = adapter.resolveSessionsRoot(opts.projectPathResolved, this.config);
      const homeDir = adapter.resolveHomeDir(sessionsRoot);
      const title = await adapter.generateTitle({
        config: this.config,
        logger: this.logger,
        cwd: opts.projectPathResolved,
        projectName: opts.projectName,
        initialPrompt: opts.initialPrompt,
        maxTitleChars,
        homeDir,
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
      const lang = await this.resolveUserLanguage("slack", userId);

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
          text: formatSessionList("slack", lang, { ...sessionPage, filterLabel: formatSessionFilterLabel(listIntent.statuses) }),
          blocks: this.buildLanguageToggleSlackBlocks(lang),
        });
        return;
      }

      const settingsIntent = parseSettingsIntentFromSlack(text);
      if (settingsIntent) {
        const identity = await getOrCreateIdentity(this.db, { platform: "slack", workspaceId: teamId ?? null, userId });
        if (settingsIntent.cmd.kind === "list") {
          let cloudKeyStatus: { openai: boolean; anthropic: boolean } | null = null;
          if (this.config.cloud?.enabled) {
            const secrets = await listSecrets(this.db, identity.id);
            const names = new Set(secrets.map((s) => s.name));
            cloudKeyStatus = {
              openai: names.has("OPENAI_API_KEY"),
              anthropic: names.has("ANTHROPIC_API_KEY"),
            };
          }
          const result = formatSettingsSummary(this.config, settingsIntent.defaultAgent, "slack", lang, identity, cloudKeyStatus);
          await this.slack.postEphemeral({
            channel: channelId,
            user: userId,
            text: result,
            blocks: this.buildLanguageToggleSlackBlocks(lang),
          });
          return;
        }
        const cloudResult = await applyCloudSettingsCommand({
          config: this.config,
          db: this.db,
          cmd: settingsIntent.cmd,
          identityId: identity.id,
          lang,
        });
        const identityResult = await applyIdentitySettingsCommand({
          config: this.config,
          db: this.db,
          cmd: settingsIntent.cmd,
          identityId: identity.id,
          lang,
        });
        const result =
          identityResult ??
          cloudResult ??
          applySettingsCommand(this.config, settingsIntent.cmd, settingsIntent.defaultAgent, "slack", lang);
        await this.slack.postEphemeral({
          channel: channelId,
          user: userId,
          text: result,
          blocks: this.buildLanguageToggleSlackBlocks(lang),
        });
        return;
      }

      const cloudCmd = parseCloudCommand(text);
      if (cloudCmd) {
        const spaceId =
          this.config.slack?.session_mode === "thread"
            ? typeof ev.ts === "string"
              ? ev.ts
              : channelId
            : channelId;
        await this.handleCloudCommand({
          platform: "slack",
          command: cloudCmd,
          chatId: channelId,
          workspaceId: teamId,
          userId,
          isDirect: channelId.startsWith("D"),
          spaceId,
          slackThreadTs: spaceId,
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

      const cmdSpaceId =
        this.config.slack?.session_mode === "thread"
          ? typeof ev.thread_ts === "string"
            ? ev.thread_ts
            : typeof ev.ts === "string"
              ? ev.ts
              : channelId
          : channelId;

      this.logger.debug(
        `[slack] message received workspace=${String(teamId ?? "-")} channel=${channelId} user=${userId} space=${cmdSpaceId} text=${JSON.stringify(
          safeSnippet(text),
        )}`,
      );

      const cloudCmd = parseCloudCommand(text);
      if (cloudCmd) {
        await this.handleCloudCommand({
          platform: "slack",
          command: cloudCmd,
          chatId: channelId,
          workspaceId: teamId,
          userId,
          isDirect: channelId.startsWith("D"),
          spaceId: cmdSpaceId,
          slackThreadTs: cmdSpaceId,
        });
        return;
      }

      const spaceId =
        this.config.slack?.session_mode === "thread"
          ? typeof ev.thread_ts === "string"
            ? ev.thread_ts
            : null
          : channelId;
      if (!spaceId) return;

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
        const lang = await this.resolveUserLanguage("slack", user);
        await this.slack.postEphemeral({
          channel,
          user,
          text: t("error.generic", lang, { message: String(e) }),
          blocks: this.buildLanguageToggleSlackBlocks(lang),
        });
      }
    }
  }

  private async startSlackWizard(teamId: string | null, channelId: string, userId: string) {
    if (!this.slack) return;
    const lang = await this.resolveUserLanguage("slack", userId);
    await setWizardState(this.db, {
      id: crypto.randomUUID(),
      agent: "codex",
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

    const menuText = buildMenuText("slack", "codex", lang);
    const commandExamples = buildCommandExamples("slack", lang);

    await this.slack.postEphemeral({
      channel: channelId,
      user: userId,
      text: menuText,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `${t("wizard.choose_project", lang, { agent: "Codex" })}:` },
          accessory: {
            type: "static_select",
            action_id: "project_select",
            placeholder: { type: "plain_text", text: t("wizard.select_project", lang) },
            options,
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: commandExamples },
        },
        ...this.buildLanguageToggleSlackBlocks(lang),
      ],
    });
  }

  private async handleSlackBlockActions(payload: any) {
    if (!this.slack) return;
    const action = payload.actions?.[0];
    if (!action) return;

    if (action.action_id === "switch_language") {
      const next = typeof action.value === "string" ? action.value : "";
      const channelId = payload.channel?.id as string | undefined;
      const userId = payload.user?.id as string | undefined;
      if (!channelId || !userId || !isUserLanguage(next)) return;
      await setUserLanguage(this.db, "slack", userId, next);
      await this.db
        .updateTable("sessions")
        .set({ language: next, updated_at: nowMs() })
        .where("platform", "=", "slack")
        .where("created_by_user_id", "=", userId)
        .where("status", "in", ["starting", "running"])
        .execute();
      const confirmKey = next === "zh" ? "lang.switched_zh" : "lang.switched_en";
      await this.slack.postEphemeral({ channel: channelId, user: userId, text: t(confirmKey, next) });
      return;
    }

    if (action.action_id === "kill_session") {
      const sessionId = typeof action.value === "string" ? action.value : null;
      const channelId = payload.channel?.id as string | undefined;
      const userId = payload.user?.id as string | undefined;
      const teamId = payload.team?.id as string | undefined;
      if (!sessionId || !channelId || !userId) return;

      const lang = await this.resolveUserLanguage("slack", userId);
      const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[slack] rejected kill action channel=${channelId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        return;
      }

      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "slack" || session.chat_id !== channelId) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("session.not_found", lang) });
        return;
      }
      if (session.status !== "starting" && session.status !== "running") {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("session.already_finished", lang) });
        return;
      }

      const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
      if (isCloudSession && this.cloudManager) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("run.stopping", lang) });
        try {
          await this.cloudManager.stopSandboxForSession(sessionId);
          await this.sendSessionMessageMarkdown(session as SessionRow, t("run.stopped", this.resolveSessionLanguage(session as SessionRow)));
        } catch (e) {
          this.logger.warn(
            `[slack] stop run failed channel=${channelId} user=${userId} session=${sessionId}: ${String(e)}`,
          );
          await this.sendSessionMessageMarkdown(
            session as SessionRow,
            t("run.stop_failed", this.resolveSessionLanguage(session as SessionRow), {
              error: redactText(e instanceof Error ? e.message : String(e)),
            }),
          );
        }
        return;
      }

      await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("session.stopping", lang) });
      await this.sessionManager.killSession(sessionId, t("session.stop_requested", this.resolveSessionLanguage(session as SessionRow)));
      return;
    }

    if (action.action_id === "stop_sandbox") {
      const sessionId = typeof action.value === "string" ? action.value : null;
      const channelId = payload.channel?.id as string | undefined;
      const userId = payload.user?.id as string | undefined;
      const teamId = payload.team?.id as string | undefined;
      if (!sessionId || !channelId || !userId) return;

      const lang = await this.resolveUserLanguage("slack", userId);
      const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[slack] rejected stop sandbox action channel=${channelId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        return;
      }

      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "slack" || session.chat_id !== channelId) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("session.not_found", lang) });
        return;
      }
      const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
      if (!this.cloudManager || !isCloudSession) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("sandbox.stop_unavailable", lang) });
        return;
      }

      await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("sandbox.stopping", lang) });
      try {
        await this.cloudManager.stopSandboxForSession(sessionId);
        await this.sendSessionMessageMarkdown(session as SessionRow, t("sandbox.stopped", this.resolveSessionLanguage(session as SessionRow)));
      } catch (e) {
        this.logger.warn(
          `[slack] stop sandbox action failed channel=${channelId} user=${userId} session=${sessionId}: ${String(e)}`,
        );
        await this.sendSessionMessageMarkdown(
          session as SessionRow,
          t("sandbox.stop_failed", this.resolveSessionLanguage(session as SessionRow), {
            error: redactText(e instanceof Error ? e.message : String(e)),
          }),
        );
      }
      return;
    }

    if (action.action_id === "run_status") {
      const runId = typeof action.value === "string" ? action.value : null;
      const channelId = payload.channel?.id as string | undefined;
      const userId = payload.user?.id as string | undefined;
      const teamId = payload.team?.id as string | undefined;
      const threadTs = (payload.message?.ts ?? payload.container?.message_ts) as string | undefined;
      if (!runId || !channelId || !userId) return;

      const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[slack] rejected run status action channel=${channelId} user=${userId} run=${runId} reason=${access.reason ?? "-"}`,
        );
        return;
      }

      await this.sendCloudRunStatus({
        platform: "slack",
        chatId: channelId,
        userId,
        workspaceId: teamId ?? null,
        runId,
        isDirect: channelId.startsWith("D"),
        slackThreadTs: threadTs,
      });
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

      const lang = await this.resolveUserLanguage("slack", userId);
      const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[slack] rejected review action channel=${channelId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        return;
      }

      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "slack" || session.chat_id !== channelId) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("session.not_found", lang) });
        return;
      }

      this.markReviewCommitDisabled(sessionId);
      if (ts) {
        await this.disableReviewCommitButtonsSlack({
          channelId,
          ts,
          text: messageText,
          note: t("review.started_note", this.resolveSessionLanguage(session as SessionRow)),
        });
      }

      const threadTs = this.config.slack?.session_mode === "thread" ? session.space_id : undefined;
      await this.slack.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: t("session.starting_review", lang),
      });
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
          text: t("error.generic", lang, { message: String(e) }),
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

      const lang = await this.resolveUserLanguage("slack", userId);
      const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[slack] rejected commit action channel=${channelId} user=${userId} session=${sessionId} reason=${access.reason ?? "-"}`,
        );
        return;
      }

      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
      if (!session || session.platform !== "slack" || session.chat_id !== channelId) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("session.not_found", lang) });
        return;
      }

      this.markReviewCommitDisabled(sessionId);
      if (ts) await this.disableReviewCommitButtonsSlack({ channelId, ts, text: messageText });

      const threadTs = this.config.slack?.session_mode === "thread" ? session.space_id : undefined;
      const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
      if (isCloudSession && this.cloudManager && this.commitProposalStore) {
        const identity = await getOrCreateIdentity(this.db, {
          platform: session.platform,
          workspaceId: session.workspace_id ?? null,
          userId: session.created_by_user_id,
        });
        this.commitProposalStore.startProposal({
          sessionId,
          platform: "slack",
          chatId: channelId,
          userId,
          spaceId: session.space_id,
          isTelegramTopic: false,
          gitUserName: identity.git_user_name,
          gitUserEmail: identity.git_user_email,
        });
        await this.slack.postEphemeral({
          channel: channelId,
          user: userId,
          thread_ts: threadTs,
          text: t("commit.proposal.preparing", lang),
        });
        try {
          await this.handleSessionMessage(session as SessionRow, userId, buildCommitProposalPrompt(identity.branch_name_rule));
        } catch (e) {
          this.logger.warn(
            `[slack] commit proposal failed channel=${channelId} user=${userId} session=${sessionId}: ${String(e)}`,
          );
          await this.slack.postEphemeral({
            channel: channelId,
            user: userId,
            thread_ts: threadTs,
            text: t("error.generic", lang, { message: String(e) }),
          });
        }
        return;
      }

      await this.slack.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: t("session.committing", lang),
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
          text: t("error.generic", lang, { message: String(e) }),
        });
      }
      return;
    }

    if (action.action_id === "commit_cancel" || action.action_id === "commit_push" || action.action_id === "commit_pr") {
      const proposalId = typeof action.value === "string" ? action.value : null;
      const channelId = payload.channel?.id as string | undefined;
      const userId = payload.user?.id as string | undefined;
      const teamId = payload.team?.id as string | undefined;
      if (!proposalId || !channelId || !userId) return;

      const lang = await this.resolveUserLanguage("slack", userId);
      const access = this.slackAccessDecision(teamId ?? null, channelId, userId);
      if (!access.allowed) {
        this.logger.warn(
          `[slack] rejected commit proposal action channel=${channelId} user=${userId} proposal=${proposalId} reason=${access.reason ?? "-"}`,
        );
        return;
      }

      const proposal = this.commitProposalStore?.getProposal(proposalId) ?? null;
      if (!proposal) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("commit.proposal.expired", lang) });
        return;
      }
      if (proposal.platform !== "slack" || proposal.chatId !== channelId || proposal.userId !== userId) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("error.not_authorized", lang) });
        return;
      }
      const session = await this.db.selectFrom("sessions").selectAll().where("id", "=", proposal.sessionId).executeTakeFirst();
      if (!session || session.platform !== "slack" || session.chat_id !== channelId) {
        await this.slack.postEphemeral({ channel: channelId, user: userId, text: t("session.not_found", lang) });
        return;
      }
      const actionKind: CommitProposalAction =
        action.action_id === "commit_cancel" ? "cancel" : action.action_id === "commit_push" ? "push" : "pr";
      await this.handleCommitProposalAction({ proposal, session: session as SessionRow, action: actionKind });
      return;
    }

    if (action.action_id !== "project_select") return;

    const projectId = action.selected_option?.value as string | undefined;
    const triggerId = payload.trigger_id as string | undefined;
    const channelId = payload.channel?.id as string | undefined;
    const userId = payload.user?.id as string | undefined;
    const teamId = payload.team?.id as string | undefined;
    if (!projectId || !triggerId || !channelId || !userId) return;
    const lang = await this.resolveUserLanguage("slack", userId);
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
      agent: "codex",
      platform: "slack",
      chat_id: channelId,
      user_id: userId,
      state: project.path === "*" ? "await_custom_path" : "await_initial_prompt",
      project_id: projectId,
      custom_path_candidate: null,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    await this.slack.openModal(triggerId, this.buildSlackWizardModal({ project, channelId, userId, teamId: teamId ?? null, lang }));
  }

  private buildSlackWizardModal(opts: {
    project: ProjectEntry;
    channelId: string;
    userId: string;
    teamId: string | null;
    lang: UserLanguage;
  }) {
    const blocks: any[] = [];

    if (opts.project.path === "*") {
      blocks.push({
        type: "input",
        block_id: "custom_path",
        label: { type: "plain_text", text: t("wizard.project_path_label", opts.lang) },
        element: { type: "plain_text_input", action_id: "input" },
        hint: { type: "plain_text", text: t("wizard.project_path_hint", opts.lang) },
      });
    }

    blocks.push({
      type: "input",
      block_id: "prompt",
      label: { type: "plain_text", text: t("wizard.prompt_label", opts.lang) },
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
      title: { type: "plain_text", text: t("wizard.modal_title", opts.lang) },
      submit: { type: "plain_text", text: t("wizard.modal_submit", opts.lang) },
      close: { type: "plain_text", text: t("wizard.modal_cancel", opts.lang) },
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
    const lang = await this.resolveUserLanguage("slack", meta.userId);
    const rootTs = await this.slack.postMessage({
      channel: meta.channelId,
      text: t("session.starting", lang),
      blocks: this.buildLanguageToggleSlackBlocks(lang),
    });
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
      agent: "codex",
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
      const lang = this.resolveSessionLanguage(session);
      await this.sendToSession(session.id, { text: t("session.queued", lang, { n }), priority: "user" });
      return;
    }
    this.logger.debug(`[session] resuming session=${session.id} from=${userId}`);
    if (this.cloudManager && this.config.cloud?.enabled) {
      const resumed = await this.cloudManager.resumeCloudSession(session, text);
      if (resumed === "resumed") return;
      if (resumed === "expired") {
        await this.sendToSession(session.id, {
          text: t("sandbox.expired_new_session", this.resolveSessionLanguage(session)),
          priority: "user",
        });
        try {
          const restarted = await this.cloudManager.restartCloudSession(session, text);
          if (restarted === "restarted") return;
        } catch (e) {
          const lang = this.resolveSessionLanguage(session);
          await this.sendToSession(session.id, {
            text: t("session.restart_failed", lang, { error: redactText(String(e)) }),
            priority: "user",
          });
          return;
        }
        await this.sendToSession(session.id, {
          text: t("sandbox.expired_prompt", this.resolveSessionLanguage(session)),
          priority: "user",
        });
        return;
      }
    }
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

function parseRepoIndex(target: string): number | null {
  const cleaned = target.trim().replace(/[.)]$/, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function isPlaygroundRepoId(value: string | null | undefined): boolean {
  return value === PLAYGROUND_REPO_ID;
}

function isPlaygroundTarget(value: string): boolean {
  const cleaned = value.trim().toLowerCase().replace(/[.)]$/, "");
  if (!cleaned) return false;
  if (cleaned === "0") return true;
  if (cleaned === "playground") return true;
  if (cleaned === "none") return true;
  if (cleaned === "norepo") return true;
  if (cleaned === "no-repo") return true;
  if (cleaned === "no_repo") return true;
  if (cleaned === "no repo") return true;
  return false;
}

const TELEGRAM_COMMAND_AGENT: Record<string, SessionAgent> = { codex: "codex", cc: "claude_code" };

function parseListSessionsIntentFromTelegram(text: string): SessionListIntent | null {
  const cmd = parseTelegramCommand(text);
  if (!cmd) return null;
  if (cmd.command === "sessions") return parseListSessionsArgs(cmd.args);
  if (cmd.command === "codex" || cmd.command === "cc") {
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

type SettingsIntent = { cmd: SettingsCommand; defaultAgent: SessionAgent };

function parseSettingsIntentFromTelegram(text: string): SettingsIntent | null {
  const cmd = parseTelegramCommand(text);
  if (!cmd) return null;
  if (cmd.command === "settings") {
    const parsed = parseSettingsArgs(cmd.args);
    return parsed ? { cmd: parsed, defaultAgent: "codex" } : null;
  }
  const defaultAgent = TELEGRAM_COMMAND_AGENT[cmd.command];
  if (!defaultAgent) return null;
  const rest = cmd.args.trim();
  if (!rest.toLowerCase().startsWith("settings")) return null;
  const parsed = parseSettingsArgs(rest.slice("settings".length));
  if (!parsed) return null;
  return { cmd: parsed, defaultAgent };
}

function parseSettingsIntentFromSlack(text: string): SettingsIntent | null {
  const m = text.match(/\bsettings\b(.*)$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  const parsed = parseSettingsArgs(rest);
  return parsed ? { cmd: parsed, defaultAgent: "codex" } : null;
}

type CloudCommand =
  | { kind: "connect"; provider: string; subcommand?: string; payload?: string }
  | { kind: "disconnect"; provider: string; installationId?: string; confirmToken?: string; all?: boolean }
  | { kind: "connections" }
  | { kind: "repos"; provider?: string; search?: string }
  | { kind: "repo_select"; target: string }
  | { kind: "repo_current" }
  | { kind: "repo_share"; target: string }
  | { kind: "repo_unshare"; target: string }
  | { kind: "actions_list" }
  | { kind: "action_run"; prompt: string; repoIds: string[] }
  | { kind: "action_status"; runId: string }
  | { kind: "action_pull"; runId: string }
  | { kind: "setup_status" }
  | { kind: "setup_lift" }
  | { kind: "tinc_token" }
  | { kind: "secrets_set"; name: string; value: string | null }
  | { kind: "secrets_create"; name: string; value: string | null }
  | { kind: "secrets_update"; name: string; value: string | null }
  | { kind: "secrets_list" }
  | { kind: "secrets_delete"; name: string }
  | { kind: "snapshot_save"; note?: string }
  | { kind: "snapshot_list"; limit?: number }
  | { kind: "snapshot_search"; query: string }
  | { kind: "snapshot_restore"; target: string }
  | { kind: "snapshot_clear" };

function normalizeCloudText(text: string): string {
  let out = text.trim();
  out = out.replace(/<@[^>]+>/g, "").trim();
  if (out.startsWith("/")) {
    const parts = out.slice(1).split(/\s+/);
    const head = parts.shift() ?? "";
    const cleanHead = head.includes("@") ? head.split("@")[0] ?? "" : head;
    out = [cleanHead, ...parts].join(" ").trim();
  }
  return out;
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function humanStatus(status: string | null | undefined, lang: UserLanguage): string {
  const s = (status ?? "").toLowerCase();
  if (s === "finished") return t("status.run_completed", lang);
  if (s === "killed") return t("status.stopped_by_user", lang);
  if (s === "error") return t("status.run_failed", lang);
  if (s === "termination") return t("status.termination", lang);
  if (s === "manual") return t("status.manual_snapshot", lang);
  return s || t("status.unknown", lang);
}

function parseCloudCommand(text: string): CloudCommand | null {
  const normalized = normalizeCloudText(text);
  if (!normalized) return null;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens.shift()!.toLowerCase();

  if (head === "connect" && tokens.length >= 1) {
    const provider = tokens.shift()!.toLowerCase();
    let subcommand: string | undefined;
    if (tokens[0] && (tokens[0]!.toLowerCase() === "status" || tokens[0]!.toLowerCase() === "revoke")) {
      subcommand = tokens.shift()!.toLowerCase();
    }
    const payload = tokens.length > 0 ? tokens.join(" ").trim() : undefined;
    return { kind: "connect", provider, subcommand, payload };
  }
  if (head === "disconnect" && tokens.length >= 1) {
    const provider = tokens.shift()!.toLowerCase();
    let installationId: string | undefined;
    let confirmToken: string | undefined;
    let all = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === "confirm" && tokens[i + 1]) {
        confirmToken = tokens[i + 1]!;
        i++;
        continue;
      }
      if (t === "--all") {
        all = true;
        continue;
      }
      if (t.startsWith("--installation=")) {
        installationId = t.split("=", 2)[1];
        continue;
      }
      if (t === "--installation" && tokens[i + 1]) {
        installationId = tokens[i + 1]!;
        i++;
        continue;
      }
    }
    return { kind: "disconnect", provider, installationId, confirmToken, all };
  }
  if (head === "connections") return { kind: "connections" };
  if (head === "repos") {
    let provider: string | undefined;
    let search: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.startsWith("--provider=")) {
        provider = t.split("=", 2)[1];
        continue;
      }
      if (t === "--provider" && tokens[i + 1]) {
        provider = tokens[i + 1]!;
        i++;
        continue;
      }
      if (t.startsWith("--search=")) {
        search = t.split("=", 2)[1];
        continue;
      }
      if (t === "--search" && tokens[i + 1]) {
        search = tokens[i + 1]!;
        i++;
        continue;
      }
      if (!search) search = t;
    }
    return { kind: "repos", provider, search };
  }
  if (head === "repo" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "select" && tokens.length >= 1) return { kind: "repo_select", target: tokens.join(" ") };
    if (sub === "current") return { kind: "repo_current" };
    if (sub === "share" && tokens.length >= 1) return { kind: "repo_share", target: tokens.join(" ") };
    if (sub === "unshare" && tokens.length >= 1) return { kind: "repo_unshare", target: tokens.join(" ") };
  }
  if (head === "snapshot") {
    const sub = tokens.shift()?.toLowerCase() ?? "";
    if (sub === "save") {
      const note = tokens.join(" ").trim();
      return { kind: "snapshot_save", note: note || undefined };
    }
    if (sub === "list") {
      const raw = tokens[0];
      const n = raw ? Number(raw) : NaN;
      const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
      return { kind: "snapshot_list", limit };
    }
    if (sub === "search" && tokens.length > 0) {
      return { kind: "snapshot_search", query: tokens.join(" ").trim() };
    }
    if (sub === "restore" && tokens.length > 0) {
      return { kind: "snapshot_restore", target: tokens.join(" ").trim() };
    }
    if (sub === "clear") {
      return { kind: "snapshot_clear" };
    }
  }
  if (head === "actions") return { kind: "actions_list" };
  if (head === "run") {
    const repoIds: string[] = [];
    const promptParts: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.startsWith("--repos=")) {
        repoIds.push(...t.split("=", 2)[1]!.split(",").map((v) => v.trim()).filter(Boolean));
        continue;
      }
      if (t === "--repos" && tokens[i + 1]) {
        repoIds.push(...tokens[i + 1]!.split(",").map((v) => v.trim()).filter(Boolean));
        i++;
        continue;
      }
      promptParts.push(t);
    }
    return { kind: "action_run", prompt: promptParts.join(" "), repoIds };
  }
  if (head === "status" && tokens.length >= 1) return { kind: "action_status", runId: tokens[0]! };
  if (head === "pull" && tokens.length >= 1) return { kind: "action_pull", runId: tokens[0]! };
  if (head === "action" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "run") {
      const repoIds: string[] = [];
      const promptParts: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t.startsWith("--repos=")) {
          repoIds.push(...t.split("=", 2)[1]!.split(",").map((v) => v.trim()).filter(Boolean));
          continue;
        }
        if (t === "--repos" && tokens[i + 1]) {
          repoIds.push(...tokens[i + 1]!.split(",").map((v) => v.trim()).filter(Boolean));
          i++;
          continue;
        }
        promptParts.push(t);
      }
      return { kind: "action_run", prompt: promptParts.join(" "), repoIds };
    }
    if (sub === "status" && tokens.length >= 1) return { kind: "action_status", runId: tokens[0]! };
    if (sub === "pull" && tokens.length >= 1) return { kind: "action_pull", runId: tokens[0]! };
  }
  if (head === "setup" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "status") return { kind: "setup_status" };
    if (sub === "lift") return { kind: "setup_lift" };
  }
  if (head === "tinc" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "token" || sub === "auth") return { kind: "tinc_token" };
  }
  if (head === "secrets" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "list") return { kind: "secrets_list" };
    if (sub === "set" && tokens.length >= 1) {
      const name = tokens.shift()!;
      const value = tokens.length > 0 ? tokens.join(" ") : null;
      return { kind: "secrets_set", name, value };
    }
    if (sub === "create" && tokens.length >= 1) {
      const name = tokens.shift()!;
      const value = tokens.length > 0 ? tokens.join(" ") : null;
      return { kind: "secrets_create", name, value };
    }
    if (sub === "update" && tokens.length >= 1) {
      const name = tokens.shift()!;
      const value = tokens.length > 0 ? tokens.join(" ") : null;
      return { kind: "secrets_update", name, value };
    }
    if (sub === "delete" && tokens.length >= 1) return { kind: "secrets_delete", name: tokens[0]! };
  }
  return null;
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

const AGENT_PREFIX: Record<SessionAgent, string> = { codex: "codex", claude_code: "claude_code" };

function applySettingsCommand(
  config: AppConfig,
  cmd: SettingsCommand,
  defaultAgent: SessionAgent,
  platform: "telegram" | "slack",
  lang: UserLanguage,
): string {
  if (cmd.kind === "list") return formatSettingsSummary(config, defaultAgent, platform, lang, null, null);

  const parsed = resolveSettingTarget(cmd.target, defaultAgent);
  if (!parsed) {
    return `${t("settings.unknown", lang, { key: cmd.target })}\n${t("settings.supported", lang, {
      keys: formatSupportedSettingKeys(),
    })}`;
  }

  const adapter = getAgentAdapter(parsed.agent);
  let agentConfig;
  try {
    agentConfig = adapter.requireConfig(config);
  } catch (e) {
    return t("error.generic", lang, { message: String(e) });
  }

  const prefix = AGENT_PREFIX[parsed.agent];

  if (parsed.type === "bool") {
    if (cmd.kind !== "set") return t("settings.use_set", lang, { cmd: `settings set ${parsed.label} <on|off>` });
    const value = parseBool(cmd.value);
    if (value === null) return t("settings.expected_bool", lang, { key: parsed.label });
    const prev = agentConfig[parsed.key];
    (agentConfig as any)[parsed.key] = value;
    return t("settings.updated", lang, {
      key: parsed.label,
      prev: String(prev),
      next: String(value),
      agent: adapter.displayName,
    });
  }

  if (parsed.type === "number") {
    if (cmd.kind !== "set") return t("settings.use_set", lang, { cmd: `settings set ${parsed.label} <number>` });
    const n = Number(cmd.value);
    if (!Number.isFinite(n)) return t("settings.expected_number", lang, { key: parsed.label });
    const next = Math.floor(n);
    if (next < parsed.min) return t("settings.min_value", lang, { key: parsed.label, min: parsed.min });
    const prev = agentConfig[parsed.key];
    (agentConfig as any)[parsed.key] = next;
    return t("settings.updated", lang, {
      key: parsed.label,
      prev: String(prev),
      next: String(next),
      agent: adapter.displayName,
    });
  }

  if (parsed.type === "string") {
    if (cmd.kind !== "set") return t("settings.use_set", lang, { cmd: `settings set ${parsed.label} <value>` });
    const next = cmd.value.trim();
    if (!next) return t("settings.empty_value", lang, { key: parsed.label });
    const prev = agentConfig[parsed.key];
    (agentConfig as any)[parsed.key] = next;
    const prevLabel = prev ?? t("settings.empty", lang);
    return t("settings.updated", lang, {
      key: parsed.label,
      prev: String(prevLabel),
      next: String(next),
      agent: adapter.displayName,
    });
  }

  if (parsed.type === "env") {
    const key = parsed.envKey;
    if (cmd.kind === "unset") {
      if (!(key in agentConfig.env)) return t("settings.env_already_unset", lang, { key, prefix });
      delete agentConfig.env[key];
      return t("settings.env_unset", lang, { key });
    }
    const value = cmd.value.trim();
    if (!value) return t("settings.empty_value", lang, { key: parsed.label });
    const prev = agentConfig.env[key];
    agentConfig.env[key] = value;
    const current = formatEnvValue(value, lang);
    const suffix = prev ? t("settings.env_set_prev", lang, { value: formatEnvValue(prev, lang) }) : "";
    return t("settings.env_set", lang, {
      key: parsed.label,
      value: current,
      suffix,
      agent: adapter.displayName,
    });
  }

  return t("settings.unsupported", lang);
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

function agentDisplayName(agent: SessionAgent): string {
  return getAgentAdapter(agent).displayName;
}

function agentShortName(agent: SessionAgent): string {
  return getAgentAdapter(agent).shortName;
}

function detectAgentFromTelegramMessageText(text: string): SessionAgent {
  const cmd = parseTelegramCommand(text);
  const mapped = cmd ? TELEGRAM_COMMAND_AGENT[cmd.command] : undefined;
  return mapped ?? "codex";
}

function buildMenuText(platform: "telegram" | "slack", agent: SessionAgent, lang: UserLanguage): string {
  const commands =
    platform === "telegram"
      ? [
          t("menu.sessions_hint_tg", lang),
          t("menu.settings_hint_tg", lang),
        ]
      : [
          t("menu.sessions_hint_slack", lang),
          t("menu.settings_hint_slack", lang),
        ];
  const examples = buildCommandExamples(platform, lang);
  const lines = [t("menu.intro", lang, { agent: agentDisplayName(agent) }), ...commands, "", examples];
  return lines.join("\n");
}

function buildCloudHelpText(platform: "telegram" | "slack", lang: UserLanguage): string {
  const title = platform === "slack" ? `*${t("cloud.help.title", lang)}*` : t("cloud.help.title", lang);
  const cmdPrefix = platform === "telegram" ? "/" : "";
  const cmd = (value: string) => `${cmdPrefix}${value}`;
  const repoShareCmd = `\`${cmd("repo share <number>")}\``;
  const notes = [
    t("cloud.help.note_group", lang, { cmd: repoShareCmd }),
  ];
  notes.push(t("cloud.help.note_disconnect", lang, { cmd: `\`${cmd("disconnect github")}\`` }));
  if (platform === "slack") {
    notes.push(t("cloud.help.note_slack_mention", lang));
  }
  const lines = [
    title,
    t("cloud.help.enabled", lang),
    "",
    t("cloud.help.quick_start", lang),
    t("cloud.help.step_connect", lang),
    t("cloud.help.cmd.connect_chatgpt", lang, { cmd: `\`${cmd("connect chatgpt")}\`` }),
    t("cloud.help.cmd.connect_chatgpt_status", lang, { cmd: `\`${cmd("connect chatgpt status")}\`` }),
    t("cloud.help.cmd.connect_chatgpt_revoke", lang, { cmd: `\`${cmd("connect chatgpt revoke")}\`` }),
    t("cloud.help.cmd.connect_github", lang, {
      cmd: `\`${cmd("connect github")}\``,
      cmd2: `\`${cmd("connect gitlab")}\``,
      cmd3: `\`${cmd("connect local")}\``,
    }),
    "",
    t("cloud.help.step_pick_repos", lang),
    t("cloud.help.cmd.repos", lang, {
      cmd: `\`${cmd("repos")}\``,
      cmd2: `\`${cmd("repos --provider github --search <term>")}\``,
    }),
    t("cloud.help.cmd.repo_select", lang, {
      cmd: `\`${cmd("repo select <number>")}\``,
      cmd2: `\`${cmd("repo select playground")}\``,
    }),
    "",
    t("cloud.help.step_share_group", lang),
    `- ${repoShareCmd}`,
    "",
    t("cloud.help.step_run_action", lang),
    t("cloud.help.cmd.run", lang, { cmd: `\`${cmd("run <prompt>")}\``, arg: "`--repos id1,id2`" }),
    "",
    t("cloud.help.step_check_results", lang),
    `- \`${cmd("status <runId>")}\``,
    `- \`${cmd("pull <runId>")}\``,
    "",
    t("cloud.help.step_secrets", lang),
    `- \`${cmd("secrets create NAME VALUE")}\``,
    `- \`${cmd("secrets update NAME VALUE")}\``,
    `- \`${cmd("secrets list")}\``,
    `- \`${cmd("secrets delete NAME")}\``,
    "",
    t("cloud.help.step_cli", lang),
    t("cloud.help.cmd.tinc_token", lang, { cmd: `\`${cmd("tinc token")}\`` }),
    "",
    t("cloud.help.step_snapshots", lang),
    `- \`${cmd("snapshot save [note]")}\``,
    `- \`${cmd("snapshot list [limit]")}\``,
    `- \`${cmd("snapshot search <query>")}\``,
    `- \`${cmd("snapshot restore <index|snapshotId>")}\``,
    "",
    t("cloud.help.step_disconnect", lang),
    `- \`${cmd("disconnect github")}\``,
    `- \`${cmd("disconnect github --installation <id>")}\``,
    `- \`${cmd("disconnect github --all")}\``,
    `- \`${cmd("disconnect github confirm <token>")}\``,
    "",
    t("cloud.help.notes", lang),
    ...notes,
  ];
  return lines.join("\n");
}

function buildCommandExamples(platform: "telegram" | "slack", lang: UserLanguage): string {
  const sessions = platform === "telegram" ? "/sessions active" : "@bot sessions active";
  const sessionsPage = platform === "telegram" ? "/sessions page 2" : "@bot sessions page 2";
  const settings = platform === "telegram" ? "/settings" : "@bot settings";
  const prefix = platform === "telegram" ? "/" : "@bot ";
  const envSet = `${prefix}settings set mcp.SEARCH http://localhost:3000`;
  const envUnset = `${prefix}settings unset mcp.SEARCH`;
  return [
    t("menu.examples", lang),
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
  defaultAgent: SessionAgent,
):
  | { type: "bool"; agent: SessionAgent; key: BoolSettingKey; label: string }
  | { type: "number"; agent: SessionAgent; key: NumberSettingKey; label: string; min: number }
  | { type: "string"; agent: SessionAgent; key: StringSettingKey; label: string }
  | { type: "env"; agent: SessionAgent; envKey: string; label: string }
  | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  const agentPrefix = lower.startsWith("codex.")
    ? ("codex" as const)
    : lower.startsWith("claude_code.")
      ? ("claude_code" as const)
      : null;

  const agent: SessionAgent = agentPrefix ?? defaultAgent;
  const prefix = AGENT_PREFIX[agent];
  const rest = agentPrefix ? trimmed.slice(`${agentPrefix}.`.length) : trimmed;
  const restLower = rest.toLowerCase();

  if (restLower === "full_auto") return { type: "bool", agent, key: "full_auto", label: `\`${prefix}.full_auto\`` };
  if (restLower === "dangerously_bypass_approvals_and_sandbox")
    return {
      type: "bool",
      agent,
      key: "dangerously_bypass_approvals_and_sandbox",
      label: `\`${prefix}.dangerously_bypass_approvals_and_sandbox\``,
    };
  if (restLower === "skip_git_repo_check") return { type: "bool", agent, key: "skip_git_repo_check", label: `\`${prefix}.skip_git_repo_check\`` };

  if (restLower === "timeout_seconds") return { type: "number", agent, key: "timeout_seconds", label: `\`${prefix}.timeout_seconds\``, min: 10 };
  if (restLower === "poll_interval_ms") return { type: "number", agent, key: "poll_interval_ms", label: `\`${prefix}.poll_interval_ms\``, min: 100 };
  if (restLower === "max_catchup_lines") return { type: "number", agent, key: "max_catchup_lines", label: `\`${prefix}.max_catchup_lines\``, min: 1 };

  if (restLower === "binary") return { type: "string", agent, key: "binary", label: `\`${prefix}.binary\`` };
  if (restLower === "sessions_dir") return { type: "string", agent, key: "sessions_dir", label: `\`${prefix}.sessions_dir\`` };

  if (restLower.startsWith("env.")) {
    const key = rest.slice("env.".length).trim();
    if (!key) return null;
    return { type: "env", agent, envKey: key, label: `Env \`${key}\`` };
  }

  if (restLower.startsWith("mcp.")) {
    const key = rest.slice("mcp.".length).trim();
    if (!key) return null;
    const envKey = normalizeEnvKey(key, { forceMcp: true });
    if (!envKey) return null;
    return { type: "env", agent, envKey, label: `MCP \`${envKey}\`` };
  }

  return null;
}

function formatSupportedSettingKeys(): string {
  return [
    "`message_verbosity`",
    "`bot.message_verbosity`",
    "`branch_name_rule`",
    "`codex.full_auto`",
    "`claude_code.full_auto`",
    "`codex.dangerously_bypass_approvals_and_sandbox`",
    "`claude_code.dangerously_bypass_approvals_and_sandbox`",
    "`codex.skip_git_repo_check`",
    "`claude_code.skip_git_repo_check`",
    "`codex.timeout_seconds`",
    "`claude_code.timeout_seconds`",
    "`codex.poll_interval_ms`",
    "`claude_code.poll_interval_ms`",
    "`codex.max_catchup_lines`",
    "`claude_code.max_catchup_lines`",
    "`codex.binary`",
    "`claude_code.binary`",
    "`codex.sessions_dir`",
    "`codex.env.<KEY>`",
    "`claude_code.sessions_dir`",
    "`claude_code.env.<KEY>`",
    "`mcp.<NAME>`",
    "`cloud.keepalive_minutes`",
    "`cloud.git_user_name`",
    "`cloud.git_user_email`",
    "`cloud.openai_api_key`",
    "`cloud.anthropic_api_key`",
  ].join(", ");
}

function formatSettingsSummary(
  config: AppConfig,
  agent: SessionAgent,
  platform: "telegram" | "slack",
  lang: UserLanguage,
  identity: {
    keepalive_minutes: number | null;
    message_verbosity: number | null;
    branch_name_rule: string | null;
    git_user_name: string | null;
    git_user_email: string | null;
  } | null,
  cloudKeyStatus: { openai: boolean; anthropic: boolean } | null,
): string {
  const adapter = getAgentAdapter(agent);
  let section;
  try {
    section = adapter.requireConfig(config);
  } catch (e) {
    return t("error.generic", lang, { message: String(e) });
  }
  const cmdPrefix = platform === "telegram" ? "/" : "@bot ";
  const prefix = AGENT_PREFIX[agent];

  const identityVerbosity = identity?.message_verbosity ?? null;
  const effectiveVerbosity =
    typeof identityVerbosity === "number" && Number.isFinite(identityVerbosity)
      ? identityVerbosity
      : config.bot.message_verbosity;
  const verbositySuffix =
    typeof identityVerbosity === "number" && Number.isFinite(identityVerbosity)
      ? t("settings.suffix_per_user", lang)
      : t("settings.suffix_default", lang);
  const identityBranchRule = identity?.branch_name_rule?.trim() || "";
  const branchRuleLabel = identityBranchRule
    ? t("settings.branch_rule_custom", lang, { rule: identityBranchRule })
    : t("settings.branch_rule_default", lang);

  const lines = [
    t("settings.title", lang, { agent: adapter.displayName }),
    `- \`${prefix}.binary\`: ${section.binary}`,
    `- \`${prefix}.sessions_dir\`: ${section.sessions_dir}`,
    `- \`${prefix}.timeout_seconds\`: ${String(section.timeout_seconds)}`,
    `- \`${prefix}.poll_interval_ms\`: ${String(section.poll_interval_ms)}`,
    `- \`${prefix}.max_catchup_lines\`: ${String(section.max_catchup_lines)}`,
    `- \`${prefix}.full_auto\`: ${String(section.full_auto)}`,
    `- \`${prefix}.dangerously_bypass_approvals_and_sandbox\`: ${String(section.dangerously_bypass_approvals_and_sandbox)}`,
    `- \`${prefix}.skip_git_repo_check\`: ${String(section.skip_git_repo_check)}`,
    "",
    t("settings.user_section", lang),
    `- \`message_verbosity\`: ${String(effectiveVerbosity)}${verbositySuffix}`,
    `- \`branch_name_rule\`: ${branchRuleLabel}`,
  ];

  const envEntries = Object.entries(section.env);
  if (envEntries.length === 0) lines.push(t("settings.env_overrides_none", lang));
  else {
    lines.push(t("settings.env_overrides", lang));
    for (const [k, v] of envEntries) lines.push(`  - \`${k}\` = ${formatEnvValue(v, lang)}`);
  }

  const mcpEntries = envEntries.filter(([k]) => k.toUpperCase().startsWith("MCP_"));
  if (mcpEntries.length === 0) lines.push(t("settings.mcp_env_none", lang));
  else {
    lines.push(t("settings.mcp_env", lang));
    for (const [k, v] of mcpEntries) lines.push(`  - \`${k}\` = ${formatEnvValue(v, lang)}`);
  }

  if (config.cloud?.enabled) {
    const identityKeepaliveMinutes = identity?.keepalive_minutes ?? null;
    const effective =
      typeof identityKeepaliveMinutes === "number" && Number.isFinite(identityKeepaliveMinutes)
        ? identityKeepaliveMinutes
        : config.cloud.keepalive_minutes;
    const suffix =
      typeof identityKeepaliveMinutes === "number" && Number.isFinite(identityKeepaliveMinutes)
        ? t("settings.suffix_per_user", lang)
        : t("settings.suffix_default", lang);
    const openaiStatus = cloudKeyStatus?.openai ? t("settings.key_set", lang) : t("settings.key_unset", lang);
    const anthropicStatus = cloudKeyStatus?.anthropic ? t("settings.key_set", lang) : t("settings.key_unset", lang);
    const gitName = identity?.git_user_name?.trim() || null;
    const gitEmail = identity?.git_user_email?.trim() || null;
    const gitNameLabel = gitName
      ? t("settings.value_per_user", lang, { value: gitName })
      : t("settings.value_default", lang, { value: "tintin[bot]" });
    const gitEmailLabel = gitEmail
      ? t("settings.value_per_user", lang, { value: gitEmail })
      : t("settings.value_default", lang, { value: "tintin@fuzz.land" });
    lines.push(
      "",
      t("settings.cloud_section", lang),
      `- \`cloud.keepalive_minutes\`: ${String(effective)}${suffix}`,
      `- \`cloud.git_user_name\`: ${gitNameLabel}`,
      `- \`cloud.git_user_email\`: ${gitEmailLabel}`,
      `- \`cloud.openai_api_key\`: ${openaiStatus}`,
      `- \`cloud.anthropic_api_key\`: ${anthropicStatus}`,
    );
  }

  lines.push(
    "",
    t("settings.examples", lang),
    `- ${cmdPrefix}settings set ${prefix}.timeout_seconds 1800`,
    `- ${cmdPrefix}settings set message_verbosity 2`,
    `- ${cmdPrefix}settings set branch_name_rule \"feature/{date}-{slug}\"`,
    `- ${cmdPrefix}settings set mcp.SEARCH http://localhost:3000`,
    `- ${cmdPrefix}settings set cloud.keepalive_minutes 10`,
    `- ${cmdPrefix}settings set cloud.git_user_name \"Tintin Bot\"`,
    `- ${cmdPrefix}settings set cloud.git_user_email tintin@fuzz.land`,
    `- ${cmdPrefix}settings set cloud.openai_api_key sk-...`,
    `- ${cmdPrefix}settings set cloud.anthropic_api_key sk-ant-...`,
    `- ${cmdPrefix}settings unset cloud.keepalive_minutes`,
    `- ${cmdPrefix}settings unset cloud.git_user_name`,
    `- ${cmdPrefix}settings unset cloud.git_user_email`,
    `- ${cmdPrefix}settings unset cloud.openai_api_key`,
    `- ${cmdPrefix}settings unset cloud.anthropic_api_key`,
    `- ${cmdPrefix}settings unset mcp.SEARCH`,
  );
  return lines.join("\n");
}

async function applyIdentitySettingsCommand(opts: {
  config: AppConfig;
  db: Db;
  cmd: SettingsCommand;
  identityId: string;
  lang: UserLanguage;
}): Promise<string | null> {
  if (opts.cmd.kind === "list") return null;
  const target = opts.cmd.target.trim().toLowerCase();
  if (
    target !== "message_verbosity" &&
    target !== "bot.message_verbosity" &&
    target !== "branch_name_rule" &&
    target !== "branchname_rule" &&
    target !== "branch-rule"
  )
    return null;

  if (opts.cmd.kind === "unset") {
    if (target === "message_verbosity" || target === "bot.message_verbosity") {
      await setIdentityMessageVerbosity(opts.db, opts.identityId, null);
      return t("settings.message_verbosity.reset", opts.lang);
    }
    await setIdentityBranchNameRule(opts.db, opts.identityId, null);
    return t("settings.branch_rule.reset", opts.lang);
  }

  if (target === "message_verbosity" || target === "bot.message_verbosity") {
    const raw = opts.cmd.value.trim();
    const next = Number(raw);
    if (!Number.isFinite(next)) return t("settings.message_verbosity.expected_number", opts.lang);
    const value = Math.floor(next);
    if (value < 1 || value > 3) return t("settings.message_verbosity.range", opts.lang);
    await setIdentityMessageVerbosity(opts.db, opts.identityId, value);
    return t("settings.message_verbosity.updated", opts.lang, { value });
  }

  const rule = opts.cmd.value.trim();
  if (!rule) return t("settings.branch_rule.empty", opts.lang);
  await setIdentityBranchNameRule(opts.db, opts.identityId, rule);
  return t("settings.branch_rule.updated", opts.lang);
}

async function applyCloudSettingsCommand(opts: {
  config: AppConfig;
  db: Db;
  cmd: SettingsCommand;
  identityId: string;
  lang: UserLanguage;
}): Promise<string | null> {
  if (opts.cmd.kind === "list") return null;
  const target = opts.cmd.target.trim().toLowerCase();
  if (
    target !== "cloud.keepalive_minutes" &&
    target !== "cloud.git_user_name" &&
    target !== "cloud.git_user_email" &&
    target !== "cloud.openai_api_key" &&
    target !== "cloud.anthropic_api_key"
  )
    return null;
  if (!opts.config.cloud) return t("cloud.config_missing", opts.lang);

  if (opts.cmd.kind === "unset") {
    if (target === "cloud.keepalive_minutes") {
      await setIdentityKeepaliveMinutes(opts.db, opts.identityId, null);
      return t("settings.cloud_keepalive.reset", opts.lang);
    }
    if (target === "cloud.git_user_name") {
      await setIdentityGitUserName(opts.db, opts.identityId, null);
      return t("settings.cloud_git_user_name.reset", opts.lang);
    }
    if (target === "cloud.git_user_email") {
      await setIdentityGitUserEmail(opts.db, opts.identityId, null);
      return t("settings.cloud_git_user_email.reset", opts.lang);
    }
    const name = target === "cloud.openai_api_key" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const ok = await deleteSecret(opts.db, opts.identityId, name);
    return ok ? t("settings.cloud_key.cleared", opts.lang, { target }) : t("settings.cloud_key.already_unset", opts.lang, { target });
  }

  if (target === "cloud.git_user_name") {
    if (opts.cmd.kind !== "set") {
      return t("settings.use_set", opts.lang, { cmd: "settings set cloud.git_user_name <name>" });
    }
    const value = opts.cmd.value.trim();
    if (!value) return t("settings.cloud_git_user_name.empty", opts.lang);
    await setIdentityGitUserName(opts.db, opts.identityId, value);
    return t("settings.cloud_git_user_name.updated", opts.lang, { value });
  }

  if (target === "cloud.git_user_email") {
    if (opts.cmd.kind !== "set") {
      return t("settings.use_set", opts.lang, { cmd: "settings set cloud.git_user_email <email>" });
    }
    const value = opts.cmd.value.trim();
    if (!value) return t("settings.cloud_git_user_email.empty", opts.lang);
    await setIdentityGitUserEmail(opts.db, opts.identityId, value);
    return t("settings.cloud_git_user_email.updated", opts.lang, { value });
  }

  if (target === "cloud.keepalive_minutes") {
    if (opts.cmd.kind !== "set") {
      return t("settings.use_set", opts.lang, { cmd: "settings set cloud.keepalive_minutes <number>" });
    }
    const n = Number(opts.cmd.value);
    if (!Number.isFinite(n)) return t("settings.cloud_keepalive.expected_number", opts.lang);
    const next = Math.floor(n);
    if (next < 0) return t("settings.cloud_keepalive.min", opts.lang);
    await setIdentityKeepaliveMinutes(opts.db, opts.identityId, next);
    return t("settings.cloud_keepalive.updated", opts.lang, { value: next });
  }

  if (opts.cmd.kind !== "set") {
    return t("settings.use_set", opts.lang, { cmd: `settings set ${target} <key>` });
  }
  const value = opts.cmd.value.trim();
  if (!value) return t("settings.cloud_key.empty", opts.lang, { target });
  if (!opts.config.cloud.secrets_key) return t("cloud.secrets_missing", opts.lang);
  const encrypted = encryptSecret(value, opts.config.cloud.secrets_key);
  const name = target === "cloud.openai_api_key" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  await setSecret(opts.db, { identityId: opts.identityId, name, encryptedValue: encrypted });
  return t("settings.cloud_key.updated", opts.lang, { target });
}

function formatEnvValue(value: string, lang: UserLanguage): string {
  const redacted = redactText(value);
  if (!redacted) return t("settings.value_empty", lang);
  if (redacted.length > 80) {
    return t("settings.value_truncated", lang, { value: redacted.slice(0, 60), count: redacted.length });
  }
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
  lang: UserLanguage,
  opts: SessionListPage & { filterLabel?: string },
): string {
  const filterSuffix = opts.filterLabel ? ` (${opts.filterLabel})` : "";
  if (opts.sessions.length === 0) {
    if (opts.page <= 1) return t("sessions.empty", lang);
    const prev = opts.page > 1 ? buildSessionsCommand(platform, opts.filterLabel, opts.page - 1) : null;
    const hint = prev ? t("sessions.empty_page_hint", lang, { cmd: prev }) : "";
    return `${t("sessions.empty_page", lang, { filter: filterSuffix, page: opts.page })}${hint}`;
  }

  const header = t("sessions.title", lang, { filter: filterSuffix, page: opts.page, limit: opts.limit });
  const lines = opts.sessions.map((s) => formatSessionLine(platform, lang, s));
  const nav: string[] = [];
  if (opts.page > 1) nav.push(buildSessionsCommand(platform, opts.filterLabel, opts.page - 1));
  if (opts.hasMore) nav.push(buildSessionsCommand(platform, opts.filterLabel, opts.page + 1));
  const navText =
    nav.length > 0 ? `\n\n${t("sessions.navigation", lang)} \`${nav.join("` | `")}\`` : "";
  return `${header}\n${lines.map((l) => `- ${l}`).join("\n")}${navText}`;
}

function formatSessionLine(platform: "telegram" | "slack", lang: UserLanguage, s: SessionRow): string {
  const emoji = formatSessionEmoji(platform, s);
  const url = formatSessionLink(platform, s);
  const emojiLabel = url ? formatEmojiLink(platform, emoji, url) : emoji;
  const age = formatRelativeAge(s.created_at, lang);
  const status = formatSessionStatus(s.status, lang);
  return `${emojiLabel} ${status} ${agentShortName(s.agent)} ${s.project_id} ${age}`;
}

function formatSessionStatus(status: SessionStatus, lang: UserLanguage): string {
  switch (status) {
    case "wizard":
      return t("session.status.wizard", lang);
    case "starting":
      return t("session.status.starting", lang);
    case "running":
      return t("session.status.running", lang);
    case "finished":
      return t("session.status.finished", lang);
    case "error":
      return t("session.status.error", lang);
    case "killed":
      return t("session.status.killed", lang);
    default:
      return String(status);
  }
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

function formatRelativeAge(createdAt: unknown, lang: UserLanguage): string {
  const ts = toNumber(createdAt);
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const diffMs = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return t("time.just_now", lang);
  if (seconds < 60) return t("time.seconds_ago", lang, { n: seconds });

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutes_ago", lang, { n: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("time.hours_ago", lang, { n: hours });

  const days = Math.floor(hours / 24);
  if (days < 14) return t("time.days_ago", lang, { n: days });

  const weeks = Math.floor(days / 7);
  if (weeks < 9) return t("time.weeks_ago", lang, { n: weeks });

  const months = Math.floor(days / 30);
  if (months < 18) return t("time.months_ago", lang, { n: months });

  const years = Math.floor(days / 365);
  return t("time.years_ago", lang, { n: years });
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return NaN;
}
