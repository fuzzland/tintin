import type { Db, SessionStatus } from "../db.js";
import type { Logger } from "../log.js";
import { updateSession } from "../store.js";
import { nowMs } from "../util.js";
import { VALID_TRANSITIONS, isTerminalStatus } from "./types.js";

/**
 * SessionStateMachine - Manages session status transitions with validation.
 *
 * Ensures that session status changes follow valid transitions:
 * - wizard -> starting
 * - starting -> running | error | killed
 * - running -> finished | error | killed
 * - finished, error, killed -> (terminal, no transitions)
 */
export class SessionStateMachine {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  /**
   * Validate whether a transition from one status to another is allowed.
   */
  validateTransition(from: SessionStatus, to: SessionStatus): boolean {
    const allowed = VALID_TRANSITIONS[from];
    return allowed.includes(to);
  }

  /**
   * Get the current status of a session.
   */
  async getCurrentStatus(sessionId: string): Promise<SessionStatus | null> {
    const row = await this.db
      .selectFrom("sessions")
      .select(["status"])
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row?.status ?? null;
  }

  /**
   * Transition a session to a new status.
   *
   * @param sessionId - The session ID
   * @param newStatus - The target status
   * @param metadata - Optional additional fields to update
   * @param skipValidation - If true, skip transition validation (for recovery scenarios)
   * @throws Error if the transition is invalid
   */
  async transition(
    sessionId: string,
    newStatus: SessionStatus,
    metadata?: Partial<{
      exit_code: number | null;
      finished_at: number | null;
      pid: number | null;
      codex_session_id: string | null;
      started_at: number | null;
    }>,
    skipValidation = false,
  ): Promise<void> {
    const currentStatus = await this.getCurrentStatus(sessionId);

    if (!skipValidation) {
      if (currentStatus === null) {
        throw new Error(`Session ${sessionId} not found`);
      }

      if (!this.validateTransition(currentStatus, newStatus)) {
        throw new Error(
          `Invalid session state transition: ${currentStatus} -> ${newStatus} for session ${sessionId}`,
        );
      }
    }

    const updateData: Record<string, unknown> = {
      status: newStatus,
      ...metadata,
    };

    // Auto-set finished_at for terminal states if not provided
    if (isTerminalStatus(newStatus) && metadata?.finished_at === undefined) {
      updateData.finished_at = nowMs();
    }

    await updateSession(this.db, sessionId, updateData);

    this.logger.debug(
      `[session] status transition session=${sessionId} ${currentStatus ?? "?"} -> ${newStatus}`,
    );
  }

  /**
   * Check if a session is in a terminal state.
   */
  async isTerminal(sessionId: string): Promise<boolean> {
    const status = await this.getCurrentStatus(sessionId);
    return status !== null && isTerminalStatus(status);
  }

  /**
   * Check if a session is running (status is "starting" or "running").
   */
  async isActive(sessionId: string): Promise<boolean> {
    const status = await this.getCurrentStatus(sessionId);
    return status === "starting" || status === "running";
  }

  /**
   * Force a session to error state (for recovery/cleanup).
   * Skips validation to allow recovery from any state.
   */
  async forceError(sessionId: string, exitCode?: number | null): Promise<void> {
    await this.transition(
      sessionId,
      "error",
      {
        exit_code: exitCode ?? null,
        finished_at: nowMs(),
        pid: null,
      },
      true, // Skip validation
    );
  }
}
