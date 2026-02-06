/**
 * IdentityResolver - Unified identity resolution for all platforms.
 *
 * Expands on websocket/services/identity.ts to handle all platforms.
 *
 * Follows SRP: Only responsible for resolving platform user IDs to database identity IDs.
 */

import type { Db } from "../db.js";
import { getOrCreateIdentity } from "../cloud/store.js";
import type { Platform, IdentityContext } from "./types.js";

export class IdentityResolver {
  constructor(private readonly db: Db) {}

  /**
   * Resolve platform-specific identity to database identity ID.
   *
   * @param ctx - Identity context containing platform, userId, and optional workspaceId
   * @returns Database identity ID
   */
  async resolve(ctx: IdentityContext): Promise<string> {
    const { platform, userId, workspaceId } = ctx;

    const identity = await getOrCreateIdentity(this.db, {
      platform,
      workspaceId: workspaceId ?? null,
      userId,
    });

    return identity.id;
  }

  /**
   * Resolve Telegram user to database identity.
   */
  async resolveTelegram(userId: string): Promise<string> {
    return this.resolve({
      platform: "telegram",
      userId,
      workspaceId: null,
    });
  }

  /**
   * Resolve Slack user to database identity.
   * Slack requires workspaceId for proper identity isolation.
   */
  async resolveSlack(userId: string, workspaceId: string | null): Promise<string> {
    return this.resolve({
      platform: "slack",
      userId,
      workspaceId,
    });
  }

  /**
   * Resolve WebSocket identity to database identity.
   *
   * WebSocket identity format: "ws:anonymous:<connId>" or "ws:<token-identity>"
   */
  async resolveWebSocket(wsIdentityId: string): Promise<string> {
    let userId = wsIdentityId;

    // Remove "ws:" prefix if present
    if (wsIdentityId.startsWith("ws:")) {
      userId = wsIdentityId.slice(3);
    }

    return this.resolve({
      platform: "websocket",
      userId,
      workspaceId: null,
    });
  }

  /**
   * Parse WebSocket identity ID to extract the user portion.
   *
   * @param wsIdentityId - Full WebSocket identity ID (e.g., "ws:anonymous:abc123")
   * @returns Extracted user ID
   */
  static parseWebSocketIdentity(wsIdentityId: string): string {
    if (wsIdentityId.startsWith("ws:")) {
      return wsIdentityId.slice(3);
    }
    return wsIdentityId;
  }

  /**
   * Create a WebSocket anonymous identity ID from connection ID.
   */
  static createAnonymousIdentity(connId: string): string {
    return `ws:anonymous:${connId.slice(0, 8)}`;
  }
}
