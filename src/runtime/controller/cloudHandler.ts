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
import { buildCloneUrl, buildGitAuthHeader, runGitClone } from "../cloud/git.js";
import { LocalCloudProvider } from "../cloud/localProvider.js";
import { createUiToken } from "../cloud/uiTokens.js";
import { startNotionFlow } from "../cloud/notion/oauth.js";
import {
  getCloudRun,
  getLatestSetupSpec,
  listGithubInstallationsForIdentity,
  createPendingAction,
  consumePendingAction,
  getGithubInstallation,
  getOrCreateIdentity,
  getSharedRepo,
  listCloudRunsForPlayground,
  listCloudRunsForRepo,
  listCloudRunsForIdentity,
  listConnections,
  listReposForIdentity,
  listSecrets,
  listSharedRepos,
  replaceGithubInstallationRepos,
  setIdentityActiveRepo,
  setExaApiKey,
  setGithubMcpToken,
  getGithubMcpToken,
  getExaApiKey,
  getNotionMcpToken,
  deleteNotionMcpToken,
  setSecret,
  shareRepo,
  unshareRepo,
  deleteSecret,
  deleteExaApiKey,
  deleteGithubMcpToken,
  putSetupSpec,
} from "../cloud/store.js";
import {
  completeChatgptOAuth,
  getChatgptAccountForIdentity,
  parseAuthorizationInput as parseChatgptAuthInput,
  revokeChatgptAccount,
  startChatgptOAuth,
} from "../chatgpt/oauth.js";
import { nowMs } from "../util.js";
import { t, type UserLanguage } from "../../locales/index.js";
import {
  PLAYGROUND_REPO_ID,
  humanStatus,
  isPlaygroundRepoId,
  isPlaygroundTarget,
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

  private buildRunActionTelegramKeyboard(
    sessionId: string,
    runId: string,
    lang: UserLanguage,
    viewUrl?: string | null,
    vscodeUrl?: string | null,
  ) {
    const rows: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
      [
        { text: t("button.stop", lang), callback_data: `kill:${sessionId}` },
        { text: t("button.status", lang), callback_data: `run_status:${runId}` },
      ],
    ];
    const linkRow: Array<{ text: string; url: string }> = [];
    if (viewUrl) linkRow.push({ text: t("button.view", lang), url: viewUrl });
    if (vscodeUrl) linkRow.push({ text: t("button.vscode", lang), url: vscodeUrl });
    if (linkRow.length > 0) rows.push(linkRow);
    return { inline_keyboard: rows };
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
        payload: this.buildRunActionTelegramKeyboard(opts.sessionId, opts.runId, opts.lang, opts.viewUrl, opts.vscodeUrl),
      };
    }
    return {
      type: "blocks",
      payload: this.buildRunActionSlackBlocks(opts.sessionId, opts.runId, opts.lang, opts.viewUrl, opts.vscodeUrl),
    };
  }

  private async sendCloudMessage(opts: {
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
    return repos.find((r) => r.name === target) ?? null;
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
              const installationId = conn.installation_id ?? null;
              if (!installationId) {
                staleConnections.push(conn);
                continue;
              }
              const installation = await getGithubInstallation(this.deps.db, installationId);
              if (!installation || !connectedStatuses.has(installation.status)) {
                staleConnections.push(conn);
                continue;
              }
              activeConnections.push({ connection: conn, installation });
            }
            if (staleConnections.length > 0) {
              await this.deps.db
                .deleteFrom("connections")
                .where(
                  "id",
                  "in",
                  staleConnections.map((c) => c.id),
                )
                .execute();
              this.deps.logger.info(
                `[cloud] cleaned stale github_app connections identity=${identity.id} count=${staleConnections.length}`,
              );
            }
            if (activeConnections.length > 0) {
              activeConnections.sort((a, b) => (b.connection.updated_at ?? 0) - (a.connection.updated_at ?? 0));
              if (activeConnections.length === 1) {
                const existing = activeConnections[0]!;
                const installationId = existing.connection.installation_id ?? null;
                const connectedAt = existing.connection.updated_at ? new Date(existing.connection.updated_at).toISOString() : null;
                const lines = [t("github.already_connected.title", lang)];
                if (existing.installation?.account_login) {
                  const accountType = existing.installation.account_type ?? "unknown";
                  lines.push(t("github.already_connected.account", lang, { login: existing.installation.account_login, type: accountType }));
                } else {
                  lines.push(t("github.already_connected.account_unknown", lang));
                }
                if (existing.installation?.status && existing.installation.status !== "active") {
                  lines.push(t("github.already_connected.status", lang, { status: existing.installation.status }));
                }
                if (installationId) lines.push(t("github.already_connected.installation_id", lang, { id: installationId }));
                if (connectedAt) lines.push(t("github.already_connected.connected_at", lang, { ts: connectedAt }));
                await reply(lines.join("\n"), true);
                return true;
              }
              const lines = [t("github.already_connected.title", lang), t("github.already_connected.active_installations", lang)];
              for (const item of activeConnections) {
                const installationId = item.connection.installation_id ?? "unknown";
                const login = item.installation?.account_login ?? "unknown";
                const accountType = item.installation?.account_type ?? "unknown";
                const status = item.installation?.status ?? "unknown";
                lines.push(t("github.already_connected.installation_item", lang, { id: installationId, login, type: accountType, status }));
              }
              lines.push("", t("github.already_connected.disconnect_hint", lang, { cmd: formatCmd("disconnect github --installation <id>") }));
              await reply(lines.join("\n"), true);
              return true;
            }
            if (!cloud.github_app) {
              await replyText("github.missing_config");
              return true;
            }
            const { authorizeUrl } = await startGithubAppFlow({
              db: this.deps.db,
              cloud,
              identityId: identity.id,
              redirectBase: cloud.public_base_url,
              metadataJson,
            });
            await replyText("github.install_link", { url: authorizeUrl }, true);
            return true;
          }
          const { authorizeUrl } = await startOAuthFlow({
            db: this.deps.db,
            cloud,
            provider,
            identityId: identity.id,
            redirectBase: cloud.public_base_url,
            metadataJson,
          });
          await replyText("oauth.authorize_link", { provider, url: authorizeUrl }, true);
        } catch (e) {
          await replyText("connect.failed", { error: String(e) });
        }
        return true;
      }
      case "disconnect": {
        if (!opts.isDirect) {
          await replyText("disconnect.dm_only", { cmd: formatCmd("disconnect github") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "disconnect" }>;
        const provider = cmd.provider;
        if (provider !== "github") {
          await replyText("disconnect.not_supported", { provider });
          return true;
        }
        if (!cloud.github_app) {
          await replyText("github.missing_config");
          return true;
        }
        const confirmToken = (cmd.confirmToken ?? "").trim();
        if (confirmToken) {
          const tokenHash = crypto.createHash("sha256").update(confirmToken, "utf8").digest("hex");
          const pending = await consumePendingAction(this.deps.db, {
            action: "github_disconnect",
            identityId: identity.id,
            tokenHash,
          });
          if (!pending) {
            await replyText("disconnect.token.invalid");
            return true;
          }
          let payload: { installationIds?: string[] } = {};
          try {
            payload = JSON.parse(pending.payload_json ?? "{}") as { installationIds?: string[] };
          } catch {
            await replyText("disconnect.token.payload_invalid");
            return true;
          }
          const installationIds = Array.isArray(payload.installationIds)
            ? payload.installationIds.filter((id) => typeof id === "string" && id.trim().length > 0)
            : [];
          if (installationIds.length === 0) {
            await replyText("disconnect.token.missing_targets");
            return true;
          }
          const results: string[] = [];
          for (const installationId of installationIds) {
            try {
              const impact = await executeGithubDisconnect({
                db: this.deps.db,
                cloud,
                logger: this.deps.logger,
                installationId,
                identityId: identity.id,
                cloudManager: this.deps.cloudManager,
              });
              results.push(
                t("disconnect.result_item", lang, {
                  installationId,
                  repos: impact.repos,
                  runs: impact.runs,
                  sessions: impact.sessions,
                  screenshots: impact.screenshots,
                }),
              );
            } catch (e) {
              await replyText("disconnect.failed_for_installation", { installationId, error: String(e) });
              return true;
            }
          }
          const lines = [t("disconnect.success_title", lang), ...results];
          await reply(lines.join("\n"), true);
          return true;
        }

        const installations = await listGithubInstallationsForIdentity(this.deps.db, identity.id);
        if (installations.length === 0) {
          await replyText("disconnect.none_installed");
          return true;
        }
        let targetIds: string[] = [];
        if (cmd.all) {
          targetIds = installations.map((row) => row.installation_id);
        } else if (cmd.installationId) {
          const match = installations.find((row) => row.installation_id === cmd.installationId);
          if (!match) {
            await replyText("disconnect.installation_not_found", { id: cmd.installationId });
            return true;
          }
          targetIds = [match.installation_id];
        } else if (installations.length === 1) {
          targetIds = [installations[0]!.installation_id];
        } else {
          const lines = [t("disconnect.multiple_found", lang), ""];
          for (const row of installations) {
            const login = row.account_login ?? "unknown";
            lines.push(t("disconnect.multiple_option", lang, { cmd: formatCmd(`disconnect github --installation ${row.installation_id}`), login }));
          }
          lines.push(`- ${formatCmd("disconnect github --all")}`);
          await reply(lines.join("\n"), true);
          return true;
        }

        const impacts = [];
        for (const installationId of targetIds) {
          impacts.push(await computeGithubDisconnectImpact(this.deps.db, installationId));
        }
        const token = crypto.randomBytes(6).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
        await createPendingAction(this.deps.db, {
          action: "github_disconnect",
          identityId: identity.id,
          tokenHash,
          payloadJson: JSON.stringify({ installationIds: targetIds }),
          ttlMs: 10 * 60 * 1000,
        });
        const lines = [
          t("disconnect.confirm_title", lang),
          t("disconnect.uninstall_notice", lang),
          "",
          t("disconnect.targets", lang),
          ...impacts.map((impact) => {
            return t("disconnect.result_item", lang, {
              installationId: impact.installationId,
              repos: impact.repos,
              runs: impact.runs,
              sessions: impact.sessions,
              screenshots: impact.screenshots,
            });
          }),
          "",
          t("disconnect.confirm_with", lang, { cmd: formatCmd(`disconnect github confirm ${token}`) }),
        ];
        await reply(lines.join("\n"), true);
        return true;
      }
      case "connections": {
        const conns = await listConnections(this.deps.db, identity.id);
        if (conns.length === 0) {
          await replyText("connections.none");
          return true;
        }
        const lines = conns.map((c) => t("connections.item", lang, { type: c.type }));
        await reply(lines.join("\n"));
        return true;
      }
      case "mcp_notion_connect": {
        if (!opts.isDirect) {
          await replyText("connect.dm_only", { cmd: formatCmd("mcp notion connect") });
          return true;
        }
        const metadataJson = JSON.stringify({
          platform: opts.platform,
          chat_id: opts.chatId,
          user_id: opts.userId,
          space_id: opts.spaceId,
          workspace_id: opts.workspaceId,
        });
        try {
          const { authorizeUrl } = await startNotionFlow({
            db: this.deps.db,
            config: this.deps.config,
            identityId: identity.id,
            metadataJson,
            logger: this.deps.logger,
          });
          await replyText("oauth.authorize_link", { provider: "Notion", url: authorizeUrl }, true);
        } catch (e) {
          await replyText("notion.oauth.start_failed", { error: String(e) });
        }
        return true;
      }
      case "mcp_notion_status": {
        const token = await getNotionMcpToken(this.deps.db, identity.id);
        if (!token) {
          await replyText("notion.oauth.not_connected");
          return true;
        }
        await replyText("notion.oauth.connected");
        return true;
      }
      case "mcp_notion_disconnect": {
        if (!opts.isDirect) {
          await replyText("connect.dm_only", { cmd: formatCmd("mcp notion disconnect") });
          return true;
        }
        const ok = await deleteNotionMcpToken(this.deps.db, identity.id);
        await replyText(ok ? "notion.oauth.disconnected" : "notion.oauth.not_connected");
        return true;
      }
      case "repos": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "repos" }>;
        const conns = await listConnections(this.deps.db, identity.id);
        for (const conn of conns) {
          try {
            if (conn.type === "github_app") {
              if (!cloud.github_app) {
                this.deps.logger.warn("[cloud] github_app not configured; cannot refresh repos.");
              } else if (!conn.installation_id) {
                this.deps.logger.warn("[cloud] github_app connection missing installation_id; cannot refresh repos.");
              } else {
                const token = await ensureGithubAppToken({
                  db: this.deps.db,
                  config: cloud.github_app,
                  secretKey: cloud.secrets_key,
                  connection: conn,
                  forceRefresh: true,
                });
                const repos = await fetchGithubInstallationRepos({
                  token: token.token,
                  apiBaseUrl: cloud.github_app.api_base_url ?? "https://api.github.com",
                });
                await replaceGithubInstallationRepos(this.deps.db, {
                  installationId: conn.installation_id,
                  repos: repos.map((r) => ({
                    providerRepoId: r.providerRepoId,
                    name: r.name,
                    url: r.url,
                    defaultBranch: r.defaultBranch,
                    archived: r.archived,
                    private: r.private,
                    permissionsJson: r.permissionsJson ?? null,
                  })),
                });
                for (const r of repos) {
                  await this.deps.db
                    .selectFrom("repos")
                    .select(["id"])
                    .where("connection_id", "=", conn.id)
                    .where("provider_repo_id", "=", r.providerRepoId)
                    .executeTakeFirst()
                    .then(async (existing) => {
                      if (existing) return;
                      await this.deps.db
                        .insertInto("repos")
                        .values({
                          id: crypto.randomUUID(),
                          connection_id: conn.id,
                          provider: "github",
                          provider_repo_id: r.providerRepoId,
                          name: r.name,
                          url: r.url,
                          default_branch: r.defaultBranch,
                          fingerprint: null,
                          created_at: nowMs(),
                          updated_at: nowMs(),
                        })
                        .execute();
                    });
                }
              }
            } else if (conn.type === "github_oauth") {
              const repos = await fetchGithubRepos({
                token: conn.access_token,
                apiBaseUrl: cloud.oauth?.github?.api_base_url ?? "https://api.github.com",
              });
              for (const r of repos) {
                await this.deps.db
                  .selectFrom("repos")
                  .select(["id"])
                  .where("connection_id", "=", conn.id)
                  .where("provider_repo_id", "=", r.providerRepoId)
                  .executeTakeFirst()
                  .then(async (existing) => {
                    if (existing) return;
                    await this.deps.db
                      .insertInto("repos")
                      .values({
                        id: crypto.randomUUID(),
                        connection_id: conn.id,
                        provider: "github",
                        provider_repo_id: r.providerRepoId,
                        name: r.name,
                        url: r.url,
                        default_branch: r.defaultBranch,
                        fingerprint: null,
                        created_at: nowMs(),
                        updated_at: nowMs(),
                      })
                      .execute();
                  });
              }
            } else if (conn.type === "gitlab_oauth") {
              const repos = await fetchGitlabRepos({
                token: conn.access_token,
                apiBaseUrl: cloud.oauth?.gitlab?.api_base_url ?? "https://gitlab.com/api/v4",
              });
              for (const r of repos) {
                await this.deps.db
                  .selectFrom("repos")
                  .select(["id"])
                  .where("connection_id", "=", conn.id)
                  .where("provider_repo_id", "=", r.providerRepoId)
                  .executeTakeFirst()
                  .then(async (existing) => {
                    if (existing) return;
                    await this.deps.db
                      .insertInto("repos")
                      .values({
                        id: crypto.randomUUID(),
                        connection_id: conn.id,
                        provider: "gitlab",
                        provider_repo_id: r.providerRepoId,
                        name: r.name,
                        url: r.url,
                        default_branch: r.defaultBranch,
                        fingerprint: null,
                        created_at: nowMs(),
                        updated_at: nowMs(),
                      })
                      .execute();
                  });
              }
            }
          } catch (e) {
            this.deps.logger.warn(`[cloud] repo refresh failed ${conn.type}: ${String(e)}`);
          }
        }
        let repos = await listReposForIdentity(this.deps.db, identity.id);
        if (cmd.provider) {
          repos = repos.filter((r) => r.provider === cmd.provider);
        }
        if (cmd.search) {
          const search = cmd.search.toLowerCase();
          repos = repos.filter((r) => r.name.toLowerCase().includes(search) || r.url.toLowerCase().includes(search));
        }
        if (repos.length === 0) {
          await replyText("repo.none", { cmd: formatCmd("connect") });
          return true;
        }
        this.lastRepoListByIdentity.set(identity.id, repos.map((r) => r.id));
        const lines = [t("repos.title", lang)];
        lines.push(`0. \`${t("repo.playground_label", lang)}\``);
        for (const [index, repo] of repos.entries()) {
          lines.push(`${index + 1}. \`${repo.name}\``);
        }
        lines.push(
          t("repos.select_hint_targets", lang, {
            cmd: formatCmd("repo select <index>"),
            cmd2: formatCmd("repo select <repo-name>"),
            cmd3: formatCmd("repo select 0"),
          }),
        );
        await reply(lines.join("\n"));
        return true;
      }
      case "repo_select": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "repo_select" }>;
        if (isPlaygroundTarget(cmd.target)) {
          await setIdentityActiveRepo(this.deps.db, identity.id, PLAYGROUND_REPO_ID);
          await replyText("repo.active_set_playground", { label: t("repo.playground_label", lang) });
          return true;
        }
        const repos = await listReposForIdentity(this.deps.db, identity.id);
        if (repos.length === 0) {
          await replyText("repo.none", { cmd: formatCmd("connect") });
          return true;
        }
        const repo = this.resolveRepoTarget(identity.id, repos, cmd.target);
        if (!repo) {
          await replyText("repo.not_found", { cmd: formatCmd("repos") });
          return true;
        }
        await setIdentityActiveRepo(this.deps.db, identity.id, repo.id);
        await reply(t("repo.active_set", lang, { name: repo.name, id: repo.id }));
        return true;
      }
      case "repo_current": {
        if (isPlaygroundRepoId(identity.active_repo_id)) {
          await reply(
            t("repo.active_label", lang, {
              label: t("repo.playground_label", lang),
            }),
          );
          return true;
        }
        if (!identity.active_repo_id) {
          await replyText("repo.none_active", {
            select: formatCmd("repo select"),
            playground: formatCmd("repo select playground"),
          });
          return true;
        }
        const repo = await this.deps.db
          .selectFrom("repos")
          .selectAll()
          .where("id", "=", identity.active_repo_id)
          .executeTakeFirst();
        if (!repo) {
          await replyText("repo.active_not_found", { cmd: formatCmd("repo select") });
          return true;
        }
        await reply(t("repo.active_detail", lang, { name: repo.name, id: repo.id }));
        return true;
      }
      case "repo_share": {
        if (!opts.isDirect) {
          await replyText("repo.share_dm_only", { cmd: formatCmd("repo share") });
          return true;
        }
        if (!identity.active_repo_id || isPlaygroundRepoId(identity.active_repo_id)) {
          await replyText("repo.none_active", {
            select: formatCmd("repo select"),
            playground: formatCmd("repo select playground"),
          });
          return true;
        }
        const repo = await this.deps.db
          .selectFrom("repos")
          .selectAll()
          .where("id", "=", identity.active_repo_id)
          .executeTakeFirst();
        const shared = await shareRepo(this.deps.db, {
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
          repoId: identity.active_repo_id,
          sharedByIdentityId: identity.id,
        });
        if (shared.alreadyShared) {
          await replyText("repo.already_shared");
          return true;
        }
        await replyText("repo.shared", { name: repo?.name ?? identity.active_repo_id });
        return true;
      }
      case "repo_unshare": {
        if (!opts.isDirect) {
          await replyText("repo.unshare_dm_only", { cmd: formatCmd("repo unshare") });
          return true;
        }
        if (!identity.active_repo_id || isPlaygroundRepoId(identity.active_repo_id)) {
          await replyText("repo.none_active", {
            select: formatCmd("repo select"),
            playground: formatCmd("repo select playground"),
          });
          return true;
        }
        const repo = await this.deps.db
          .selectFrom("repos")
          .selectAll()
          .where("id", "=", identity.active_repo_id)
          .executeTakeFirst();
        const ok = await unshareRepo(this.deps.db, {
          platform: opts.platform,
          workspaceId: opts.workspaceId,
          chatId: opts.chatId,
          repoId: identity.active_repo_id,
        });
        if (!ok) {
          await replyText("repo.not_shared");
          return true;
        }
        await replyText("repo.unshared", { name: repo?.name ?? identity.active_repo_id });
        return true;
      }
      case "actions_list": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("actions") });
          return true;
        }
        const runs = await listCloudRunsForIdentity(this.deps.db, { identityId: identity.id, limit: 10 });
        if (runs.length === 0) {
          await replyText("run.none_recent");
          return true;
        }
        const lines = [t("run.list.title", lang)];
        for (const run of runs) {
          lines.push(`- ${run.id} (${humanStatus(run.status, lang)})`);
          const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
          if (link) lines.push(`  ${link}`);
        }
        await reply(lines.join("\n"));
        return true;
      }
      case "action_status": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("status <runId>") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "action_status" }>;
        const run = await getCloudRun(this.deps.db, cmd.runId);
        if (!run || run.identity_id !== identity.id) {
          await replyText("run.not_found");
          return true;
        }
        const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
        await reply(
          link
            ? t("run.status_with_link", lang, { id: run.id, status: run.status, url: link })
            : t("run.status_line", lang, { id: run.id, status: run.status }),
        );
        return true;
      }
      case "action_pull": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("pull <runId>") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "action_pull" }>;
        const run = await getCloudRun(this.deps.db, cmd.runId);
        if (!run || run.identity_id !== identity.id) {
          await replyText("run.not_found");
          return true;
        }
        const summary = run.diff_summary ?? t("run.diff_none", lang);
        const link = this.buildCloudUiLink(run.id, identity.id, opts.isDirect);
        const tail = link ? `\nView: ${link}` : "";
        await reply(
          t("run.diff_summary", lang, {
            id: run.id,
            summary,
            cmd: `tinc pull --run ${run.id}`,
            view: tail,
          }),
        );
        return true;
      }
      case "snapshot_save": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_save" }>;
        try {
          const { snapshotId, runId } = await this.deps.cloudManager.saveSnapshot({
            identityId: identity.id,
            note: cmd.note,
            sourceStatus: "manual",
          });
          await replyText("snapshot.saved", { snapshotId, runId });
        } catch (e) {
          await replyText("snapshot.save_failed", { error: String(e) });
        }
        return true;
      }
      case "snapshot_list": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_list" }>;
        const snapshots = await this.deps.cloudManager.listSnapshots(identity.id, cmd.limit);
        if (snapshots.length === 0) {
          await replyText("snapshot.none");
          return true;
        }
        this.lastSnapshotListByIdentity.set(
          identity.id,
          snapshots.map((s) => s.id),
        );
        const formatSnapshot = (s: (typeof snapshots)[number], idx: number) => {
          const noteText = (s.note ?? "").split("\n")[0] ?? "";
          const noteClean = noteText.toLowerCase().startsWith("status:") ? "" : noteText.trim();
          const noteShort = noteClean.length > 0 ? truncateText(noteClean, 200) : t("snapshot.none_label", lang);
          const title = s.title?.trim().length ? truncateText(s.title.trim(), 120) : t("snapshot.none_label", lang);
          const status = humanStatus(s.source_status, lang);
          return [
            `${idx + 1}.`,
            `${t("snapshot.field_id", lang)} ${s.id}`,
            `${t("snapshot.field_title", lang)} ${title}`,
            `${t("snapshot.field_status", lang)} ${status}`,
            `${t("snapshot.field_note", lang)} ${noteShort}`,
            "---",
          ].join("\n");
        };
        const lines = snapshots.map(formatSnapshot);
        lines.push(t("snapshot.restore_hint", lang, { cmd: formatCmd("snapshot restore <index|snapshotId>") }));
        await reply(lines.join("\n"));
        return true;
      }
      case "snapshot_search": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_search" }>;
        if (!cmd.query.trim()) {
          await replyText("snapshot.search_query_required");
          return true;
        }
        const snapshots = await this.deps.cloudManager.searchSnapshots(identity.id, cmd.query, 10);
        if (snapshots.length === 0) {
          await replyText("snapshot.search_none");
          return true;
        }
        this.lastSnapshotListByIdentity.set(
          identity.id,
          snapshots.map((s) => s.id),
        );
        const formatSnapshot = (s: (typeof snapshots)[number], idx: number) => {
          const noteText = (s.note ?? "").split("\n")[0] ?? "";
          const noteClean = noteText.toLowerCase().startsWith("status:") ? "" : noteText.trim();
          const noteShort = noteClean.length > 0 ? truncateText(noteClean, 200) : t("snapshot.none_label", lang);
          const title = s.title?.trim().length ? truncateText(s.title.trim(), 120) : t("snapshot.none_label", lang);
          const status = humanStatus(s.source_status, lang);
          return [
            `${idx + 1}.`,
            `${t("snapshot.field_id", lang)} ${s.id}`,
            `${t("snapshot.field_title", lang)} ${title}`,
            `${t("snapshot.field_status", lang)} ${status}`,
            `${t("snapshot.field_note", lang)} ${noteShort}`,
            "---",
          ].join("\n");
        };
        const lines = snapshots.map(formatSnapshot);
        lines.push(t("snapshot.restore_hint", lang, { cmd: formatCmd("snapshot restore <index|snapshotId>") }));
        await reply(lines.join("\n"));
        return true;
      }
      case "snapshot_restore": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "snapshot_restore" }>;
        let snapshotId = cmd.target.trim();
        const idx = Number(snapshotId);
        if (Number.isInteger(idx)) {
          const last = this.lastSnapshotListByIdentity.get(identity.id);
          if (!last || idx < 1 || idx > last.length) {
            await replyText("snapshot.invalid_index");
            return true;
          }
          snapshotId = last[idx - 1]!;
        }
        const agent = cloud.default_agent === "claude_code" ? "claude_code" : "codex";
        if (agent === "claude_code" && !this.deps.config.claude_code) {
          await replyText("agent.claude_code.not_configured");
          return true;
        }
        try {
          const result = await this.deps.cloudManager.restoreSnapshot({
            identityId: identity.id,
            snapshotId,
            platform: opts.platform,
            workspaceId: opts.workspaceId,
            chatId: opts.chatId,
            spaceId: opts.spaceId,
            userId: opts.userId,
            agent,
          });
          const link = this.buildCloudUiLink(result.runId, identity.id, opts.isDirect);
          const vscodeUrl = await this.deps.cloudManager.getVscodeUrl(result.sessionId);
          const text = t("snapshot.restored", lang, { snapshotId, runId: result.runId });
          await this.sendCloudRunStartedMessage({
            platform: opts.platform,
            chatId: opts.chatId,
            userId: opts.userId,
            workspaceId: opts.workspaceId,
            text,
            sessionId: result.sessionId,
            runId: result.runId,
            viewUrl: link,
            vscodeUrl,
            replyToMessageId: opts.replyToMessageId,
            messageThreadId: opts.messageThreadId,
            slackThreadTs: opts.slackThreadTs,
          });
        } catch (e) {
          await replyText("snapshot.restore_failed", { error: String(e) });
        }
        return true;
      }
      case "snapshot_clear": {
        try {
          const count = await this.deps.cloudManager.clearSnapshots(identity.id);
          await replyText("snapshot.clear_success", { count });
        } catch (e) {
          await replyText("snapshot.clear_failed", { error: String(e) });
        }
        return true;
      }
      case "action_run": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "action_run" }>;
        let repoIds = cmd.repoIds;
        let playground = false;
        if (repoIds.length === 0) {
          if (isPlaygroundRepoId(identity.active_repo_id)) {
            playground = true;
          } else if (identity.active_repo_id) {
            repoIds = [identity.active_repo_id];
          } else {
            playground = true;
          }
        }
        if (!playground) {
          const repos = await listReposForIdentity(this.deps.db, identity.id);
          const repoIdSet = new Set(repos.map((r) => r.id));
          for (const id of repoIds) {
            if (!repoIdSet.has(id)) {
              await replyText("repo.not_found_or_accessible", { id });
              return true;
            }
          }
          if (!opts.isDirect) {
            const shared = await listSharedRepos(this.deps.db, { platform: opts.platform, workspaceId: opts.workspaceId, chatId: opts.chatId });
            const sharedIds = new Set(shared.map((s) => s.repo_id));
            for (const id of repoIds) {
              if (!sharedIds.has(id)) {
                await replyText("repo.not_shared_in_chat", { id });
                return true;
              }
            }
          }
        }
        const agent = cloud.default_agent === "claude_code" ? "claude_code" : "codex";
        if (agent === "claude_code" && !this.deps.config.claude_code) {
          await replyText("agent.claude_code.not_configured");
          return true;
        }
        const prompt = cmd.prompt.trim();
        if (!prompt) {
          await replyText("run.prompt_required");
          return true;
        }
        try {
          const result = await this.deps.cloudManager.startRun({
            identityId: identity.id,
            platform: opts.platform,
            workspaceId: opts.workspaceId,
            chatId: opts.chatId,
            spaceId: opts.spaceId,
            userId: opts.userId,
            prompt,
            repoIds,
            agent,
            playground,
          });
          const link = this.buildCloudUiLink(result.runId, identity.id, opts.isDirect);
          const vscodeUrl = await this.deps.cloudManager.getVscodeUrl(result.sessionId);
          const text = t("run.started", lang, { id: result.runId });
          await this.sendCloudRunStartedMessage({
            platform: opts.platform,
            chatId: opts.chatId,
            userId: opts.userId,
            workspaceId: opts.workspaceId,
            text,
            sessionId: result.sessionId,
            runId: result.runId,
            viewUrl: link,
            vscodeUrl,
            replyToMessageId: opts.replyToMessageId,
            messageThreadId: opts.messageThreadId,
            slackThreadTs: opts.slackThreadTs,
          });
        } catch (e) {
          const msg = String(e);
          if (/ChatGPT auth missing or expired/i.test(msg) || /ChatGPT token unavailable/i.test(msg) || msg.includes("CHATGPT_AUTH_ERROR_PREFIX")) {
            await replyText("run.failed_auth", { cmd: formatCmd("connect chatgpt") });
          } else {
            await replyText("run.failed", { error: msg });
          }
        }
        return true;
      }
      case "setup_status": {
        if (isPlaygroundRepoId(identity.active_repo_id)) {
          await replyText("setup.playground_no_repo_manage");
          return true;
        }
        if (!identity.active_repo_id) {
          await replyText("repo.none_active_simple");
          return true;
        }
        const spec = await getLatestSetupSpec(this.deps.db, identity.active_repo_id);
        if (!spec) {
          await replyText("setup.no_spec", { cmd: formatCmd("setup lift") });
          return true;
        }
        await replyText("setup.configured");
        return true;
      }
      case "setup_lift": {
        if (isPlaygroundRepoId(identity.active_repo_id)) {
          await replyText("setup.playground_no_repo_lift");
          return true;
        }
        if (!identity.active_repo_id) {
          await replyText("repo.none_active_simple");
          return true;
        }
        try {
          const repo = await this.deps.db.selectFrom("repos").selectAll().where("id", "=", identity.active_repo_id).executeTakeFirstOrThrow();
          const conn = await this.deps.db.selectFrom("connections").selectAll().where("id", "=", repo.connection_id).executeTakeFirstOrThrow();
          const provider = new LocalCloudProvider(cloud.workspaces_dir, this.deps.logger);
          const workspace = await provider.createWorkspace({ prefix: "lift" });
          let cloneToken = conn.access_token;
          let cloneUser: string | undefined;
          if (conn.type === "github_app" && cloud.github_app) {
            const token = await ensureGithubAppToken({
              db: this.deps.db,
              config: cloud.github_app,
              secretKey: cloud.secrets_key,
              connection: conn,
            });
            cloneToken = token.token;
            cloneUser = "x-access-token";
          }
          const clone = buildCloneUrl(repo.url, cloneToken, cloneUser ? { username: cloneUser } : undefined);
          const authHeader = buildGitAuthHeader(cloneToken, cloneUser);
          await runGitClone({
            url: clone.url,
            cwd: workspace.rootPath,
            targetDir: path.join(workspace.rootPath, "repo"),
            logger: this.deps.logger,
            authHeader,
          });
          const spec = await generateSetupSpecFromPath(path.join(workspace.rootPath, "repo"));
          const yml = stringifySetupSpec(spec);
          const hash = hashSetupSpec(yml);
          await putSetupSpec(this.deps.db, { repoId: repo.id, ymlBlob: yml, hash });
          await provider.terminateWorkspace(workspace);
          await replyText("setup.lift_saved");
        } catch (e) {
          await replyText("setup.lift_failed", { error: String(e) });
        }
        return true;
      }
      case "tinc_token": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("tinc token") });
          return true;
        }
        const ui = cloud.ui;
        if (!ui || !ui.token_secret) {
          await replyText("cloud.ui_token_missing");
          return true;
        }
        const token = createUiToken(ui, { scope: "identity", identity_id: identity.id });
        const baseRaw =
          cloud.public_base_url && cloud.public_base_url.trim().length > 0
            ? cloud.public_base_url
            : `http://localhost:${this.deps.config.bot.port}`;
        const baseUrl = baseRaw.replace(/\/+$/g, "");
        const ttlMs = ui.token_ttl_ms;
        const ttl =
          typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
            ? ttlMs >= 60 * 60 * 1000
              ? `${(ttlMs / (60 * 60 * 1000)).toFixed(1)}h`
              : `${Math.max(1, Math.round(ttlMs / (60 * 1000)))}m`
            : null;
        const lines = [
          t("tinc.token.title", lang),
          "`" + token + "`",
          "",
          t("tinc.token.env_vars", lang),
          "`TINC_URL=" + baseUrl + "`",
          "`TINC_TOKEN=<token>`",
          "",
          t("tinc.token.example", lang),
          "`TINC_URL=" + baseUrl + " TINC_TOKEN=<token> tinc pull --run <id>`",
          ttl ? t("tinc.token.ttl", lang, { ttl }) : null,
        ].filter((line): line is string => Boolean(line));
        await reply(lines.join("\n"), true);
        return true;
      }
      case "secrets_set": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("secrets set") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_set" }>;
        if (!cmd.value) {
          await replyText("secrets.usage_set", { cmd: formatCmd("secrets set NAME VALUE") });
          return true;
        }
        try {
          const encrypted = encryptSecret(cmd.value, cloud.secrets_key);
          await setSecret(this.deps.db, { identityId: identity.id, name: cmd.name, encryptedValue: encrypted });
          await replyText("secrets.saved", { name: cmd.name });
        } catch (e) {
          await replyText("secrets.save_failed", { error: String(e) });
        }
        return true;
      }
      case "secrets_create": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("secrets create") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_create" }>;
        if (!cmd.value) {
          await replyText("secrets.usage_create", { cmd: formatCmd("secrets create NAME VALUE") });
          return true;
        }
        const existing = await listSecrets(this.deps.db, identity.id);
        if (this.findSecretMetaByName(existing, cmd.name)) {
          await replyText("secrets.exists", { name: cmd.name, cmd: formatCmd("secrets update") });
          return true;
        }
        try {
          const encrypted = encryptSecret(cmd.value, cloud.secrets_key);
          await setSecret(this.deps.db, { identityId: identity.id, name: cmd.name, encryptedValue: encrypted });
          await replyText("secrets.created", { name: cmd.name });
        } catch (e) {
          await replyText("secrets.create_failed", { error: String(e) });
        }
        return true;
      }
      case "secrets_update": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("secrets update") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_update" }>;
        if (!cmd.value) {
          await replyText("secrets.usage_update", { cmd: formatCmd("secrets update NAME VALUE") });
          return true;
        }
        const existing = await listSecrets(this.deps.db, identity.id);
        if (!this.findSecretMetaByName(existing, cmd.name)) {
          await replyText("secrets.not_found_use_create", { name: cmd.name, cmd: formatCmd("secrets create") });
          return true;
        }
        try {
          const encrypted = encryptSecret(cmd.value, cloud.secrets_key);
          await setSecret(this.deps.db, { identityId: identity.id, name: cmd.name, encryptedValue: encrypted });
          await replyText("secrets.updated", { name: cmd.name });
        } catch (e) {
          await replyText("secrets.update_failed", { error: String(e) });
        }
        return true;
      }
      case "secrets_list": {
        const secrets = await listSecrets(this.deps.db, identity.id);
        if (secrets.length === 0) {
          await replyText("secrets.none");
          return true;
        }
        await reply(secrets.map((s) => `- \`${s.name}\``).join("\n"));
        return true;
      }
      case "secrets_delete": {
        const cmd = opts.command as Extract<CloudCommand, { kind: "secrets_delete" }>;
        const ok = await deleteSecret(this.deps.db, identity.id, cmd.name);
        await reply(ok ? t("secrets.deleted", lang, { name: cmd.name }) : t("secrets.delete_not_found", lang));
        return true;
      }
      case "mcp_github_token_set": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("mcp github token set") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "mcp_github_token_set" }>;
        if (!cmd.token) {
          await replyText("mcp.github_token.usage_set", { cmd: formatCmd("mcp github token set <token>") });
          return true;
        }
        if (!cloud.secrets_key) {
          await replyText("cloud.secrets_missing");
          return true;
        }
        try {
          const encrypted = encryptSecret(cmd.token, cloud.secrets_key);
          await setGithubMcpToken(this.deps.db, { identityId: identity.id, encryptedToken: encrypted });
          await replyText("mcp.github_token.saved");
        } catch (e) {
          await replyText("mcp.github_token.save_failed", { error: String(e) });
        }
        return true;
      }
      case "mcp_github_token_status": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("mcp github token status") });
          return true;
        }
        const row = await getGithubMcpToken(this.deps.db, identity.id);
        await replyText(row?.encrypted_token ? "mcp.github_token.status_set" : "mcp.github_token.status_missing");
        return true;
      }
      case "mcp_github_token_delete": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("mcp github token delete") });
          return true;
        }
        const ok = await deleteGithubMcpToken(this.deps.db, identity.id);
        await replyText(ok ? "mcp.github_token.deleted" : "mcp.github_token.delete_missing");
        return true;
      }
      case "mcp_exa_key_set": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("mcp exa key set") });
          return true;
        }
        const cmd = opts.command as Extract<CloudCommand, { kind: "mcp_exa_key_set" }>;
        if (!cmd.key) {
          await replyText("mcp.exa_key.usage_set", { cmd: formatCmd("mcp exa key set <key>") });
          return true;
        }
        if (!cloud.secrets_key) {
          await replyText("cloud.secrets_missing");
          return true;
        }
        try {
          await setExaApiKey(this.deps.db, identity.id, cmd.key, cloud.secrets_key);
          await replyText("mcp.exa_key.saved");
        } catch (e) {
          await replyText("mcp.exa_key.save_failed", { error: String(e) });
        }
        return true;
      }
      case "mcp_exa_key_status": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("mcp exa key status") });
          return true;
        }
        const key = await getExaApiKey(this.deps.db, identity.id);
        await replyText(key ? "mcp.exa_key.status_set" : "mcp.exa_key.status_missing");
        return true;
      }
      case "mcp_exa_key_delete": {
        if (!opts.isDirect) {
          await replyText("command.dm_only", { cmd: formatCmd("mcp exa key delete") });
          return true;
        }
        const ok = await deleteExaApiKey(this.deps.db, identity.id);
        await replyText(ok ? "mcp.exa_key.deleted" : "mcp.exa_key.delete_missing");
        return true;
      }
    }
    return false;
  }
}
