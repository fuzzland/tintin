import type { Logger } from '../log.js';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { CloudManager } from '../cloud/manager.js';
import type { WebSocketManager } from './manager.js';
import type { ClientMessage, WebSocketSection } from './types.js';
import { ErrorCodes } from './types.js';
import { verifyProxyToken } from '../cloud/proxy.js';
import { requireAuth } from './guards.js';
import { GitHubService, GitHubDisconnectService, SandboxLifecycleService } from './services/index.js';
import { listRunsForGroup } from '../cloud/runsQuery.js';
import { listCloudRunsForIdentity, getIdentity } from '../cloud/store.js';
import { WebSocketChatOrchestrator } from '../orchestrator/WebSocketChatOrchestrator.js';
import type { SessionManager } from '../sessionManager.js';

export class WebSocketHandler {
  private readonly githubService: GitHubService;
  private readonly githubDisconnectService: GitHubDisconnectService;
  readonly chatOrchestrator: WebSocketChatOrchestrator | null;
  readonly sandboxLifecycleService: SandboxLifecycleService | null;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly sessionManager: SessionManager,
    private readonly config: AppConfig,
    private readonly wsConfig: WebSocketSection,
    private readonly db: Db,
    private readonly logger: Logger,
    cloudManager: CloudManager | null = null,
  ) {
    this.githubService = new GitHubService(
      wsManager,
      config,
      db,
      logger,
    );

    this.githubDisconnectService = new GitHubDisconnectService(
      wsManager,
      config,
      db,
      logger,
      cloudManager,
    );

    // Initialize sandbox lifecycle service if cloud is enabled
    this.sandboxLifecycleService = cloudManager
      ? new SandboxLifecycleService(wsManager, cloudManager, db, logger)
      : null;

    this.chatOrchestrator = cloudManager
      ? new WebSocketChatOrchestrator({
          wsManager,
          logger,
          db,
          config,
          sessionManager,
          cloudManager,
          sandboxLifecycleService: this.sandboxLifecycleService,
        })
      : null;
  }

  async handleMessage(connId: string, message: ClientMessage): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn) return;

    switch (message.type) {
      case 'auth':
        await this.handleAuth(connId, message.token);
        break;

      case 'ping':
        // Already handled in manager
        break;

      case 'get_connections': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubService.handleGetConnections(connId, auth.identityId);
        break;
      }

      case 'list_repos': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubService.handleListRepos(connId, auth.identityId, {
          provider: message.provider,
          search: message.search,
        });
        break;
      }

      case 'get_auth_status': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubService.handleGetAuthStatus(connId, auth.identityId, message.provider);
        break;
      }

      case 'start_oauth': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubService.handleStartOAuth(connId, auth.identityId, message.provider);
        break;
      }

      case 'github_disconnect': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.githubDisconnectService.handleGitHubDisconnect(connId, auth.identityId, message);
        break;
      }

      case 'chat': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        if (!this.chatOrchestrator) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.SERVICE_ERROR,
            message: 'Cloud service not available',
          });
          return;
        }
        await this.chatOrchestrator.handleChat(connId, auth.conn, message);
        break;
      }

      case 'stop': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        if (!this.chatOrchestrator) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.SERVICE_ERROR,
            message: 'Cloud service not available',
          });
          return;
        }
        await this.chatOrchestrator.handleStop(connId, auth.conn, message);
        break;
      }

      case 'subscribe': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        if (!this.chatOrchestrator) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.SERVICE_ERROR,
            message: 'Cloud service not available',
          });
          return;
        }
        await this.chatOrchestrator.handleSubscribe(connId, auth.conn, message);
        break;
      }

      case 'list_runs': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.handleListRuns(connId, auth.identityId, message.limit);
        break;
      }

      default:
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.INVALID_MESSAGE,
          message: 'Unknown message type',
        });
    }
  }

  private async handleAuth(connId: string, token?: string): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn) return;

    // Phase 1: auth_enabled = false, skip token verification
    if (!this.wsConfig.auth_enabled) {
      // Create or get anonymous identity for WebSocket connections
      const identityId = `ws:anonymous:${connId.slice(0, 8)}`;

      if (!this.wsManager.setAuthenticated(connId, identityId)) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.RATE_LIMIT,
          message: 'Too many connections',
        });
        this.wsManager.closeConnection(connId, 4003, 'Too many connections');
        return;
      }

      this.wsManager.sendToConnection(connId, {
        type: 'auth_ok',
        identityId,
      });
      this.logger.debug(`[ws] auth ok (no-auth mode) id=${connId} identity=${identityId}`);

      // Provision sandbox after successful auth (async, non-blocking)
      if (this.sandboxLifecycleService) {
        void this.sandboxLifecycleService.provisionSandbox(connId, identityId);
      }
      return;
    }

    // Phase 2: Token verification (when auth_enabled = true)
    if (!token) {
      this.wsManager.sendToConnection(connId, {
        type: 'auth_error',
        message: 'Token required',
      });
      this.wsManager.closeConnection(connId, 4001, 'Token required');
      return;
    }

    // Use cloud.proxy.shared_secret to verify token
    const secret = this.config.cloud?.proxy?.shared_secret;
    if (!secret) {
      this.logger.warn(`[ws] auth failed id=${connId}: shared_secret not configured`);
      this.wsManager.sendToConnection(connId, {
        type: 'auth_error',
        message: 'Auth not configured',
      });
      this.wsManager.closeConnection(connId, 4001, 'Auth not configured');
      return;
    }

    const verified = verifyProxyToken(secret, token);
    if (!verified) {
      this.logger.warn(`[ws] auth failed id=${connId}: invalid token`);
      this.wsManager.sendToConnection(connId, {
        type: 'auth_error',
        message: 'Invalid token',
      });
      this.wsManager.closeConnection(connId, 4001, 'Invalid token');
      return;
    }

    if (!this.wsManager.setAuthenticated(connId, verified.identityId)) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.RATE_LIMIT,
        message: 'Too many connections',
      });
      this.wsManager.closeConnection(connId, 4003, 'Too many connections');
      return;
    }

    this.wsManager.sendToConnection(connId, {
      type: 'auth_ok',
      identityId: verified.identityId,
    });
    this.logger.debug(`[ws] auth ok id=${connId} identity=${verified.identityId}`);

    // Provision sandbox after successful auth (async, non-blocking)
    if (this.sandboxLifecycleService) {
      void this.sandboxLifecycleService.provisionSandbox(connId, verified.identityId);
    }
  }

  private async handleListRuns(connId: string, identityId: string, limit?: number): Promise<void> {
    try {
      // Get the identity to check for group_id
      const identity = await getIdentity(this.db, {
        platform: 'websocket',
        workspaceId: null,
        userId: identityId,
      });

      const effectiveLimit = limit ?? 5;

      if (identity?.group_id) {
        // User is in a group - show runs from all platforms
        const runs = await listRunsForGroup(this.db, identity.group_id, effectiveLimit);
        this.wsManager.sendToConnection(connId, {
          type: 'runs_list',
          runs: runs.map(r => ({
            id: r.id,
            status: r.status,
            prompt: r.prompt,
            platform: r.platform,
            diffSummary: r.diffSummary,
            createdAt: r.createdAt,
          })),
        });
      } else {
        // User not linked to a group - show their own runs
        const runs = await listCloudRunsForIdentity(this.db, { identityId, limit: effectiveLimit });
        this.wsManager.sendToConnection(connId, {
          type: 'runs_list',
          runs: runs.map(r => ({
            id: r.id,
            status: r.status,
            prompt: r.prompt,
            platform: 'websocket',
            diffSummary: r.diff_summary ?? null,
            createdAt: r.created_at,
          })),
        });
      }
    } catch (e) {
      this.logger.error(`[ws] handleListRuns error connId=${connId}: ${String(e)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: 'Failed to list runs',
      });
    }
  }
}
