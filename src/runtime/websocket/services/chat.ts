import type { Logger } from '../../log.js';
import type { Db } from '../../db.js';
import type { AppConfig } from '../../config.js';
import type { CloudManager } from '../../cloud/manager.js';
import type { WebSocketManager } from '../manager.js';
import type { ChatMessage, StopMessage, SubscribeMessage, WSConnection } from '../types.js';
import { ErrorCodes } from '../types.js';
import { IdentityResolver } from '../../shared/IdentityResolver.js';
import type { SandboxLifecycleService } from './sandboxLifecycle.js';
import { getLatestSessionForChat, type SessionRow } from '../../store.js';
import { listReposForIdentity, getCloudRunBySession } from '../../cloud/store.js';
import { mapDbStatusToWsStatus } from '../../cloud/types.js';

/**
 * ChatService - Handles WebSocket chat messages.
 * Unified handler for chat, stop, and subscribe operations.
 * Follows TG model: route by chatId, client manages chat history.
 */
export class ChatService {
  private readonly identityResolver: IdentityResolver;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly cloudManager: CloudManager,
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly sandboxService: SandboxLifecycleService | null = null,
  ) {
    this.identityResolver = new IdentityResolver(db);
  }

  /** Helper: send error message */
  private sendError(connId: string, code: string, message: string): void {
    this.wsManager.sendToConnection(connId, { type: 'error', code, message });
  }

  /** Helper: find active session for chatId */
  private async findActiveSession(chatId: string): Promise<SessionRow | undefined> {
    return getLatestSessionForChat(this.db, 'websocket', chatId, ['starting', 'running']);
  }

  /** Helper: find finished session for chatId */
  private async findFinishedSession(chatId: string): Promise<SessionRow | undefined> {
    return getLatestSessionForChat(this.db, 'websocket', chatId, ['finished', 'error']);
  }

  /**
   * Handle a chat message.
   * If active session exists: send follow-up
   * If no active session: create new or resume from snapshot
   */
  async handleChat(
    connId: string,
    conn: WSConnection,
    message: ChatMessage,
  ): Promise<void> {
    const { chatId, prompt } = message;

    if (!chatId) {
      return this.sendError(connId, ErrorCodes.INVALID_MESSAGE, 'chatId is required');
    }

    if (!prompt?.trim()) {
      return this.sendError(connId, ErrorCodes.INVALID_MESSAGE, 'prompt is required');
    }

    try {
      // Check sandbox status if sandboxService is available
      if (this.sandboxService) {
        const { status, error } = this.sandboxService.getSandboxStatus(connId);
        if (status === 'provisioning') {
          return this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Sandbox is still provisioning');
        }
        if (status === 'in_use') {
          return this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Sandbox is in use. Stop current run first.');
        }
        if (status === 'error') {
          return this.sendError(connId, ErrorCodes.SERVICE_ERROR, `Sandbox error: ${error ?? 'Unknown'}`);
        }
        if (status === 'terminating') {
          return this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Sandbox is terminating');
        }
      }

      // Find active session for this chatId
      const activeSession = await this.findActiveSession(chatId);

      if (activeSession) {
        // Send follow-up to existing session
        await this.sendFollowUp(connId, chatId, activeSession, prompt.trim());
      } else {
        // No active session - start new or resume
        await this.startOrResumeSession(connId, conn, message);
      }
    } catch (err) {
      this.logger.error(`[ws][chat] handleChat error connId=${connId}: ${String(err)}`);
      this.sendError(connId, ErrorCodes.SERVICE_ERROR, `Failed to process chat: ${String(err)}`);
    }
  }

  private async sendFollowUp(
    connId: string,
    chatId: string,
    session: SessionRow,
    prompt: string,
  ): Promise<void> {
    // Subscribe to session
    this.wsManager.subscribeToSession(connId, session.id);

    // Resume or queue the prompt
    const resumed = await this.cloudManager.resumeCloudSession(session, prompt);

    if (resumed === 'resumed') {
      this.logger.info(`[ws][chat] follow-up sent chatId=${chatId} sessionId=${session.id}`);
      if (this.sandboxService) {
        this.sandboxService.markInUse(connId, session.id);
      }
    } else {
      // Session not resumable, need to restart
      this.logger.info(`[ws][chat] session not resumable, restarting chatId=${chatId}`);
      const restarted = await this.cloudManager.restartCloudSession(session, prompt);
      if (restarted !== 'restarted') {
        this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Failed to resume or restart session');
      }
    }
  }

  private async startOrResumeSession(
    connId: string,
    conn: WSConnection,
    message: ChatMessage,
  ): Promise<void> {
    const { chatId, prompt, repoIds = [], agent: requestedAgent, restoreSnapshotId } = message;
    const dbIdentityId = await this.identityResolver.resolveWebSocket(conn.identityId!);
    const isPlayground = repoIds.length === 0;

    // Validate repo access
    if (!isPlayground) {
      const accessible = await this.validateRepoAccess(dbIdentityId, repoIds);
      if (!accessible) {
        return this.sendError(connId, ErrorCodes.ACCESS_DENIED, 'No access to specified repositories');
      }
    }

    // Check for finished session to resume
    const finishedSession = await this.findFinishedSession(chatId);
    let snapshotId = restoreSnapshotId ?? null;

    if (!snapshotId && finishedSession) {
      snapshotId = await this.cloudManager.detectLatestSnapshot({
        identityId: dbIdentityId,
        lastRunId: null,
      });
      if (snapshotId) {
        this.logger.info(`[ws][chat] auto-restore snapshot=${snapshotId} chatId=${chatId}`);
      }
    }

    // Determine agent
    const agent = requestedAgent ?? (this.config.cloud?.default_agent === 'claude_code' ? 'claude_code' : 'codex');

    // Send initial status
    this.wsManager.sendToConnection(connId, {
      type: 'run_status',
      chatId,
      status: 'preparing',
      message: isPlayground ? 'Starting playground session' : 'Preparing cloud sandbox',
    });

    const spaceId = `${Date.now()}`;
    let sessionId: string;
    let cdpUrl: string | null;

    // Check for existing sandbox
    const sandbox = this.sandboxService?.getSandbox(connId);

    if (sandbox) {
      const result = await this.cloudManager.startRunWithWorkspace({
        workspace: { id: sandbox.workspaceId, rootPath: sandbox.rootPath },
        identityId: dbIdentityId,
        platform: 'websocket',
        workspaceId: null,
        chatId,
        spaceId,
        userId: conn.identityId!,
        prompt: prompt.trim(),
        repoIds,
        agent,
        playground: isPlayground,
        restoreSnapshotId: snapshotId,
      });
      sessionId = result.sessionId;
      cdpUrl = result.cdpUrl;
      this.sandboxService!.markInUse(connId, sessionId);
    } else {
      const result = await this.cloudManager.startRun({
        identityId: dbIdentityId,
        platform: 'websocket',
        workspaceId: null,
        chatId,
        spaceId,
        userId: conn.identityId!,
        prompt: prompt.trim(),
        repoIds,
        agent,
        playground: isPlayground,
        restoreSnapshotId: snapshotId,
      });
      sessionId = result.sessionId;
      cdpUrl = result.cdpUrl;
    }

    // Subscribe to session for streaming updates
    this.wsManager.subscribeToSession(connId, sessionId);

    // Send browser session if available
    if (cdpUrl) {
      const liveViewUrl = this.cloudManager.getLiveViewUrl(sessionId);
      this.wsManager.sendToConnection(connId, {
        type: 'browser_session',
        sessionId,
        cdpUrl,
        liveViewUrl: liveViewUrl ?? undefined,
        provider: 'hyperbrowser',
      });
    }

    this.logger.info(`[ws][chat] session started chatId=${chatId} sessionId=${sessionId} agent=${agent}`);
  }

  private async validateRepoAccess(identityId: string, repoIds: string[]): Promise<boolean> {
    if (repoIds.length === 0) return true;
    const accessibleRepos = await listReposForIdentity(this.db, identityId);
    const accessibleIds = new Set(accessibleRepos.map((r) => r.id));
    return repoIds.every((id) => accessibleIds.has(id));
  }

  /**
   * Handle stop message.
   * Stops the active session for the given chatId.
   */
  async handleStop(
    connId: string,
    conn: WSConnection,
    message: StopMessage,
  ): Promise<void> {
    const { chatId } = message;

    if (!chatId) {
      return this.sendError(connId, ErrorCodes.INVALID_MESSAGE, 'chatId is required');
    }

    try {
      const session = await this.findActiveSession(chatId);
      if (!session) {
        return this.sendError(connId, ErrorCodes.SESSION_NOT_FOUND, 'No active session for this chat');
      }

      // Validate ownership
      const dbIdentityId = await this.identityResolver.resolveWebSocket(conn.identityId!);
      const run = await this.db
        .selectFrom('cloud_runs')
        .select(['identity_id'])
        .where('session_id', '=', session.id)
        .executeTakeFirst();

      if (run && run.identity_id !== dbIdentityId) {
        return this.sendError(connId, ErrorCodes.ACCESS_DENIED, 'You do not have access to this session');
      }

      // Find runId for stopping
      const cloudRun = await getCloudRunBySession(this.db, session.id);
      if (!cloudRun) {
        return this.sendError(connId, ErrorCodes.SESSION_NOT_FOUND, 'Run not found');
      }

      const stopped = await this.cloudManager.stopCloudRun(cloudRun.id);
      if (!stopped) {
        return this.sendError(connId, ErrorCodes.SERVICE_ERROR, 'Failed to stop run');
      }

      if (this.sandboxService) {
        this.sandboxService.markReady(connId);
      }

      this.wsManager.broadcastToSession(session.id, {
        type: 'done',
        chatId,
        stopped: true,
      });

      this.logger.info(`[ws][chat] stopped chatId=${chatId} sessionId=${session.id}`);
    } catch (err) {
      this.logger.error(`[ws][chat] handleStop error connId=${connId}: ${String(err)}`);
      this.sendError(connId, ErrorCodes.SERVICE_ERROR, `Failed to stop: ${String(err)}`);
    }
  }

  /**
   * Handle subscribe message.
   * Subscribes to the active session for the given chatId.
   */
  async handleSubscribe(
    connId: string,
    conn: WSConnection,
    message: SubscribeMessage,
  ): Promise<void> {
    const { chatId } = message;

    if (!chatId) {
      return this.sendError(connId, ErrorCodes.INVALID_MESSAGE, 'chatId is required');
    }

    try {
      const session = await this.findActiveSession(chatId);
      if (!session) {
        return this.sendError(connId, ErrorCodes.SESSION_NOT_FOUND, 'No active session for this chat');
      }

      // Subscribe to the session
      this.wsManager.subscribeToSession(connId, session.id);

      // Get run for status
      const run = await this.db
        .selectFrom('cloud_runs')
        .selectAll()
        .where('session_id', '=', session.id)
        .executeTakeFirst();

      if (run) {
        this.wsManager.sendToConnection(connId, {
          type: 'run_status',
          chatId,
          status: mapDbStatusToWsStatus(run.status),
        });
      }

      this.logger.debug(`[ws][chat] subscribed chatId=${chatId} sessionId=${session.id}`);
    } catch (err) {
      this.logger.error(`[ws][chat] handleSubscribe error connId=${connId}: ${String(err)}`);
      this.sendError(connId, ErrorCodes.SERVICE_ERROR, `Failed to subscribe: ${String(err)}`);
    }
  }

  /**
   * Clean up resources for a disconnected connection.
   */
  cleanupConnection(_connId: string): void {
    // Future: clean up any pending queues, etc.
  }
}
