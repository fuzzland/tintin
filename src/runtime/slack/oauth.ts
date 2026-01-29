import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import { nowMs } from "../util.js";
import {
  InstallProvider,
  type AuthorizeResult,
  type CallbackOptions,
  type InstallPathOptions,
  type Installation,
  type InstallationQuery,
  type InstallationStore,
  type InstallURLOptions,
  LogLevel as SlackLogLevel,
} from "@slack/oauth";

export const SLACK_INSTALL_PATH = "/slack/install";
export const SLACK_OAUTH_REDIRECT_PATH = "/slack/oauth_redirect";

const normalizeScopes = (scopes: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of scopes) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const buildSlackInstallUrlOptions = (config: AppConfig): InstallURLOptions => {
  if (!config.slack) throw new Error("Slack not configured");
  const base = config.cloud?.public_base_url?.replace(/\/+$/g, "");
  if (!base) throw new Error("cloud.public_base_url is required for Slack OAuth");
  const redirectUri = `${base}${SLACK_OAUTH_REDIRECT_PATH}`;
  const scopes = normalizeScopes(config.slack.scopes);
  const userScopes = normalizeScopes(config.slack.user_scopes);
  return {
    scopes,
    userScopes: userScopes.length > 0 ? userScopes : undefined,
    redirectUri,
  };
};

const resolveInstallIds = (installation: Installation): {
  teamId: string | null;
  enterpriseId: string | null;
  isEnterpriseInstall: boolean;
} => {
  const teamId = installation.team?.id ?? null;
  const enterpriseId = installation.enterprise?.id ?? null;
  const isEnterpriseInstall = Boolean(installation.isEnterpriseInstall);
  if (!teamId && !enterpriseId) {
    throw new Error("Slack installation missing team_id and enterprise_id");
  }
  return { teamId, enterpriseId, isEnterpriseInstall };
};

export class SlackInstallationStore implements InstallationStore {
  constructor(private readonly db: Db, private readonly logger: Logger) {}

  async storeInstallation(installation: Installation): Promise<void> {
    const { teamId, enterpriseId, isEnterpriseInstall } = resolveInstallIds(installation);
    const now = nowMs();
    const record = {
      id: crypto.randomUUID(),
      team_id: teamId,
      enterprise_id: enterpriseId,
      is_enterprise_install: isEnterpriseInstall ? 1 : 0,
      bot_token: installation.bot?.token ?? null,
      bot_refresh_token: installation.bot?.refreshToken ?? null,
      bot_token_expires_at: installation.bot?.expiresAt ?? null,
      installed_by_user_id: installation.user?.id ?? null,
      data_json: JSON.stringify(installation),
      created_at: now,
      updated_at: now,
    };

    if (isEnterpriseInstall) {
      if (!enterpriseId) throw new Error("Enterprise install missing enterprise_id");
      await this.db
        .insertInto("slack_installations")
        .values(record)
        .onConflict((oc) =>
          oc.column("enterprise_id").doUpdateSet({
            team_id: record.team_id,
            enterprise_id: record.enterprise_id,
            is_enterprise_install: record.is_enterprise_install,
            bot_token: record.bot_token,
            bot_refresh_token: record.bot_refresh_token,
            bot_token_expires_at: record.bot_token_expires_at,
            installed_by_user_id: record.installed_by_user_id,
            data_json: record.data_json,
            updated_at: record.updated_at,
          }),
        )
        .execute();
      return;
    }

    if (!teamId) throw new Error("Workspace install missing team_id");
    await this.db
      .insertInto("slack_installations")
      .values(record)
      .onConflict((oc) =>
        oc.column("team_id").doUpdateSet({
          team_id: record.team_id,
          enterprise_id: record.enterprise_id,
          is_enterprise_install: record.is_enterprise_install,
          bot_token: record.bot_token,
          bot_refresh_token: record.bot_refresh_token,
          bot_token_expires_at: record.bot_token_expires_at,
          installed_by_user_id: record.installed_by_user_id,
          data_json: record.data_json,
          updated_at: record.updated_at,
        }),
      )
      .execute();
  }

  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation> {
    const isEnterpriseInstall = Boolean(query.isEnterpriseInstall);
    if (isEnterpriseInstall) {
      if (!query.enterpriseId) throw new Error("Slack enterprise install fetch missing enterprise_id");
      const row = await this.db
        .selectFrom("slack_installations")
        .selectAll()
        .where("enterprise_id", "=", query.enterpriseId)
        .executeTakeFirst();
      if (!row) throw new Error(`Slack installation not found enterprise_id=${query.enterpriseId}`);
      return JSON.parse(row.data_json) as Installation;
    }
    if (!query.teamId) throw new Error("Slack workspace install fetch missing team_id");
    const row = await this.db
      .selectFrom("slack_installations")
      .selectAll()
      .where("team_id", "=", query.teamId)
      .executeTakeFirst();
    if (!row) throw new Error(`Slack installation not found team_id=${query.teamId}`);
    return JSON.parse(row.data_json) as Installation;
  }

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    const isEnterpriseInstall = Boolean(query.isEnterpriseInstall);
    if (isEnterpriseInstall) {
      if (!query.enterpriseId) throw new Error("Slack enterprise install delete missing enterprise_id");
      await this.db.deleteFrom("slack_installations").where("enterprise_id", "=", query.enterpriseId).execute();
      return;
    }
    if (!query.teamId) throw new Error("Slack workspace install delete missing team_id");
    await this.db.deleteFrom("slack_installations").where("team_id", "=", query.teamId).execute();
  }
}

const slackLogLevel = (rawLevel: string | undefined): SlackLogLevel => {
  if (rawLevel === "debug") return SlackLogLevel.DEBUG;
  if (rawLevel === "info") return SlackLogLevel.INFO;
  if (rawLevel === "warn") return SlackLogLevel.WARN;
  return SlackLogLevel.ERROR;
};

export const createSlackInstallProvider = (config: AppConfig, db: Db, logger: Logger): InstallProvider => {
  if (!config.slack) {
    throw new Error("Slack not configured");
  }
  return new InstallProvider({
    clientId: config.slack.client_id,
    clientSecret: config.slack.client_secret,
    stateSecret: config.slack.state_secret,
    installationStore: new SlackInstallationStore(db, logger),
    authVersion: "v2",
    logLevel: slackLogLevel(config.bot.log_level),
    directInstall: true,
    installUrlOptions: buildSlackInstallUrlOptions(config),
  });
};

export const getSlackInstallUrlOptions = (config: AppConfig): InstallURLOptions => {
  return buildSlackInstallUrlOptions(config);
};

export const handleSlackInstall = async (opts: {
  provider: InstallProvider;
  req: IncomingMessage;
  res: ServerResponse;
  config: AppConfig;
  options?: InstallPathOptions;
}) => {
  const installOptions = buildSlackInstallUrlOptions(opts.config);
  await opts.provider.handleInstallPath(opts.req, opts.res, opts.options, installOptions);
};

export const handleSlackOauthCallback = async (opts: {
  provider: InstallProvider;
  req: IncomingMessage;
  res: ServerResponse;
  config: AppConfig;
  options?: CallbackOptions;
}) => {
  const installOptions = buildSlackInstallUrlOptions(opts.config);
  await opts.provider.handleCallback(opts.req, opts.res, opts.options, installOptions);
};

export const authorizeSlackWorkspace = async (opts: {
  provider: InstallProvider;
  teamId: string;
  enterpriseId?: string | null;
  isEnterpriseInstall?: boolean;
}): Promise<AuthorizeResult> => {
  const isEnterpriseInstall = Boolean(opts.isEnterpriseInstall);
  if (isEnterpriseInstall && !opts.enterpriseId) {
    throw new Error("Slack authorize missing enterprise_id");
  }
  if (!isEnterpriseInstall && !opts.teamId) {
    throw new Error("Slack authorize missing team_id");
  }
  return await opts.provider.authorize({
    teamId: isEnterpriseInstall ? undefined : opts.teamId,
    enterpriseId: opts.enterpriseId ?? undefined,
    isEnterpriseInstall,
  });
};
