export interface NotificationTarget {
  identityId: string;
  platform: "telegram" | "slack" | "websocket";
  userId: string;
  workspaceId: string | null;
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface RunSummaryCard {
  runId: string;
  status: "completed" | "error";
  title: string;
  prompt: string;
  diffStats: DiffStats | null;
  screenshotUrl: string | null;
  viewUrl: string;
  vscodeUrl: string | null;
  initiatorPlatform: string;
  finishedAt: number;
}
