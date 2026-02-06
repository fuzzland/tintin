import type { Logger } from '../../log.js';
import type { Db } from '../../db.js';
import type { CloudManager } from '../../cloud/manager.js';
import type { WebSocketManager } from '../manager.js';
import type { WSConnection, ConnectionSandbox, ConnectionSandboxStatus } from '../types.js';
import { IdentityResolver } from '../../shared/IdentityResolver.js';
import { getCloudRunBySession } from '../../cloud/store.js';

/**
 * SandboxLifecycleService - Manages sandbox (workspace) lifecycle tied to WebSocket connections.
 *
 * Responsibilities:
 * - Provision sandbox on auth success (async, non-blocking)
 * - Terminate sandbox on disconnect (with snapshot if run was active)
 * - Track sandbox state per connection
 *
 * Follows SRP: Only responsible for sandbox lifecycle management.
 * Follows DIP: All dependencies injected via constructor.
 */
export class SandboxLifecycleService {
  private readonly identityResolver: IdentityResolver;
  private onSessionCompleteCallback: ((sessionId: string, connId: string) => void) | null = null;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly cloudManager: CloudManager,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {
    this.identityResolver = new IdentityResolver(db);
  }

  /**
   * Provision a sandbox for a WebSocket connection after successful auth.
   * This method is async and non-blocking - it sends status updates via WebSocket.
   *
   * @param connId - WebSocket connection ID
   * @param wsIdentityId - WebSocket identity ID (e.g., "ws:anonymous:xyz" or token-based identity)
   */
  async provisionSandbox(connId: string, wsIdentityId: string): Promise<void> {
    const conn = this.wsManager.getConnection(connId);
    if (!conn) {
      this.logger.debug(`[sandbox] provision skipped: connection not found connId=${connId}`);
      return;
    }

    try {
      // Resolve WS identity to DB identity
      const dbIdentityId = await this.identityResolver.resolveWebSocket(wsIdentityId);

      // Initialize sandbox state as provisioning
      const sandbox: ConnectionSandbox = {
        workspaceId: '',
        rootPath: '',
        status: 'provisioning',
        sessionId: null,
        dbIdentityId,
        createdAt: Date.now(),
        error: null,
      };
      conn.sandbox = sandbox;

      // Send provisioning status
      this.wsManager.sendToConnection(connId, {
        type: 'sandbox_status',
        status: 'provisioning',
        message: 'Creating sandbox workspace...',
      });

      this.logger.info(`[sandbox] provisioning started connId=${connId} identity=${dbIdentityId}`);

      // Create workspace via CloudManager
      const workspace = await this.cloudManager.createConnectionWorkspace({
        identityId: dbIdentityId,
        connId,
      });

      // Update sandbox state to ready
      sandbox.workspaceId = workspace.id;
      sandbox.rootPath = workspace.rootPath;
      sandbox.status = 'ready';

      // Send ready message
      this.wsManager.sendToConnection(connId, {
        type: 'sandbox_ready',
        workspaceId: workspace.id,
      });

      this.logger.info(`[sandbox] ready connId=${connId} workspaceId=${workspace.id}`);
    } catch (err) {
      this.logger.error(`[sandbox] provision failed connId=${connId}: ${String(err)}`);

      // Update sandbox state to error
      if (conn.sandbox) {
        conn.sandbox.status = 'error';
        conn.sandbox.error = String(err);
      }

      // Send error message
      this.wsManager.sendToConnection(connId, {
        type: 'sandbox_error',
        message: `Failed to create sandbox: ${String(err)}`,
        recoverable: false,
      });
    }
  }

  /**
   * Terminate a sandbox when a WebSocket connection closes.
   * Handles stopping active runs and taking snapshots before termination.
   *
   * @param connId - WebSocket connection ID
   * @param conn - WebSocket connection object (may be partially cleaned up)
   */
  async terminateSandbox(connId: string, conn: WSConnection): Promise<void> {
    const sandbox = conn.sandbox;
    if (!sandbox || !sandbox.workspaceId) {
      this.logger.debug(`[sandbox] terminate skipped: no sandbox connId=${connId}`);
      return;
    }

    // Skip if already terminating
    if (sandbox.status === 'terminating') {
      this.logger.debug(`[sandbox] terminate skipped: already terminating connId=${connId}`);
      return;
    }

    sandbox.status = 'terminating';
    this.logger.info(
      `[sandbox] terminating connId=${connId} workspaceId=${sandbox.workspaceId} ` +
      `status=${sandbox.status} sessionId=${sandbox.sessionId}`,
    );

    try {
      // Get runId from sessionId if needed for cleanup
      let runId: string | null = null;
      if (sandbox.sessionId) {
        const run = await getCloudRunBySession(this.db, sandbox.sessionId);
        runId = run?.id ?? null;
      }

      await this.cloudManager.terminateConnectionWorkspace({
        workspaceId: sandbox.workspaceId,
        sessionId: sandbox.sessionId,
        runId,
        identityId: sandbox.dbIdentityId,
      });

      this.logger.info(`[sandbox] terminated connId=${connId} workspaceId=${sandbox.workspaceId}`);
    } catch (err) {
      this.logger.error(`[sandbox] terminate failed connId=${connId}: ${String(err)}`);
      // Continue cleanup even on error - workspace will be cleaned up by lease expiry
    }
  }

  /**
   * Get the sandbox for a connection if it's usable (ready or in_use).
   * Returns null if sandbox doesn't exist or is in an unusable state.
   *
   * @param connId - WebSocket connection ID
   * @returns ConnectionSandbox if usable, null otherwise
   */
  getSandbox(connId: string): ConnectionSandbox | null {
    const conn = this.wsManager.getConnection(connId);
    if (!conn?.sandbox) return null;

    const { status } = conn.sandbox;
    if (status === 'ready' || status === 'in_use') {
      return conn.sandbox;
    }
    return null;
  }

  /**
   * Get sandbox status info for error messages.
   * Returns status and any error message.
   *
   * @param connId - WebSocket connection ID
   */
  getSandboxStatus(connId: string): { status: ConnectionSandboxStatus | null; error: string | null } {
    const conn = this.wsManager.getConnection(connId);
    if (!conn?.sandbox) {
      return { status: null, error: null };
    }
    return { status: conn.sandbox.status, error: conn.sandbox.error };
  }

  /**
   * Mark sandbox as in use for an active run.
   *
   * @param connId - WebSocket connection ID
   * @param sessionId - Session ID
   */
  markInUse(connId: string, sessionId: string): void {
    const conn = this.wsManager.getConnection(connId);
    if (!conn?.sandbox) return;

    conn.sandbox.status = 'in_use';
    conn.sandbox.sessionId = sessionId;

    this.logger.debug(`[sandbox] marked in_use connId=${connId} sessionId=${sessionId}`);
  }

  /**
   * Mark sandbox as ready (available for new runs).
   *
   * @param connId - WebSocket connection ID
   */
  markReady(connId: string): void {
    const conn = this.wsManager.getConnection(connId);
    if (!conn?.sandbox) return;

    conn.sandbox.status = 'ready';
    conn.sandbox.sessionId = null;

    this.logger.debug(`[sandbox] marked ready connId=${connId}`);
  }

  /**
   * Mark sandbox as ready and notify via callback.
   * Used when a session completes to transition the sandbox and trigger follow-up processing.
   */
  markReadyAndNotify(connId: string): void {
    const conn = this.wsManager.getConnection(connId);
    if (!conn?.sandbox) return;

    const sessionId = conn.sandbox.sessionId;
    conn.sandbox.status = 'ready';
    conn.sandbox.sessionId = null;

    this.logger.debug(`[sandbox] marked ready (with notify) connId=${connId} sessionId=${sessionId}`);

    if (sessionId && this.onSessionCompleteCallback) {
      this.onSessionCompleteCallback(sessionId, connId);
    }
  }

  /**
   * Register a callback to be called when a session completes.
   * Used to wire up follow-up queue processing.
   */
  setOnSessionComplete(callback: (sessionId: string, connId: string) => void): void {
    this.onSessionCompleteCallback = callback;
  }

  /**
   * Check if sandbox is ready for a new run.
   */
  isReady(connId: string): boolean {
    const conn = this.wsManager.getConnection(connId);
    return conn?.sandbox?.status === 'ready';
  }

  /**
   * Check if sandbox is currently in use.
   */
  isInUse(connId: string): boolean {
    const conn = this.wsManager.getConnection(connId);
    return conn?.sandbox?.status === 'in_use';
  }

  /**
   * Check if sandbox is still provisioning.
   */
  isProvisioning(connId: string): boolean {
    const conn = this.wsManager.getConnection(connId);
    return conn?.sandbox?.status === 'provisioning';
  }
}
