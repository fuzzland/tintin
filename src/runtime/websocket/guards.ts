import type { WebSocketManager } from './manager.js';
import type { WSConnection } from './types.js';
import { ErrorCodes } from './types.js';

export interface AuthenticatedConnection {
  conn: WSConnection;
  identityId: string;
}

/**
 * Check if connection is authenticated, send error and return null if not.
 */
export function requireAuth(
  wsManager: WebSocketManager,
  connId: string,
): AuthenticatedConnection | null {
  const conn = wsManager.getConnection(connId);
  if (!conn || !conn.authenticated || !conn.identityId) {
    wsManager.sendToConnection(connId, {
      type: 'error',
      code: ErrorCodes.AUTH_REQUIRED,
      message: 'Not authenticated',
    });
    return null;
  }
  return { conn, identityId: conn.identityId };
}

/**
 * Check if session ID is provided, send error and return false if not.
 */
export function requireSessionId(
  wsManager: WebSocketManager,
  connId: string,
  sessionId: string | undefined,
): sessionId is string {
  if (!sessionId) {
    wsManager.sendToConnection(connId, {
      type: 'error',
      code: ErrorCodes.INVALID_MESSAGE,
      message: 'Session ID required',
    });
    return false;
  }
  return true;
}
