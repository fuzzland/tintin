// ============ Client → Server Messages ============

export interface AuthMessage {
  type: 'auth';
  token?: string;
}

export interface ChatMessage {
  type: 'chat';
  sessionId?: string;
  projectId?: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
}

export interface StopMessage {
  type: 'stop';
  sessionId: string;
}

export interface SubscribeMessage {
  type: 'subscribe';
  sessionId: string;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  sessionId: string;
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage =
  | AuthMessage
  | ChatMessage
  | StopMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | PingMessage;

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
  | PongMessage;

// ============ Error Codes ============

export const ErrorCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  ACCESS_DENIED: 'ACCESS_DENIED',
  RATE_LIMIT: 'RATE_LIMIT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  SERVICE_ERROR: 'SERVICE_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

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
