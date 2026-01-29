import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { BotController } from "../controller2.js";
import type { CloudManager } from "../cloud/manager.js";
import type { TelegramClient } from "../platform/telegram.js";
import type { SlackClient } from "../platform/slack.js";
import type { InstallProvider } from "@slack/oauth";
import type { WebSocketManager } from "../websocket/manager.js";
import type { TaskQueue } from "../util.js";
import { t, type UserLanguage } from "../../locales/index.js";
import { contentTypeForPath, readHeader, readRequestBody, sendJson, sendText } from "./httpUtils.js";
import { createProxyToken, handleProxyRequest } from "../cloud/proxy.js";
import { handleOAuthCallback } from "../cloud/oauth.js";
import { handleGithubAppCallback } from "../cloud/githubApp.js";
import {
  githubWebhookAppIdMatches,
  githubWebhookMaxBodyBytes,
  parseGithubWebhookPayload,
  recordGithubWebhookEvent,
  shouldHandleGithubWebhookEvent,
  verifyGithubWebhookSignature,
} from "../cloud/githubWebhook.js";
import { completeChatgptOAuth, isAllowedRedirectHost } from "../chatgpt/oauth.js";
import { verifySlackSignature } from "../platform/slack.js";
import { SLACK_INSTALL_PATH, SLACK_OAUTH_REDIRECT_PATH, handleSlackInstall, handleSlackOauthCallback } from "../slack/oauth.js";
import { handleAgentRoutes } from "./http/agentRoutes.js";
import { handleCloudApiRoutes } from "./http/cloudApiRoutes.js";

const buildChatgptOauthSuccessHtml = (lang: UserLanguage): string => {
  const title = escapeHtml(t("chatgpt.oauth.success_title", lang));
  const message = escapeHtml(t("chatgpt.oauth.success_message", lang));
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { background: #0b1021; color: #e8edf7; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; padding: 32px; }
      .card { max-width: 720px; margin: 0 auto; border: 1px solid #23304f; border-radius: 8px; padding: 24px; background: #0f172a; }
      h1 { margin-top: 0; }
      .muted { color: #9fb0d3; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p class="muted">${message}</p>
    </div>
  </body>
</html>`;
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

export type CreateHttpServerDeps = {
  config: AppConfig;
  db: Db;
  logger: Logger;
  controller: BotController;
  cloudManager: CloudManager | null;
  telegram: TelegramClient | null;
  slack: SlackClient | null;
  slackInstallProvider: InstallProvider | null;
  wsManager: WebSocketManager | null;
  slackEventStartTs: number;
  queue: TaskQueue;
  githubWebhookIngestQueue: TaskQueue;
  scheduleGithubWebhookProcessing: (reason: string) => void;
  resolveUserLanguage: (platform: "telegram" | "slack", userId: string) => Promise<UserLanguage>;
  resolveSessionLanguage: (session: { language?: string | null }) => UserLanguage;
  notifyGithubConnected: (metadataJson: string | null) => Promise<void>;
  notifyChatgptConnected: (metadataJson: string | null) => Promise<void>;
  notifyWebSocketOAuthComplete: (metadataJson: string | null, provider: string, identityId: string) => Promise<void>;
};

export function createHttpServer(deps: CreateHttpServerDeps) {
  const { config, db, logger } = deps;
  const uiConfig = config.cloud?.ui ?? null;

  const handleChatgptCallback = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    hostHeader: string,
  ) => {
    if (!config.chatgpt_oauth) return false;
    let chatgptPath: string | null = null;
    try {
      chatgptPath = new URL(config.chatgpt_oauth.redirect_uri).pathname;
    } catch {
      chatgptPath = null;
    }
    if (!chatgptPath || url.pathname !== chatgptPath || req.method !== "GET") return false;
    const hostValue = hostHeader.split(",")[0]?.trim().toLowerCase() ?? "";
    if (hostValue && !isAllowedRedirectHost(hostValue, config.chatgpt_oauth)) {
      sendText(res, 400, "Host not allowed");
      return true;
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) {
      sendText(res, 400, "Missing OAuth parameters");
      return true;
    }
    try {
      logger.info(`[chatgpt][oauth] callback received host=${hostValue || "(none)"} state=${state}`);
      const result = await completeChatgptOAuth({ db, config, code, state, logger });
      logger.info(
        `[chatgpt][oauth] linked via callback identity=${result.identityId} account=${result.chatgptUserId} workspace=${result.workspaceId ?? "(none)"}`,
      );
      await deps.notifyChatgptConnected(result.metadataJson);
      const metadata = result.metadataJson ? JSON.parse(result.metadataJson) : null;
      const lang =
        metadata && typeof metadata.platform === "string" && typeof metadata.user_id === "string"
          ? await deps.resolveUserLanguage(metadata.platform, metadata.user_id)
          : "en";
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(buildChatgptOauthSuccessHtml(lang));
    } catch (e) {
      sendText(res, 400, `ChatGPT OAuth failed: ${String(e)}`);
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.method) {
      sendText(res, 400, "bad request");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? `${config.bot.host}:${config.bot.port}`}`);
    const pathname = url.pathname;

    try {
      if (req.method === "GET" && pathname === "/healthz") {
        sendText(res, 200, "ok");
        return;
      }

      if (req.method === "OPTIONS" && pathname === "/api/ws/token") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "GET" && pathname === "/api/ws/token") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        const proxy = config.cloud?.proxy;
        if (!proxy?.shared_secret) {
          sendJson(res, 500, { error: "WebSocket token auth not configured" });
          return;
        }
        const identityId = `ws:web:${crypto.randomUUID().slice(0, 8)}`;
        const ttlMs = proxy.token_ttl_ms ?? 3600000;
        const token = createProxyToken(proxy.shared_secret, identityId, ttlMs);
        sendJson(res, 200, { token, identityId, expiresIn: ttlMs });
        return;
      }

      if (deps.slackInstallProvider && req.method === "GET" && pathname === SLACK_INSTALL_PATH) {
        try {
          await handleSlackInstall({ provider: deps.slackInstallProvider, req, res, config });
        } catch (e) {
          sendText(res, 400, `Slack install failed: ${String(e)}`);
        }
        return;
      }

      if (deps.slackInstallProvider && req.method === "GET" && pathname === SLACK_OAUTH_REDIRECT_PATH) {
        try {
          await handleSlackOauthCallback({ provider: deps.slackInstallProvider, req, res, config });
        } catch (e) {
          sendText(res, 400, `Slack OAuth failed: ${String(e)}`);
        }
        return;
      }

      const pathParts = pathname.split("/").filter(Boolean);
      if (
        await handleAgentRoutes({
          deps: {
            config,
            db,
            logger,
            cloudManager: deps.cloudManager,
            wsManager: deps.wsManager,
          },
          req,
          res,
          url,
          pathname,
          pathParts,
        })
      ) {
        return;
      }

      if (
        await handleCloudApiRoutes({
          deps: {
            config,
            db,
            logger,
            resolveSessionLanguage: deps.resolveSessionLanguage,
          },
          req,
          res,
          url,
          pathname,
          pathParts,
        })
      ) {
        return;
      }

      if (config.cloud?.proxy?.enabled) {
        if (pathname.startsWith(config.cloud.proxy.openai_path)) {
          await handleProxyRequest({
            req,
            res,
            config,
            db,
            logger,
            kind: "openai",
            pathPrefix: config.cloud.proxy.openai_path,
            url,
          });
          return;
        }
        if (pathname.startsWith(config.cloud.proxy.anthropic_path)) {
          await handleProxyRequest({
            req,
            res,
            config,
            db,
            logger,
            kind: "anthropic",
            pathPrefix: config.cloud.proxy.anthropic_path,
            url,
          });
          return;
        }
      }

      if (req.method === "POST" && shouldHandleGithubWebhookEvent(config.cloud, pathname)) {
        const cfg = config.cloud!.github_app!;
        const contentType = readHeader(req, "content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          sendText(res, 415, "unsupported content-type");
          return;
        }
        let bodyText = "";
        try {
          bodyText = await readRequestBody(req, githubWebhookMaxBodyBytes());
        } catch (err) {
          const msg = String(err);
          logger.warn(`[github_webhook] body read failed: ${msg}`);
          if (msg.toLowerCase().includes("too large")) {
            sendText(res, 413, "payload too large");
          } else {
            sendText(res, 400, "bad request");
          }
          return;
        }
        const signatureHeader256 = readHeader(req, "x-hub-signature-256");
        const signatureHeader = readHeader(req, "x-hub-signature");
        if (
          !verifyGithubWebhookSignature({
            body: bodyText,
            signature256: signatureHeader256,
            signature: signatureHeader,
            secret: cfg.webhook_secret,
          })
        ) {
          logger.warn("[github_webhook] unauthorized (bad signature)");
          sendText(res, 401, "unauthorized");
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(bodyText);
        } catch {
          logger.warn("[github_webhook] invalid JSON");
          sendText(res, 400, "bad request");
          return;
        }
        const meta = parseGithubWebhookPayload(payload);
        if (!githubWebhookAppIdMatches(meta.appId, cfg.app_id)) {
          logger.warn("[github_webhook] app_id mismatch");
          sendText(res, 403, "forbidden");
          return;
        }
        const event = readHeader(req, "x-github-event") ?? "";
        const deliveryId = readHeader(req, "x-github-delivery") ?? "";
        if (!event || !deliveryId) {
          sendText(res, 400, "missing webhook headers");
          return;
        }
        const headersJson = JSON.stringify({
          "x-github-event": event,
          "x-github-delivery": deliveryId,
          "x-hub-signature-256": signatureHeader256 ?? null,
          "x-hub-signature": signatureHeader ?? null,
          "user-agent": readHeader(req, "user-agent"),
          "content-type": contentType,
        });
        deps.githubWebhookIngestQueue.enqueue(async () => {
          try {
            const result = await recordGithubWebhookEvent({
              db,
              deliveryId,
              event,
              action: meta.action,
              installationId: meta.installationId,
              repoId: meta.repoId,
              headersJson,
              payloadJson: bodyText,
            });
            if (result === "duplicate") {
              logger.info(`[github_webhook] duplicate delivery_id=${deliveryId}`);
              return;
            }
            deps.scheduleGithubWebhookProcessing("webhook");
          } catch (err) {
            logger.error(`[github_webhook] persist failed delivery_id=${deliveryId}`, err);
          }
        });
        sendText(res, 202, "accepted");
        return;
      }

      if (config.chatgpt_oauth && (await handleChatgptCallback(req, res, url, (readHeader(req, "host") ?? "").trim()))) return;

      if (config.cloud?.enabled && req.method === "GET" && pathname === config.cloud.oauth.callback_path) {
        const installationId = url.searchParams.get("installation_id");
        const state = url.searchParams.get("state") ?? "";
        if (installationId) {
          if (!state) {
            sendText(res, 400, "Missing GitHub App state");
            return;
          }
          try {
            const result = await handleGithubAppCallback({ db, cloud: config.cloud, installationId, state });
            await deps.notifyWebSocketOAuthComplete(result.metadataJson, result.provider, result.identityId);
            await deps.notifyGithubConnected(result.metadataJson);
            sendText(res, 200, "Connected. Return to the chat.");
          } catch (e) {
            sendText(res, 400, `GitHub App connect failed: ${String(e)}`);
          }
          return;
        }
        const provider = url.searchParams.get("provider") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (!provider || !code || !state) {
          sendText(res, 400, "Missing OAuth parameters");
          return;
        }
        try {
          const result = await handleOAuthCallback({ db, cloud: config.cloud, provider, code, state });
          await deps.notifyWebSocketOAuthComplete(result.metadataJson, result.provider, result.identityId);
          if (result.provider === "github") {
            await deps.notifyGithubConnected(result.metadataJson);
          }
          sendText(res, 200, "Connected. Return to the chat.");
        } catch (e) {
          sendText(res, 400, `OAuth failed: ${String(e)}`);
        }
        return;
      }

      if (deps.telegram && config.telegram?.mode === "webhook" && req.method === "POST" && pathname === config.telegram?.webhook_path) {
        const secretHeader = readHeader(req, "x-telegram-bot-api-secret-token");
        if (!secretHeader) {
          logger.warn("Telegram webhook unauthorized (missing secret header)");
          sendText(res, 401, "unauthorized");
          return;
        }
        if (secretHeader !== config.telegram?.webhook_secret_token) {
          logger.warn("Telegram webhook unauthorized (bad secret header)");
          sendText(res, 401, "unauthorized");
          return;
        }
        const bodyText = await readRequestBody(req);
        let body: any;
        try {
          body = JSON.parse(bodyText);
        } catch {
          logger.warn("Telegram webhook bad JSON");
          sendText(res, 400, "bad request");
          return;
        }
        const updateId = typeof body?.update_id === "number" ? body.update_id : "?";
        const keys = body && typeof body === "object" ? Object.keys(body).filter((k) => k !== "update_id").join(",") : "-";
        logger.debug(`[tg] webhook update_id=${updateId} keys=${keys}`);
        deps.queue.enqueue(async () => {
          try {
            await deps.controller.handleTelegramUpdate(body as any);
          } catch (e) {
            logger.error("Telegram update handler error", e);
          }
        });
        sendText(res, 200, "ok");
        return;
      }

      if (deps.slack && req.method === "POST" && pathname === config.slack?.events_path) {
        const bodyText = await readRequestBody(req);
        const ok = verifySlackSignature({
          signingSecret: config.slack!.signing_secret,
          timestampHeader: readHeader(req, "x-slack-request-timestamp"),
          signatureHeader: readHeader(req, "x-slack-signature"),
          body: bodyText,
        });
        if (!ok) {
          logger.warn("Slack events unauthorized (bad signature)");
          sendText(res, 401, "unauthorized");
          return;
        }
        const body = JSON.parse(bodyText) as any;
        if (body.type === "url_verification" && typeof body.challenge === "string") {
          sendJson(res, 200, { challenge: body.challenge });
          return;
        }
        const evType = body?.event?.type ?? body?.type ?? "?";
        const eventTime = typeof body?.event_time === "number" ? body.event_time : null;
        if (eventTime !== null && eventTime < deps.slackEventStartTs) {
          logger.info(
            `[slack] drop stale event type=${String(evType)} event_time=${eventTime} started_at=${deps.slackEventStartTs}`,
          );
          sendText(res, 200, "ok");
          return;
        }
        logger.debug(`[slack] events type=${String(evType)}`);
        deps.queue.enqueue(async () => {
          try {
            await deps.controller.handleSlackEvent(body);
          } catch (e) {
            logger.error("Slack event handler error", e);
          }
        });
        sendText(res, 200, "ok");
        return;
      }

      if (deps.slack && req.method === "POST" && pathname === config.slack?.interactions_path) {
        const bodyText = await readRequestBody(req);
        const ok = verifySlackSignature({
          signingSecret: config.slack!.signing_secret,
          timestampHeader: readHeader(req, "x-slack-request-timestamp"),
          signatureHeader: readHeader(req, "x-slack-signature"),
          body: bodyText,
        });
        if (!ok) {
          logger.warn("Slack interactions unauthorized (bad signature)");
          sendText(res, 401, "unauthorized");
          return;
        }
        const params = new URLSearchParams(bodyText);
        const payloadRaw = params.get("payload");
        if (!payloadRaw) {
          sendText(res, 400, "bad request");
          return;
        }
        const payload = JSON.parse(payloadRaw) as any;

        logger.debug(`[slack] interaction type=${String(payload?.type ?? "?")}`);
        deps.queue.enqueue(async () => {
          try {
            await deps.controller.handleSlackInteraction(payload);
          } catch (e) {
            logger.error("Slack interaction handler error", e);
          }
        });

        if (payload.type === "view_submission") {
          sendJson(res, 200, { response_action: "clear" });
          return;
        }
        sendText(res, 200, "");
        return;
      }

      if (uiConfig && req.method === "GET" && pathname.startsWith(uiConfig.path)) {
        const uiRoot = path.join(config.config_dir, "frontend", "dist");
        const relRaw = pathname.slice(uiConfig.path.length) || "/";
        const relPath = relRaw === "/" ? "/index.html" : relRaw;
        const filePath = path.join(uiRoot, relPath);
        if (!filePath.startsWith(uiRoot)) {
          sendText(res, 403, "forbidden");
          return;
        }
        let data: Buffer | null = null;
        let target = filePath;
        try {
          data = await readFile(filePath);
        } catch {
          try {
            target = path.join(uiRoot, "index.html");
            data = await readFile(target);
          } catch {
            data = null;
          }
        }
        if (!data) {
          sendText(res, 404, "not found");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", contentTypeForPath(target));
        res.end(data);
        return;
      }

      sendText(res, 404, "not found");
    } catch (err) {
      logger.error("HTTP handler error", err);
      sendText(res, 500, "internal error");
    }
  });

  return { server, handleChatgptCallback };
}
