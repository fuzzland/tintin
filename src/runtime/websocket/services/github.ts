import type { Logger } from '../../log.js';
import type { Db } from '../../db.js';
import type { AppConfig } from '../../config.js';
import type { WebSocketManager } from '../manager.js';
import { ErrorCodes } from '../types.js';
import {
  listConnections,
  listReposForIdentity,
  listGithubInstallationsForIdentity,
  getOrCreateIdentity,
  replaceGithubInstallationRepos,
  upsertRepo,
} from '../../cloud/store.js';
import { startGithubAppFlow, ensureGithubAppTokenForInstallation, parseGithubAppMetadata } from '../../cloud/githubApp.js';
import { startOAuthFlow } from '../../cloud/oauth.js';
import { fetchGithubInstallationRepos } from '../../cloud/repos.js';

export class GitHubService {
  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  async handleGetConnections(connId: string, identityId: string): Promise<void> {
    try {
      const dbIdentityId = await this.getOrCreateDbIdentity(identityId);

      // Get connections from DB
      const connections = await listConnections(this.db, dbIdentityId);

      // For github_app connections, fetch installation info
      const result: Array<{
        id: string;
        type: string;
        installationId?: string;
        accountLogin?: string;
        status?: string;
        createdAt: number;
      }> = [];

      for (const c of connections) {
        const item: typeof result[number] = {
          id: c.id,
          type: c.type,
          createdAt: c.created_at,
        };

        if (c.type === 'github_app' && c.installation_id) {
          item.installationId = c.installation_id;
          // Parse metadata for account info
          const metadata = parseGithubAppMetadata(c.metadata_json);
          if (metadata?.account_login) {
            item.accountLogin = metadata.account_login;
          }
          item.status = 'active';
        }

        result.push(item);
      }

      // Also include GitHub installations that might not have a connection yet
      const installations = await listGithubInstallationsForIdentity(this.db, dbIdentityId);
      for (const inst of installations) {
        const existingConn = result.find(c => c.type === 'github_app' && c.installationId === inst.installation_id);
        if (!existingConn) {
          result.push({
            id: inst.installation_id,
            type: 'github_app',
            installationId: inst.installation_id,
            accountLogin: inst.account_login ?? undefined,
            status: inst.status ?? 'active',
            createdAt: inst.created_at,
          });
        } else if (!existingConn.accountLogin && inst.account_login) {
          existingConn.accountLogin = inst.account_login;
          existingConn.status = inst.status ?? 'active';
        }
      }

      this.wsManager.sendToConnection(connId, {
        type: 'connections_list',
        connections: result,
      });
    } catch (err) {
      this.logger.error(`[ws] get_connections error id=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to get connections: ${String(err)}`,
      });
    }
  }

  async handleListRepos(
    connId: string,
    identityId: string,
    opts: { provider?: string; search?: string },
  ): Promise<void> {
    try {
      const dbIdentityId = await this.getOrCreateDbIdentity(identityId);

      // Sync repos from remote if there are GitHub App installations
      await this.syncReposForIdentity(dbIdentityId);

      // Get repos from DB
      let repos = await listReposForIdentity(this.db, dbIdentityId);

      // Filter by provider if specified
      if (opts.provider) {
        repos = repos.filter(r => r.provider === opts.provider);
      }

      // Filter by search term if specified
      if (opts.search) {
        const searchLower = opts.search.toLowerCase();
        repos = repos.filter(r => r.name.toLowerCase().includes(searchLower));
      }

      this.wsManager.sendToConnection(connId, {
        type: 'repos_list',
        repos: repos.map(r => ({
          id: r.id,
          name: r.name,
          url: r.url,
          provider: r.provider,
          defaultBranch: r.default_branch,
        })),
        total: repos.length,
      });
    } catch (err) {
      this.logger.error(`[ws] list_repos error id=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to list repos: ${String(err)}`,
      });
    }
  }

  async handleGetAuthStatus(
    connId: string,
    identityId: string,
    provider: 'github' | 'gitlab',
  ): Promise<void> {
    try {
      const dbIdentityId = await this.getOrCreateDbIdentity(identityId);
      const connections = await listConnections(this.db, dbIdentityId);

      let connected = false;
      let accountLogin: string | undefined;
      let installationId: string | undefined;

      if (provider === 'github') {
        // Check for github_app connection first, then github_oauth
        const githubAppConn = connections.find(c => c.type === 'github_app');
        const githubOAuthConn = connections.find(c => c.type === 'github_oauth');

        if (githubAppConn) {
          connected = true;
          installationId = githubAppConn.installation_id ?? undefined;
          const metadata = parseGithubAppMetadata(githubAppConn.metadata_json);
          accountLogin = metadata?.account_login;

          // Also check installations table for account info
          if (!accountLogin) {
            const installations = await listGithubInstallationsForIdentity(this.db, dbIdentityId);
            const inst = installations.find(i => i.installation_id === installationId);
            accountLogin = inst?.account_login ?? undefined;
          }
        } else if (githubOAuthConn) {
          connected = true;
        }
      } else if (provider === 'gitlab') {
        const gitlabConn = connections.find(c => c.type === 'gitlab');
        connected = !!gitlabConn;
      }

      this.wsManager.sendToConnection(connId, {
        type: 'auth_status',
        provider,
        connected,
        accountLogin,
        installationId,
      });
    } catch (err) {
      this.logger.error(`[ws] get_auth_status error id=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to get auth status: ${String(err)}`,
      });
    }
  }

  async handleStartOAuth(
    connId: string,
    identityId: string,
    provider: 'github' | 'gitlab',
  ): Promise<void> {
    try {
      const cloud = this.config.cloud;
      if (!cloud) {
        throw new Error('Cloud configuration not available');
      }

      const dbIdentityId = await this.getOrCreateDbIdentity(identityId);

      // Build redirect base from config
      const host = this.config.bot.host ?? 'localhost';
      const port = this.config.bot.port ?? 3000;
      const protocol = host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https';
      const redirectBase = `${protocol}://${host}${port === 80 || port === 443 ? '' : `:${port}`}`;

      // Store connection ID in metadata for potential WebSocket notification on callback
      const metadataJson = JSON.stringify({ connection_id: connId });

      let authorizeUrl: string;

      if (provider === 'github') {
        // Use GitHub App flow if configured, otherwise fall back to OAuth
        if (cloud.github_app?.app_id && cloud.github_app?.app_slug && cloud.github_app?.private_key) {
          const result = await startGithubAppFlow({
            db: this.db,
            cloud,
            identityId: dbIdentityId,
            redirectBase,
            metadataJson,
          });
          authorizeUrl = result.authorizeUrl;
        } else if (cloud.oauth?.github) {
          const result = await startOAuthFlow({
            db: this.db,
            cloud,
            provider: 'github',
            identityId: dbIdentityId,
            redirectBase,
            metadataJson,
          });
          authorizeUrl = result.authorizeUrl;
        } else {
          throw new Error('GitHub authentication not configured');
        }
      } else if (provider === 'gitlab') {
        if (!cloud.oauth?.gitlab) {
          throw new Error('GitLab OAuth not configured');
        }
        const result = await startOAuthFlow({
          db: this.db,
          cloud,
          provider: 'gitlab',
          identityId: dbIdentityId,
          redirectBase,
          metadataJson,
        });
        authorizeUrl = result.authorizeUrl;
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

      this.wsManager.sendToConnection(connId, {
        type: 'oauth_started',
        provider,
        authorizeUrl,
      });

      this.logger.debug(`[ws] oauth started id=${connId} provider=${provider}`);
    } catch (err) {
      this.logger.error(`[ws] start_oauth error id=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to start OAuth: ${String(err)}`,
      });
    }
  }

  /**
   * Get or create a database identity for the WebSocket connection.
   * WebSocket identities use the format "ws:<identityId>" from the connection.
   */
  private async getOrCreateDbIdentity(wsIdentityId: string): Promise<string> {
    // Parse the WebSocket identity to extract platform and userId
    // Format: ws:anonymous:<connId> or ws:<token-identity>
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

  /**
   * Sync repositories from remote GitHub installations to the database.
   */
  private async syncReposForIdentity(identityId: string): Promise<void> {
    const cloud = this.config.cloud;
    if (!cloud?.github_app || !cloud.secrets_key) return;

    try {
      const installations = await listGithubInstallationsForIdentity(this.db, identityId);

      for (const inst of installations) {
        if (inst.status !== 'active') continue;

        try {
          // Get token for this installation
          const tokenResult = await ensureGithubAppTokenForInstallation({
            db: this.db,
            config: cloud.github_app,
            secretKey: cloud.secrets_key,
            installationId: inst.installation_id,
          });

          // Fetch repos from GitHub API
          const remoteRepos = await fetchGithubInstallationRepos({
            token: tokenResult.token,
            apiBaseUrl: cloud.github_app.api_base_url,
          });

          // Update installation repos table
          await replaceGithubInstallationRepos(this.db, {
            installationId: inst.installation_id,
            repos: remoteRepos,
          });

          // Get connection for this installation
          const connections = await listConnections(this.db, identityId);
          const conn = connections.find(c => c.type === 'github_app' && c.installation_id === inst.installation_id);

          if (conn) {
            // Also upsert into repos table for unified repo listing
            for (const repo of remoteRepos) {
              await upsertRepo(this.db, {
                connectionId: conn.id,
                provider: 'github',
                providerRepoId: repo.providerRepoId,
                name: repo.name,
                url: repo.url,
                defaultBranch: repo.defaultBranch,
              });
            }
          }
        } catch (instErr) {
          this.logger.warn(`[ws] Failed to sync repos for installation ${inst.installation_id}: ${String(instErr)}`);
        }
      }
    } catch (err) {
      this.logger.warn(`[ws] Failed to sync repos for identity ${identityId}: ${String(err)}`);
    }
  }
}
