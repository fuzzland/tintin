import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { sleep, TaskQueue } from "./util.js";
import { TelegramClient } from "./platform/telegram.js";
import { SlackClient, type SlackTokenProvider } from "./platform/slack.js";
import type { InteractiveMarkup } from "./platform/base.js";
import { BotController } from "./controller2.js";
import { createCommitProposalRuntime } from "./service/commitProposals.js";
import { CloudManager } from "./cloud/manager.js";
import {
  githubWebhookPollIntervalMs,
  processPendingGithubWebhookEvents,
} from "./cloud/githubWebhook.js";
import { purgeExpiredChatgptStates } from "./chatgpt/store.js";
import { JsonlStreamer } from "./streamer.js";
import { SessionManager } from "./sessionManager.js";
import { createSessionMessenger } from "./service/sessionMessenger.js";
import { getUserLanguage } from "./store.js";
import { addCloudRunScreenshot, getCloudRunBySession } from "./cloud/store.js";
import { uploadScreenshot } from "./cloud/s3.js";
import { authorizeSlackWorkspace, createSlackInstallProvider } from "./slack/oauth.js";
import http from "node:http";
import { PlaywrightMcpManager } from "./playwrightMcp.js";
import { isUserLanguage, t, type UserLanguage } from "../locales/index.js";
import { WebSocketManager } from "./websocket/manager.js";
import { WebSocketHandler } from "./websocket/handler.js";
import { createHttpServer } from "./service/httpServer.js";
import { readHeader, sendText } from "./service/httpUtils.js";

export interface BotServiceDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
}

type CloudConnectMetadata = {
  platform: "telegram" | "slack";
  chat_id: string;
  user_id: string;
  workspace_id?: string | null;
};

function parseCloudConnectMetadata(metadataJson: string | null): CloudConnectMetadata | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as any;
    const platform = parsed?.platform;
    const chatId = parsed?.chat_id;
    const userId = parsed?.user_id;
    const workspaceId = parsed?.workspace_id;
    if ((platform !== "slack" && platform !== "telegram") || typeof chatId !== "string" || typeof userId !== "string") {
      return null;
    }
    return {
      platform,
      chat_id: chatId,
      user_id: userId,
      workspace_id: typeof workspaceId === "string" ? workspaceId : workspaceId === null ? null : undefined,
    };
  } catch {
    return null;
  }
}

export async function createBotService(deps: BotServiceDeps) {
  const { config, db, logger } = deps;
  const slackEventStartTs = Math.floor(Date.now() / 1000);

  /**
   * Determines whether a session is a Telegram forum topic session.
   *
   * In Tintin, Telegram topic-backed sessions are identified by a non-empty `space_emoji`:
   * it is only set when Tintin successfully creates a forum topic and picks an icon.
   */
  const isTelegramTopicSession = (session: { platform: string; space_emoji: string | null }): boolean => {
    return (
      session.platform === "telegram" && typeof session.space_emoji === "string" && session.space_emoji.trim().length > 0
    );
  };

  const resolveSessionLanguage = (session: { language?: string | null }): UserLanguage => {
    const language = session.language;
    return typeof language === "string" && isUserLanguage(language) ? language : "en";
  };

  const resolveUserLanguage = async (platform: "telegram" | "slack", userId: string): Promise<UserLanguage> => {
    try {
      return await getUserLanguage(db, platform, userId);
    } catch {
      return "en";
    }
  };

  const getTelegramReplyMarkup = (markup?: InteractiveMarkup) => {
    if (markup?.type !== "inline_keyboard") return undefined;
    return markup.payload as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  };

  const getSlackBlocks = (markup?: InteractiveMarkup) => {
    return markup?.type === "blocks" ? (markup.payload as unknown[]) : undefined;
  };
  const uiConfig = config.cloud?.ui ?? null;

  const extractPlaywrightTool = (caption?: string): string | null => {
    if (!caption) return null;
    const match = caption.match(/Playwright\\s+(.+?)\\s+(screenshot|截图)/i);
    if (!match) return null;
    const tool = match[1]?.trim();
    if (!tool) return null;
    const lower = tool.toLowerCase();
    if (lower === "screenshot" || tool === "截图") return null;
    return tool;
  };

  const sanitizeFilename = (name: string): string => {
    return name.replace(/[^A-Za-z0-9_.-]+/g, "-");
  };

  const maybeUploadScreenshot = async (sessionId: string, message: { file: Buffer; filename: string; mimeType?: string; caption?: string }) => {
    if (!config.cloud?.enabled || !uiConfig) return;
    if (!uiConfig.s3_bucket || !uiConfig.s3_region || !uiConfig.token_secret) return;
    const run = await getCloudRunBySession(db, sessionId);
    if (!run) return;
    const safePrefix = uiConfig.s3_prefix.replace(/\/+$/g, "");
    const key = `${safePrefix}/${run.id}/${Date.now()}-${sanitizeFilename(message.filename)}`;
    await uploadScreenshot(uiConfig, { key, body: message.file, contentType: message.mimeType });
    await addCloudRunScreenshot(db, {
      runId: run.id,
      sessionId,
      s3Key: key,
      mimeType: message.mimeType ?? null,
      tool: extractPlaywrightTool(message.caption),
    });
  };

  const queue = new TaskQueue(16);
  const githubWebhookIngestQueue = new TaskQueue(4);
  const githubWebhookQueue = new TaskQueue(4);
  let githubWebhookPollInFlight = false;
  const githubWebhookEnabled = Boolean(config.cloud?.enabled && config.cloud.github_app);
  const scheduleGithubWebhookProcessing = (reason: string) => {
    if (!githubWebhookEnabled || !config.cloud) return;
    if (githubWebhookPollInFlight) return;
    githubWebhookPollInFlight = true;
    githubWebhookQueue.enqueue(async () => {
      try {
        const result = await processPendingGithubWebhookEvents({ db, cloud: config.cloud!, logger });
        if (result.processed > 0) {
          logger.info(`[github_webhook] processed=${result.processed} skipped=${result.skipped} reason=${reason}`);
        }
      } catch (err) {
        logger.warn(`[github_webhook] processing failed reason=${reason}: ${String(err)}`);
      } finally {
        githubWebhookPollInFlight = false;
      }
    });
  };
  const reviewCommitDisabled = new Set<string>();

  const telegram = config.telegram ? new TelegramClient(config.telegram, logger) : null;
  const slackInstallProvider = config.slack ? createSlackInstallProvider(config, db, logger) : null;
  const slackTokenProvider: SlackTokenProvider | null = slackInstallProvider
    ? async (context) => {
        const auth = await authorizeSlackWorkspace({
          provider: slackInstallProvider,
          teamId: context.teamId ?? "",
          enterpriseId: context.enterpriseId,
          isEnterpriseInstall: context.isEnterpriseInstall,
        });
        if (!auth.botToken) throw new Error("Slack bot token missing from installation");
        return { token: auth.botToken, expiresAt: auth.botTokenExpiresAt ?? null };
      }
    : null;
  const slack = slackTokenProvider ? new SlackClient(config.slack!, logger, slackTokenProvider, config.bot.log_level) : null;
  const playwrightMcp = config.playwright_mcp?.enabled ? new PlaywrightMcpManager(config.playwright_mcp, logger) : null;

  const { commitProposalStore, maybeHandleCommitProposalMessage, suppressFinalizeForSession } = createCommitProposalRuntime({
    config,
    db,
    logger,
    telegram,
    slack,
    resolveUserLanguage,
    getTelegramReplyMarkup,
    getSlackBlocks,
  });

  // WebSocket manager - initialized here so it's accessible in sendToSession closure
  // The actual setup happens after sessionManager is created
  let wsManager: WebSocketManager | null = null;

  if (config.chatgpt_oauth) {
    const sweep = async () => {
      try {
        const deleted = await purgeExpiredChatgptStates(db);
        if (deleted > 0) logger.info(`[chatgpt][oauth] swept expired states count=${deleted}`);
      } catch (e) {
        logger.warn(`[chatgpt][oauth] state sweep failed: ${String(e)}`);
      }
    };
    let sweepScheduled = false;
    const scheduleSweep = () => {
      if (sweepScheduled) return;
      sweepScheduled = true;
      void sweep();
    };
    void sweep();
    const intervalMs = 5 * 60 * 1000;
    setInterval(() => void sweep(), intervalMs);
    process.once("beforeExit", scheduleSweep);
    process.once("SIGINT", scheduleSweep);
    process.once("SIGTERM", scheduleSweep);
  }
  if (telegram) await telegram.init();
  if (playwrightMcp) {
    process.once("exit", () => void playwrightMcp.stop());
    process.once("SIGINT", () => void playwrightMcp.stop());
    process.once("SIGTERM", () => void playwrightMcp.stop());
  }
  if (githubWebhookEnabled) {
    scheduleGithubWebhookProcessing("startup");
    const intervalMs = githubWebhookPollIntervalMs();
    setInterval(() => scheduleGithubWebhookProcessing("poll"), intervalMs);
  }

  const notifyGithubConnected = async (metadataJson: string | null) => {
    const metadata = parseCloudConnectMetadata(metadataJson);
    if (!metadata) return;
    const lang = await resolveUserLanguage(metadata.platform, metadata.user_id);
    const cmdPrefix = metadata.platform === "telegram" ? "/" : "";
    const text = t("connect.github.connected", lang, { cmd: `\`${cmdPrefix}repos\`` });
    try {
      if (metadata.platform === "telegram") {
        if (!telegram) return;
        const chatId = Number(metadata.chat_id);
        if (!Number.isFinite(chatId)) return;
        await telegram.sendMessage({ chatId, text, priority: "user" });
        return;
      }
      if (!slack) return;
      const workspaceId = metadata.workspace_id ?? null;
      if (!workspaceId) {
        logger.warn(`Slack GitHub connect missing workspace_id chat=${metadata.chat_id} user=${metadata.user_id}`);
        return;
      }
      let channel = metadata.chat_id;
      if (!channel.startsWith("D")) {
        channel = await slack.openConversation({ users: [metadata.user_id], workspaceId });
      }
      await slack.postMessageDetailed({ channel, text, blocksOnLastChunk: false, priority: "user", workspaceId });
    } catch (e) {
      logger.warn(`Failed to send GitHub connect message: ${String(e)}`);
    }
  };

  /**
   * Notify WebSocket client about OAuth completion
   */
  const notifyWebSocketOAuthComplete = async (
    metadataJson: string | null,
    provider: string,
    identityId: string,
  ): Promise<void> => {
    if (!metadataJson || !wsManager) return;
    try {
      const wsMetadata = JSON.parse(metadataJson);
      if (!wsMetadata.connection_id) return;

      // Get account login for GitHub providers
      let accountLogin: string | undefined;
      if (provider === "github") {
        // For GitHub, account_login is stored in github_installations via the connection's installation_id
        const connection = await db
          .selectFrom("connections")
          .innerJoin("github_installations", "connections.installation_id", "github_installations.installation_id")
          .select(["github_installations.account_login"])
          .where("connections.identity_id", "=", identityId)
          .where("connections.type", "like", "github%")
          .orderBy("connections.created_at", "desc")
          .executeTakeFirst();
        accountLogin = connection?.account_login ?? undefined;
      }

      wsManager.sendToConnection(wsMetadata.connection_id, {
        type: 'auth_status',
        provider,
        connected: true,
        accountLogin,
      });
      logger.info(`Sent auth_status to WebSocket connection ${wsMetadata.connection_id}`);
    } catch {
      // Ignore parse errors
    }
  };

  const notifyChatgptConnected = async (metadataJson: string | null) => {
    const metadata = parseCloudConnectMetadata(metadataJson);
    if (!metadata) return;
    const lang = await resolveUserLanguage(metadata.platform, metadata.user_id);
    const cmdPrefix = metadata.platform === "telegram" ? "/" : "";
    const text = t("connect.chatgpt.connected", lang, {
      cmd: `\`${cmdPrefix}connect chatgpt status\``,
    });
    try {
      if (metadata.platform === "telegram") {
        if (!telegram) return;
        const chatId = Number(metadata.chat_id);
        if (!Number.isFinite(chatId)) return;
        await telegram.sendMessage({ chatId, text, priority: "user" });
        return;
      }
      if (!slack) return;
      const workspaceId = metadata.workspace_id ?? null;
      if (!workspaceId) {
        logger.warn(`Slack ChatGPT connect missing workspace_id chat=${metadata.chat_id} user=${metadata.user_id}`);
        return;
      }
      let channel = metadata.chat_id;
      if (!channel.startsWith("D")) {
        channel = await slack.openConversation({ users: [metadata.user_id], workspaceId });
      }
      await slack.postMessageDetailed({ channel, text, blocksOnLastChunk: false, priority: "user", workspaceId });
    } catch (e) {
      logger.warn(`Failed to send ChatGPT connect message: ${String(e)}`);
    }
  };

  const { sendToSession, lookupTelegramSessionId } = createSessionMessenger({
    config,
    db,
    logger,
    telegram,
    slack,
    getWsManager: () => wsManager,
    isTelegramTopicSession,
    resolveSessionLanguage,
    getTelegramReplyMarkup,
    getSlackBlocks,
    maybeUploadScreenshot,
    maybeHandleCommitProposalMessage,
    suppressFinalizeForSession,
    reviewCommitDisabled,
  });

  const streamer = new JsonlStreamer(config, db, logger, sendToSession, playwrightMcp);
  streamer.start();

  const cloudManager = config.cloud?.enabled ? new CloudManager(config, db, logger, null) : null;
  const sessionManager = new SessionManager(
    config,
    db,
    logger,
    sendToSession,
    async (id) => streamer.drainSession(id),
    playwrightMcp,
    cloudManager ? async (sessionId, status) => cloudManager.handleSessionFinished(sessionId, status) : undefined,
  );
  if (cloudManager) cloudManager.attachSessionManager(sessionManager);
  if (cloudManager) await cloudManager.start();
  await sessionManager.reconcileStaleSessions();
  const controller = new BotController(
    config,
    db,
    logger,
    sessionManager,
    telegram,
    slack,
    sendToSession,
    reviewCommitDisabled,
    cloudManager,
    commitProposalStore,
    telegram ? lookupTelegramSessionId : null,
  );

  // WebSocket manager initialization
  let wsHandler: WebSocketHandler | null = null;
  if (config.websocket?.enabled) {
    wsManager = new WebSocketManager(config.websocket, logger);
    wsHandler = new WebSocketHandler(wsManager, sessionManager, config, config.websocket, db, logger, cloudManager);
    wsManager.setHandler((connId, message) => wsHandler!.handleMessage(connId, message));
    wsManager.startHeartbeat();
    logger.info(`[ws] WebSocket enabled on path=${config.websocket.path}`);
  }

  if (telegram && config.telegram?.mode === "poll") {
    logger.info(
      `Telegram polling enabled (timeout=${config.telegram.poll_timeout_seconds}s rate=${config.telegram.rate_limit_msgs_per_sec} msg/s)`,
    );
    let offset: number | undefined;
    (async () => {
      while (true) {
        try {
          const updates = await telegram.getUpdates({ offset });
          for (const update of updates) {
            offset = update.update_id + 1;
            queue.enqueue(async () => {
              try {
                await controller.handleTelegramUpdate(update);
              } catch (e) {
                logger.error("Telegram poll handler error", e);
              }
            });
          }
        } catch (e) {
          logger.error("Telegram poll error", e);
          await sleep(1000);
        }
      }
    })().catch(() => {});
  }

  const { server, handleChatgptCallback } = createHttpServer({
    config,
    db,
    logger,
    controller,
    cloudManager,
    telegram,
    slack,
    slackInstallProvider,
    wsManager,
    slackEventStartTs,
    queue,
    githubWebhookIngestQueue,
    scheduleGithubWebhookProcessing,
    resolveUserLanguage,
    resolveSessionLanguage,
    notifyGithubConnected,
    notifyChatgptConnected,
    notifyWebSocketOAuthComplete,
  });

  // WebSocket upgrade handler
  if (wsManager && config.websocket?.enabled) {
    server.on("upgrade", (req, socket, head) => {
      const reqUrl = req.url ?? "";
      const pathOnly = reqUrl.split("?")[0];
      if (pathOnly === config.websocket!.path) {
        wsManager!.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  }

  let chatgptCallbackServer: http.Server | null = null;

  return {
    async start() {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(config.bot.port, config.bot.host, () => {
          server.off("error", onError);
          logger.info(`Listening on http://${config.bot.host}:${config.bot.port}`);
          resolve();
        });
      });

      if (config.chatgpt_oauth) {
        try {
          const uri = new URL(config.chatgpt_oauth.redirect_uri);
          const targetHost = uri.hostname;
          const targetPort = uri.port ? Number(uri.port) : uri.protocol === "https:" ? 443 : 80;
          const mainPort = config.bot.port;
          const mainHost = config.bot.host;
          const needsSideServer =
            (targetHost === "localhost" || targetHost === "127.0.0.1") &&
            targetPort !== mainPort &&
            (targetHost === mainHost || mainHost === "0.0.0.0");
          if (needsSideServer) {
            chatgptCallbackServer = http.createServer(async (req, res) => {
              if (!req.url || !req.method) {
                sendText(res, 400, "bad request");
                return;
              }
              const url = new URL(req.url, `http://${req.headers.host ?? `${targetHost}:${targetPort}`}`);
              const handled = await handleChatgptCallback(req, res, url, (readHeader(req, "host") ?? "").trim());
              if (!handled) sendText(res, 404, "not found");
            });
            await new Promise<void>((resolve, reject) => {
              const onError = (err: Error) => reject(err);
              chatgptCallbackServer!.once("error", onError);
              chatgptCallbackServer!.listen(targetPort, targetHost, () => {
                chatgptCallbackServer!.off("error", onError);
                logger.info(`[chatgpt][oauth] side callback server listening on http://${targetHost}:${targetPort}`);
                resolve();
              });
            });
          }
        } catch {
          /* ignore bad redirect_uri */
        }
      }
    },
  };
}
