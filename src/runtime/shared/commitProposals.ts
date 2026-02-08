import type { CommitProposalAction } from "./types.js";

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
    workspaceId: string | null;
    isTelegramTopic: boolean;
    gitUserName: string | null;
    gitUserEmail: string | null;
  }) => void;
  getProposal: (id: string) => CommitProposal | null;
  consumeProposal: (id: string) => CommitProposal | null;
  clearPendingForSession: (sessionId: string) => void;
}

export type { CommitProposalAction } from "./types.js";
