import type { AppConfig } from '../../config.js';

/**
 * CloudLinkBuilder - Builds URLs for cloud run resources.
 * Follows SRP: Only responsible for URL construction.
 */
export class CloudLinkBuilder {
  constructor(private readonly config: AppConfig) {}

  /**
   * Build the view URL for a cloud run.
   */
  buildViewUrl(runId: string): string | undefined {
    const cloud = this.config.cloud;
    const ui = cloud?.ui;
    if (!cloud?.enabled || !ui || !ui.token_secret || !cloud.public_base_url) {
      return undefined;
    }

    const base = cloud.public_base_url.replace(/\/+$/g, '');
    const path = ui.path.startsWith('/') ? ui.path : `/${ui.path}`;
    return `${base}${path}/runs/${runId}`;
  }

  /**
   * Build VS Code tunnel URL for a session.
   */
  buildVscodeUrl(tunnelUrl: string | null): string | undefined {
    if (!tunnelUrl) return undefined;
    return `vscode://ms-vscode.remote-server/tunnel/${tunnelUrl}`;
  }

  /**
   * Build the public base URL from config.
   */
  getPublicBaseUrl(): string {
    return this.config.cloud?.public_base_url ?? `http://127.0.0.1:${this.config.bot.port}`;
  }
}
