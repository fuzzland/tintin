import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import crypto from 'node:crypto';
import type { Logger } from '../log.js';
import type { WSConnection, WebSocketSection, ServerMessage, ClientMessage } from './types.js';
import { ErrorCodes } from './types.js';

export class WebSocketManager {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, WSConnection>();
  private readonly sessionSubscribers = new Map<string, Set<string>>(); // sessionId → connectionIds
  private readonly identityConnections = new Map<string, Set<string>>(); // identityId → connectionIds
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private handler: ((connId: string, message: ClientMessage) => Promise<void>) | null = null;

  constructor(
    private readonly config: WebSocketSection,
    private readonly logger: Logger,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.logger.info(`[ws] WebSocketManager initialized path=${config.path}`);
  }

  setHandler(handler: (connId: string, message: ClientMessage) => Promise<void>): void {
    this.handler = handler;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.connections.size >= this.config.max_connections) {
      this.logger.warn('[ws] max connections reached, rejecting upgrade');
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      this.handleConnection(ws, req);
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const connId = crypto.randomUUID();
    const now = Date.now();

    const conn: WSConnection = {
      id: connId,
      ws,
      identityId: null,
      authenticated: false,
      subscribedSessions: new Set(),
      lastPingAt: now,
      lastActivityAt: now,
      createdAt: now,
      messageCount: 0,
    };

    this.connections.set(connId, conn);
    this.logger.debug(`[ws] connection established id=${connId} total=${this.connections.size}`);

    // Set auth timeout
    const authTimeout = setTimeout(() => {
      if (!conn.authenticated) {
        this.logger.debug(`[ws] auth timeout id=${connId}`);
        this.send(conn, {
          type: 'error',
          code: ErrorCodes.AUTH_REQUIRED,
          message: 'Authentication timeout',
        });
        ws.close(4001, 'Authentication timeout');
      }
    }, this.config.auth_timeout_ms);

    ws.on('message', (data: RawData) => {
      void this.handleMessage(conn, data, authTimeout);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      clearTimeout(authTimeout);
      this.handleClose(conn, code, reason.toString());
    });

    ws.on("error", (err: Error) => {
      this.logger.warn(`[ws] connection error id=${connId}: ${String(err)}`);
    });

    ws.on('pong', () => {
      conn.lastPingAt = Date.now();
    });
  }

  private async handleMessage(conn: WSConnection, data: RawData, authTimeout: ReturnType<typeof setTimeout>): Promise<void> {
    conn.lastActivityAt = Date.now();
    conn.messageCount++;

    // Check message size
    const dataStr = data.toString();
    if (dataStr.length > this.config.max_message_size) {
      this.send(conn, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Message too large',
      });
      return;
    }

    // Basic rate limiting check
    const elapsed = conn.lastActivityAt - conn.createdAt;
    const maxMessages = Math.ceil((elapsed / 1000) * this.config.rate_limit_messages_per_sec) + 10;
    if (conn.messageCount > maxMessages) {
      this.send(conn, {
        type: 'error',
        code: ErrorCodes.RATE_LIMIT,
        message: 'Rate limit exceeded',
      });
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(dataStr) as ClientMessage;
    } catch {
      this.send(conn, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Invalid JSON',
      });
      return;
    }

    if (!message || typeof message.type !== 'string') {
      this.send(conn, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Missing message type',
      });
      return;
    }

    // Handle ping/pong internally
    if (message.type === 'ping') {
      conn.lastPingAt = Date.now();
      this.send(conn, { type: 'pong' });
      return;
    }

    // Auth is required before any other message
    if (!conn.authenticated && message.type !== 'auth') {
      this.send(conn, {
        type: 'error',
        code: ErrorCodes.AUTH_REQUIRED,
        message: 'Authentication required',
      });
      return;
    }

    // Clear auth timeout on successful auth
    if (message.type === 'auth') {
      clearTimeout(authTimeout);
    }

    // Delegate to handler
    if (this.handler) {
      try {
        await this.handler(conn.id, message);
      } catch (err) {
        this.logger.error(`[ws] handler error id=${conn.id}: ${String(err)}`);
        this.send(conn, {
          type: 'error',
          code: ErrorCodes.SERVICE_ERROR,
          message: 'Internal server error',
        });
      }
    }
  }

  private handleClose(conn: WSConnection, code: number, reason: string): void {
    this.logger.debug(`[ws] connection closed id=${conn.id} code=${code} reason=${reason}`);

    // Clean up session subscriptions
    for (const sessionId of conn.subscribedSessions) {
      const subscribers = this.sessionSubscribers.get(sessionId);
      if (subscribers) {
        subscribers.delete(conn.id);
        if (subscribers.size === 0) {
          this.sessionSubscribers.delete(sessionId);
        }
      }
    }

    // Clean up identity tracking
    if (conn.identityId) {
      const identityConns = this.identityConnections.get(conn.identityId);
      if (identityConns) {
        identityConns.delete(conn.id);
        if (identityConns.size === 0) {
          this.identityConnections.delete(conn.identityId);
        }
      }
    }

    this.connections.delete(conn.id);
    this.logger.debug(`[ws] connection removed id=${conn.id} total=${this.connections.size}`);
  }

  // ============ Public API ============

  getConnection(connId: string): WSConnection | undefined {
    return this.connections.get(connId);
  }

  setAuthenticated(connId: string, identityId: string): boolean {
    const conn = this.connections.get(connId);
    if (!conn) return false;

    // Check max connections per identity
    const existingConns = this.identityConnections.get(identityId);
    if (existingConns && existingConns.size >= this.config.max_connections_per_identity) {
      this.logger.warn(`[ws] max connections per identity reached identity=${identityId}`);
      return false;
    }

    conn.authenticated = true;
    conn.identityId = identityId;

    // Track identity connections
    let identityConns = this.identityConnections.get(identityId);
    if (!identityConns) {
      identityConns = new Set();
      this.identityConnections.set(identityId, identityConns);
    }
    identityConns.add(connId);

    return true;
  }

  subscribeToSession(connId: string, sessionId: string): boolean {
    const conn = this.connections.get(connId);
    if (!conn || !conn.authenticated) return false;

    conn.subscribedSessions.add(sessionId);

    let subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.sessionSubscribers.set(sessionId, subscribers);
    }
    subscribers.add(connId);

    this.logger.debug(`[ws] subscribed id=${connId} session=${sessionId}`);
    return true;
  }

  unsubscribeFromSession(connId: string, sessionId: string): boolean {
    const conn = this.connections.get(connId);
    if (!conn) return false;

    conn.subscribedSessions.delete(sessionId);

    const subscribers = this.sessionSubscribers.get(sessionId);
    if (subscribers) {
      subscribers.delete(connId);
      if (subscribers.size === 0) {
        this.sessionSubscribers.delete(sessionId);
      }
    }

    this.logger.debug(`[ws] unsubscribed id=${connId} session=${sessionId}`);
    return true;
  }

  hasSubscribers(sessionId: string): boolean {
    const subscribers = this.sessionSubscribers.get(sessionId);
    return Boolean(subscribers && subscribers.size > 0);
  }

  broadcastToSession(sessionId: string, message: ServerMessage): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers || subscribers.size === 0) return;

    const payload = JSON.stringify(message);
    for (const connId of subscribers) {
      const conn = this.connections.get(connId);
      if (conn && conn.ws.readyState === 1) { // OPEN
        try {
          conn.ws.send(payload);
        } catch (err) {
          this.logger.warn(`[ws] broadcast failed id=${connId}: ${String(err)}`);
        }
      }
    }
  }

  send(conn: WSConnection, message: ServerMessage): void {
    if (conn.ws.readyState !== 1) return; // OPEN
    try {
      conn.ws.send(JSON.stringify(message));
    } catch (err) {
      this.logger.warn(`[ws] send failed id=${conn.id}: ${String(err)}`);
    }
  }

  sendToConnection(connId: string, message: ServerMessage): boolean {
    const conn = this.connections.get(connId);
    if (!conn) return false;
    this.send(conn, message);
    return true;
  }

  closeConnection(connId: string, code: number, reason: string): void {
    const conn = this.connections.get(connId);
    if (conn) {
      conn.ws.close(code, reason);
    }
  }

  // ============ Lifecycle ============

  startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.connection_timeout_ms;

      for (const [connId, conn] of this.connections) {
        // Check for stale connections
        if (now - conn.lastPingAt > timeout) {
          this.logger.debug(`[ws] connection timeout id=${connId}`);
          conn.ws.close(4002, 'Connection timeout');
          continue;
        }

        // Send ping
        if (conn.ws.readyState === 1) { // OPEN
          try {
            conn.ws.ping();
          } catch {
            // Ignore ping errors
          }
        }
      }
    }, this.config.ping_interval_ms);

    this.logger.info('[ws] heartbeat started');
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.logger.info('[ws] heartbeat stopped');
    }
  }

  getStats(): { connections: number; sessions: number } {
    return {
      connections: this.connections.size,
      sessions: this.sessionSubscribers.size,
    };
  }

  close(): void {
    this.stopHeartbeat();
    for (const conn of this.connections.values()) {
      conn.ws.close(1001, 'Server shutdown');
    }
    this.connections.clear();
    this.sessionSubscribers.clear();
    this.identityConnections.clear();
    this.wss.close();
    this.logger.info('[ws] WebSocketManager closed');
  }
}
