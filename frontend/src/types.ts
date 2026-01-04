export type CloudRunStatus = "queued" | "running" | "finished" | "error" | "killed";

export interface RunSummary {
  id: string;
  status: CloudRunStatus;
  provider: string;
  primary_repo_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface Identity {
  id: string;
  platform: string;
  workspace_id: string | null;
  user_id: string;
  onboarded_at: number | null;
  created_at: number;
}

export interface RepoInfo {
  id: string;
  name: string;
  url: string;
  default_branch: string | null;
  mount_path: string;
}

export interface SessionInfo {
  id: string;
  agent: string;
  status: string;
  codex_session_id: string | null;
  codex_cwd: string;
  started_at: number | null;
  finished_at: number | null;
}

export interface RunDetailResponse {
  run: RunSummary;
  identity: Identity | null;
  repos: RepoInfo[];
  session: SessionInfo | null;
}

export interface DiffFileView {
  path: string;
  before: string;
  after: string;
}

export interface DiffEntry {
  id: string;
  timestamp: number | null;
  patch: string;
  files: DiffFileView[];
}

export interface CommandEntry {
  id: string;
  timestamp: number | null;
  cwd: string | null;
  command: string;
  output: string;
  exitCode: number | null;
}

export interface ArtifactsResponse {
  diffs: DiffEntry[];
  commands: CommandEntry[];
}

export interface ScreenshotItem {
  id: string;
  url: string;
  tool: string | null;
  mime_type: string | null;
  created_at: number;
}

export interface ScreenshotResponse {
  screenshots: ScreenshotItem[];
}

export type EventFragment =
  | { kind: "text"; text: string; continuous?: boolean }
  | { kind: "tool_call"; text: string }
  | { kind: "tool_output"; text: string }
  | { kind: "plan_update"; plan: Array<{ step: string; status: string }>; explanation?: string };
