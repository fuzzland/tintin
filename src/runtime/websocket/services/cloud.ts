import type { Logger } from '../../log.js';
import type { Db } from '../../db.js';
import type { AppConfig } from '../../config.js';
import type { CloudManager } from '../../cloud/manager.js';
import type { WebSocketManager } from '../manager.js';
import type { CloudRunMessage, WSConnection } from '../types.js';
import { ErrorCodes } from '../types.js';
import { IdentityResolver } from './identity.js';
import { CloudLinkBuilder } from './linkBuilder.js';
import { listReposForIdentity, getCloudRun } from '../../cloud/store.js';

/**
 * CloudRunService - Handles WebSocket cloud run requests.
 * Follows SRP: Only responsible for cloud run creation and subscription.
 * Follows DIP: All dependencies injected via constructor.
 */
export class CloudRunService {
  private readonly identityResolver: IdentityResolver;
  private readonly linkBuilder: CloudLinkBuilder;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly cloudManager: CloudManager,
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {
    this.identityResolver = new IdentityResolver(db);
    this.linkBuilder = new CloudLinkBuilder(config);
  }

  async handleCloudRun(
    connId: string,
    conn: WSConnection,
    message: CloudRunMessage,
  ): Promise<void> {
    const prompt = message.prompt?.trim();
    if (!prompt) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Prompt is required',
      });
      return;
    }

    try {
      const dbIdentityId = await this.identityResolver.resolve(conn.identityId!);
      const repoIds = message.repoIds ?? [];
      const isPlayground = repoIds.length === 0;

      // Validate repo access if repos specified
      if (!isPlayground) {
        const accessible = await this.validateRepoAccess(dbIdentityId, repoIds);
        if (!accessible) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.ACCESS_DENIED,
            message: 'You do not have access to one or more specified repositories',
          });
          return;
        }
      }

      // Determine agent
      const agent = message.agent ?? (this.config.cloud?.default_agent === 'claude_code' ? 'claude_code' : 'codex');

      // Send initial status
      this.wsManager.sendToConnection(connId, {
        type: 'run_status',
        runId: '', // Will be updated after run creation
        status: 'preparing',
        message: isPlayground ? 'Starting playground session' : 'Preparing cloud sandbox',
      });

      // Build virtual chat/space IDs for WebSocket
      const virtualChatId = `ws:${conn.identityId}`;
      const virtualSpaceId = `${Date.now()}`;

      // Start cloud run
      const { runId, sessionId } = await this.cloudManager.startRun({
        identityId: dbIdentityId,
        platform: 'websocket',
        workspaceId: null,
        chatId: virtualChatId,
        spaceId: virtualSpaceId,
        userId: conn.identityId!,
        prompt,
        repoIds,
        agent,
        playground: isPlayground,
        restoreSnapshotId: message.restoreSnapshotId ?? null,
      });

      // Subscribe connection to session
      this.wsManager.subscribeToSession(connId, sessionId);

      // Send session started message
      this.wsManager.sendToConnection(connId, {
        type: 'session_started',
        sessionId,
        runId,
      });

      // Send run links
      const viewUrl = this.linkBuilder.buildViewUrl(runId);
      this.wsManager.sendToConnection(connId, {
        type: 'run_links',
        runId,
        sessionId,
        viewUrl,
        // vscodeUrl will be sent later when available via cloud manager
      });

      this.logger.info(
        `[ws][cloud] run started connId=${connId} runId=${runId} sessionId=${sessionId} repos=${repoIds.length} agent=${agent}`,
      );
    } catch (err) {
      this.logger.error(`[ws][cloud] handleCloudRun error connId=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to start cloud run: ${String(err)}`,
      });
    }
  }

  async handleSubscribeRun(connId: string, runId: string): Promise<void> {
    try {
      const run = await getCloudRun(this.db, runId);
      if (!run) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SESSION_NOT_FOUND,
          message: 'Run not found',
        });
        return;
      }

      const sessionId = run.session_id;
      if (!sessionId) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SESSION_NOT_FOUND,
          message: 'Run has no associated session',
        });
        return;
      }

      // Subscribe to the session
      this.wsManager.subscribeToSession(connId, sessionId);

      // Send current run status
      this.wsManager.sendToConnection(connId, {
        type: 'run_status',
        runId,
        status: this.mapRunStatus(run.status),
      });

      // Send run links
      const viewUrl = this.linkBuilder.buildViewUrl(runId);
      this.wsManager.sendToConnection(connId, {
        type: 'run_links',
        runId,
        sessionId,
        viewUrl,
      });

      this.logger.debug(`[ws][cloud] subscribed to run connId=${connId} runId=${runId} sessionId=${sessionId}`);
    } catch (err) {
      this.logger.error(`[ws][cloud] handleSubscribeRun error connId=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to subscribe to run: ${String(err)}`,
      });
    }
  }

  /**
   * Validate that the identity has access to all specified repos.
   */
  private async validateRepoAccess(identityId: string, repoIds: string[]): Promise<boolean> {
    if (repoIds.length === 0) return true;

    const accessibleRepos = await listReposForIdentity(this.db, identityId);
    const accessibleIds = new Set(accessibleRepos.map((r) => r.id));

    for (const repoId of repoIds) {
      if (!accessibleIds.has(repoId)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Map database run status to WebSocket CloudRunStatus.
   */
  private mapRunStatus(dbStatus: string): 'queued' | 'preparing' | 'cloning' | 'setting_up' | 'running' | 'finished' | 'error' {
    switch (dbStatus) {
      case 'queued':
        return 'queued';
      case 'running':
        return 'running';
      case 'finished':
        return 'finished';
      case 'error':
      case 'killed':
        return 'error';
      default:
        return 'preparing';
    }
  }
}
