/**
 * WebSocketChatOrchestrator - WebSocket chat/stop/subscribe handling.
 *
 * Migrates WebSocket chat logic into Adapter + Orchestrator path while
 * keeping WebSocketHandler as a thin router for auth and GitHub flows.
 */

import crypto from "node:crypto";
import type { Logger } from "../log.js";
import type { Db } from "../db.js";
import type { AppConfig } from "../config.js";
import type { SessionManager } from "../sessionManager.js";
import type { CloudManager } from "../cloud/manager.js";
import type { WebSocketManager } from "../websocket/manager.js";
import type { ChatMessage, StopMessage, SubscribeMessage, WSConnection } from "../websocket/types.js";
import { ErrorCodes } from "../websocket/types.js";
import { IdentityResolver } from "../shared/IdentityResolver.js";
import type { SandboxLifecycleService } from "../websocket/services/sandboxLifecycle.js";
import {
  getLatestSessionForChat,
  enqueuePendingMessage,
  countPendingMessages,
  type SessionRow,
} from "../store.js";
import { listReposForIdentity, getCloudRunBySession } from "../cloud/store.js";
import { mapDbStatusToWsStatus } from "../cloud/types.js";
import { WebSocketAdapter } from "../adapters/WebSocketAdapter.js";
import { SessionOrchestrator } from "./SessionOrchestrator.js";
import type { OrchestratorDeps, SessionInfo } from "./types.js";

export interface WebSocketChatOrchestratorDeps {
  wsManager: WebSocketManager;
  logger: Logger;
  db: Db;
  config: AppConfig;
  sessionManager: SessionManager;
  cloudManager: CloudManager | null;
  sandboxLifecycleService: SandboxLifecycleService | null;
}

export class WebSocketChatOrchestrator {
  private readonly adapter: WebSocketAdapter;
  private readonly identityResolver: IdentityResolver;
  private readonly sessionOrchestrator: SessionOrchestrator;

  constructor(private readonly deps: WebSocketChatOrchestratorDeps) {
    this.adapter = new WebSocketAdapter({ wsManager: deps.wsManager, logger: deps.logger });
    this.identityResolver = new IdentityResolver(deps.db);
    this.sessionOrchestrator = new SessionOrchestrator(this.buildOrchestratorDeps(), deps.logger);
  }

  async handleChat(connId: string, conn: WSConnection, message: ChatMessage): Promise<void> {
    const cloudManager = this.deps.cloudManager;
    if (!cloudManager) {
      this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, "Cloud service not available");
      return;
    }

    const { chatId, prompt } = message;
    if (!chatId) {
      this.adapter.sendError(connId, ErrorCodes.INVALID_MESSAGE, "chatId is required");
      return;
    }

    const trimmedPrompt = prompt?.trim() ?? "";
    if (!trimmedPrompt) {
      this.adapter.sendError(connId, ErrorCodes.INVALID_MESSAGE, "prompt is required");
      return;
    }

    try {
      const mode = message.mode ?? "queue";
      if (this.deps.sandboxLifecycleService) {
        const { status, error } = this.deps.sandboxLifecycleService.getSandboxStatus(connId);
        if (status === "provisioning") {
          this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, "Sandbox is still provisioning");
          return;
        }
        if (status === "in_use" && mode !== "interrupt") {
          this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, "Sandbox is in use. Stop current run first.");
          return;
        }
        if (status === "error") {
          this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, `Sandbox error: ${error ?? "Unknown"}`);
          return;
        }
        if (status === "terminating") {
          this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, "Sandbox is terminating");
          return;
        }
      }

      const activeSession = await this.findActiveSession(chatId);
      const ctx = this.buildMessageContext(connId, conn, chatId);

      if (activeSession) {
        if (mode === "interrupt") {
          const stopped = await this.stopActiveSessionForChat(connId, conn, chatId);
          if (!stopped) return;
          await this.startNewSession(connId, conn, message, ctx);
          return;
        }
        this.adapter.subscribeToSession(connId, activeSession.id);
        const request = this.adapter.toChatRequest(ctx, trimmedPrompt);
        const result = await this.sessionOrchestrator.handleSessionMessage(this.toSessionInfo(activeSession), request);
        await this.adapter.sendResponse(ctx, result);
        return;
      }

      await this.startNewSession(connId, conn, message, ctx);
    } catch (err) {
      this.deps.logger.error(`[ws][chat] handleChat error connId=${connId}: ${String(err)}`);
      this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, `Failed to process chat: ${String(err)}`);
    }
  }

  async handleStop(connId: string, conn: WSConnection, message: StopMessage): Promise<void> {
    const { chatId } = message;
    if (!chatId) {
      this.adapter.sendError(connId, ErrorCodes.INVALID_MESSAGE, "chatId is required");
      return;
    }

    try {
      await this.stopActiveSessionForChat(connId, conn, chatId);
    } catch (err) {
      this.deps.logger.error(`[ws][chat] handleStop error connId=${connId}: ${String(err)}`);
      this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, `Failed to stop: ${String(err)}`);
    }
  }

  async handleSubscribe(connId: string, _conn: WSConnection, message: SubscribeMessage): Promise<void> {
    const { chatId } = message;
    if (!chatId) {
      this.adapter.sendError(connId, ErrorCodes.INVALID_MESSAGE, "chatId is required");
      return;
    }

    try {
      const session = await this.findActiveSession(chatId);
      if (!session) {
        this.adapter.sendError(connId, ErrorCodes.SESSION_NOT_FOUND, "No active session for this chat");
        return;
      }

      this.adapter.subscribeToSession(connId, session.id);

      const run = await this.deps.db
        .selectFrom("cloud_runs")
        .selectAll()
        .where("session_id", "=", session.id)
        .executeTakeFirst();

      if (run) {
        this.deps.wsManager.sendToConnection(connId, {
          type: "run_status",
          chatId,
          status: mapDbStatusToWsStatus(run.status),
        });
      }

      this.deps.logger.debug(`[ws][chat] subscribed chatId=${chatId} sessionId=${session.id}`);
    } catch (err) {
      this.deps.logger.error(`[ws][chat] handleSubscribe error connId=${connId}: ${String(err)}`);
      this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, `Failed to subscribe: ${String(err)}`);
    }
  }

  cleanupConnection(_connId: string): void {
    // Reserved for future cleanups.
  }

  private buildMessageContext(connId: string, conn: WSConnection, chatId: string) {
    return {
      platform: "websocket" as const,
      chatId,
      userId: conn.identityId ?? "",
      language: "en" as const,
      connId,
    };
  }

  private async startNewSession(
    connId: string,
    conn: WSConnection,
    message: ChatMessage,
    ctx: ReturnType<WebSocketChatOrchestrator["buildMessageContext"]>,
  ): Promise<void> {
    const cloudManager = this.deps.cloudManager;
    if (!cloudManager) return;

    const { chatId, repoIds = [], agent: requestedAgent, restoreSnapshotId } = message;
    const dbIdentityId = await this.identityResolver.resolveWebSocket(conn.identityId!);
    const isPlayground = repoIds.length === 0;

    if (!isPlayground) {
      const accessible = await this.validateRepoAccess(dbIdentityId, repoIds);
      if (!accessible) {
        this.adapter.sendError(connId, ErrorCodes.ACCESS_DENIED, "No access to specified repositories");
        return;
      }
    }

    const finishedSession = await this.findFinishedSession(chatId);
    let snapshotId = restoreSnapshotId ?? null;

    if (!snapshotId && finishedSession) {
      snapshotId = await cloudManager.detectLatestSnapshot({
        identityId: dbIdentityId,
        lastRunId: null,
      });
      if (snapshotId) {
        this.deps.logger.info(`[ws][chat] auto-restore snapshot=${snapshotId} chatId=${chatId}`);
      }
    }

    const agent =
      requestedAgent ?? (this.deps.config.cloud?.default_agent === "claude_code" ? "claude_code" : "codex");

    this.adapter.sendRunStatus(
      connId,
      chatId,
      "preparing",
      isPlayground ? "Starting playground session" : "Preparing cloud sandbox",
    );

    const spaceId = `${Date.now()}`;
    let sessionId: string;
    let cdpUrl: string | null;

    const sandbox = this.deps.sandboxLifecycleService?.getSandbox(connId);

    if (sandbox) {
      const result = await cloudManager.startRunWithWorkspace({
        workspace: { id: sandbox.workspaceId, rootPath: sandbox.rootPath },
        identityId: dbIdentityId,
        platform: "websocket",
        workspaceId: null,
        chatId,
        spaceId,
        userId: conn.identityId!,
        prompt: message.prompt.trim(),
        repoIds,
        agent,
        playground: isPlayground,
        restoreSnapshotId: snapshotId,
      });
      sessionId = result.sessionId;
      cdpUrl = result.cdpUrl;
      this.deps.sandboxLifecycleService!.markInUse(connId, sessionId);
    } else {
      const result = await cloudManager.startRun({
        identityId: dbIdentityId,
        platform: "websocket",
        workspaceId: null,
        chatId,
        spaceId,
        userId: conn.identityId!,
        prompt: message.prompt.trim(),
        repoIds,
        agent,
        playground: isPlayground,
        restoreSnapshotId: snapshotId,
      });
      sessionId = result.sessionId;
      cdpUrl = result.cdpUrl;
    }

    this.adapter.subscribeToSession(connId, sessionId);

    if (cdpUrl) {
      const liveViewUrl = cloudManager.getLiveViewUrl(sessionId);
      this.adapter.sendBrowserSession(connId, sessionId, cdpUrl, liveViewUrl ?? undefined);
    }

    this.deps.logger.info(`[ws][chat] session started chatId=${chatId} sessionId=${sessionId} agent=${agent}`);
  }

  private async validateRepoAccess(identityId: string, repoIds: string[]): Promise<boolean> {
    if (repoIds.length === 0) return true;
    const accessibleRepos = await listReposForIdentity(this.deps.db, identityId);
    const accessibleIds = new Set(accessibleRepos.map((r) => r.id));
    return repoIds.every((id) => accessibleIds.has(id));
  }

  private async stopActiveSessionForChat(connId: string, conn: WSConnection, chatId: string): Promise<boolean> {
    const cloudManager = this.deps.cloudManager;
    if (!cloudManager) {
      this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, "Cloud service not available");
      return false;
    }

    const session = await this.findActiveSession(chatId);
    if (!session) {
      this.adapter.sendError(connId, ErrorCodes.SESSION_NOT_FOUND, "No active session for this chat");
      return false;
    }

    const dbIdentityId = await this.identityResolver.resolveWebSocket(conn.identityId!);
    const run = await this.deps.db
      .selectFrom("cloud_runs")
      .select(["identity_id"])
      .where("session_id", "=", session.id)
      .executeTakeFirst();

    if (run && run.identity_id !== dbIdentityId) {
      this.adapter.sendError(connId, ErrorCodes.ACCESS_DENIED, "You do not have access to this session");
      return false;
    }

    const cloudRun = await getCloudRunBySession(this.deps.db, session.id);
    if (!cloudRun) {
      this.adapter.sendError(connId, ErrorCodes.SESSION_NOT_FOUND, "Run not found");
      return false;
    }

    const stopped = await cloudManager.stopCloudRun(cloudRun.id);
    if (!stopped) {
      this.adapter.sendError(connId, ErrorCodes.SERVICE_ERROR, "Failed to stop run");
      return false;
    }

    if (this.deps.sandboxLifecycleService) {
      this.deps.sandboxLifecycleService.markReady(connId);
    }

    this.deps.wsManager.broadcastToSession(session.id, {
      type: "done",
      chatId,
      stopped: true,
    });

    this.deps.logger.info(`[ws][chat] stopped chatId=${chatId} sessionId=${session.id}`);
    return true;
  }

  private async findActiveSession(chatId: string): Promise<SessionRow | undefined> {
    return getLatestSessionForChat(this.deps.db, "websocket", chatId, ["starting", "running"]);
  }

  private async findFinishedSession(chatId: string): Promise<SessionRow | undefined> {
    return getLatestSessionForChat(this.deps.db, "websocket", chatId, ["finished", "error"]);
  }

  private toSessionInfo(session: SessionRow): SessionInfo {
    return {
      id: session.id,
      status: session.status as SessionInfo["status"],
      platform: session.platform as SessionInfo["platform"],
      chatId: session.chat_id,
      createdByUserId: session.created_by_user_id,
      workspaceId: session.workspace_id ?? null,
      spaceId: session.space_id ?? null,
      language: session.language ?? null,
    };
  }

  private buildOrchestratorDeps(): OrchestratorDeps {
    const { db, cloudManager, sessionManager } = this.deps;

    return {
      enqueueMessage: async (sessionId, userId, text) => {
        await enqueuePendingMessage(db, {
          id: crypto.randomUUID(),
          session_id: sessionId,
          user_id: userId,
          message_text: text,
        });
      },
      countPendingMessages: async (sessionId) => {
        return countPendingMessages(db, sessionId);
      },
      resumeCloudSession: async (session, prompt) => {
        if (!cloudManager) return "not_found";
        const sessionRow = await db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", session.id)
          .executeTakeFirst();
        if (!sessionRow) return "not_found";
        try {
          const result = await cloudManager.resumeCloudSession(sessionRow as any, prompt);
          if (result === "not_cloud") return "not_found";
          return result as "resumed" | "expired";
        } catch {
          return "error";
        }
      },
      restartCloudSession: async (session, prompt) => {
        if (!cloudManager) return "failed";
        const sessionRow = await db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", session.id)
          .executeTakeFirst();
        if (!sessionRow) return "failed";
        try {
          const result = await cloudManager.restartCloudSession(sessionRow as any, prompt);
          if (result === "not_cloud") return "failed";
          return result as "restarted";
        } catch {
          return "failed";
        }
      },
      resumeLocalSession: async (session, prompt) => {
        const sessionRow = await db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", session.id)
          .executeTakeFirst();
        if (!sessionRow) return;
        await sessionManager.resumeSession(sessionRow as any, prompt);
      },
      isCloudSession: async (session) => {
        const run = await getCloudRunBySession(db, session.id);
        return !!run;
      },
      stopCloudSandbox: async (sessionId) => {
        if (!cloudManager) return;
        await cloudManager.stopSandboxForSession(sessionId);
      },
      killLocalSession: async (sessionId, reason) => {
        await sessionManager.killSession(sessionId, reason);
      },
      getSession: async (sessionId) => {
        const row = await db
          .selectFrom("sessions")
          .selectAll()
          .where("id", "=", sessionId)
          .executeTakeFirst();
        if (!row) return null;
        return {
          id: row.id,
          status: row.status as any,
          platform: row.platform as any,
          chatId: row.chat_id,
          createdByUserId: row.created_by_user_id,
          workspaceId: row.workspace_id ?? null,
          spaceId: row.space_id ?? null,
          language: row.language as any,
        };
      },
      getCloudRunStatus: async (runId) => {
        if (!cloudManager) return null;
        const run = await db
          .selectFrom("cloud_runs")
          .select(["status"])
          .where("id", "=", runId)
          .executeTakeFirst();
        if (!run) return null;
        return { status: run.status };
      },
    };
  }
}
