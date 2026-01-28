import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "../log.js";
import type { ProcessContext, ProcessRegisterOptions } from "./types.js";

/**
 * ProcessLifecycleManager - Manages agent process lifecycle.
 *
 * Handles:
 * - Process registration and unregistration
 * - Timeout management for session limits
 * - Process termination (graceful and forced)
 * - Process lookup by session ID
 */
export class ProcessLifecycleManager {
  private readonly processes = new Map<string, ProcessContext>();

  constructor(private readonly logger: Logger) {}

  /**
   * Register a new process for a session.
   *
   * @throws Error if session already has a registered process
   */
  register(
    sessionId: string,
    child: ChildProcessWithoutNullStreams,
    opts: ProcessRegisterOptions,
  ): void {
    if (this.processes.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a registered process`);
    }

    this.processes.set(sessionId, {
      child,
      timeout: opts.timeout,
      kind: opts.kind,
      agent: opts.agent,
      debug: opts.debug,
    });

    this.logger.debug(
      `[process] registered session=${sessionId} kind=${opts.kind} agent=${opts.agent} pid=${child.pid ?? "?"}`,
    );
  }

  /**
   * Unregister a process for a session.
   * Clears the timeout if present.
   *
   * @returns The process context if found, undefined otherwise
   */
  unregister(sessionId: string): ProcessContext | undefined {
    const proc = this.processes.get(sessionId);
    if (proc) {
      clearTimeout(proc.timeout);
      this.processes.delete(sessionId);
      this.logger.debug(`[process] unregistered session=${sessionId}`);
    }
    return proc;
  }

  /**
   * Get the process context for a session.
   */
  get(sessionId: string): ProcessContext | undefined {
    return this.processes.get(sessionId);
  }

  /**
   * Check if a session has a registered process.
   */
  has(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  /**
   * Update the timeout for a session.
   */
  setTimeout(sessionId: string, newTimeout: ReturnType<typeof setTimeout>): boolean {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;
    clearTimeout(proc.timeout);
    proc.timeout = newTimeout;
    return true;
  }

  /**
   * Clear the timeout for a session without unregistering.
   */
  clearTimeout(sessionId: string): boolean {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;
    clearTimeout(proc.timeout);
    return true;
  }

  /**
   * Kill a process for a session.
   *
   * @param sessionId - The session ID
   * @param signal - The signal to send (default: SIGTERM)
   * @returns true if the process was found and killed, false otherwise
   */
  kill(sessionId: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;

    try {
      proc.child.kill(signal);
      this.logger.debug(`[process] killed session=${sessionId} signal=${signal}`);
      return true;
    } catch (e) {
      this.logger.warn(`[process] kill failed session=${sessionId}: ${String(e)}`);
      return false;
    }
  }

  /**
   * Force kill a process for a session (SIGKILL).
   */
  forceKill(sessionId: string): boolean {
    return this.kill(sessionId, "SIGKILL");
  }

  /**
   * Check if a process is still running (not killed).
   */
  isAlive(sessionId: string): boolean {
    const proc = this.processes.get(sessionId);
    return proc !== undefined && !proc.child.killed;
  }

  /**
   * Get all registered session IDs.
   */
  getSessionIds(): string[] {
    return Array.from(this.processes.keys());
  }

  /**
   * Get the count of registered processes.
   */
  get size(): number {
    return this.processes.size;
  }

  /**
   * Clear all processes (for shutdown).
   * Kills all processes and clears all timeouts.
   *
   * @param signal - The signal to send to all processes
   */
  clearAll(signal: NodeJS.Signals = "SIGTERM"): void {
    for (const sessionId of this.processes.keys()) {
      this.kill(sessionId, signal);
      this.unregister(sessionId);
    }
  }

  /**
   * Get debug info for a session's process.
   */
  getDebug(sessionId: string): ProcessContext["debug"] | null {
    return this.processes.get(sessionId)?.debug ?? null;
  }

  /**
   * Get the agent type for a session's process.
   */
  getAgent(sessionId: string): ProcessContext["agent"] | null {
    return this.processes.get(sessionId)?.agent ?? null;
  }
}
