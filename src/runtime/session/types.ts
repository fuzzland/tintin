import type { ChildProcessWithoutNullStreams, ChildProcess } from "node:child_process";
import type { SessionAgent, SessionStatus } from "../db.js";
import type { SpawnedAgentProcess } from "../agents.js";

/**
 * Session status types as a union type.
 */
export type { SessionStatus } from "../db.js";

/**
 * Valid session status transitions.
 * Terminal states (finished, error, killed) have no valid transitions.
 */
export const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  wizard: ["starting"],
  starting: ["running", "error", "killed"],
  running: ["finished", "error", "killed"],
  finished: [],  // Terminal state
  error: [],     // Terminal state
  killed: [],    // Terminal state
};

/**
 * Check if a status is a terminal state.
 */
export function isTerminalStatus(status: SessionStatus): boolean {
  return status === "finished" || status === "error" || status === "killed";
}

/**
 * Context for a running process.
 */
export interface ProcessContext {
  child: ChildProcessWithoutNullStreams;
  timeout: ReturnType<typeof setTimeout>;
  kind: "exec" | "resume";
  agent: SessionAgent;
  debug: SpawnedAgentProcess["debug"];
}

/**
 * Options for registering a process.
 */
export interface ProcessRegisterOptions {
  timeout: ReturnType<typeof setTimeout>;
  kind: "exec" | "resume";
  agent: SessionAgent;
  debug: SpawnedAgentProcess["debug"];
}

/**
 * ChatGPT proxy context.
 */
export interface ChatGptProxyContext {
  proc: ChildProcess;
  refreshPath: string;
  identityId: string;
}

/**
 * Result of applying cloud proxy to environment.
 */
export interface CloudProxyResult {
  env: Record<string, string>;
  codexHome?: string;  // If set, the CODEX_HOME path that was configured
}

/**
 * Kill reason - can be a plain string or a localization key with params.
 */
export type KillReason = string | { key: string; params?: Record<string, string | number> };
