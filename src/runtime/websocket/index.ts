// WebSocket module exports
export { WebSocketManager } from './manager.js';
export { WebSocketHandler } from './handler.js';
export { requireAuth, requireSessionId } from './guards.js';
export type { AuthenticatedConnection } from './guards.js';
export { SessionService, GitHubService } from './services/index.js';
export type {
  // Client → Server messages
  AuthMessage,
  ChatMessage,
  StopMessage,
  SubscribeMessage,
  UnsubscribeMessage,
  PingMessage,
  ClientMessage,
  // Server → Client messages
  AuthOkMessage,
  AuthErrorMessage,
  SessionStartedMessage,
  ChunkMessage,
  ToolCallMessage,
  ToolOutputMessage,
  PlanUpdateMessage,
  DoneMessage,
  ErrorMessage,
  PongMessage,
  ServerMessage,
  // Other types
  ErrorCode,
  WSConnection,
  WebSocketSection,
} from './types.js';
export { ErrorCodes } from './types.js';
