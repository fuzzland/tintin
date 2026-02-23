import type { CloudRunWsStatus as CloudRunStatus, BrowserProvider } from '../cloud/types.js';
import type { ProgressEvent } from '../streamer/progress/types.js';

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

// ============ Cloud Run Messages (Client → Server) ============

export interface CloudRunMessage {
  type: 'cloud_run';
  chatId: string;                // stable conversation id from website
  projectId?: string;              // project ID (preferred over repoIds)
  repoIds?: string[];              // repo IDs (deprecated, use projectId)
  prompt: string;                  // user prompt
  agent?: 'codex' | 'claude_code'; // optional, defaults from config
  language?: string;               // optional, language code (e.g., 'en', 'zh')
  restoreSnapshotId?: string;      // optional, restore from specified snapshot
  autoRestore?: boolean;           // optional, auto-restore from latest snapshot
  lastRunId?: string;              // optional, restore from specific run's snapshot
}

export interface SubscribeChatMessage {
  type: 'subscribe_chat';
  chatId: string;
}

export interface CloudFollowUpMessage {
  type: 'cloud_follow_up';
  chatId: string;
  prompt: string;
}

export interface CloudStopMessage {
  type: 'cloud_stop';
  chatId: string;
}

export type ClientMessage =
  | AuthMessage
  | PingMessage
  | CloudRunMessage
  | SubscribeChatMessage
  | CloudFollowUpMessage
  | CloudStopMessage;

// ============ Server → Client Messages ============

export interface AuthResultMessage {
  type: 'auth_result';
  success: boolean;
  identityId?: string;  // when success=true
  message?: string;     // when success=false
}

export interface ChunkMessage {
  type: 'chunk';
  sessionId: string;
  content: string;
}

export interface ToolCallMessage {
  type: 'tool_call';
  sessionId: string;
  name: string;
  input?: string;
}

export interface ToolOutputMessage {
  type: 'tool_output';
  sessionId: string;
  name: string;
  output: string;
}

export interface AgentEventMessage {
  type: 'agent_event';
  sessionId: string;
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
  sessionId: string;
  plan: Array<{
    step: string;
    status: 'pending' | 'in_progress' | 'done' | 'failed';
  }>;
  explanation?: string;
}

export interface DoneMessage {
  type: 'done';
  sessionId: string;
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

// ============ Cloud Run Messages (Server → Client) ============

export interface RunStatusMessage {
  type: 'run_status';
  runId: string;
  sessionId?: string;  // present when status='started'
  status: CloudRunStatus | 'started';
  message?: string;
}

export interface RunLinksMessage {
  type: 'run_links';
  runId: string;
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

export interface FollowUpStatusMessage {
  type: 'follow_up_status';
  runId: string;
  sessionId: string;
  status: 'queued' | 'resuming' | 'restarting';
  position?: number;  // only when status='queued'
}

export interface ProgressEventMessage {
  type: 'progress_event';
  sessionId: string;
  event: ProgressEvent;
}

export type ServerMessage =
  | AuthResultMessage
  | ChunkMessage
  | ToolCallMessage
  | ToolOutputMessage
  | AgentEventMessage
  | PlanUpdateMessage
  | DoneMessage
  | ErrorMessage
  | PongMessage
  | RunStatusMessage
  | RunLinksMessage
  | BrowserSessionMessage
  | SandboxStatusMessage
  | FollowUpStatusMessage
  | ProgressEventMessage;

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
  recoverable?: boolean;  // only when status='error'
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
