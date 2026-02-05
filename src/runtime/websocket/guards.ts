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
 * Check if cloud service is available, send error and return false if not.
 */
export function requireCloudService<T>(
  wsManager: WebSocketManager,
  connId: string,
  service: T | null,
): service is T {
  if (!service) {
    wsManager.sendToConnection(connId, {
      type: 'error',
      code: ErrorCodes.SERVICE_ERROR,
      message: 'Cloud run is not enabled',
    });
    return false;
  }
  return true;
}
