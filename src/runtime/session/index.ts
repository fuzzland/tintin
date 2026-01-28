// Session module - modular session management
//
// This module provides the refactored, modular implementation of SessionManager.
// Each component has a single responsibility:
// - SessionStateMachine: Manages session status transitions with validation
// - ProcessLifecycleManager: Manages agent process lifecycle (registration, timeout, kill)
// - ChatGptProxyManager: Manages ChatGPT OAuth proxy processes
// - EnvironmentBuilder: Fluent builder for constructing agent environment variables

export { SessionStateMachine } from "./SessionStateMachine.js";
export { ProcessLifecycleManager } from "./ProcessLifecycleManager.js";
export { ChatGptProxyManager } from "./ChatGptProxyManager.js";
export { EnvironmentBuilder } from "./EnvironmentBuilder.js";

export type {
  SessionStatus,
  ProcessContext,
  ProcessRegisterOptions,
  ChatGptProxyContext,
  CloudProxyResult,
  KillReason,
} from "./types.js";

export { VALID_TRANSITIONS, isTerminalStatus } from "./types.js";
