import type { Db } from '../../db.js';
import { getOrCreateIdentity } from '../../cloud/store.js';

/**
 * IdentityResolver - Handles WebSocket connection identity mapping.
 * Follows SRP: Only responsible for identity resolution logic.
 */
export class IdentityResolver {
  constructor(private readonly db: Db) {}

  /**
   * Resolve WebSocket identityId to database identity ID.
   * Format: ws:anonymous:<connId> or ws:<token-identity>
   */
  async resolve(wsIdentityId: string): Promise<string> {
    // Parse the WebSocket identity to extract platform and userId
    const platform = 'websocket';
    let userId = wsIdentityId;

    if (wsIdentityId.startsWith('ws:')) {
      userId = wsIdentityId.slice(3); // Remove "ws:" prefix
    }

    const identity = await getOrCreateIdentity(this.db, {
      platform,
      workspaceId: null,
      userId,
    });

    return identity.id;
  }
}
