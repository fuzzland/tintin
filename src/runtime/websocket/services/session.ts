import type { Logger } from '../../log.js';
import type { Db } from '../../db.js';
import type { AppConfig } from '../../config.js';
import type { SessionManager } from '../../sessionManager.js';
import type { WebSocketManager } from '../manager.js';
import type { ChatMessage, WSConnection } from '../types.js';
import { ErrorCodes } from '../types.js';
import type { SessionRow } from '../../store.js';

export class SessionService {
  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly sessionManager: SessionManager,
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  async handleChat(
    connId: string,
    conn: WSConnection,
    message: ChatMessage,
  ): Promise<void> {
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
          userId: conn.identityId!,
          spaceId: virtualSpaceId,
          projectId: projectId!,
          projectPathResolved: resolvedProjectPath,
          initialPrompt: userContent,
          agent: agent as 'codex' | 'claude_code',
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

  async handleStop(
    connId: string,
    conn: WSConnection,
    sessionId: string,
  ): Promise<void> {
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

  async handleSubscribe(connId: string, sessionId: string): Promise<void> {
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

  handleUnsubscribe(connId: string, sessionId: string): void {
    if (!sessionId) return;
    this.wsManager.unsubscribeFromSession(connId, sessionId);
  }
}
