import type { CloudRunWsStatus as CloudRunStatus, BrowserProvider } from '../cloud/types.js';

// Re-export types for backward compatibility
export type { CloudRunStatus, BrowserProvider };

// ============ Client → Server Messages ============

export interface AuthMessage {
  type: 'auth';
  token?: string;
}

export interface PingMessage {
  type: 'ping';
}

export interface GetConnectionsMessage {
  type: 'get_connections';
}

export interface ListReposMessage {
  type: 'list_repos';
  provider?: string;  // 'github' | 'gitlab'
  search?: string;
}

export interface GetAuthStatusMessage {
  type: 'get_auth_status';
  provider: 'github' | 'gitlab';
}

export interface StartOAuthMessage {
  type: 'start_oauth';
  provider: 'github' | 'gitlab';
}

export interface GitHubDisconnectMessage {
  type: 'github_disconnect';
  action: 'preview' | 'confirm';
  token?: string;  // Required when action is 'confirm'
}

// ============ Chat Messages (Client → Server) ============

export interface ChatMessage {
  type: 'chat';
  chatId: string;                         // Website-generated chat ID
  prompt: string;                         // User input
  repoIds?: string[];                     // Optional, specify repos on first message
  agent?: 'codex' | 'claude_code';        // Optional, specify agent on first message
  restoreSnapshotId?: string;             // Optional, restore from snapshot
}

export interface StopMessage {
  type: 'stop';
  chatId: string;                         // Stop the active session for this chat
}

export interface SubscribeMessage {
  type: 'subscribe';
  chatId: string;                         // Subscribe to the active session for this chat
}

export interface ListRunsMessage {
  type: 'list_runs';
  limit?: number;  // defaults to 5
}

export type ClientMessage =
  | AuthMessage
  | PingMessage
  | GetConnectionsMessage
  | ListReposMessage
  | GetAuthStatusMessage
  | StartOAuthMessage
  | GitHubDisconnectMessage
  | ChatMessage
  | StopMessage
  | SubscribeMessage
  | ListRunsMessage;

// ============ Server → Client Messages ============

export interface AuthOkMessage {
  type: 'auth_ok';
  identityId?: string;
}

export interface AuthErrorMessage {
  type: 'auth_error';
  message: string;
}

export interface SessionStartedMessage {
  type: 'session_started';
  sessionId: string;
  runId?: string;
  chatId: string;
}

export interface ChunkMessage {
  type: 'chunk';
  chatId: string;
  content: string;
}

export interface ToolCallMessage {
  type: 'tool_call';
  chatId: string;
  name: string;
  input?: string;
}

export interface ToolOutputMessage {
  type: 'tool_output';
  chatId: string;
  name: string;
  output: string;
}

export interface AgentEventMessage {
  type: 'agent_event';
  chatId: string;
  command: string;
  subcommand: string;
  request: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    meta?: unknown;
    upload_bytes?: number;
  };
  response: {
    status: number;
    body?: unknown;
    text?: string;
    error?: string;
  };
}

export interface PlanUpdateMessage {
  type: 'plan_update';
  chatId: string;
  plan: Array<{
    step: string;
    status: 'pending' | 'in_progress' | 'done' | 'failed';
  }>;
  explanation?: string;
}

export interface DoneMessage {
  type: 'done';
  chatId: string;
  stopped?: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ErrorMessage {
  type: 'error';
  sessionId?: string;
  code?: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
}

export interface ConnectionsListMessage {
  type: 'connections_list';
  connections: Array<{
    id: string;
    type: string;
    installationId?: string;
    accountLogin?: string;
    status?: string;
    createdAt: number;
  }>;
}

export interface ReposListMessage {
  type: 'repos_list';
  repos: Array<{
    id: string;
    name: string;
    url: string;
    provider: string;
    defaultBranch: string | null;
  }>;
  total: number;
}

export interface AuthStatusMessage {
  type: 'auth_status';
  provider: string;
  connected: boolean;
  accountLogin?: string;
  installationId?: string;
}

export interface OAuthStartedMessage {
  type: 'oauth_started';
  provider: string;
  authorizeUrl: string;
}

export interface GitHubDisconnectImpact {
  repos: number;
  runs: number;
  sessions: number;
  screenshots: number;
  snapshots: number;
}

export interface GitHubDisconnectPreviewMessage {
  type: 'github_disconnect_preview';
  impact: GitHubDisconnectImpact;
  confirmToken: string;
  expiresIn: number;  // ms
}

export interface GitHubDisconnectResultMessage {
  type: 'github_disconnect_result';
  success: true;
  impact: GitHubDisconnectImpact;
}

export interface GitHubDisconnectErrorMessage {
  type: 'github_disconnect_error';
  error: string;
}

// ============ Cloud Run Messages (Server → Client) ============

export interface RunStatusMessage {
  type: 'run_status';
  chatId: string;
  status: CloudRunStatus;
  message?: string;
}

export interface RunLinksMessage {
  type: 'run_links';
  chatId: string;
  sessionId: string;
  viewUrl?: string;
  vscodeUrl?: string;          // VS Code desktop URI scheme
  codeServerUrl?: string;      // Modal tunnel URL (direct access to web code-server)
  previewUrl?: string;         // Dev server tunnel URL
  previewSummary?: string;     // Description for UI display
}

export interface BrowserSessionMessage {
  type: 'browser_session';
  sessionId: string;
  runId: string;
  cdpUrl: string;
  liveViewUrl?: string;
  provider: BrowserProvider;
}

export interface WorkspaceRestoredMessage {
  type: 'workspace_restored';
  snapshotId: string;
  workspaceId: string;
}

export interface RunCompletedNotificationMessage {
  type: 'run_completed_notification';
  runId: string;
  status: 'completed' | 'error';
  title: string;
  diffStats: { filesChanged: number; additions: number; deletions: number } | null;
  screenshotUrl: string | null;
  viewUrl: string;
  vscodeUrl: string | null;
  initiatorPlatform: string;
  finishedAt: number;
}

export interface RunsListMessage {
  type: 'runs_list';
  runs: Array<{
    id: string;
    status: string;
    prompt: string;
    platform: string;
    diffSummary: string | null;
    createdAt: number;
  }>;
}

export type ServerMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | SessionStartedMessage
  | ChunkMessage
  | ToolCallMessage
  | ToolOutputMessage
  | AgentEventMessage
  | PlanUpdateMessage
  | DoneMessage
  | ErrorMessage
  | PongMessage
  | ConnectionsListMessage
  | ReposListMessage
  | AuthStatusMessage
  | OAuthStartedMessage
  | GitHubDisconnectPreviewMessage
  | GitHubDisconnectResultMessage
  | GitHubDisconnectErrorMessage
  | RunStatusMessage
  | RunLinksMessage
  | BrowserSessionMessage
  | SandboxStatusMessage
  | SandboxReadyMessage
  | SandboxErrorMessage
  | WorkspaceRestoredMessage
  | RunCompletedNotificationMessage
  | RunsListMessage;

// ============ Error Codes ============

export const ErrorCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  ACCESS_DENIED: 'ACCESS_DENIED',
  RATE_LIMIT: 'RATE_LIMIT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  SERVICE_ERROR: 'SERVICE_ERROR',
  RUN_NOT_RESUMABLE: 'RUN_NOT_RESUMABLE',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// ============ Connection Sandbox State ============

/**
 * Sandbox status for a WebSocket connection.
 * - provisioning: Workspace is being created
 * - ready: Workspace is ready for use
 * - in_use: An agent run is active in the sandbox
 * - terminating: Workspace is being terminated
 * - error: Sandbox provisioning or operation failed
 */
export type ConnectionSandboxStatus =
  | 'provisioning'
  | 'ready'
  | 'in_use'
  | 'terminating'
  | 'error';

/**
 * Represents a sandbox (workspace) tied to a WebSocket connection.
 * Created on auth success, destroyed on disconnect.
 */
export interface ConnectionSandbox {
  workspaceId: string;
  rootPath: string;
  status: ConnectionSandboxStatus;
  runId: string | null;
  sessionId: string | null;
  dbIdentityId: string;
  createdAt: number;
  error: string | null;
}

// ============ Sandbox Messages (Server → Client) ============

export interface SandboxStatusMessage {
  type: 'sandbox_status';
  status: ConnectionSandboxStatus;
  workspaceId?: string;
  message?: string;
}

export interface SandboxReadyMessage {
  type: 'sandbox_ready';
  workspaceId: string;
}

export interface SandboxErrorMessage {
  type: 'sandbox_error';
  message: string;
  recoverable: boolean;
}

// ============ Connection State ============

export interface WSConnection {
  id: string;
  ws: import('ws').WebSocket;
  identityId: string | null;
  authenticated: boolean;
  subscribedSessions: Set<string>;
  lastPingAt: number;
  lastActivityAt: number;
  createdAt: number;
  messageCount: number;
  sandbox: ConnectionSandbox | null;
}

// ============ WebSocket Config ============

export interface WebSocketSection {
  enabled: boolean;
  path: string;
  auth_enabled: boolean;
  auth_secret?: string;
  ping_interval_ms: number;
  connection_timeout_ms: number;
  auth_timeout_ms: number;
  max_connections: number;
  max_connections_per_identity: number;
  max_message_size: number;
  rate_limit_messages_per_sec: number;
}
