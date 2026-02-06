/**
 * SessionOrchestrator - Unified session handling layer.
 *
 * This module provides platform-agnostic session orchestration:
 * - Message handling (queue, resume, restart)
 * - Action processing (stop, review, commit)
 * - Session state management
 *
 * Platform adapters convert their specific messages to ChatRequest/SessionAction
 * and delegate to SessionOrchestrator for consistent behavior.
 */

// Types
export type {
  SessionPlatform,
  ChatRequest,
  ChatResult,
  SessionAction,
  ActionContext,
  ActionResult,
  SessionStatus,
  SessionInfo,
  ResumeResult,
  RestartResult,
  OrchestratorDeps,
} from "./types.js";

// Orchestrator
export { SessionOrchestrator } from "./SessionOrchestrator.js";
