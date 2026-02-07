/**
 * SessionOrchestrator - Unified session handling for all platforms.
 *
 * Extracts common session logic from controller2.ts and websocket/services/chat.ts.
 * Provides platform-agnostic session management: message handling, action processing.
 *
 * Follows SRP: Only responsible for session lifecycle orchestration.
 * Depends on injected services for actual operations.
 */

import type { Logger } from "../log.js";
import type {
  ChatRequest,
  ChatResult,
  SessionAction,
  ActionContext,
  ActionResult,
  SessionInfo,
  OrchestratorDeps,
} from "./types.js";
import { t } from "../../locales/index.js";
import { redactText } from "../redact.js";

export class SessionOrchestrator {
  constructor(
    private readonly deps: OrchestratorDeps,
    private readonly logger: Logger,
  ) {}

  /**
   * Handle a chat message for an existing session.
   *
   * Decision tree:
   * 1. If session is busy (running/starting): queue message
   * 2. If session is resumable: resume with new prompt
   * 3. If cloud session expired: attempt restart
   *
   * @param session - The existing session
   * @param request - The chat request
   * @returns Result with status
   */
  async handleSessionMessage(
    session: SessionInfo,
    request: ChatRequest,
  ): Promise<ChatResult> {
    const { userId, prompt, language } = request;

    // Case 1: Session is busy - queue the message
    if (session.status === "running" || session.status === "starting") {
      await this.deps.enqueueMessage(session.id, userId, prompt);
      const pendingCount = await this.deps.countPendingMessages(session.id);
      this.logger.debug(
        `[orchestrator] queued message session=${session.id} from=${userId} pending=${pendingCount}`,
      );
      return {
        success: true,
        sessionId: session.id,
        queued: true,
        pendingCount,
        statusMessage: t("session.queued", language, { n: pendingCount }),
      };
    }

    // Case 2: Session is finished/error - try to resume
    this.logger.debug(`[orchestrator] resuming session=${session.id} from=${userId}`);

    // Check if this is a cloud session
    const isCloud = await this.deps.isCloudSession(session);

    if (isCloud) {
      return this.handleCloudResume(session, request);
    }

    // Local session - direct resume
    try {
      await this.deps.resumeLocalSession(session, prompt);
      return {
        success: true,
        sessionId: session.id,
        statusMessage: t("session.starting", language),
      };
    } catch (e) {
      this.logger.error(
        `[orchestrator] local resume failed session=${session.id}: ${String(e)}`,
      );
      return {
        success: false,
        sessionId: session.id,
        error: t("session.error", language, {
          error: redactText(String(e)),
        }),
      };
    }
  }

  /**
   * Handle cloud session resume with expiry detection.
   */
  private async handleCloudResume(
    session: SessionInfo,
    request: ChatRequest,
  ): Promise<ChatResult> {
    const { prompt, language } = request;

    const resumed = await this.deps.resumeCloudSession(session, prompt);

    if (resumed === "resumed") {
      return {
        success: true,
        sessionId: session.id,
        statusMessage: t("session.starting", language),
      };
    }

    if (resumed === "expired") {
      // Try to restart the expired session
      this.logger.info(`[orchestrator] session expired, restarting session=${session.id}`);

      try {
        const restarted = await this.deps.restartCloudSession(session, prompt);
        if (restarted === "restarted") {
          return {
            success: true,
            sessionId: session.id,
            statusMessage: t("session.starting", language),
          };
        }
      } catch (e) {
        this.logger.warn(
          `[orchestrator] restart failed session=${session.id}: ${String(e)}`,
        );
        return {
          success: false,
          sessionId: session.id,
          error: t("session.restart_failed", language, {
            error: redactText(String(e)),
          }),
        };
      }

      return {
        success: false,
        sessionId: session.id,
        error: t("sandbox.expired_prompt", language),
      };
    }

    // Not found or other error
    return {
      success: false,
      sessionId: session.id,
      error: t("session.error", language, { error: resumed }),
    };
  }

  /**
   * Handle a session action (stop, review, commit, etc.).
   *
   * @param action - The action to perform
   * @param context - Context for the action
   * @returns Result with response message
   */
  async handleAction(
    action: SessionAction,
    context: ActionContext,
  ): Promise<ActionResult> {
    switch (action.kind) {
      case "kill":
        return this.handleKillAction(action.sessionId, context);
      case "review":
        return this.handleReviewAction(action.sessionId, context);
      case "commit":
        return this.handleCommitAction(action.sessionId, context);
      case "run_status":
        return this.handleRunStatusAction(action.runId, context);
      case "stop_sandbox":
        return this.handleStopSandboxAction(action.sessionId, context);
      default:
        return { handled: false, error: "Unknown action" };
    }
  }

  /**
   * Kill a running session.
   */
  private async handleKillAction(
    sessionId: string,
    context: ActionContext,
  ): Promise<ActionResult> {
    const { language } = context;

    const session = await this.deps.getSession(sessionId);
    if (!session) {
      return {
        handled: true,
        response: t("session.not_found", language),
        ephemeral: true,
      };
    }

    if (session.status !== "starting" && session.status !== "running") {
      return {
        handled: true,
        response: t("session.already_finished", language),
        ephemeral: true,
      };
    }

    const isCloud = await this.deps.isCloudSession(session);

    try {
      if (isCloud) {
        await this.deps.stopCloudSandbox(sessionId);
        return {
          handled: true,
          response: t("run.stopped", language),
        };
      } else {
        await this.deps.killLocalSession(
          sessionId,
          t("session.stop_requested", language),
        );
        return {
          handled: true,
          response: t("session.stopped", language),
        };
      }
    } catch (e) {
      this.logger.warn(
        `[orchestrator] stop failed session=${sessionId}: ${String(e)}`,
      );
      return {
        handled: true,
        error: t("run.stop_failed", language, {
          error: redactText(e instanceof Error ? e.message : String(e)),
        }),
      };
    }
  }

  /**
   * Trigger a code review.
   * Note: Actual review prompt is handled by the adapter layer.
   */
  private async handleReviewAction(
    sessionId: string,
    context: ActionContext,
  ): Promise<ActionResult> {
    const { language } = context;

    const session = await this.deps.getSession(sessionId);
    if (!session) {
      return {
        handled: true,
        response: t("session.not_found", language),
        ephemeral: true,
      };
    }

    // Return that we're starting review - actual prompt sending
    // is handled by the platform adapter
    return {
      handled: true,
      response: t("session.starting_review", language),
      ephemeral: true,
    };
  }

  /**
   * Trigger a commit.
   * Note: Actual commit prompt is handled by the adapter layer.
   */
  private async handleCommitAction(
    sessionId: string,
    context: ActionContext,
  ): Promise<ActionResult> {
    const { language } = context;

    const session = await this.deps.getSession(sessionId);
    if (!session) {
      return {
        handled: true,
        response: t("session.not_found", language),
        ephemeral: true,
      };
    }

    // Return that we're starting commit - actual prompt sending
    // is handled by the platform adapter
    return {
      handled: true,
      response: t("session.committing", language),
      ephemeral: true,
    };
  }

  /**
   * Get run status for a cloud run.
   */
  private async handleRunStatusAction(
    runId: string,
    context: ActionContext,
  ): Promise<ActionResult> {
    const { language } = context;

    const status = await this.deps.getCloudRunStatus(runId);
    if (!status) {
      return {
        handled: true,
        response: t("run.not_found", language),
        ephemeral: true,
      };
    }

    return {
      handled: true,
      response: status.message ?? status.status,
      ephemeral: true,
    };
  }

  /**
   * Stop a sandbox (for WebSocket connections).
   */
  private async handleStopSandboxAction(
    sessionId: string,
    context: ActionContext,
  ): Promise<ActionResult> {
    const { language } = context;

    try {
      await this.deps.stopCloudSandbox(sessionId);
      return {
        handled: true,
        response: t("sandbox.stopped", language),
      };
    } catch (e) {
      this.logger.warn(
        `[orchestrator] stop sandbox failed session=${sessionId}: ${String(e)}`,
      );
      return {
        handled: true,
        error: t("sandbox.stop_failed", language, {
          error: redactText(e instanceof Error ? e.message : String(e)),
        }),
      };
    }
  }

  /**
   * Check if a session can accept new messages.
   * Used by adapters to determine routing.
   */
  isSessionBusy(session: SessionInfo): boolean {
    return session.status === "running" || session.status === "starting";
  }

  /**
   * Check if a session is in a terminal state.
   */
  isSessionTerminal(session: SessionInfo): boolean {
    return (
      session.status === "finished" ||
      session.status === "error" ||
      session.status === "killed"
    );
  }
}
