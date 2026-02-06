import crypto from "node:crypto";
import type { AppConfig, ProjectEntry } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import type { SessionManager } from "./sessionManager.js";
import type { CloudManager } from "./cloud/manager.js";
import type { TelegramClient, TelegramUpdate } from "./platform/telegram.js";
import type { SlackClient } from "./platform/slack.js";
import type { IMessagingPlatform, InteractiveMarkup } from "./platform/base.js";
import { redactText } from "./redact.js";
import type { SendToSessionFn } from "./messaging.js";
import { getCloudRunBySession } from "./cloud/store.js";
import { countPendingMessages, enqueuePendingMessage, getUserLanguage } from "./store.js";
import type { SessionRow } from "./store.js";
import { isUserLanguage, t, type UserLanguage } from "../locales/index.js";
import { AccessControl } from "./shared/AccessControl.js";
import type { CommitProposalStore } from "./controller/types.js";
import { mergeTextIntoSlackBlocks } from "./message/slack.js";
import { TelegramHandler } from "./controller/telegramHandler.js";
import { SlackHandler } from "./controller/slackHandler.js";
import { CloudHandler } from "./controller/cloudHandler.js";
import { InteractionHandler } from "./controller/interactionHandler.js";

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

export class BotController {
  private readonly telegramHandler: TelegramHandler;
  private readonly slackHandler: SlackHandler;
  private readonly cloudHandler: CloudHandler;
  private readonly interactionHandler: InteractionHandler;
  private readonly accessControl: AccessControl;

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
  ) {
    this.accessControl = new AccessControl({
      config: this.config,
      telegram: this.telegram,
      logger: this.logger,
    });
    this.interactionHandler = new InteractionHandler({
      config: this.config,
      db: this.db,
      logger: this.logger,
      sessionManager: this.sessionManager,
      cloudManager: this.cloudManager,
      telegram: this.telegram,
      slack: this.slack,
      sendPlatformMessage: this.sendPlatformMessage.bind(this),
      resolveUserLanguage: this.resolveUserLanguage.bind(this),
      resolveSessionLanguage: this.resolveSessionLanguage.bind(this),
      isCloudSession: this.isCloudSession.bind(this),
      isTelegramTopicSession: (session) => this.telegramHandler.isTelegramTopicSession(session),
      sendCloudRunStatus: (opts) => this.cloudHandler.sendCloudRunStatus(opts),
      handleSessionMessage: this.handleSessionMessage.bind(this),
      commitProposalStore: this.commitProposalStore,
      markReviewCommitDisabled: this.markReviewCommitDisabled.bind(this),
      disableReviewCommitButtons: this.disableReviewCommitButtons.bind(this),
      accessControl: this.accessControl,
      buildCommitProposalPrompt,
      reviewPrompt: REVIEW_PROMPT,
      commitPrompt: COMMIT_PROMPT,
    });
    this.telegramHandler = new TelegramHandler({
      config: this.config,
      db: this.db,
      logger: this.logger,
      telegram: this.telegram,
      sessionManager: this.sessionManager,
      lookupTelegramSessionByReply: this.lookupTelegramSessionByReply,
      resolveUserLanguage: this.resolveUserLanguage.bind(this),
      accessControl: this.accessControl,
      sendCloudHelp: (...args) => this.cloudHandler.sendCloudHelp(...args),
      handleCloudCommand: (...args) => this.cloudHandler.handleCloudCommand(...args),
      handleSharedInteractionAction: (...args) => this.interactionHandler.handleSharedInteractionAction(...args),
      handleSessionMessage: this.handleSessionMessage.bind(this),
      projectById: this.projectById.bind(this),
    });
    this.slackHandler = new SlackHandler({
      config: this.config,
      db: this.db,
      logger: this.logger,
      slack: this.slack,
      sessionManager: this.sessionManager,
      resolveUserLanguage: this.resolveUserLanguage.bind(this),
      accessControl: this.accessControl,
      sendCloudHelp: (...args) => this.cloudHandler.sendCloudHelp(...args),
      handleCloudCommand: (...args) => this.cloudHandler.handleCloudCommand(...args),
      handleSharedInteractionAction: (...args) => this.interactionHandler.handleSharedInteractionAction(...args),
      handleSessionMessage: this.handleSessionMessage.bind(this),
      projectById: this.projectById.bind(this),
    });
    this.cloudHandler = new CloudHandler({
      config: this.config,
      db: this.db,
      logger: this.logger,
      cloudManager: this.cloudManager,
      telegram: this.telegram,
      slack: this.slack,
      sendPlatformMessage: this.sendPlatformMessage.bind(this),
      resolveUserLanguage: this.resolveUserLanguage.bind(this),
    });
  }

  private markReviewCommitDisabled(sessionId: string) {
    this.reviewCommitDisabled.add(sessionId);
  }

  private async isCloudSession(session: SessionRow): Promise<boolean> {
    if (typeof session.project_id === "string" && session.project_id.startsWith("cloud:")) return true;
    // Fallback: look up cloud run by session_id to handle older records or missing prefix.
    const run = await getCloudRunBySession(this.db, session.id);
    return Boolean(run);
  }

  private async disableReviewCommitButtonsSlack(opts: {
    channelId: string;
    ts: string;
    text?: string;
    note?: string;
    workspaceId?: string | null;
  }) {
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
          workspaceId: opts.workspaceId,
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
        workspaceId: opts.workspaceId,
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

  // --- Telegram ---

  async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    await this.telegramHandler.handleTelegramUpdate(update);
  }

  async handleSlackEvent(body: unknown): Promise<void> {
    await this.slackHandler.handleSlackEvent(body);
  }

  async handleSlackInteraction(payload: unknown): Promise<void> {
    await this.slackHandler.handleSlackInteraction(payload);
  }

  private resolveSessionLanguage(session: SessionRow): UserLanguage {
    return isUserLanguage(session.language) ? session.language : "en";
  }

  private async resolveUserLanguage(platform: "telegram" | "slack", userId: string): Promise<UserLanguage> {
    return await getUserLanguage(this.db, platform, userId);
  }

  private async sendPlatformMessage(opts: {
    platform: IMessagingPlatform | null;
    chatId: string;
    text: string;
    markup?: InteractiveMarkup;
    threadId?: string | number;
    replyToMessageId?: string | number;
    priority?: "user" | "background";
    workspaceId?: string | null;
  }) {
    if (!opts.platform) return;
    const priority = opts.priority ?? "user";
    const threadId =
      typeof opts.threadId === "number" ? (Number.isFinite(opts.threadId) ? String(opts.threadId) : undefined) : opts.threadId;
    const replyToMessageId =
      typeof opts.replyToMessageId === "number"
        ? Number.isFinite(opts.replyToMessageId)
          ? String(opts.replyToMessageId)
          : undefined
        : opts.replyToMessageId;
    if (opts.platform.platformName === "slack") {
      let markup = opts.markup;
      if (markup?.type === "blocks" && Array.isArray(markup.payload)) {
        markup = {
          type: "blocks",
          payload: mergeTextIntoSlackBlocks(opts.text, markup.payload),
        };
      }
      await (opts.platform as SlackClient).sendMessage({
        chatId: opts.chatId,
        text: opts.text,
        threadId: undefined,
        replyToMessageId,
        markup,
        priority,
        workspaceId: opts.workspaceId,
      });
      return;
    }
    await opts.platform.sendMessage({
      chatId: opts.chatId,
      text: opts.text,
      threadId,
      replyToMessageId,
      markup: opts.markup,
      priority,
    });
  }

  private async disableReviewCommitButtons(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    messageId: string;
    text?: string;
    note?: string;
    workspaceId?: string | null;
  }) {
    if (opts.platform === "telegram") {
      const messageId = Number(opts.messageId);
      if (!Number.isFinite(messageId)) return;
      await this.telegramHandler.disableReviewCommitButtonsTelegram({
        chatId: opts.chatId,
        messageId,
        text: opts.text,
        note: opts.note,
      });
      return;
    }
    await this.disableReviewCommitButtonsSlack({
      channelId: opts.chatId,
      ts: opts.messageId,
      text: opts.text,
      note: opts.note,
      workspaceId: opts.workspaceId,
    });
  }

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
