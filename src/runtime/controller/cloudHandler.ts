import crypto from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { CloudManager } from "../cloud/manager.js";
import type { SlackClient } from "../platform/slack.js";
import type { TelegramClient } from "../platform/telegram.js";
import type { IMessagingPlatform, InteractiveMarkup } from "../platform/base.js";
import { redactText } from "../redact.js";
import { startOAuthFlow } from "../cloud/oauth.js";
import { ensureGithubAppToken, startGithubAppFlow } from "../cloud/githubApp.js";
import { computeGithubDisconnectImpact, executeGithubDisconnect } from "../cloud/githubDisconnect.js";
import { fetchGithubInstallationRepos, fetchGithubRepos, fetchGitlabRepos } from "../cloud/repos.js";
import { encryptSecret } from "../cloud/secrets.js";
import { generateSetupSpecFromPath } from "../cloud/lift.js";
import { hashSetupSpec, stringifySetupSpec } from "../cloud/setupSpec.js";
import { buildCloneUrl, runGitClone } from "../cloud/git.js";
import { LocalCloudProvider } from "../cloud/localProvider.js";
import { createUiToken } from "../cloud/uiTokens.js";
import {
  getCloudRun,
  getLatestSetupSpec,
  createPendingAction,
  consumePendingAction,
  getGithubInstallation,
  getOrCreateIdentity,
  getSharedRepo,
  listCloudRunsForPlayground,
  listCloudRunsForRepo,
  listConnections,
  listReposForIdentity,
  listSecrets,
  listSharedRepos,
  replaceGithubInstallationRepos,
  setIdentityActiveRepo,
  setSecret,
  shareRepo,
  unshareRepo,
  deleteSecret,
  putSetupSpec,
} from "../cloud/store.js";
import {
  completeChatgptOAuth,
  getChatgptAccountForIdentity,
  parseAuthorizationInput as parseChatgptAuthInput,
  revokeChatgptAccount,
  startChatgptOAuth,
} from "../chatgpt/oauth.js";
import { t, type UserLanguage } from "../../locales/index.js";
import {
  PLAYGROUND_REPO_ID,
  humanStatus,
  isPlaygroundRepoId,
  parseRepoIndex,
  truncateText,
  type CloudCommand,
} from "./commands.js";
import { buildCloudHelpText } from "./sessions.js";

export interface CloudHandlerDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  cloudManager: CloudManager | null;
  telegram: TelegramClient | null;
  slack: SlackClient | null;
  sendPlatformMessage: (opts: {
    platform: IMessagingPlatform | null;
    chatId: string;
    text: string;
    markup?: InteractiveMarkup;
    threadId?: string | number;
    replyToMessageId?: string | number;
    priority?: "user" | "background";
    workspaceId?: string | null;
  }) => Promise<void>;
  resolveUserLanguage: (platform: "telegram" | "slack", userId: string) => Promise<UserLanguage>;
  buildRunActionTelegramKeyboard: (
    sessionId: string,
    runId: string,
    lang: UserLanguage,
    viewUrl?: string | null,
    vscodeUrl?: string | null,
  ) => unknown[];
}

type IdentityRepo = Awaited<ReturnType<typeof listReposForIdentity>>[number];

export class CloudHandler {
  private readonly lastRepoListByIdentity = new Map<string, string[]>();
  private readonly lastSnapshotListByIdentity = new Map<string, string[]>();

  constructor(private readonly deps: CloudHandlerDeps) {}

  private buildCloudUiLink(runId: string, identityId: string, isDirect: boolean): string | null {
    const cloud = this.deps.config.cloud;
    const ui = cloud?.ui;
    if (!cloud?.enabled || !ui || !ui.token_secret || !cloud.public_base_url) return null;
    const base = cloud.public_base_url.replace(/\/+$/g, "");
    const path = ui.path.startsWith("/") ? ui.path : `/${ui.path}`;
    const token = isDirect
      ? createUiToken(ui, { scope: "identity", identity_id: identityId })
      : createUiToken(ui, { scope: "run", run_id: runId });
    return `${base}${path}/${runId}?token=${encodeURIComponent(token)}`;
  }

  private buildRunActionSlackBlocks(
    sessionId: string,
    runId: string,
    lang: UserLanguage,
    viewUrl?: string | null,
    vscodeUrl?: string | null,
  ) {
    const elements: Array<{
      type: string;
      text: { type: string; text: string };
      action_id: string;
      style?: string;
      value?: string;
      url?: string;
    }> = [
      {
        type: "button",
        text: { type: "plain_text", text: t("button.stop", lang) },
        style: "danger",
        action_id: "kill_session",
        value: sessionId,
      },
      { type: "button", text: { type: "plain_text", text: t("button.status", lang) }, action_id: "run_status", value: runId },
    ];
    if (viewUrl) {
      elements.push({ type: "button", text: { type: "plain_text", text: t("button.view", lang) }, action_id: "view_run", url: viewUrl });
    }
    if (vscodeUrl) {
      elements.push({ type: "button", text: { type: "plain_text", text: t("button.vscode", lang) }, action_id: "open_vscode", url: vscodeUrl });
    }
    return [{ type: "actions", elements }];
  }

  private buildRunActionMarkup(opts: {
    platform: "telegram" | "slack";
    sessionId: string;
    runId: string;
    lang: UserLanguage;
    viewUrl?: string | null;
    vscodeUrl?: string | null;
  }): InteractiveMarkup {
    if (opts.platform === "telegram") {
      return {
        type: "inline_keyboard",
        payload: this.deps.buildRunActionTelegramKeyboard(opts.sessionId, opts.runId, opts.lang, opts.viewUrl, opts.vscodeUrl),
      };
    }
    return {
      type: "blocks",
      payload: this.buildRunActionSlackBlocks(opts.sessionId, opts.runId, opts.lang, opts.viewUrl, opts.vscodeUrl),
    };
  }

  async sendCloudMessage(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    workspaceId: string | null;
    text: string;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
    ephemeral?: boolean;
  }) {
    if (opts.platform === "telegram") {
      await this.deps.sendPlatformMessage({
        platform: this.deps.telegram,
        chatId: opts.chatId,
        text: opts.text,
        replyToMessageId: opts.replyToMessageId,
        threadId: opts.messageThreadId,
        priority: "user",
      });
      return;
    }
    if (!this.deps.slack) return;
    const isDm = opts.chatId.startsWith("D");
    const ephemeral = opts.ephemeral ?? !isDm;
    if (ephemeral && !isDm) {
      await this.deps.slack.postEphemeral({
        channel: opts.chatId,
        user: opts.userId,
        text: opts.text,
        workspaceId: opts.workspaceId,
      });
      return;
    }
    await this.deps.sendPlatformMessage({
      platform: this.deps.slack,
      chatId: opts.chatId,
      text: opts.text,
      threadId: opts.slackThreadTs,
      priority: "user",
      workspaceId: opts.workspaceId,
    });
  }

  private async sendCloudRunStartedMessage(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    workspaceId: string | null;
    text: string;
    sessionId: string;
    runId: string;
    viewUrl?: string | null;
    vscodeUrl?: string | null;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }) {
    const lang = await this.deps.resolveUserLanguage(opts.platform, opts.userId);
    const markup = this.buildRunActionMarkup({
      platform: opts.platform,
      sessionId: opts.sessionId,
      runId: opts.runId,
      lang,
      viewUrl: opts.viewUrl,
      vscodeUrl: opts.vscodeUrl,
    });
    const platformClient = opts.platform === "telegram" ? this.deps.telegram : this.deps.slack;
    const threadId = opts.platform === "telegram" ? opts.messageThreadId : opts.slackThreadTs;
    await this.deps.sendPlatformMessage({
      platform: platformClient,
      chatId: opts.chatId,
      text: opts.text,
      replyToMessageId: opts.replyToMessageId,
      threadId,
      markup,
      priority: "user",
      workspaceId: opts.workspaceId,
    });
  }

  async sendCloudRunStatus(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    workspaceId: string | null;
    runId: string;
    isDirect: boolean;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }) {
    const lang = await this.deps.resolveUserLanguage(opts.platform, opts.userId);
    if (!this.deps.cloudManager || !this.deps.config.cloud?.enabled) {
      await this.sendCloudMessage({ ...opts, text: t("cloud.disabled", lang) });
      return;
    }
    const identity = await getOrCreateIdentity(this.deps.db, {
      platform: opts.platform,
      workspaceId: opts.workspaceId,
      userId: opts.userId,
    });
    const run = await getCloudRun(this.deps.db, opts.runId);
    if (!run || run.identity_id !== identity.id) {
      await this.sendCloudMessage({ ...opts, text: t("run.not_found", lang) });
      return;
    }
    const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
    const text = link
      ? t("run.status_with_link", lang, { id: run.id, status: run.status, url: link })
      : t("run.status_line", lang, { id: run.id, status: run.status });
    await this.sendCloudMessage({ ...opts, text });
  }

  async sendCloudHelp(opts: {
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    workspaceId: string | null;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }) {
    const lang = await this.deps.resolveUserLanguage(opts.platform, opts.userId);
    await this.sendCloudMessage({
      ...opts,
      text: buildCloudHelpText(opts.platform, lang),
    });
  }

  private resolveRepoTarget(identityId: string, repos: IdentityRepo[], rawTarget: string): IdentityRepo | null {
    const target = rawTarget.trim();
    const index = parseRepoIndex(target);
    if (index !== null) {
      const list = this.lastRepoListByIdentity.get(identityId) ?? repos.map((r) => r.id);
      const repoId = list[index - 1];
      if (repoId) {
        const match = repos.find((r) => r.id === repoId);
        if (match) return match;
      }
    }
    return repos.find((r) => r.id === target || r.name === target) ?? null;
  }

  private findSecretMetaByName(secrets: { name: string; created_at: number; updated_at: number }[], name: string) {
    const target = name.trim();
    if (!target) return null;
    return secrets.find((s) => s.name === target) ?? null;
  }

  async handleCloudCommand(opts: {
    platform: "telegram" | "slack";
    command: CloudCommand;
    chatId: string;
    workspaceId: string | null;
    userId: string;
    isDirect: boolean;
    spaceId: string;
    replyToMessageId?: number;
    messageThreadId?: number;
    slackThreadTs?: string;
  }): Promise<boolean> {
    const lang = await this.deps.resolveUserLanguage(opts.platform, opts.userId);
    if (!this.deps.cloudManager || !this.deps.config.cloud?.enabled) {
      await this.sendCloudMessage({
        platform: opts.platform,
        chatId: opts.chatId,
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        text: t("cloud.disabled", lang),
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
        slackThreadTs: opts.slackThreadTs,
      });
      return true;
    }

    const identity = await getOrCreateIdentity(this.deps.db, {
      platform: opts.platform,
      workspaceId: opts.workspaceId,
      userId: opts.userId,
    });

    if (!opts.isDirect && !identity.onboarded_at) {
      await this.sendCloudMessage({
        platform: opts.platform,
        chatId: opts.chatId,
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        text: t("cloud.setup_required", lang),
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
        slackThreadTs: opts.slackThreadTs,
      });
      return true;
    }

    const reply = async (text: string, ephemeral?: boolean) => {
      await this.sendCloudMessage({
        platform: opts.platform,
        chatId: opts.chatId,
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        text,
        replyToMessageId: opts.replyToMessageId,
        messageThreadId: opts.messageThreadId,
        slackThreadTs: opts.slackThreadTs,
        ephemeral,
      });
    };
    const replyText = async (key: Parameters<typeof t>[0], params?: Record<string, string | number>, ephemeral?: boolean) => {
      await reply(t(key, lang, params), ephemeral);
    };
    const cmdPrefix = opts.platform === "telegram" ? "/" : "";
    const formatCmd = (value: string) => `\`${cmdPrefix}${value}\``;

    const cloud = this.deps.config.cloud;
    if (!cloud) {
      await replyText("cloud.config_missing");
      return true;
    }

    switch (opts.command.kind) {
      case "connect": {
        if (!opts.isDirect) {
          await replyText("connect.dm_only", { cmd: formatCmd("connect") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "connect" }>;
        const provider = cmd.provider;
        const metadataJson = JSON.stringify({
          platform: opts.platform,
          chat_id: opts.chatId,
          user_id: opts.userId,
          space_id: opts.spaceId,
          workspace_id: opts.workspaceId,
        });
        try {
          if (provider === "chatgpt") {
            if (!this.deps.config.chatgpt_oauth) {
              await replyText("connect.chatgpt.not_configured");
              return true;
            }
            if (cmd.subcommand === "status") {
              const account = await getChatgptAccountForIdentity({
                db: this.deps.db,
                config: this.deps.config,
                identityId: identity.id,
              });
              if (!account) {
                await replyText("connect.chatgpt.none", undefined, true);
                return true;
              }
              const lines = [
                t("connect.chatgpt.status.title", lang),
                t("connect.chatgpt.status.account_id", lang, { id: account.chatgptUserId }),
                account.email
                  ? t("connect.chatgpt.status.email", lang, { email: account.email })
                  : t("connect.chatgpt.status.email_unknown", lang),
                t("connect.chatgpt.status.expires", lang, { ts: new Date(account.expiresAt).toISOString() }),
                account.workspaceId
                  ? t("connect.chatgpt.status.workspace", lang, { workspace: account.workspaceId })
                  : t("connect.chatgpt.status.workspace_none", lang),
              ];
              await reply(lines.join("\n"), true);
              return true;
            }
            if (cmd.subcommand === "revoke") {
              this.deps.logger.info(
                `[chatgpt][oauth] revoke requested platform=${opts.platform} chat=${opts.chatId} user=${opts.userId} identity=${identity.id}`,
              );
              await revokeChatgptAccount({ db: this.deps.db, identityId: identity.id });
              this.deps.logger.info(`[chatgpt][oauth] revoked identity=${identity.id}`);
              await replyText("connect.chatgpt.unlinked", undefined, true);
              return true;
            }
            if (cmd.payload) {
              const parsed = parseChatgptAuthInput(cmd.payload);
              if (!parsed.code || !parsed.state) {
                await replyText("connect.chatgpt.paste_redirect");
                return true;
              }
              try {
                this.deps.logger.info(
                  `[chatgpt][oauth] manual redirect received platform=${opts.platform} chat=${opts.chatId} user=${opts.userId} identity=${identity.id} state=${parsed.state}`,
                );
                await completeChatgptOAuth({
                  db: this.deps.db,
                  config: this.deps.config,
                  code: parsed.code,
                  state: parsed.state,
                  expectedIdentityId: identity.id,
                  logger: this.deps.logger,
                });
                this.deps.logger.info(
                  `[chatgpt][oauth] linked account platform=${opts.platform} chat=${opts.chatId} identity=${identity.id} state=${parsed.state}`,
                );
                await replyText("connect.chatgpt.connected", { cmd: formatCmd("connect chatgpt status") }, true);
              } catch (e) {
                await replyText("connect.chatgpt.failed", { error: String(e) });
              }
              return true;
            }
            const { authorizeUrl } = await startChatgptOAuth({
              db: this.deps.db,
              config: this.deps.config,
              identityId: identity.id,
              metadataJson,
            });
            const lines = [
              t("connect.chatgpt.signin.title", lang),
              t("connect.chatgpt.signin.open_link", lang),
              authorizeUrl,
              "",
              t("connect.chatgpt.signin.instructions", lang),
              `- ${formatCmd("connect chatgpt <paste-full-redirect-url>")}`,
            ];
            await reply(lines.join("\n"), true);
            return true;
          }
          if (!cloud?.public_base_url) {
            await replyText("cloud.public_base_missing");
            return true;
          }
          if (provider === "github") {
            const connections = (await listConnections(this.deps.db, identity.id)).filter((c) => c.type === "github_app");
            const activeConnections: Array<{
              connection: (typeof connections)[number];
              installation: Awaited<ReturnType<typeof getGithubInstallation>>;
            }> = [];
            const staleConnections: typeof connections = [];
            const connectedStatuses = new Set(["active", "suspended", "disconnecting"]);
            for (const conn of connections) {
              const installationId = conn.metadata?.installation_id;
              if (!installationId) {
                staleConnections.push(conn);
                continue;
              }
              const installation = await getGithubInstallation(this.deps.db, installationId);
              if (!installation) {
                staleConnections.push(conn);
                continue;
              }
              if (!connectedStatuses.has(installation.status)) {
                staleConnections.push(conn);
                continue;
              }
              activeConnections.push({ connection: conn, installation });
            }
            if (staleConnections.length) {
              await this.deps.db
                .updateTable("connections")
                .set({ status: "disconnected", updated_at: Date.now() })
                .where("id", "in", staleConnections.map((conn) => conn.id))
                .execute();
            }
            if (activeConnections.length) {
              const lines = [t("connect.github.already", lang)];
              for (const { installation } of activeConnections) {
                lines.push(t("connect.github.installation", lang, { id: installation.id, account: installation.account_login }));
              }
              await reply(lines.join("\n"), true);
              return true;
            }
            if (!this.deps.config.cloud?.github_app) {
              await replyText("connect.github.not_configured");
              return true;
            }
            const { authorizeUrl, state } = await startGithubAppFlow({
              db: this.deps.db,
              config: this.deps.config,
              logger: this.deps.logger,
              metadataJson,
            });
            const lines = [
              t("connect.github.signin.title", lang),
              t("connect.github.signin.open_link", lang),
              authorizeUrl,
              "",
              t("connect.github.signin.instructions", lang),
              t("connect.github.signin.note", lang),
            ];
            await reply(lines.join("\n"), true);
            return true;
          }
          if (provider === "gitlab") {
            const connections = (await listConnections(this.deps.db, identity.id)).filter((c) => c.type === "gitlab_oauth");
            if (connections.length) {
              await replyText("connect.gitlab.already", undefined, true);
              return true;
            }
            if (!cloud?.oauth) {
              await replyText("connect.gitlab.not_configured");
              return true;
            }
            const { authorizeUrl } = await startOAuthFlow({
              config: this.deps.config,
              db: this.deps.db,
              provider: "gitlab",
              metadataJson,
            });
            const lines = [
              t("connect.gitlab.signin.title", lang),
              t("connect.gitlab.signin.open_link", lang),
              authorizeUrl,
            ];
            await reply(lines.join("\n"), true);
            return true;
          }
          if (provider === "local") {
            await replyText("connect.local.unsupported", undefined, true);
            return true;
          }
        } catch (e) {
          this.deps.logger.warn(`[cloud] connect failed: ${String(e)}`);
          await replyText("connect.failed", { error: redactText(e instanceof Error ? e.message : String(e)) });
          return true;
        }
        await replyText("connect.unsupported");
        return true;
      }
      case "connect_callback": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "connect_callback" }>;
        const pending = await consumePendingAction(this.deps.db, {
          id: cmd.token,
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          userId: opts.userId,
        });
        if (!pending) {
          await replyText("connect.callback_expired");
          return true;
        }
        const meta = pending.metadata ?? {};
        const installToken = meta.install_token;
        if (pending.action !== "github_app" || !installToken) {
          await replyText("connect.callback_invalid");
          return true;
        }
        try {
          await ensureGithubAppToken({
            db: this.deps.db,
            logger: this.deps.logger,
            cloudManager: this.deps.cloudManager,
          });
          const connection = await startGithubAppFlow({
            db: this.deps.db,
            config: this.deps.config,
            logger: this.deps.logger,
            metadataJson: pending.metadata_json,
            installToken,
            installationId: meta.installation_id,
          });
          const repos = await fetchGithubInstallationRepos({
            db: this.deps.db,
            logger: this.deps.logger,
            installationId: connection.metadata?.installation_id ?? "",
          });
          await replaceGithubInstallationRepos(this.deps.db, {
            installationId: connection.metadata?.installation_id ?? "",
            repos,
          });
          await replyText("connect.github.success", undefined, true);
        } catch (e) {
          this.deps.logger.warn(`[cloud] github app install callback failed ${String(e)}`);
          await replyText("connect.github.failed", { error: redactText(e instanceof Error ? e.message : String(e)) });
        }
        return true;
      }
      case "connect_status": {
        const conns = await listConnections(this.deps.db, identity.id);
        if (!conns.length) {
          await replyText("connect.status.none", undefined, true);
          return true;
        }
        const lines = [t("connect.status.title", lang)];
        for (const conn of conns) {
          lines.push(t("connect.status.line", lang, { provider: conn.type, status: conn.status }));
        }
        await reply(lines.join("\n"), true);
        return true;
      }
      case "connect_refresh": {
        const conns = await listConnections(this.deps.db, identity.id);
        if (!conns.length) {
          await replyText("connect.refresh.none", undefined, true);
          return true;
        }
        let didRefresh = false;
        for (const conn of conns) {
          try {
            if (conn.type === "github_app") {
              const installationId = conn.metadata?.installation_id;
              if (!installationId) {
                this.deps.logger.warn("[cloud] github_app connection missing installation_id; cannot refresh repos.");
                continue;
              }
              await ensureGithubAppToken({
                db: this.deps.db,
                logger: this.deps.logger,
                cloudManager: this.deps.cloudManager,
              });
              const repos = await fetchGithubInstallationRepos({
                db: this.deps.db,
                logger: this.deps.logger,
                installationId,
              });
              await replaceGithubInstallationRepos(this.deps.db, {
                installationId,
                repos,
              });
              didRefresh = true;
            } else if (conn.type === "github") {
              if (!conn.metadata?.access_token) {
                await this.deps.db
                  .updateTable("connections")
                  .set({ status: "expired", updated_at: Date.now() })
                  .where("id", "=", conn.id)
                  .execute();
                continue;
              }
              const repos = await fetchGithubRepos({
                accessToken: conn.metadata.access_token,
              });
              await this.deps.db
                .updateTable("repos")
                .set({ updated_at: Date.now() })
                .where("connection_id", "=", conn.id)
                .execute();
              for (const repo of repos) {
                await this.deps.db
                  .insertInto("repos")
                  .values({
                    id: `${conn.id}:${repo.id}`,
                    connection_id: conn.id,
                    identity_id: conn.identity_id,
                    name: repo.name,
                    provider: "github",
                    repo_owner: repo.owner,
                    repo_name: repo.name,
                    metadata: repo,
                    created_at: Date.now(),
                    updated_at: Date.now(),
                  })
                  .onConflict((oc) =>
                    oc.column("id").doUpdateSet({
                      name: repo.name,
                      repo_owner: repo.owner,
                      repo_name: repo.name,
                      metadata: repo,
                      updated_at: Date.now(),
                    }),
                  )
                  .execute();
              }
              didRefresh = true;
            } else if (conn.type === "gitlab_oauth") {
              if (!conn.metadata?.access_token) {
                await this.deps.db
                  .updateTable("connections")
                  .set({ status: "expired", updated_at: Date.now() })
                  .where("id", "=", conn.id)
                  .execute();
                continue;
              }
              const repos = await fetchGitlabRepos({
                accessToken: conn.metadata.access_token,
              });
              await this.deps.db
                .updateTable("repos")
                .set({ updated_at: Date.now() })
                .where("connection_id", "=", conn.id)
                .execute();
              for (const repo of repos) {
                await this.deps.db
                  .insertInto("repos")
                  .values({
                    id: `${conn.id}:${repo.id}`,
                    connection_id: conn.id,
                    identity_id: conn.identity_id,
                    name: repo.name,
                    provider: "gitlab",
                    repo_owner: repo.owner,
                    repo_name: repo.name,
                    metadata: repo,
                    created_at: Date.now(),
                    updated_at: Date.now(),
                  })
                  .onConflict((oc) =>
                    oc.column("id").doUpdateSet({
                      name: repo.name,
                      repo_owner: repo.owner,
                      repo_name: repo.name,
                      metadata: repo,
                      updated_at: Date.now(),
                    }),
                  )
                  .execute();
              }
              didRefresh = true;
            }
          } catch (e) {
            this.deps.logger.warn(`[cloud] repo refresh failed ${conn.type}: ${String(e)}`);
          }
        }
        await replyText(didRefresh ? "connect.refresh.ok" : "connect.refresh.no_changes", undefined, true);
        return true;
      }
      case "connect_disconnect": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "connect_disconnect" }>;
        const installation = cmd.installation;
        if (!installation) {
          await replyText("connect.disconnect.missing", undefined, true);
          return true;
        }
        const impacts = [] as Awaited<ReturnType<typeof computeGithubDisconnectImpact>>[];
        for (const installationId of installation) {
          impacts.push(await computeGithubDisconnectImpact(this.deps.db, installationId));
        }
        const token = crypto.randomUUID();
        await createPendingAction(this.deps.db, {
          id: token,
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          userId: opts.userId,
          action: "github_disconnect",
          metadata: {
            installations: installation,
          },
          metadataJson: JSON.stringify({
            platform: opts.platform,
            chat_id: opts.chatId,
            user_id: opts.userId,
            space_id: opts.spaceId,
            workspace_id: opts.workspaceId,
          }),
        });
        const lines = [t("connect.disconnect.title", lang)];
        for (const impact of impacts) {
          lines.push(t("connect.disconnect.installation", lang, { id: impact.installationId, repos: impact.repoCount }));
        }
        lines.push(t("connect.disconnect.confirm", lang, { cmd: formatCmd(`disconnect github confirm ${token}`) }));
        await reply(lines.join("\n"), true);
        return true;
      }
      case "connect_disconnect_confirm": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "connect_disconnect_confirm" }>;
        const pending = await consumePendingAction(this.deps.db, {
          id: cmd.token,
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          userId: opts.userId,
        });
        if (!pending || pending.action !== "github_disconnect") {
          await replyText("connect.disconnect.confirm_missing", undefined, true);
          return true;
        }
        const installations = pending.metadata?.installations ?? [];
        if (!Array.isArray(installations) || !installations.length) {
          await replyText("connect.disconnect.confirm_missing", undefined, true);
          return true;
        }
        const results = [] as string[];
        for (const installationId of installations) {
          try {
            await executeGithubDisconnect(this.deps.db, installationId);
            results.push(t("connect.disconnect.confirmed", lang, { id: installationId }));
          } catch (e) {
            results.push(t("connect.disconnect.failed", lang, { id: installationId, error: redactText(String(e)) }));
          }
        }
        await reply(results.join("\n"), true);
        return true;
      }
      case "repos": {
        const conns = await listConnections(this.deps.db, identity.id);
        if (!conns.length) {
          await replyText("repos.none", undefined, true);
          return true;
        }
        let repos = await listReposForIdentity(this.deps.db, identity.id);
        if (opts.command.provider) {
          repos = repos.filter((repo) => repo.provider === opts.command.provider);
        }
        if (opts.command.search) {
          const query = opts.command.search.toLowerCase();
          repos = repos.filter((repo) => repo.name.toLowerCase().includes(query) || repo.id.toLowerCase().includes(query));
        }
        if (!repos.length) {
          await replyText("repos.none", undefined, true);
          return true;
        }
        this.lastRepoListByIdentity.set(identity.id, repos.map((r) => r.id));
        const lines = [t("repos.title", lang)];
        repos.forEach((repo, index) => {
          lines.push(`${index + 1}. ${repo.name}`);
        });
        const cmdKey = opts.platform === "telegram" ? "repo select" : "repo select";
        lines.push(t("repos.select", lang, { cmd: formatCmd(cmdKey), cmd2: formatCmd("repo select <name>") }));
        await reply(lines.join("\n"), true);
        return true;
      }
      case "repo_select": {
        const repos = await listReposForIdentity(this.deps.db, identity.id);
        if (!repos.length) {
          await replyText("repos.none", undefined, true);
          return true;
        }
        if (opts.command.target === "playground") {
          await setIdentityActiveRepo(this.deps.db, identity.id, PLAYGROUND_REPO_ID);
          await replyText("repo.selected_playground", undefined, true);
          return true;
        }
        const target = opts.command.target;
        const repo = this.resolveRepoTarget(identity.id, repos, target);
        if (!repo) {
          await replyText("repo.not_found", { target: truncateText(target, 40) });
          return true;
        }
        await setIdentityActiveRepo(this.deps.db, identity.id, repo.id);
        await replyText("repo.selected", { name: repo.name }, true);
        return true;
      }
      case "repo_share": {
        if (!opts.command.target) {
          await replyText("repo.share.missing");
          return true;
        }
        const repos = await listReposForIdentity(this.deps.db, identity.id);
        if (!repos.length) {
          await replyText("repos.none", undefined, true);
          return true;
        }
        const repo = this.resolveRepoTarget(identity.id, repos, opts.command.target);
        if (!repo) {
          await replyText("repo.not_found", { target: truncateText(opts.command.target, 40) });
          return true;
        }
        const result = await shareRepo(this.deps.db, {
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
          sharedByUserId: opts.userId,
          repoId: repo.id,
        });
        await replyText("repo.share.ok", { name: repo.name, token: result.token });
        return true;
      }
      case "repo_unshare": {
        if (!opts.command.target) {
          await replyText("repo.unshare.missing");
          return true;
        }
        const repos = await listReposForIdentity(this.deps.db, identity.id);
        if (!repos.length) {
          await replyText("repos.none", undefined, true);
          return true;
        }
        const repo = this.resolveRepoTarget(identity.id, repos, opts.command.target);
        if (!repo) {
          await replyText("repo.not_found", { target: truncateText(opts.command.target, 40) });
          return true;
        }
        const shared = await getSharedRepo(this.deps.db, {
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
          repoId: repo.id,
        });
        if (!shared) {
          await replyText("repo.unshare.none");
          return true;
        }
        await unshareRepo(this.deps.db, {
          id: shared.id,
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
        });
        await replyText("repo.unshare.ok", { name: repo.name });
        return true;
      }
      case "sessions": {
        if (!identity.active_repo_id) {
          await replyText("repo.select_first");
          return true;
        }
        if (isPlaygroundRepoId(identity.active_repo_id)) {
          const runs = await listCloudRunsForPlayground(this.deps.db, identity.id, 10);
          if (!runs.length) {
            await replyText("sessions.empty");
            return true;
          }
          const lines = [t("sessions.title", lang)];
          for (const run of runs) {
            lines.push(`- ${run.id} (${humanStatus(run.status)})`);
            const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
            if (link) lines.push(`  ${link}`);
          }
          await reply(lines.join("\n"), true);
          return true;
        }
        const runs = await listCloudRunsForRepo(this.deps.db, identity.active_repo_id, 10);
        if (!runs.length) {
          await replyText("sessions.empty");
          return true;
        }
        const lines = [t("sessions.title", lang)];
        for (const run of runs) {
          lines.push(`- ${run.id} (${humanStatus(run.status)})`);
          const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
          if (link) lines.push(`  ${link}`);
        }
        await reply(lines.join("\n"), true);
        return true;
      }
      case "status": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "status" }>;
        const run = await getCloudRun(this.deps.db, cmd.runId);
        if (!run || run.identity_id !== identity.id) {
          await replyText("run.not_found");
          return true;
        }
        const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
        const text = link
          ? t("run.status_with_link", lang, { id: run.id, status: run.status, url: link })
          : t("run.status_line", lang, { id: run.id, status: run.status });
        await reply(text, true);
        return true;
      }
      case "pull": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "pull" }>;
        const run = await getCloudRun(this.deps.db, cmd.runId);
        if (!run || run.identity_id !== identity.id) {
          await replyText("run.not_found");
          return true;
        }
        const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
        const lines = [t("run.pull.title", lang, { id: run.id })];
        if (link) lines.push(t("run.pull.link", lang, { url: link }));
        await reply(lines.join("\n"), true);
        return true;
      }
      case "snapshot_save": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_save" }>;
        if (!identity.active_repo_id) {
          await replyText("repo.select_first");
          return true;
        }
        if (!this.deps.cloudManager) {
          await replyText("snapshot.unavailable");
          return true;
        }
        try {
          const { snapshotId, runId } = await this.deps.cloudManager.saveSnapshot({
            identityId: identity.id,
            repoId: identity.active_repo_id,
            note: cmd.note,
          });
          const link = this.buildCloudUiLink(runId, identity.id, opts.isDirect);
          const lines = [t("snapshot.saved", lang, { id: snapshotId })];
          if (link) lines.push(t("snapshot.saved_link", lang, { url: link }));
          await reply(lines.join("\n"), true);
        } catch (e) {
          await replyText("snapshot.save_failed", { error: redactText(String(e)) });
        }
        return true;
      }
      case "snapshot_list": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_list" }>;
        if (!this.deps.cloudManager) {
          await replyText("snapshot.unavailable");
          return true;
        }
        const snapshots = await this.deps.cloudManager.listSnapshots(identity.id, cmd.limit);
        if (!snapshots.length) {
          await replyText("snapshot.none", undefined, true);
          return true;
        }
        this.lastSnapshotListByIdentity.set(
          identity.id,
          snapshots.map((snapshot) => snapshot.id),
        );
        const lines = [t("snapshot.list", lang)];
        snapshots.forEach((snapshot, idx) => {
          const ts = new Date(snapshot.createdAt).toISOString();
          const note = snapshot.note ? ` (${snapshot.note})` : "";
          lines.push(`${idx + 1}. ${snapshot.id}${note} - ${ts}`);
        });
        await reply(lines.join("\n"), true);
        return true;
      }
      case "snapshot_search": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_search" }>;
        if (!this.deps.cloudManager) {
          await replyText("snapshot.unavailable");
          return true;
        }
        const snapshots = await this.deps.cloudManager.searchSnapshots(identity.id, cmd.query, 10);
        if (!snapshots.length) {
          await replyText("snapshot.none", undefined, true);
          return true;
        }
        this.lastSnapshotListByIdentity.set(
          identity.id,
          snapshots.map((snapshot) => snapshot.id),
        );
        const lines = [t("snapshot.list", lang)];
        snapshots.forEach((snapshot, idx) => {
          const ts = new Date(snapshot.createdAt).toISOString();
          const note = snapshot.note ? ` (${snapshot.note})` : "";
          lines.push(`${idx + 1}. ${snapshot.id}${note} - ${ts}`);
        });
        await reply(lines.join("\n"), true);
        return true;
      }
      case "snapshot_restore": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_restore" }>;
        if (!this.deps.cloudManager) {
          await replyText("snapshot.unavailable");
          return true;
        }
        let snapshotId = cmd.snapshotId;
        if (!snapshotId && cmd.snapshotIndex) {
          const last = this.lastSnapshotListByIdentity.get(identity.id);
          if (!last || cmd.snapshotIndex < 1 || cmd.snapshotIndex > last.length) {
            await replyText("snapshot.index_invalid", { index: cmd.snapshotIndex });
            return true;
          }
          snapshotId = last[cmd.snapshotIndex - 1];
        }
        if (!snapshotId) {
          await replyText("snapshot.restore_missing");
          return true;
        }
        const agent = cmd.agent ?? this.deps.config.cloud?.default_agent ?? "codex";
        if (agent === "claude_code" && !this.deps.config.claude_code) {
          await replyText("session.agent_disabled", { agent: "claude_code" });
          return true;
        }
        try {
          const result = await this.deps.cloudManager.restoreSnapshot({
            identityId: identity.id,
            snapshotId,
            agent,
          });
          const link = this.buildCloudUiLink(result.runId, identity.id, opts.isDirect);
          const vscodeUrl = await this.deps.cloudManager.getVscodeUrl(result.sessionId);
          await this.sendCloudRunStartedMessage({
            platform: opts.platform,
            chatId: opts.chatId,
            userId: opts.userId,
            workspaceId: opts.workspaceId,
            text: t("snapshot.restored", lang, { id: snapshotId, runId: result.runId }),
            sessionId: result.sessionId,
            runId: result.runId,
            viewUrl: link,
            vscodeUrl,
            replyToMessageId: opts.replyToMessageId,
            messageThreadId: opts.messageThreadId,
            slackThreadTs: opts.slackThreadTs,
          });
        } catch (e) {
          await replyText("snapshot.restore_failed", { error: redactText(String(e)) });
        }
        return true;
      }
      case "snapshot_clear": {
        if (!this.deps.cloudManager) {
          await replyText("snapshot.unavailable");
          return true;
        }
        const count = await this.deps.cloudManager.clearSnapshots(identity.id);
        await replyText("snapshot.cleared", { count }, true);
        return true;
      }
      case "run": {
        if (!identity.active_repo_id) {
          await replyText("repo.select_first");
          return true;
        }
        const agent = opts.command.agent ?? this.deps.config.cloud?.default_agent ?? "codex";
        if (agent === "claude_code" && !this.deps.config.claude_code) {
          await replyText("session.agent_disabled", { agent: "claude_code" });
          return true;
        }
        const result = await this.deps.cloudManager.startRun({
          identityId: identity.id,
          repoId: identity.active_repo_id,
          message: opts.command.prompt,
          sharedRepoToken: opts.command.sharedRepo,
          agent,
        });
        const link = this.buildCloudUiLink(result.runId, identity.id, opts.isDirect);
        const vscodeUrl = await this.deps.cloudManager.getVscodeUrl(result.sessionId);
        await this.sendCloudRunStartedMessage({
          platform: opts.platform,
          chatId: opts.chatId,
          userId: opts.userId,
          workspaceId: opts.workspaceId,
          text: t("run.started", lang, { id: result.runId }),
          sessionId: result.sessionId,
          runId: result.runId,
          viewUrl: link,
          vscodeUrl,
          replyToMessageId: opts.replyToMessageId,
          messageThreadId: opts.messageThreadId,
          slackThreadTs: opts.slackThreadTs,
        });
        return true;
      }
      case "setup": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "setup" }>;
        if (!identity.active_repo_id) {
          await replyText("repo.select_first");
          return true;
        }
        const spec = await getLatestSetupSpec(this.deps.db, identity.active_repo_id);
        if (spec && !cmd.force) {
          await replyText("setup.exists", undefined, true);
          return true;
        }
        const repo = await this.deps.db
          .selectFrom("repos")
          .selectAll()
          .where("id", "=", identity.active_repo_id)
          .executeTakeFirstOrThrow();
        const conn = await this.deps.db
          .selectFrom("connections")
          .selectAll()
          .where("id", "=", repo.connection_id)
          .executeTakeFirstOrThrow();
        const provider = new LocalCloudProvider(cloud.workspaces_dir, this.deps.logger);
        const workspace = await provider.getWorkspace({
          runId: `setup-${Date.now()}`,
          identityId: identity.id,
        });
        const clone = await buildCloneUrl({
          db: this.deps.db,
          connection: conn,
        });
        await runGitClone({ url: clone.url, cwd: workspace.rootPath, targetDir: path.join(workspace.rootPath, "repo"), logger: this.deps.logger });
        const specResult = await generateSetupSpecFromPath(path.join(workspace.rootPath, "repo"));
        const yml = stringifySetupSpec(specResult.spec);
        const hash = hashSetupSpec(yml);
        await putSetupSpec(this.deps.db, { repoId: repo.id, ymlBlob: yml, hash });
        const urlBase = cloud.public_base_url ?? `http://localhost:${this.deps.config.bot.port}`;
        const url = `${urlBase}/cloud/setup/${repo.id}`;
        await replyText("setup.ready", { url }, true);
        return true;
      }
      case "secrets_list": {
        const secrets = await listSecrets(this.deps.db, identity.id);
        if (!secrets.length) {
          await replyText("secrets.none", undefined, true);
          return true;
        }
        const lines = [t("secrets.list", lang)];
        secrets.forEach((secret) => {
          const createdAt = new Date(secret.created_at).toISOString();
          const updatedAt = new Date(secret.updated_at).toISOString();
          lines.push(`- ${secret.name} (created ${createdAt}, updated ${updatedAt})`);
        });
        await reply(lines.join("\n"), true);
        return true;
      }
      case "secrets_create": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_create" }>;
        if (!cmd.name || !cmd.value) {
          await replyText("secrets.create_missing");
          return true;
        }
        const existing = await listSecrets(this.deps.db, identity.id);
        if (this.findSecretMetaByName(existing, cmd.name)) {
          await replyText("secrets.exists", { name: cmd.name });
          return true;
        }
        const encrypted = encryptSecret({
          secret: cmd.value,
          key: cloud.secrets_key ?? "",
        });
        await setSecret(this.deps.db, { identityId: identity.id, name: cmd.name, encryptedValue: encrypted });
        await replyText("secrets.created", { name: cmd.name }, true);
        return true;
      }
      case "secrets_update": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_update" }>;
        if (!cmd.name || !cmd.value) {
          await replyText("secrets.update_missing");
          return true;
        }
        const existing = await listSecrets(this.deps.db, identity.id);
        if (!this.findSecretMetaByName(existing, cmd.name)) {
          await replyText("secrets.not_found", { name: cmd.name });
          return true;
        }
        const encrypted = encryptSecret({
          secret: cmd.value,
          key: cloud.secrets_key ?? "",
        });
        await setSecret(this.deps.db, { identityId: identity.id, name: cmd.name, encryptedValue: encrypted });
        await replyText("secrets.updated", { name: cmd.name }, true);
        return true;
      }
      case "secrets_delete": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_delete" }>;
        if (!cmd.name) {
          await replyText("secrets.delete_missing");
          return true;
        }
        const existing = await listSecrets(this.deps.db, identity.id);
        if (!this.findSecretMetaByName(existing, cmd.name)) {
          await replyText("secrets.not_found", { name: cmd.name });
          return true;
        }
        await deleteSecret(this.deps.db, { identityId: identity.id, name: cmd.name });
        await replyText("secrets.deleted", { name: cmd.name }, true);
        return true;
      }
      case "repo_list_shared": {
        const repos = await listSharedRepos(this.deps.db, {
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
        });
        if (!repos.length) {
          await replyText("repo.shared.none", undefined, true);
          return true;
        }
        const lines = [t("repo.shared.title", lang)];
        repos.forEach((repo) => {
          lines.push(`- ${repo.name}`);
        });
        await reply(lines.join("\n"), true);
        return true;
      }
      case "help": {
        await this.sendCloudHelp({
          platform: opts.platform,
          chatId: opts.chatId,
          userId: opts.userId,
          workspaceId: opts.workspaceId,
          replyToMessageId: opts.replyToMessageId,
          messageThreadId: opts.messageThreadId,
          slackThreadTs: opts.slackThreadTs,
        });
        return true;
      }
    }
  }
}
