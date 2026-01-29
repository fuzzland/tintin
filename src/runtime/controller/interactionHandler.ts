import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionManager } from "../sessionManager.js";
import type { CloudManager } from "../cloud/manager.js";
import type { SlackClient } from "../platform/slack.js";
import type { TelegramClient } from "../platform/telegram.js";
import type { IMessagingPlatform, InteractiveMarkup } from "../platform/base.js";
import { redactText } from "../redact.js";
import { nowMs } from "../util.js";
import { t, type UserLanguage } from "../../locales/index.js";
import { getOrCreateIdentity } from "../cloud/store.js";
import { setUserLanguage } from "../store.js";
import type { CommitProposal, CommitProposalAction, CommitProposalStore, SharedInteractionAction } from "./types.js";
import type { SessionRow } from "../store.js";

export interface InteractionHandlerDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  sessionManager: SessionManager;
  cloudManager: CloudManager | null;
  telegram: TelegramClient | null;
  slack: SlackClient | null;
  sendPlatformMessage: (opts: {
    platform: IMessagingPlatform | null;
    chatId: string;
    text: string;
    markup?: InteractiveMarkup;
    threadId?: string | number;
    replyToMessageId?: string | number;
    priority?: "user" | "background";
    workspaceId?: string | null;
  }) => Promise<void>;
  resolveUserLanguage: (platform: "telegram" | "slack", userId: string) => Promise<UserLanguage>;
  resolveSessionLanguage: (session: SessionRow) => UserLanguage;
  isCloudSession: (session: SessionRow) => Promise<boolean>;
  isTelegramTopicSession: (session: { platform: string; space_emoji: string | null }) => boolean;
  sendCloudRunStatus: (opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    workspaceId: string | null;
    runId: string;
    isDirect: boolean;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }) => Promise<void>;
  handleSessionMessage: (session: SessionRow, userId: string, text: string) => Promise<void>;
  commitProposalStore: CommitProposalStore | null;
  markReviewCommitDisabled: (sessionId: string) => void;
  disableReviewCommitButtons: (opts: {
    platform: "telegram" | "slack";
    chatId: string;
    messageId: string;
    text?: string;
    note?: string;
    workspaceId?: string | null;
  }) => Promise<void>;
  telegramAccessDecision: (chatId: string, userId: string) => Promise<{ allowed: boolean; reason?: string }>;
  slackAccessDecision: (workspaceId: string | null, channelId: string, userId: string) => { allowed: boolean; reason?: string };
  buildCommitProposalPrompt: (branchRule: string | null) => string;
  reviewPrompt: string;
  commitPrompt: string;
}

export class InteractionHandler {
  constructor(private readonly deps: InteractionHandlerDeps) {}

  async handleSharedInteractionAction(opts: {
    platform: "telegram" | "slack";
    action: SharedInteractionAction;
    chatId: string;
    userId: string;
    workspaceId: string | null;
    messageId?: string;
    messageText?: string;
    threadTs?: string;
    interactionId?: string;
    replyToMessageId?: number;
    messageThreadId?: number;
    isDirect?: boolean;
  }): Promise<boolean> {
    const actorLang = await this.deps.resolveUserLanguage(opts.platform, opts.userId);
    const respond = async (text: string) => {
      if (opts.platform === "telegram") {
        if (!this.deps.telegram || !opts.interactionId) return;
        await this.deps.telegram.answerCallbackQuery(opts.interactionId, text);
        return;
      }
      if (!this.deps.slack) return;
      await this.deps.slack.postEphemeral({
        channel: opts.chatId,
        user: opts.userId,
        thread_ts: opts.threadTs,
        text,
        workspaceId: opts.workspaceId,
      });
    };
    const sendError = async (message: string) => {
      if (opts.platform === "telegram") {
        await this.deps.sendPlatformMessage({
          platform: this.deps.telegram,
          chatId: opts.chatId,
          text: message,
          replyToMessageId: opts.replyToMessageId,
          threadId: opts.messageThreadId,
          priority: "user",
        });
        return;
      }
      if (!this.deps.slack) return;
      await this.deps.slack.postEphemeral({
        channel: opts.chatId,
        user: opts.userId,
        thread_ts: opts.threadTs,
        text: message,
        workspaceId: opts.workspaceId,
      });
    };

    switch (opts.action.kind) {
      case "lang": {
        const next = opts.action.value;
        await setUserLanguage(this.deps.db, opts.platform, opts.userId, next);
        await this.deps.db
          .updateTable("sessions")
          .set({ language: next, updated_at: nowMs() })
          .where("platform", "=", opts.platform)
          .where("created_by_user_id", "=", opts.userId)
          .where("status", "in", ["starting", "running"])
          .execute();
        const confirmKey = next === "zh" ? "lang.switched_zh" : "lang.switched_en";
        await respond(t(confirmKey, next));
        return true;
      }
      case "kill": {
        const access =
          opts.platform === "telegram"
            ? await this.deps.telegramAccessDecision(opts.chatId, opts.userId)
            : this.deps.slackAccessDecision(opts.workspaceId, opts.chatId, opts.userId);
        if (!access.allowed) {
          this.deps.logger.warn(
            `[${opts.platform}] rejected kill action chat=${opts.chatId} user=${opts.userId} session=${opts.action.sessionId} reason=${access.reason ?? "-"}`,
          );
          await respond(t("error.not_authorized", actorLang));
          return true;
        }
        const session = await this.deps.db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", opts.action.sessionId)
          .executeTakeFirst();
        if (!session || session.platform !== opts.platform || session.chat_id !== opts.chatId) {
          await respond(t("session.not_found", actorLang));
          return true;
        }
        if (session.status !== "starting" && session.status !== "running") {
          await respond(t("session.already_finished", actorLang));
          return true;
        }
        const isCloudSession = await this.deps.isCloudSession(session as SessionRow);
        if (isCloudSession && this.deps.cloudManager) {
          await respond(t("run.stopping", actorLang));
          try {
            await this.deps.cloudManager.stopSandboxForSession(opts.action.sessionId);
            await this.sendSessionMessageMarkdown(session as SessionRow, t("run.stopped", this.deps.resolveSessionLanguage(session as SessionRow)));
          } catch (e) {
            this.deps.logger.warn(
              `[${opts.platform}] stop run failed chat=${opts.chatId} user=${opts.userId} session=${opts.action.sessionId}: ${String(e)}`,
            );
            await this.sendSessionMessageMarkdown(
              session as SessionRow,
              t("run.stop_failed", this.deps.resolveSessionLanguage(session as SessionRow), {
                error: redactText(e instanceof Error ? e.message : String(e)),
              }),
            );
          }
          return true;
        }
        await respond(t("session.stopping", actorLang));
        await this.deps.sessionManager.killSession(opts.action.sessionId, t("session.stop_requested", this.deps.resolveSessionLanguage(session as SessionRow)));
        return true;
      }
      case "review": {
        const access =
          opts.platform === "telegram"
            ? await this.deps.telegramAccessDecision(opts.chatId, opts.userId)
            : this.deps.slackAccessDecision(opts.workspaceId, opts.chatId, opts.userId);
        if (!access.allowed) {
          this.deps.logger.warn(
            `[${opts.platform}] rejected review action chat=${opts.chatId} user=${opts.userId} session=${opts.action.sessionId} reason=${access.reason ?? "-"}`,
          );
          await respond(t("error.not_authorized", actorLang));
          return true;
        }
        const session = await this.deps.db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", opts.action.sessionId)
          .executeTakeFirst();
        if (!session || session.platform !== opts.platform || session.chat_id !== opts.chatId) {
          await respond(t("session.not_found", actorLang));
          return true;
        }
        this.deps.markReviewCommitDisabled(opts.action.sessionId);
        if (opts.messageId) {
          await this.deps.disableReviewCommitButtons({
            platform: opts.platform,
            chatId: opts.chatId,
            messageId: opts.messageId,
            text: opts.messageText,
            note: t("review.started_note", this.deps.resolveSessionLanguage(session as SessionRow)),
            workspaceId: opts.workspaceId,
          });
        }
        await respond(t("session.starting_review", actorLang));
        try {
          await this.deps.handleSessionMessage(session as SessionRow, opts.userId, this.deps.reviewPrompt);
        } catch (e) {
          this.deps.logger.warn(
            `[${opts.platform}] review action failed chat=${opts.chatId} user=${opts.userId} session=${opts.action.sessionId}: ${String(e)}`,
          );
          await sendError(
            t("error.generic", actorLang, { message: redactText(e instanceof Error ? e.message : String(e)) }),
          );
        }
        return true;
      }
      case "commit": {
        const access =
          opts.platform === "telegram"
            ? await this.deps.telegramAccessDecision(opts.chatId, opts.userId)
            : this.deps.slackAccessDecision(opts.workspaceId, opts.chatId, opts.userId);
        if (!access.allowed) {
          this.deps.logger.warn(
            `[${opts.platform}] rejected commit action chat=${opts.chatId} user=${opts.userId} session=${opts.action.sessionId} reason=${access.reason ?? "-"}`,
          );
          await respond(t("error.not_authorized", actorLang));
          return true;
        }
        const session = await this.deps.db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", opts.action.sessionId)
          .executeTakeFirst();
        if (!session || session.platform !== opts.platform || session.chat_id !== opts.chatId) {
          await respond(t("session.not_found", actorLang));
          return true;
        }
        this.deps.markReviewCommitDisabled(opts.action.sessionId);
        if (opts.messageId) {
          await this.deps.disableReviewCommitButtons({
            platform: opts.platform,
            chatId: opts.chatId,
            messageId: opts.messageId,
            text: opts.messageText,
            workspaceId: opts.workspaceId,
          });
        }
        const isCloudSession = await this.deps.isCloudSession(session as SessionRow);
        if (isCloudSession && this.deps.cloudManager && this.deps.commitProposalStore) {
          const identity = await getOrCreateIdentity(this.deps.db, {
            platform: session.platform,
            workspaceId: session.workspace_id ?? null,
            userId: session.created_by_user_id,
          });
          this.deps.commitProposalStore.startProposal({
            sessionId: opts.action.sessionId,
            platform: opts.platform,
            chatId: opts.chatId,
            userId: opts.userId,
            spaceId: session.space_id,
            workspaceId: session.workspace_id ?? opts.workspaceId ?? null,
            isTelegramTopic: this.deps.isTelegramTopicSession(session),
            gitUserName: identity.git_user_name,
            gitUserEmail: identity.git_user_email,
          });
          await respond(t("commit.proposal.preparing", actorLang));
          try {
            await this.deps.handleSessionMessage(session as SessionRow, opts.userId, this.deps.buildCommitProposalPrompt(identity.branch_name_rule));
          } catch (e) {
            this.deps.logger.warn(
              `[${opts.platform}] commit proposal failed chat=${opts.chatId} user=${opts.userId} session=${opts.action.sessionId}: ${String(e)}`,
            );
            await sendError(
              t("error.generic", actorLang, { message: redactText(e instanceof Error ? e.message : String(e)) }),
            );
          }
          return true;
        }
        await respond(t("session.committing", actorLang));
        try {
          await this.deps.handleSessionMessage(session as SessionRow, opts.userId, this.deps.commitPrompt);
        } catch (e) {
          this.deps.logger.warn(
            `[${opts.platform}] commit action failed chat=${opts.chatId} user=${opts.userId} session=${opts.action.sessionId}: ${String(e)}`,
          );
          await sendError(
            t("error.generic", actorLang, { message: redactText(e instanceof Error ? e.message : String(e)) }),
          );
        }
        return true;
      }
      case "run_status": {
        const access =
          opts.platform === "telegram"
            ? await this.deps.telegramAccessDecision(opts.chatId, opts.userId)
            : this.deps.slackAccessDecision(opts.workspaceId, opts.chatId, opts.userId);
        if (!access.allowed) {
          this.deps.logger.warn(
            `[${opts.platform}] rejected run status action chat=${opts.chatId} user=${opts.userId} run=${opts.action.runId} reason=${access.reason ?? "-"}`,
          );
          await respond(t("error.not_authorized", actorLang));
          return true;
        }
        await respond(t("run.status_fetching", actorLang));
        await this.deps.sendCloudRunStatus({
          platform: opts.platform,
          chatId: opts.chatId,
          userId: opts.userId,
          workspaceId: opts.workspaceId,
          runId: opts.action.runId,
          isDirect: opts.isDirect ?? false,
          replyToMessageId: opts.replyToMessageId,
          messageThreadId: opts.messageThreadId,
          slackThreadTs: opts.threadTs,
        });
        return true;
      }
      case "stop_sandbox": {
        const access =
          opts.platform === "telegram"
            ? await this.deps.telegramAccessDecision(opts.chatId, opts.userId)
            : this.deps.slackAccessDecision(opts.workspaceId, opts.chatId, opts.userId);
        if (!access.allowed) {
          this.deps.logger.warn(
            `[${opts.platform}] rejected stop sandbox action chat=${opts.chatId} user=${opts.userId} session=${opts.action.sessionId} reason=${access.reason ?? "-"}`,
          );
          await respond(t("error.not_authorized", actorLang));
          return true;
        }
        const session = await this.deps.db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", opts.action.sessionId)
          .executeTakeFirst();
        if (!session || session.platform !== opts.platform || session.chat_id !== opts.chatId) {
          await respond(t("session.not_found", actorLang));
          return true;
        }
        const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
        if (!this.deps.cloudManager || !isCloudSession) {
          await respond(t("sandbox.stop_unavailable", actorLang));
          return true;
        }
        await respond(t("sandbox.stopping", actorLang));
        try {
          await this.deps.cloudManager.stopSandboxForSession(opts.action.sessionId);
          await this.sendSessionMessageMarkdown(session as SessionRow, t("sandbox.stopped", this.deps.resolveSessionLanguage(session as SessionRow)));
        } catch (e) {
          this.deps.logger.warn(
            `[${opts.platform}] stop sandbox action failed chat=${opts.chatId} user=${opts.userId} session=${opts.action.sessionId}: ${String(e)}`,
          );
          await this.sendSessionMessageMarkdown(
            session as SessionRow,
            t("sandbox.stop_failed", this.deps.resolveSessionLanguage(session as SessionRow), {
              error: redactText(e instanceof Error ? e.message : String(e)),
            }),
          );
        }
        return true;
      }
      case "commit_proposal": {
        const access =
          opts.platform === "telegram"
            ? await this.deps.telegramAccessDecision(opts.chatId, opts.userId)
            : this.deps.slackAccessDecision(opts.workspaceId, opts.chatId, opts.userId);
        if (!access.allowed) {
          this.deps.logger.warn(
            `[${opts.platform}] rejected commit proposal action chat=${opts.chatId} user=${opts.userId} proposal=${opts.action.proposalId} reason=${access.reason ?? "-"}`,
          );
          await respond(t("error.not_authorized", actorLang));
          return true;
        }
        const proposal = this.deps.commitProposalStore?.getProposal(opts.action.proposalId) ?? null;
        if (!proposal) {
          await respond(t("commit.proposal.expired", actorLang));
          return true;
        }
        if (proposal.platform !== opts.platform || proposal.chatId !== opts.chatId || proposal.userId !== opts.userId) {
          await respond(t("error.not_authorized", actorLang));
          return true;
        }
        const session = await this.deps.db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", proposal.sessionId)
          .executeTakeFirst();
        if (!session || session.platform !== opts.platform || session.chat_id !== opts.chatId) {
          await respond(t("session.not_found", actorLang));
          return true;
        }
        await respond(t("action.processing", actorLang));
        await this.handleCommitProposalAction({ proposal, session: session as SessionRow, action: opts.action.action });
        return true;
      }
    }
  }

  private async sendSessionMessageMarkdown(session: SessionRow, text: string) {
    if (session.platform === "telegram") {
      const chatId = Number(session.chat_id);
      const space = Number(session.space_id);
      if (Number.isNaN(chatId) || Number.isNaN(space)) return;
      await this.deps.sendPlatformMessage({
        platform: this.deps.telegram,
        chatId: session.chat_id,
        text,
        replyToMessageId: this.deps.isTelegramTopicSession(session) ? undefined : space,
        threadId: this.deps.isTelegramTopicSession(session) ? space : undefined,
        priority: "user",
      });
      return;
    }
    if (session.platform === "slack") {
      await this.deps.sendPlatformMessage({
        platform: this.deps.slack,
        chatId: session.chat_id,
        text,
        threadId: undefined,
        priority: "user",
        workspaceId: session.workspace_id ?? null,
      });
    }
  }

  private async handleCommitProposalAction(opts: {
    proposal: CommitProposal;
    session: SessionRow;
    action: CommitProposalAction;
  }) {
    if (!this.deps.commitProposalStore) return;
    const isCloudSession = await this.deps.isCloudSession(opts.session);
    const lang = this.deps.resolveSessionLanguage(opts.session);
    if (!this.deps.cloudManager || !isCloudSession) {
      await this.sendSessionMessageMarkdown(opts.session, t("commit.cloud_unavailable", lang));
      return;
    }

    this.deps.commitProposalStore.consumeProposal(opts.proposal.id);

    if (opts.action === "cancel") {
      await this.sendSessionMessageMarkdown(opts.session, t("commit.proposal.canceled", lang));
      return;
    }

    await this.sendSessionMessageMarkdown(opts.session, t("commit.committing", lang));
    try {
      await this.deps.cloudManager.commitAndPushRun({
        sessionId: opts.session.id,
        commitMessage: opts.proposal.commitMessage,
        branchName: opts.proposal.branchName,
        gitUserName: opts.proposal.gitUserName,
        gitUserEmail: opts.proposal.gitUserEmail,
      });
    } catch (e) {
      await this.sendSessionMessageMarkdown(
        opts.session,
        t("commit.failed", lang, {
          error: redactText(e instanceof Error ? e.message : String(e)),
        }),
      );
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
      const pr = await this.deps.cloudManager.createPullRequestForRun({
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
}
