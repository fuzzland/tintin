import type { CommitProposalAction as _CommitProposalAction, InteractionAction } from "../shared/types.js";

// Re-export from shared types for backward compatibility
export type CommitProposalAction = _CommitProposalAction;
export type SharedInteractionAction = InteractionAction;

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
