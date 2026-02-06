/**
 * SessionOrchestrator Types - Platform-agnostic session handling.
 *
 * These types define the contract between platform adapters and the orchestrator.
 * They ensure consistent behavior across Telegram, Slack, and WebSocket.
 */

import type { UserLanguage } from "../../locales/index.js";

/**
 * Platform identifier for session context.
 */
export type SessionPlatform = "telegram" | "slack" | "websocket";

/**
 * Platform-agnostic chat request.
 * Adapters convert platform-specific messages to this format.
 */
export interface ChatRequest {
  /** Platform originating the request */
  platform: SessionPlatform;
  /** Platform-specific chat/channel ID */
  chatId: string;
  /** User who sent the message */
  userId: string;
  /** The message content */
  prompt: string;
  /** User's preferred language */
  language: UserLanguage;
  /** Optional workspace ID (Slack) */
  workspaceId?: string | null;
  /** Whether this is a direct message */
  isDirect?: boolean;
  /** Repository IDs for cloud runs */
  repoIds?: string[];
  /** Agent type preference */
  agent?: "codex" | "claude_code";
  /** Snapshot ID to restore from */
  restoreSnapshotId?: string | null;
}

/**
 * Result of processing a chat request.
 */
export interface ChatResult {
  /** Whether the request was processed successfully */
  success: boolean;
  /** Session ID if a session was created/resumed */
  sessionId?: string;
  /** Run ID for cloud runs */
  runId?: string;
  /** Status message for the user */
  statusMessage?: string;
  /** Error message if failed */
  error?: string;
  /** Whether message was queued (session busy) */
  queued?: boolean;
  /** Number of pending messages in queue */
  pendingCount?: number;
}

/**
 * Session action types for button interactions.
 * Unified from shared/types.ts InteractionAction.
 */
export type SessionAction =
  | { kind: "stop"; sessionId: string }
  | { kind: "review"; sessionId: string }
  | { kind: "commit"; sessionId: string }
  | { kind: "run_status"; runId: string }
  | { kind: "stop_sandbox"; sessionId: string };

/**
 * Context for action execution.
 */
export interface ActionContext {
  /** Platform originating the action */
  platform: SessionPlatform;
  /** Platform-specific chat/channel ID */
  chatId: string;
  /** User executing the action */
  userId: string;
  /** User's preferred language */
  language: UserLanguage;
  /** Optional workspace ID (Slack) */
  workspaceId?: string | null;
  /** Message ID for button updates */
  messageId?: string;
  /** Original message text for button updates */
  messageText?: string;
  /** Telegram callback query ID */
  interactionId?: string;
  /** Slack thread timestamp */
  threadTs?: string;
}

/**
 * Result of processing a session action.
 */
export interface ActionResult {
  /** Whether the action was processed */
  handled: boolean;
  /** User-facing response message */
  response?: string;
  /** Whether to show as toast/ephemeral */
  ephemeral?: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Session state for orchestrator decisions.
 */
export type SessionStatus =
  | "wizard"
  | "starting"
  | "running"
  | "finished"
  | "error"
  | "killed";

/**
 * Minimal session data needed by orchestrator.
 */
export interface SessionInfo {
  id: string;
  status: SessionStatus;
  platform: SessionPlatform;
  chatId: string;
  createdByUserId: string;
  workspaceId: string | null;
  spaceId: string | null;
  language: UserLanguage | null;
  isCloud?: boolean;
}

/**
 * Resume result from cloud manager.
 */
export type ResumeResult = "resumed" | "expired" | "not_found" | "error";

/**
 * Restart result from cloud manager.
 */
export type RestartResult = "restarted" | "failed";

/**
 * Dependency interface for SessionOrchestrator.
 * Allows for clean testing and platform-specific implementations.
 */
export interface OrchestratorDeps {
  /** Queue a message for a busy session */
  enqueueMessage(sessionId: string, userId: string, text: string): Promise<void>;
  /** Count pending messages for a session */
  countPendingMessages(sessionId: string): Promise<number>;
  /** Resume a cloud session with new prompt */
  resumeCloudSession(session: SessionInfo, prompt: string): Promise<ResumeResult>;
  /** Restart an expired cloud session */
  restartCloudSession(session: SessionInfo, prompt: string): Promise<RestartResult>;
  /** Resume a local session with new prompt */
  resumeLocalSession(session: SessionInfo, prompt: string): Promise<void>;
  /** Check if session is a cloud session */
  isCloudSession(session: SessionInfo): Promise<boolean>;
  /** Stop a cloud sandbox */
  stopCloudSandbox(sessionId: string): Promise<void>;
  /** Kill a local session */
  killLocalSession(sessionId: string, reason: string): Promise<void>;
  /** Get session by ID */
  getSession(sessionId: string): Promise<SessionInfo | null>;
  /** Get cloud run status */
  getCloudRunStatus(runId: string): Promise<{ status: string; message?: string } | null>;
}
