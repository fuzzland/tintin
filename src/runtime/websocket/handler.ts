import type { Logger } from '../log.js';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { SessionManager } from '../sessionManager.js';
import type { WebSocketManager } from './manager.js';
import type { ClientMessage, WebSocketSection } from './types.js';
import { ErrorCodes } from './types.js';
import type { SessionRow } from '../store.js';

export class WebSocketHandler {
  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly sessionManager: SessionManager,
    private readonly config: AppConfig,
    private readonly wsConfig: WebSocketSection,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  async handleMessage(connId: string, message: ClientMessage): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn) return;

    switch (message.type) {
      case 'auth':
        await this.handleAuth(connId, message.token);
        break;
      case 'chat':
        await this.handleChat(connId, message);
        break;
      case 'stop':
        await this.handleStop(connId, message.sessionId);
        break;
      case 'subscribe':
        await this.handleSubscribe(connId, message.sessionId);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(connId, message.sessionId);
        break;
      case 'ping':
        // Already handled in manager
        break;
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

    try {
      // TODO: Implement token verification in Phase 2
      // For now, reject if auth is enabled but no implementation
      this.wsManager.sendToConnection(connId, {
        type: 'auth_error',
        message: 'Token verification not implemented',
      });
      this.wsManager.closeConnection(connId, 4001, 'Token verification not implemented');
    } catch (err) {
      this.logger.warn(`[ws] auth failed id=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'auth_error',
        message: 'Invalid token',
      });
      this.wsManager.closeConnection(connId, 4001, 'Invalid token');
    }
  }

  private async handleChat(connId: string, message: { sessionId?: string; projectId?: string; messages: Array<{ role: string; content: string }> }): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn || !conn.authenticated || !conn.identityId) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.AUTH_REQUIRED,
        message: 'Not authenticated',
      });
      return;
    }

    // Extract user message content
    const userMessages = message.messages.filter(m => m.role === 'user');
    if (userMessages.length === 0) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'No user message provided',
      });
      return;
    }

    const userContent = userMessages.map(m => m.content).join('\n');

    try {
      // Resolve project
      let projectId = message.projectId;
      let projectPath: string | null = null;

      if (projectId) {
        // Check if it's a registered project
        const project = this.config.projects.find(p => p.id === projectId);
        if (project) {
          projectPath = project.path;
        } else if (projectId === 'playground' || projectId === '__playground__') {
          // Playground mode - use cloud workspace
          projectId = 'cloud:playground';
        } else if (projectId.startsWith('cloud:')) {
          // Already a cloud project reference
          projectPath = null;
        } else {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.INVALID_MESSAGE,
            message: `Unknown project: ${projectId}`,
          });
          return;
        }
      } else {
        // Default to first project or playground
        const firstProject = this.config.projects.find(p => p.path !== '*');
        if (firstProject) {
          projectId = firstProject.id;
          projectPath = firstProject.path;
        } else {
          projectId = 'cloud:playground';
        }
      }

      // Resume existing session or create new one
      let sessionId = message.sessionId;

      if (sessionId) {
        // Verify session exists and belongs to this identity
        const existingSession = await this.db
          .selectFrom('sessions')
          .selectAll()
          .where('id', '=', sessionId)
          .executeTakeFirst();

        if (!existingSession) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.SESSION_NOT_FOUND,
            sessionId,
            message: 'Session not found',
          });
          return;
        }

        // Check if session is already running
        if (existingSession.status === 'running' || existingSession.status === 'starting') {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.INVALID_MESSAGE,
            sessionId,
            message: 'Session is already running',
          });
          return;
        }

        // Subscribe to this session
        this.wsManager.subscribeToSession(connId, sessionId);

        // Resume session with new message
        await this.sessionManager.resumeSession(existingSession as SessionRow, userContent);

        this.wsManager.sendToConnection(connId, {
          type: 'session_started',
          sessionId,
        });
      } else {
        // Create new session
        const agent = this.config.cloud?.default_agent === 'claude_code' ? 'claude_code' : 'codex';

        // For WebSocket, we use a virtual chat/space ID based on connection
        const virtualChatId = `ws:${conn.identityId}`;
        const virtualSpaceId = `${Date.now()}`;

        // Resolve project path - use the resolved path or default to data dir for cloud projects
        const resolvedProjectPath = projectPath ?? this.config.bot.data_dir;

        sessionId = await this.sessionManager.startNewSession({
          platform: 'websocket',
          workspaceId: null,
          chatId: virtualChatId,
          userId: conn.identityId,
          spaceId: virtualSpaceId,
          projectId: projectId!,
          projectPathResolved: resolvedProjectPath,
          initialPrompt: userContent,
          agent: agent as any,
        });

        // Subscribe to this session
        this.wsManager.subscribeToSession(connId, sessionId);

        this.wsManager.sendToConnection(connId, {
          type: 'session_started',
          sessionId,
        });
      }
    } catch (err) {
      this.logger.error(`[ws] chat error id=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to start session: ${String(err)}`,
      });
    }
  }

  private async handleStop(connId: string, sessionId: string): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn || !conn.authenticated) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.AUTH_REQUIRED,
        message: 'Not authenticated',
      });
      return;
    }

    if (!sessionId) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Session ID required',
      });
      return;
    }

    // Check if subscribed to this session
    if (!conn.subscribedSessions.has(sessionId)) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.ACCESS_DENIED,
        sessionId,
        message: 'Not subscribed to this session',
      });
      return;
    }

    try {
      await this.sessionManager.killSession(sessionId, 'Stopped via WebSocket');

      this.wsManager.broadcastToSession(sessionId, {
        type: 'done',
        sessionId,
        stopped: true,
      });

      this.logger.debug(`[ws] session stopped id=${connId} session=${sessionId}`);
    } catch (err) {
      this.logger.error(`[ws] stop error id=${connId} session=${sessionId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        sessionId,
        message: `Failed to stop session: ${String(err)}`,
      });
    }
  }

  private async handleSubscribe(connId: string, sessionId: string): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn || !conn.authenticated) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.AUTH_REQUIRED,
        message: 'Not authenticated',
      });
      return;
    }

    if (!sessionId) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Session ID required',
      });
      return;
    }

    // Verify session exists
    const session = await this.db
      .selectFrom('sessions')
      .select(['id', 'status'])
      .where('id', '=', sessionId)
      .executeTakeFirst();

    if (!session) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SESSION_NOT_FOUND,
        sessionId,
        message: 'Session not found',
      });
      return;
    }

    // TODO: In Phase 2, verify identity has access to this session

    this.wsManager.subscribeToSession(connId, sessionId);
    this.logger.debug(`[ws] subscribed id=${connId} session=${sessionId}`);
  }

  private handleUnsubscribe(connId: string, sessionId: string): void {
    if (!sessionId) return;
    this.wsManager.unsubscribeFromSession(connId, sessionId);
  }
}
