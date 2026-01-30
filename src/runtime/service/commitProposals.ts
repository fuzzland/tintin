import crypto from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionMessage } from "../messaging.js";
import type { TelegramClient } from "../platform/telegram.js";
import type { SlackClient } from "../platform/slack.js";
import type { CommitProposal, CommitProposalStore } from "../controller/types.js";
import type { InteractiveMarkup } from "../platform/base.js";
import { isUserLanguage, t, type UserLanguage } from "../../locales/index.js";
import { mergeTextIntoSlackBlocks } from "../message/slack.js";

export type PendingCommitProposal = {
  sessionId: string;
  platform: "telegram" | "slack";
  chatId: string;
  userId: string;
  spaceId: string;
  workspaceId: string | null;
  isTelegramTopic: boolean;
  gitUserName: string | null;
  gitUserEmail: string | null;
  buffer: string;
};

export type CommitProposalRuntime = {
  commitProposalStore: CommitProposalStore;
  maybeHandleCommitProposalMessage: (sessionId: string, message: SessionMessage) => Promise<boolean>;
  suppressFinalizeForSession: Set<string>;
};

export function createCommitProposalRuntime(deps: {
  config: AppConfig;
  db: Db;
  logger: Logger;
  telegram: TelegramClient | null;
  slack: SlackClient | null;
  resolveUserLanguage: (platform: "telegram" | "slack", userId: string) => Promise<UserLanguage>;
  getTelegramReplyMarkup: (markup?: InteractiveMarkup) => { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined;
  getSlackBlocks: (markup?: InteractiveMarkup) => unknown[] | undefined;
}) : CommitProposalRuntime {
  const pendingCommitProposals = new Map<string, PendingCommitProposal>();
  const suppressFinalizeForSession = new Set<string>();
  const commitProposals = new Map<string, CommitProposal>();

  const buildCommitProposalTelegramKeyboard = (proposalId: string, lang: UserLanguage) => {
    return {
      inline_keyboard: [
        [
          { text: t("button.cancel", lang), callback_data: `cpr:${proposalId}:cancel` },
          { text: t("button.commit_push", lang), callback_data: `cpr:${proposalId}:push` },
        ],
        [{ text: t("button.create_pr", lang), callback_data: `cpr:${proposalId}:pr` }],
      ],
    };
  };

  const buildCommitProposalSlackBlocks = (proposalId: string, lang: UserLanguage) => {
    return [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: t("button.cancel", lang) },
            style: "danger",
            action_id: "commit_cancel",
            value: proposalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: t("button.commit_push", lang) },
            action_id: "commit_push",
            value: proposalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: t("button.create_pr", lang) },
            action_id: "commit_pr",
            value: proposalId,
          },
        ],
      },
    ];
  };

  const buildCommitProposalMarkup = (
    platform: "telegram" | "slack",
    proposalId: string,
    lang: UserLanguage,
  ): InteractiveMarkup => {
    if (platform === "telegram") {
      return { type: "inline_keyboard", payload: buildCommitProposalTelegramKeyboard(proposalId, lang) };
    }
    return { type: "blocks", payload: buildCommitProposalSlackBlocks(proposalId, lang) };
  };

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

  const parseFormattedCommitProposal = (
    raw: string,
    lang: UserLanguage,
  ): { commitMessage: string; branchName: string; summary: string } | null => {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;

    const normalize = (value: string) =>
      value
        .replace(/^[*_~`>\s]+/g, "")
        .replace(/[*_~`]+$/g, "")
        .trim();

    const branchPrefix = normalize(t("commit.proposal.branch", lang, { branch: "" }));
    const commitPrefix = normalize(t("commit.proposal.commit", lang, { message: "" }));
    const summaryPrefix = normalize(t("commit.proposal.summary", lang, { summary: "" }));
    const emptySummary = normalize(t("commit.proposal.summary_empty", lang));

    let branchName = "";
    let commitMessage = "";
    let summary = "";

    for (const line of lines) {
      const normalized = normalize(line);
      if (!branchName && normalized.startsWith(branchPrefix)) {
        branchName = normalized.slice(branchPrefix.length).trim();
        continue;
      }
      if (!commitMessage && normalized.startsWith(commitPrefix)) {
        commitMessage = normalized.slice(commitPrefix.length).trim();
        continue;
      }
      if (!summary && normalized.startsWith(summaryPrefix)) {
        summary = normalized.slice(summaryPrefix.length).trim();
        continue;
      }
    }

    if (summary === emptySummary) summary = "";
    if (!branchName || !commitMessage) return null;
    return { commitMessage, branchName, summary };
  };

  const resolvePendingLanguage = async (pending: PendingCommitProposal): Promise<UserLanguage> => {
    const row = await deps.db
      .selectFrom("sessions")
      .select(["language"])
      .where("id", "=", pending.sessionId)
      .executeTakeFirst();
    if (row && isUserLanguage(row.language ?? "")) return row.language;
    return await deps.resolveUserLanguage(pending.platform, pending.userId);
  };

  const formatCommitProposalText = (proposal: CommitProposal, lang: UserLanguage) => {
    const summary = proposal.summary?.trim();
    const summaryLine = summary ? summary : t("commit.proposal.summary_empty", lang);
    return [
      t("commit.proposal.title", lang),
      t("commit.proposal.branch", lang, { branch: proposal.branchName }),
      t("commit.proposal.commit", lang, { message: proposal.commitMessage }),
      t("commit.proposal.summary", lang, { summary: summaryLine }),
      "",
      t("commit.proposal.choose_action", lang),
    ].join("\n");
  };

  const sendCommitProposalMessage = async (opts: {
    pending: PendingCommitProposal;
    text: string;
    proposalId: string;
    lang: UserLanguage;
  }) => {
    if (opts.pending.platform === "telegram") {
      if (!deps.telegram) return;
      const chatId = Number(opts.pending.chatId);
      const space = Number(opts.pending.spaceId);
      if (Number.isNaN(chatId)) return;
      const markup = buildCommitProposalMarkup("telegram", opts.proposalId, opts.lang);
      const replyMarkup = deps.getTelegramReplyMarkup(markup);
      if (opts.pending.isTelegramTopic && Number.isFinite(space)) {
        await deps.telegram.sendMessage({
          chatId,
          messageThreadId: Number(space),
          text: opts.text,
          replyMarkup,
          priority: "user",
        });
        return;
      }
      if (Number.isFinite(space)) {
        await deps.telegram.sendMessage({
          chatId,
          replyToMessageId: Number(space),
          text: opts.text,
          replyMarkup,
          priority: "user",
        });
        return;
      }
      await deps.telegram.sendMessage({ chatId, text: opts.text, replyMarkup, priority: "user" });
      return;
    }

    if (opts.pending.platform === "slack") {
      if (!deps.slack) return;
      const threadTs = undefined;
      await deps.slack.postMessageDetailed({
        channel: opts.pending.chatId,
        thread_ts: threadTs,
        text: opts.text,
        blocks: mergeTextIntoSlackBlocks(
          opts.text,
          deps.getSlackBlocks(buildCommitProposalMarkup("slack", opts.proposalId, opts.lang)),
        ),
        blocksOnLastChunk: false,
        priority: "user",
        workspaceId: opts.pending.workspaceId,
      });
    }
  };

  const sendCommitProposalNotice = async (pending: PendingCommitProposal, text: string, lang: UserLanguage) => {
    if (pending.platform === "telegram") {
      if (!deps.telegram) return;
      const chatId = Number(pending.chatId);
      const space = Number(pending.spaceId);
      if (Number.isNaN(chatId)) return;
      if (pending.isTelegramTopic && Number.isFinite(space)) {
        await deps.telegram.sendMessage({ chatId, messageThreadId: Number(space), text, priority: "user" });
        return;
      }
      if (Number.isFinite(space)) {
        await deps.telegram.sendMessage({ chatId, replyToMessageId: Number(space), text, priority: "user" });
        return;
      }
      await deps.telegram.sendMessage({ chatId, text, priority: "user" });
      return;
    }
    if (pending.platform === "slack") {
      if (!deps.slack) return;
      const threadTs = undefined;
      await deps.slack.postMessageDetailed({
        channel: pending.chatId,
        thread_ts: threadTs,
        text,
        blocks: mergeTextIntoSlackBlocks(text, undefined),
        blocksOnLastChunk: false,
        priority: "user",
        workspaceId: pending.workspaceId,
      });
    }
  };

  const sendCommitProposalError = async (
    pending: PendingCommitProposal,
    reasonKey: Parameters<typeof t>[0],
    params?: Record<string, string | number>,
  ) => {
    const lang = await resolvePendingLanguage(pending);
    const reason = t(reasonKey, lang, params);
    const text = t("commit.proposal.failed", lang, { reason });
    await sendCommitProposalNotice(pending, text, lang);
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

  const maybeHandleCommitProposalMessage = async (sessionId: string, message: SessionMessage) => {
    const pending = pendingCommitProposals.get(sessionId);
    if (!pending) return false;
    if (message.type === "finalize") return false;
    if (message.type === "plan_update" || message.type === "image") return true;
    const text = typeof message.text === "string" ? message.text : "";
    if (text || message.final) {
      pending.buffer = pending.buffer ? `${pending.buffer}\n${text}` : text;
      if (pending.buffer.length > 40_000) {
        pendingCommitProposals.delete(sessionId);
        suppressFinalizeForSession.add(sessionId);
        await sendCommitProposalError(pending, "commit.proposal.output_too_large");
        return true;
      }
      let parsed = extractCommitProposalPayload(pending.buffer);
      const lang = await resolvePendingLanguage(pending);
      if (!parsed) {
        parsed = parseFormattedCommitProposal(pending.buffer, lang);
      }
      if (parsed) {
        pendingCommitProposals.delete(sessionId);
        suppressFinalizeForSession.add(sessionId);
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
        const textOut = formatCommitProposalText(proposal, lang);
        await sendCommitProposalMessage({ pending, text: textOut, proposalId: proposal.id, lang });
        return true;
      }
      if (message.final) {
        pendingCommitProposals.delete(sessionId);
        suppressFinalizeForSession.add(sessionId);
        await sendCommitProposalError(pending, "commit.proposal.invalid_json");
        return true;
      }
    }
    return true;
  };

  return {
    commitProposalStore,
    maybeHandleCommitProposalMessage,
    suppressFinalizeForSession,
  };
}
