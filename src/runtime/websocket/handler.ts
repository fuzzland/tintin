import type { Logger } from '../log.js';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { SessionManager } from '../sessionManager.js';
import type { WebSocketManager } from './manager.js';
import type { ClientMessage, WebSocketSection } from './types.js';
import { ErrorCodes } from './types.js';
import { verifyProxyToken } from '../cloud/proxy.js';
import { requireAuth, requireSessionId } from './guards.js';
import { SessionService, GitHubService } from './services/index.js';

export class WebSocketHandler {
  private readonly sessionService: SessionService;
  private readonly githubService: GitHubService;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly sessionManager: SessionManager,
    private readonly config: AppConfig,
    private readonly wsConfig: WebSocketSection,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {
    this.sessionService = new SessionService(
      wsManager,
      sessionManager,
      config,
      db,
      logger,
    );
    this.githubService = new GitHubService(
      wsManager,
      config,
      db,
      logger,
    );
  }

  async handleMessage(connId: string, message: ClientMessage): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn) return;

    switch (message.type) {
      case 'auth':
        await this.handleAuth(connId, message.token);
        break;

      case 'chat': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        await this.sessionService.handleChat(connId, auth.conn, message);
        break;
      }

      case 'stop': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        if (!requireSessionId(this.wsManager, connId, message.sessionId)) return;
        await this.sessionService.handleStop(connId, auth.conn, message.sessionId);
        break;
      }

      case 'subscribe': {
        const auth = requireAuth(this.wsManager, connId);
        if (!auth) return;
        if (!requireSessionId(this.wsManager, connId, message.sessionId)) return;
        await this.sessionService.handleSubscribe(connId, message.sessionId);
        break;
      }

      case 'unsubscribe': {
        if (!message.sessionId) return;
        this.sessionService.handleUnsubscribe(connId, message.sessionId);
        break;
      }

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
  }
}
