import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { CloudManager } from "../cloud/manager.js";
import type { CommitProposalStore, CommitProposalAction } from "../shared/commitProposals.js";
import type { SessionRow } from "../store.js";
import type { IMessagingPlatform, InteractiveMarkup } from "../platform/base.js";
import type { TelegramClient } from "../platform/telegram.js";
import type { SlackClient } from "../platform/slack.js";
import { getCloudRunBySession } from "../cloud/store.js";
import { isUserLanguage, t, type UserLanguage } from "../../locales/index.js";
import { redactText } from "../redact.js";

export interface CommitProposalContext {
  platform: "telegram" | "slack";
  chatId: string;
  userId: string;
  workspaceId: string | null;
  proposalId: string;
  action: CommitProposalAction;
}

export interface CommitProposalResult {
  handled: boolean;
  error?: string;
}

export interface CommitProposalOrchestratorDeps {
  logger: Logger;
  db: Db;
  cloudManager: CloudManager | null;
  commitProposalStore: CommitProposalStore | null;
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
}

export class CommitProposalOrchestrator {
  constructor(private readonly deps: CommitProposalOrchestratorDeps) {}

  async handle(ctx: CommitProposalContext): Promise<CommitProposalResult> {
    if (!this.deps.commitProposalStore) {
      return { handled: false, error: "Commit proposal store not configured" };
    }

    const actorLang = await this.deps.resolveUserLanguage(ctx.platform, ctx.userId);
    const proposal = this.deps.commitProposalStore.getProposal(ctx.proposalId);

    if (!proposal) {
      await this.sendDirectMessage(ctx, t("commit.proposal.expired", actorLang));
      return { handled: true };
    }

    if (proposal.platform !== ctx.platform || proposal.chatId !== ctx.chatId || proposal.userId !== ctx.userId) {
      await this.sendDirectMessage(ctx, t("error.not_authorized", actorLang));
      return { handled: true };
    }

    const session = await this.deps.db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", proposal.sessionId)
      .executeTakeFirst();

    if (!session || session.platform !== ctx.platform || session.chat_id !== ctx.chatId) {
      await this.sendDirectMessage(ctx, t("session.not_found", actorLang));
      return { handled: true };
    }

    const lang = await this.resolveSessionLanguage(session, ctx.platform, ctx.userId);
    const isCloudSession = await this.isCloudSession(session);
    if (!this.deps.cloudManager || !isCloudSession) {
      await this.sendSessionMessage(session, t("commit.cloud_unavailable", lang));
      return { handled: true };
    }

    this.deps.commitProposalStore.consumeProposal(proposal.id);

    if (ctx.action === "cancel") {
      await this.sendSessionMessage(session, t("commit.proposal.canceled", lang));
      return { handled: true };
    }

    await this.sendSessionMessage(session, t("commit.committing", lang));

    try {
      await this.deps.cloudManager.commitAndPushRun({
        sessionId: session.id,
        commitMessage: proposal.commitMessage,
        branchName: proposal.branchName,
        gitUserName: proposal.gitUserName,
        gitUserEmail: proposal.gitUserEmail,
      });
    } catch (e) {
      await this.sendSessionMessage(
        session,
        t("commit.failed", lang, {
          error: redactText(e instanceof Error ? e.message : String(e)),
        }),
      );
      return { handled: true };
    }

    if (ctx.action === "push") {
      const lines = [
        t("commit.pushed.title", lang),
        t("commit.pushed.branch", lang, { branch: proposal.branchName }),
        t("commit.pushed.commit", lang, { message: proposal.commitMessage }),
      ];
      await this.sendSessionMessage(session, lines.join("\n"));
      return { handled: true };
    }

    try {
      const pr = await this.deps.cloudManager.createPullRequestForRun({
        sessionId: session.id,
        branchName: proposal.branchName,
        title: proposal.commitMessage,
        body: proposal.summary ? `Summary:\n${proposal.summary}` : undefined,
      });
      const lines = [
        t("commit.pr.created.title", lang),
        t("commit.pr.created.branch", lang, { branch: proposal.branchName }),
        t("commit.pr.created.base", lang, { base: pr.base }),
        pr.url ? t("commit.pr.created.link", lang, { url: pr.url }) : t("commit.pr.created.no_link", lang),
      ];
      await this.sendSessionMessage(session, lines.join("\n"));
    } catch (e) {
      const lines = [
        t("commit.pr.failed.title", lang),
        t("commit.pr.failed.branch", lang, { branch: proposal.branchName }),
        t("commit.pr.failed.error", lang, { error: redactText(e instanceof Error ? e.message : String(e)) }),
      ];
      await this.sendSessionMessage(session, lines.join("\n"));
    }

    return { handled: true };
  }

  private async resolveSessionLanguage(
    session: SessionRow,
    platform: "telegram" | "slack",
    userId: string,
  ): Promise<UserLanguage> {
    if (isUserLanguage(session.language ?? "")) return session.language as UserLanguage;
    return this.deps.resolveUserLanguage(platform, userId);
  }

  private async isCloudSession(session: SessionRow): Promise<boolean> {
    if (typeof session.project_id === "string" && session.project_id.startsWith("cloud:")) return true;
    const run = await getCloudRunBySession(this.deps.db, session.id);
    return Boolean(run);
  }

  private isTelegramTopicSession(session: SessionRow): boolean {
    return session.platform === "telegram" && typeof session.space_emoji === "string" && session.space_emoji.trim().length > 0;
  }

  private async sendDirectMessage(ctx: CommitProposalContext, text: string): Promise<void> {
    const platform = ctx.platform === "telegram" ? this.deps.telegram : this.deps.slack;
    await this.deps.sendPlatformMessage({
      platform,
      chatId: ctx.chatId,
      text,
      priority: "user",
      workspaceId: ctx.workspaceId,
    });
  }

  private async sendSessionMessage(session: SessionRow, text: string): Promise<void> {
    if (session.platform === "telegram") {
      const chatId = Number(session.chat_id);
      const space = Number(session.space_id);
      if (Number.isNaN(chatId) || Number.isNaN(space)) return;
      await this.deps.sendPlatformMessage({
        platform: this.deps.telegram,
        chatId: session.chat_id,
        text,
        replyToMessageId: this.isTelegramTopicSession(session) ? undefined : space,
        threadId: this.isTelegramTopicSession(session) ? space : undefined,
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
}
