import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { sleep, TaskQueue, nowMs } from "./util.js";
import { TelegramClient } from "./platform/telegram.js";
import { SlackClient, type SlackTokenProvider, verifySlackSignature } from "./platform/slack.js";
import type { IMessagingPlatform, InteractiveMarkup } from "./platform/base.js";
import { BotController } from "./controller2.js";
import type { CommitProposal, CommitProposalStore } from "./controller/types.js";
import { CloudManager } from "./cloud/manager.js";
import { handleOAuthCallback } from "./cloud/oauth.js";
import { handleGithubAppCallback } from "./cloud/githubApp.js";
import {
  githubWebhookMaxBodyBytes,
  githubWebhookAppIdMatches,
  githubWebhookPollIntervalMs,
  parseGithubWebhookPayload,
  processPendingGithubWebhookEvents,
  recordGithubWebhookEvent,
  shouldHandleGithubWebhookEvent,
  verifyGithubWebhookSignature,
} from "./cloud/githubWebhook.js";
import { handleProxyRequest, createProxyToken } from "./cloud/proxy.js";
import { completeChatgptOAuth, isAllowedRedirectHost } from "./chatgpt/oauth.js";
import { purgeExpiredChatgptStates } from "./chatgpt/store.js";
import { JsonlStreamer, mapEventToFragments } from "./streamer.js";
import { SessionManager } from "./sessionManager.js";
import type { SendToSessionFn, SessionMessage } from "./messaging.js";
import type { TelegramMessage } from "./platform/telegram.js";
import { getUserLanguage, createSession, type SessionRow } from "./store.js";
import { getAgentAdapter } from "./agents.js";
import {
  addCloudRunScreenshot,
  getCloudRun,
  getCloudRunBySession,
  listCloudRunScreenshots,
  listCloudRunsForIdentity,
  listSecrets,
  getSecret,
  setSecret,
  deleteSecret,
  getOrCreateIdentity,
  createCodeRegistryEntry,
  listCodeRegistryEntries,
  ignoreCodeRegistryEntry,
  createSiteRegistryEntry,
  listSiteRegistryEntries,
  ignoreSiteRegistryEntry,
  createStaticDeployEntry,
  updateStaticDeployEntry,
  setStaticDeployActive,
  listStaticDeploys,
  getStaticDeployByIdx,
  createDynamicDeployEntry,
  updateDynamicDeployEntry,
  listDynamicDeploys,
  getDynamicDeployByIdx,
} from "./cloud/store.js";
import { uploadScreenshot, signScreenshotUrl } from "./cloud/s3.js";
import { verifyUiToken, type UiTokenPayload } from "./cloud/uiTokens.js";
import { buildRunArtifactsFromJsonl } from "./cloud/uiArtifacts.js";
import { encryptSecret } from "./cloud/secrets.js";
import {
  SLACK_INSTALL_PATH,
  SLACK_OAUTH_REDIRECT_PATH,
  authorizeSlackWorkspace,
  createSlackInstallProvider,
  handleSlackInstall,
  handleSlackOauthCallback,
} from "./slack/oauth.js";
import http from "node:http";
import { PlaywrightMcpManager } from "./playwrightMcp.js";
import { appendFile, open, readdir, readFile, mkdir, rm, rename, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { isUserLanguage, t, type UserLanguage } from "../locales/index.js";
import { WebSocketManager } from "./websocket/manager.js";
import { WebSocketHandler } from "./websocket/handler.js";
import type { ServerMessage } from "./websocket/types.js";

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

function readHeader(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function readRequestBody(req: http.IncomingMessage, maxBytes?: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const limit = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Number.POSITIVE_INFINITY;
    const chunks: Array<Buffer> = [];
    let total = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

function sendText(res: http.ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function decodeBase64Url(input: string): Buffer | null {
  if (!input) return null;
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  try {
    return Buffer.from(normalized + pad, "base64");
  } catch {
    return null;
  }
}

function parseAgentMeta(headerValue: string | null): any | null {
  if (!headerValue) return null;
  const decoded = decodeBase64Url(headerValue);
  if (!decoded) return null;
  try {
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    return null;
  }
}

async function writeRequestToFile(req: http.IncomingMessage, targetPath: string, maxBytes: number): Promise<number> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const out = createWriteStream(targetPath);
  let total = 0;
  return await new Promise<number>((resolve, reject) => {
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        req.destroy();
        out.destroy();
        reject(new Error("payload too large"));
      }
    });
    out.on("error", reject);
    out.on("finish", () => resolve(total));
    pipeline(req, out).catch(reject);
  });
}

async function runCommand(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    child.on("error", (err) => resolve({ stdout, stderr: String(err), exitCode: 1 }));
  });
}

function isSafeTarEntry(entry: string): boolean {
  if (!entry) return true;
  if (entry.startsWith("/") || entry.startsWith("\\")) return false;
  const parts = entry.split("/").filter(Boolean);
  return !parts.some((part) => part === "..");
}

async function safeExtractTar(archivePath: string, destDir: string): Promise<void> {
  const list = await runCommand("tar", ["-tvzf", archivePath]);
  if (list.exitCode !== 0) throw new Error(`tar list failed: ${list.stderr || list.stdout}`);
  const lines = list.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const typeChar = parts[0]?.[0] ?? "";
    if (typeChar === "l" || typeChar === "h") {
      throw new Error(`unsafe tar entry type: ${line}`);
    }
    const namePart = parts.slice(5).join(" ");
    const arrowIdx = namePart.indexOf(" -> ");
    const linkIdx = namePart.indexOf(" link to ");
    const cutIdx = arrowIdx >= 0 ? arrowIdx : linkIdx >= 0 ? linkIdx : namePart.length;
    const entry = namePart.slice(0, cutIdx).replace(/^\.\/+/, "");
    if (!isSafeTarEntry(entry)) throw new Error(`unsafe tar entry: ${entry}`);
  }
  await mkdir(destDir, { recursive: true });
  const extract = await runCommand("tar", ["-xzf", archivePath, "-C", destDir, "--no-same-owner", "--no-same-permissions"]);
  if (extract.exitCode !== 0) throw new Error(`tar extract failed: ${extract.stderr || extract.stdout}`);
}

function normalizeSetupList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return [];
}

function normalizeIgnoreList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return [];
}

function inferPortFromStartup(startup: string): number {
  const portFromEnv = startup.match(/\bPORT\s*=\s*(\d{2,5})\b/);
  if (portFromEnv) return Number(portFromEnv[1]);
  const portFlag = startup.match(/--port(?:=|\s+)(\d{2,5})/);
  if (portFlag) return Number(portFlag[1]);
  const shortFlag = startup.match(/\s-p\s+(\d{2,5})/);
  if (shortFlag) return Number(shortFlag[1]);
  return 3000;
}

function buildNginxServerBlock(host: string, rootPath: string): string {
  return [
    "server {",
    "  listen 80;",
    `  server_name ${host};`,
    `  root ${rootPath};`,
    "  index index.html;",
    "  location / {",
    "    try_files $uri $uri/ /index.html;",
    "  }",
    "}",
    "",
  ].join("\n");
}

function buildLocalSiteUrl(port: number, sitePath: string): string {
  const trimmed = sitePath.trim();
  const suffix = trimmed.length > 0 ? (trimmed.startsWith("/") ? trimmed : `/${trimmed}`) : "";
  return `http://127.0.0.1:${port}${suffix}`;
}

async function resolveModalTunnelUrl(sandbox: any, port: number): Promise<string> {
  if (!sandbox) return "";
  const maxAttempts = 20;
  const delayMs = 2000;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const tunnels = (await sandbox.tunnels(5_000)) as Record<string | number, { url?: string } | undefined>;
      const tunnel = tunnels[port];
      if (tunnel?.url) return tunnel.url;
    } catch {
      // ignore
    }
    await sleep(delayMs);
  }
  return "";
}

const STATIC_SITE_ROOT = "/mnt/data/sites";
const NGINX_CONF_DIR = "/etc/nginx/conf.d";
const DYNAMIC_DEPLOY_ROOT = "/mnt/data/deploys/dynamic";
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function sendSse(res: http.ServerResponse, data: unknown, event?: string) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

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

async function readNewJsonlLines(filePath: string, offset: number): Promise<{ lines: string[]; newOffset: number }> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (offset >= stat.size) return { lines: [], newOffset: offset };

    const maxBytes = 2_000_000;
    const remaining = stat.size - offset;
    const toRead = Math.min(remaining, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, offset);
    const slice = buf.subarray(0, bytesRead);

    const lastNewline = slice.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], newOffset: offset };

    const complete = slice.subarray(0, lastNewline);
    const text = complete.toString("utf8");
    const lines = text.split("\n");
    const newOffset = offset + lastNewline + 1;
    return { lines, newOffset };
  } finally {
    await handle.close();
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path.join(dir, e.name));
  files.sort();
  return files;
}

function contentTypeForPath(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

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
    return markup?.type === "inline_keyboard" ? markup.payload : undefined;
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
  const firstMessageSent = new Set<string>();
  const firstMessageSending = new Set<string>();
  const reviewCommitDisabled = new Set<string>();
  const lastTelegramMessageId = new Map<string, number>();
  const telegramMessageToSession = new Map<string, string>();
  const lastSlackMessage = new Map<string, { ts: string; text: string }>();
  const planTelegramMessageId = new Map<string, number>();
  const planSlackMessageTs = new Map<string, string>();

  type PendingCommitProposal = {
    sessionId: string;
    platform: "telegram" | "slack";
    chatId: string;
    userId: string;
    spaceId: string;
    workspaceId: string | null;
    isTelegramTopic: boolean;
    gitUserName: string | null;
    gitUserEmail: string | null;
    buffer: string;
  };

  const pendingCommitProposals = new Map<string, PendingCommitProposal>();
  const suppressFinalizeForSession = new Set<string>();
  const commitProposals = new Map<string, CommitProposal>();

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
      await notifyChatgptConnected(result.metadataJson);
      const metadata = parseCloudConnectMetadata(result.metadataJson);
      const lang = metadata ? await resolveUserLanguage(metadata.platform, metadata.user_id) : "en";
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(buildChatgptOauthSuccessHtml(lang));
    } catch (e) {
      sendText(res, 400, `ChatGPT OAuth failed: ${String(e)}`);
    }
    return true;
  };

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

  const isFencedCodeBlock = (text: string): boolean => {
    const t = text.trim();
    return t.startsWith("```") && t.endsWith("```");
  };

  const buildTelegramInlineKeyboard = (opts: {
    sessionId: string;
    includeKill: boolean;
    includeReview: boolean;
    includeCommit: boolean;
    includeStopSandbox: boolean;
    currentLang?: UserLanguage;
  }) => {
    const lang = opts.currentLang ?? "en";
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    const actionRow: Array<{ text: string; callback_data: string }> = [];
    if (opts.includeKill) actionRow.push({ text: t("button.stop", lang), callback_data: `kill:${opts.sessionId}` });
    if (opts.includeStopSandbox) {
      actionRow.push({ text: t("button.stop_sandbox", lang), callback_data: `stop_sandbox:${opts.sessionId}` });
    }
    if (opts.includeReview) actionRow.push({ text: t("button.review", lang), callback_data: `review:${opts.sessionId}` });
    if (opts.includeCommit) actionRow.push({ text: t("button.commit", lang), callback_data: `commit:${opts.sessionId}` });
    if (actionRow.length > 0) rows.push(actionRow);
    return rows.length > 0 ? { inline_keyboard: rows } : undefined;
  };

  const buildSlackButtons = (opts: {
    sessionId: string;
    includeKill: boolean;
    includeReview: boolean;
    includeCommit: boolean;
    includeStopSandbox: boolean;
    currentLang?: UserLanguage;
  }) => {
    const lang = opts.currentLang ?? "en";
    const elements: any[] = [];
    if (opts.includeKill) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: t("button.stop", lang) },
        style: "danger",
        action_id: "kill_session",
        value: opts.sessionId,
      });
    }
    if (opts.includeStopSandbox) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: t("button.stop_sandbox", lang) },
        style: "danger",
        action_id: "stop_sandbox",
        value: opts.sessionId,
      });
    }
    if (opts.includeReview) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: t("button.review", lang) },
        action_id: "review_session",
        value: opts.sessionId,
      });
    }
    if (opts.includeCommit) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: t("button.commit", lang) },
        action_id: "commit_session",
        value: opts.sessionId,
      });
    }
    return elements.length > 0 ? [{ type: "actions", elements }] : undefined;
  };

  const buildSessionActionMarkup = (
    platform: "telegram" | "slack",
    opts: {
      sessionId: string;
      includeKill: boolean;
      includeReview: boolean;
      includeCommit: boolean;
      includeStopSandbox: boolean;
      currentLang?: UserLanguage;
    },
  ): InteractiveMarkup | undefined => {
    if (platform === "telegram") {
      const replyMarkup = buildTelegramInlineKeyboard(opts);
      return replyMarkup ? { type: "inline_keyboard", payload: replyMarkup } : undefined;
    }
    const blocks = buildSlackButtons(opts);
    return blocks ? { type: "blocks", payload: blocks } : undefined;
  };

  const buildCommitProposalTelegramKeyboard = (proposalId: string, lang: UserLanguage) => {
    return {
      inline_keyboard: [
        [
          { text: t("button.cancel", lang), callback_data: `cpr:${proposalId}:cancel` },
          { text: t("button.commit_push", lang), callback_data: `cpr:${proposalId}:push` },
        ],
        [{ text: t("button.create_pr", lang), callback_data: `cpr:${proposalId}:pr` }],
      ],
    };
  };

  const buildCommitProposalSlackBlocks = (proposalId: string, lang: UserLanguage) => {
    return [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: t("button.cancel", lang) },
            style: "danger",
            action_id: "commit_cancel",
            value: proposalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: t("button.commit_push", lang) },
            action_id: "commit_push",
            value: proposalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: t("button.create_pr", lang) },
            action_id: "commit_pr",
            value: proposalId,
          },
        ],
      },
    ];
  };

  const buildCommitProposalMarkup = (
    platform: "telegram" | "slack",
    proposalId: string,
    lang: UserLanguage,
  ): InteractiveMarkup => {
    if (platform === "telegram") {
      return { type: "inline_keyboard", payload: buildCommitProposalTelegramKeyboard(proposalId, lang) };
    }
    return { type: "blocks", payload: buildCommitProposalSlackBlocks(proposalId, lang) };
  };

  const extractCommitProposalPayload = (
    raw: string,
  ): { commitMessage: string; branchName: string; summary: string } | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let candidate = trimmed;
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence && fence[1]) candidate = fence[1].trim();
    const jsonMatch = candidate.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const commitMessage = String(parsed.commit_message ?? parsed.commitMessage ?? "").trim();
      const branchName = String(parsed.branch_name ?? parsed.branchName ?? "").trim();
      const summary = String(parsed.summary ?? parsed.description ?? "").trim();
      if (!commitMessage || !branchName) return null;
      return { commitMessage, branchName, summary };
    } catch {
      return null;
    }
  };

  const resolvePendingLanguage = async (pending: PendingCommitProposal): Promise<UserLanguage> => {
    const row = await db
      .selectFrom("sessions")
      .select(["language"])
      .where("id", "=", pending.sessionId)
      .executeTakeFirst();
    if (row && isUserLanguage(row.language ?? "")) return row.language;
    return await resolveUserLanguage(pending.platform, pending.userId);
  };

  const formatCommitProposalText = (proposal: CommitProposal, lang: UserLanguage) => {
    const summary = proposal.summary?.trim();
    const summaryLine = summary ? summary : t("commit.proposal.summary_empty", lang);
    return [
      t("commit.proposal.title", lang),
      t("commit.proposal.branch", lang, { branch: proposal.branchName }),
      t("commit.proposal.commit", lang, { message: proposal.commitMessage }),
      t("commit.proposal.summary", lang, { summary: summaryLine }),
      "",
      t("commit.proposal.choose_action", lang),
    ].join("\n");
  };

  const sendCommitProposalMessage = async (opts: {
    pending: PendingCommitProposal;
    text: string;
    proposalId: string;
    lang: UserLanguage;
  }) => {
    if (opts.pending.platform === "telegram") {
      if (!telegram) return;
      const chatId = Number(opts.pending.chatId);
      const space = Number(opts.pending.spaceId);
      if (Number.isNaN(chatId)) return;
      const markup = buildCommitProposalMarkup("telegram", opts.proposalId, opts.lang);
      const replyMarkup = getTelegramReplyMarkup(markup);
      if (opts.pending.isTelegramTopic && Number.isFinite(space)) {
        await telegram.sendMessage({
          chatId,
          messageThreadId: Number(space),
          text: opts.text,
          replyMarkup,
          priority: "user",
        });
        return;
      }
      if (Number.isFinite(space)) {
        await telegram.sendMessage({
          chatId,
          replyToMessageId: Number(space),
          text: opts.text,
          replyMarkup,
          priority: "user",
        });
        return;
      }
      await telegram.sendMessage({ chatId, text: opts.text, replyMarkup, priority: "user" });
      return;
    }

    if (opts.pending.platform === "slack") {
      if (!slack) return;
      const threadTs = undefined;
      await slack.postMessageDetailed({
        channel: opts.pending.chatId,
        thread_ts: threadTs,
        text: opts.text,
        blocks: getSlackBlocks(buildCommitProposalMarkup("slack", opts.proposalId, opts.lang)),
        blocksOnLastChunk: false,
        priority: "user",
        workspaceId: opts.pending.workspaceId,
      });
    }
  };

  const sendCommitProposalNotice = async (pending: PendingCommitProposal, text: string, lang: UserLanguage) => {
    if (pending.platform === "telegram") {
      if (!telegram) return;
      const chatId = Number(pending.chatId);
      const space = Number(pending.spaceId);
      if (Number.isNaN(chatId)) return;
      if (pending.isTelegramTopic && Number.isFinite(space)) {
        await telegram.sendMessage({ chatId, messageThreadId: Number(space), text, priority: "user" });
        return;
      }
      if (Number.isFinite(space)) {
        await telegram.sendMessage({ chatId, replyToMessageId: Number(space), text, priority: "user" });
        return;
      }
      await telegram.sendMessage({ chatId, text, priority: "user" });
      return;
    }
    if (pending.platform === "slack") {
      if (!slack) return;
      const threadTs = undefined;
      await slack.postMessageDetailed({
        channel: pending.chatId,
        thread_ts: threadTs,
        text,
        blocksOnLastChunk: false,
        priority: "user",
        workspaceId: pending.workspaceId,
      });
    }
  };

  const sendCommitProposalError = async (
    pending: PendingCommitProposal,
    reasonKey: Parameters<typeof t>[0],
    params?: Record<string, string | number>,
  ) => {
    const lang = await resolvePendingLanguage(pending);
    const reason = t(reasonKey, lang, params);
    const text = t("commit.proposal.failed", lang, { reason });
    await sendCommitProposalNotice(pending, text, lang);
  };

  const commitProposalStore: CommitProposalStore = {
    startProposal: (opts) => {
      pendingCommitProposals.set(opts.sessionId, { ...opts, buffer: "" });
    },
    getProposal: (id) => commitProposals.get(id) ?? null,
    consumeProposal: (id) => {
      const proposal = commitProposals.get(id) ?? null;
      if (proposal) commitProposals.delete(id);
      return proposal;
    },
    clearPendingForSession: (sessionId) => {
      pendingCommitProposals.delete(sessionId);
    },
  };

  const maybeHandleCommitProposalMessage = async (sessionId: string, message: { type?: string; text?: string; final?: boolean }) => {
    const pending = pendingCommitProposals.get(sessionId);
    if (!pending) return false;
    if (message.type === "finalize") return false;
    if (message.type === "plan_update" || message.type === "image") return true;
    const text = typeof message.text === "string" ? message.text : "";
    if (text || message.final) {
      pending.buffer = pending.buffer ? `${pending.buffer}\n${text}` : text;
      if (pending.buffer.length > 40_000) {
        pendingCommitProposals.delete(sessionId);
        suppressFinalizeForSession.add(sessionId);
        await sendCommitProposalError(pending, "commit.proposal.output_too_large");
        return true;
      }
      const parsed = extractCommitProposalPayload(pending.buffer);
      if (parsed) {
        pendingCommitProposals.delete(sessionId);
        suppressFinalizeForSession.add(sessionId);
        const proposal: CommitProposal = {
          id: crypto.randomUUID(),
          sessionId: pending.sessionId,
          platform: pending.platform,
          chatId: pending.chatId,
          userId: pending.userId,
          commitMessage: parsed.commitMessage,
          branchName: parsed.branchName,
          summary: parsed.summary,
          gitUserName: pending.gitUserName,
          gitUserEmail: pending.gitUserEmail,
          createdAt: Date.now(),
        };
        commitProposals.set(proposal.id, proposal);
        const lang = await resolvePendingLanguage(pending);
        const text = formatCommitProposalText(proposal, lang);
        await sendCommitProposalMessage({ pending, text, proposalId: proposal.id, lang });
        return true;
      }
      if (message.final) {
        pendingCommitProposals.delete(sessionId);
        suppressFinalizeForSession.add(sessionId);
        await sendCommitProposalError(pending, "commit.proposal.invalid_json");
        return true;
      }
    }
    return true;
  };

  const telegramMessageKey = (chatId: string | number, messageId: number) => `${String(chatId)}:${String(messageId)}`;
  const trackTelegramMessage = (sessionId: string, chatId: number, messageId: number) => {
    const prev = lastTelegramMessageId.get(sessionId);
    if (prev) {
      telegramMessageToSession.delete(telegramMessageKey(chatId, prev));
    }
    lastTelegramMessageId.set(sessionId, messageId);
    telegramMessageToSession.set(telegramMessageKey(chatId, messageId), sessionId);
  };

  const sendSessionImage = async (opts: {
    sessionId: string;
    session: SessionRow;
    telegramTopicSession: boolean;
    message: Extract<SessionMessage, { type: "image" }>;
    caption: string;
    priority: "user" | "background";
  }) => {
    const platformClient: IMessagingPlatform | null =
      opts.session.platform === "telegram" ? telegram : opts.session.platform === "slack" ? slack : null;
    if (!platformClient) return;

    const isTelegram = opts.session.platform === "telegram";
    const workspaceId = opts.session.workspace_id ?? null;
    const threadId = isTelegram ? (opts.telegramTopicSession ? opts.session.space_id : undefined) : undefined;
    const replyToMessageId = isTelegram && !opts.telegramTopicSession ? opts.session.space_id : undefined;
    const uploadOpts = {
      chatId: opts.session.chat_id,
      threadId,
      replyToMessageId,
      filename: opts.message.filename,
      file: opts.message.file,
      mimeType: opts.message.mimeType,
      caption: opts.caption,
      priority: opts.priority,
      workspaceId,
    };

    let result: { messageId: string } | null = null;
    try {
      result = await platformClient.sendPhoto(uploadOpts);
    } catch {
      result = await platformClient.sendDocument(uploadOpts);
    }

    if (isTelegram && result?.messageId) {
      const chatId = Number(opts.session.chat_id);
      const messageId = Number(result.messageId);
      if (Number.isFinite(chatId) && Number.isFinite(messageId)) {
        trackTelegramMessage(opts.sessionId, chatId, messageId);
      }
    }
  };

  const sendSessionCompleteNotice = async (opts: {
    sessionId: string;
    session: {
      platform: string;
      chat_id: string;
      space_id: string;
      space_emoji: string | null;
      project_id: string | null;
      language?: string | null;
      workspace_id?: string | null;
    };
    actionsDisabled: boolean;
  }) => {
    const { sessionId, session, actionsDisabled } = opts;
    const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
    const lang = resolveSessionLanguage(session);
    const text = t("session.complete", lang);

    if (session.platform === "telegram") {
      if (!telegram) return;
      const chatId = Number(session.chat_id);
      const space = Number(session.space_id);
      if (Number.isNaN(chatId) || Number.isNaN(space)) return;
      const markup = buildSessionActionMarkup("telegram", {
        sessionId,
        includeKill: false,
        includeReview: !actionsDisabled,
        includeCommit: !actionsDisabled,
        includeStopSandbox: !actionsDisabled && isCloudSession,
        currentLang: lang,
      });
      const replyMarkup = getTelegramReplyMarkup(markup);
      const sendFallback = async () => {
        if (Number.isFinite(space)) {
          try {
            const sent = await telegram.sendMessageSingleStrict(
              isTelegramTopicSession(session)
                ? {
                    chatId,
                    messageThreadId: space,
                    text,
                    replyMarkup,
                    priority: "user",
                    forcePrimary: true,
                  }
                : {
                    chatId,
                    replyToMessageId: space,
                    text,
                    replyMarkup,
                    priority: "user",
                    forcePrimary: true,
                  },
            );
            if (sent) trackTelegramMessage(sessionId, chatId, sent.message_id);
            return;
          } catch {
            // Fall through to a plain message.
          }
        }
        const sent = await telegram.sendMessage({
          chatId,
          text,
          replyMarkup,
          priority: "user",
          forcePrimary: true,
        });
        if (sent) trackTelegramMessage(sessionId, chatId, sent.message_id);
      };
      const messageId = lastTelegramMessageId.get(sessionId);
      if (!messageId) {
        try {
          await sendFallback();
        } catch {
          // Ignore failures.
        }
        return;
      }
      try {
        await telegram.editMessageReplyMarkup({
          chatId,
          messageId,
          replyMarkup,
          priority: "user",
        });
      } catch {
        try {
          await sendFallback();
        } catch {
          // Ignore failures.
        }
      }
      return;
    }

    if (session.platform === "slack") {
      if (!slack) return;
      const channel = session.chat_id;
      const threadTs = undefined;
      const workspaceId = session.workspace_id ?? null;
        const markup = buildSessionActionMarkup("slack", {
          sessionId,
          includeKill: false,
          includeReview: !actionsDisabled,
          includeCommit: !actionsDisabled,
          includeStopSandbox: !actionsDisabled && isCloudSession,
          currentLang: lang,
        });
      const blocks = getSlackBlocks(markup);
      const last = lastSlackMessage.get(sessionId);
      if (last) {
        try {
          await slack.updateMessage({ channel, ts: last.ts, text: last.text, blocks, workspaceId });
          return;
        } catch {
          // Fall through to a new message.
        }
      }
      try {
        const posted = await slack.postMessageDetailed({
          channel,
          thread_ts: threadTs,
          text,
          blocks,
          blocksOnLastChunk: false,
          priority: "user",
          workspaceId,
        });
        if (posted.lastTs && posted.lastText !== null) {
          lastSlackMessage.set(sessionId, { ts: posted.lastTs, text: posted.lastText });
        }
      } catch {
        // Ignore failures.
      }
    }
  };

  const escapeHtml = (input: string): string => {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  const normalizePlanStatus = (raw: string): "pending" | "in_progress" | "completed" => {
    const s = raw.trim().toLowerCase();
    if (s === "completed" || s === "done" || s === "finished") return "completed";
    if (s === "in_progress" || s === "in progress" || s === "active" || s === "running") return "in_progress";
    return "pending";
  };

  const formatPlanMessageTelegramHtml = (opts: {
    lang: UserLanguage;
    plan: Array<{ step: string; status: string }>;
    explanation?: string;
  }): string => {
    const maxChars = config.telegram?.max_chars ?? 4096;
    const header = `<b>${escapeHtml(t("plan.title", opts.lang))}</b>`;
    const explanation = (opts.explanation ?? "").trim();
    const lines: string[] = [header];
    if (explanation) lines.push(`<i>${escapeHtml(explanation)}</i>`);
    lines.push("");

    for (const item of opts.plan) {
      const step = (item.step ?? "").trim();
      if (!step) continue;
      const status = normalizePlanStatus(item.status ?? "");
      const escaped = escapeHtml(step);
      if (status === "completed") lines.push(`• <s>${escaped}</s>`);
      else if (status === "in_progress") lines.push(`• <b>${escaped}</b>`);
      else lines.push(`• ${escaped}`);
    }

    const base = lines.join("\n").trim();
    if (base.length <= maxChars) return base;

    const out: string[] = [];
    let len = 0;
    const trailer = `<i>${escapeHtml(t("plan.truncated", opts.lang))}</i>`;
    for (const line of lines) {
      const extra = (out.length > 0 ? 1 : 0) + line.length;
      if (len + extra > maxChars) break;
      out.push(line);
      len += extra;
    }
    const trailerExtra = (out.length > 0 ? 1 : 0) + trailer.length;
    while (out.length > 0 && len + trailerExtra > maxChars) {
      const removed = out.pop()!;
      len -= removed.length + (out.length > 0 ? 1 : 0);
    }
    if (out.length === 0) return trailer.slice(0, maxChars);
    if (len + trailerExtra <= maxChars) out.push(trailer);
    return out.join("\n").trim();
  };

  const formatPlanMessageSlack = (opts: {
    lang: UserLanguage;
    plan: Array<{ step: string; status: string }>;
    explanation?: string;
  }): string => {
    const maxChars = config.slack?.max_chars ?? 3000;
    const explanation = (opts.explanation ?? "").trim();
    const lines: string[] = [`*${t("plan.title", opts.lang)}*`];
    if (explanation) lines.push(`_${explanation}_`);
    lines.push("");

    for (const item of opts.plan) {
      const step = (item.step ?? "").trim();
      if (!step) continue;
      const status = normalizePlanStatus(item.status ?? "");
      if (status === "completed") lines.push(`• ~${step}~`);
      else if (status === "in_progress") lines.push(`• *${step}*`);
      else lines.push(`• ${step}`);
    }

    const base = lines.join("\n").trim();
    if (base.length <= maxChars) return base;

    const out: string[] = [];
    let len = 0;
    const trailer = t("plan.truncated", opts.lang);
    for (const line of lines) {
      const extra = (out.length > 0 ? 1 : 0) + line.length;
      if (len + extra > maxChars) break;
      out.push(line);
      len += extra;
    }
    const trailerExtra = (out.length > 0 ? 1 : 0) + trailer.length;
    while (out.length > 0 && len + trailerExtra > maxChars) {
      const removed = out.pop()!;
      len -= removed.length + (out.length > 0 ? 1 : 0);
    }
    if (out.length === 0) return trailer.slice(0, maxChars);
    if (len + trailerExtra <= maxChars) out.push(trailer);
    return out.join("\n").trim();
  };

  const upsertPlanMessage = async (
    sessionId: string,
    session: {
      platform: string;
      chat_id: string;
      space_id: string;
      space_emoji: string | null;
      workspace_id?: string | null;
    },
    lang: UserLanguage,
    plan: Array<{ step: string; status: string }>,
    explanation?: string,
  ) => {
    if (session.platform === "telegram") {
      if (!telegram) return;
      const chatId = Number(session.chat_id);
      const space = Number(session.space_id);
      if (Number.isNaN(chatId) || Number.isNaN(space)) return;
      const text = formatPlanMessageTelegramHtml({ plan, explanation, lang });
      const existing = planTelegramMessageId.get(sessionId);
      if (existing) {
        try {
          await telegram.editMessageText({
            chatId,
            messageId: existing,
            text,
            parseMode: "HTML",
            priority: "user",
          });
          return;
        } catch {
          planTelegramMessageId.delete(sessionId);
        }
      }

      try {
        const sent = await telegram.sendMessageSingleStrict(
          isTelegramTopicSession(session)
            ? {
                chatId,
                messageThreadId: space,
                text,
                parseMode: "HTML",
                priority: "user",
                forcePrimary: true,
              }
            : {
                chatId,
                replyToMessageId: space,
                text,
                parseMode: "HTML",
                priority: "user",
                forcePrimary: true,
              },
        );
        if (sent) {
          planTelegramMessageId.set(sessionId, sent.message_id);
          trackTelegramMessage(sessionId, chatId, sent.message_id);
        }
      } catch {
        // Ignore plan send failures.
      }
      return;
    }

    if (session.platform === "slack") {
      if (!slack) return;
      const channel = session.chat_id;
      const threadTs = undefined;
      const workspaceId = session.workspace_id ?? null;
      const text = formatPlanMessageSlack({ plan, explanation, lang });
      const existing = planSlackMessageTs.get(sessionId);
      if (existing) {
        try {
          await slack.updateMessage({ channel, ts: existing, text, workspaceId });
          return;
        } catch {
          planSlackMessageTs.delete(sessionId);
        }
      }
      try {
        const posted = await slack.postMessageDetailed({
          channel,
          thread_ts: threadTs,
          text,
          blocksOnLastChunk: false,
          priority: "user",
          workspaceId,
        });
        if (posted.lastTs) planSlackMessageTs.set(sessionId, posted.lastTs);
      } catch {
        // Ignore plan send failures.
      }
    }
  };

  const sendToSession: SendToSessionFn = async (sessionId, message) => {
    const session = await db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
    if (!session) return;
    const lang = resolveSessionLanguage(session);

    // WebSocket push: broadcast to all subscribers of this session
    if (wsManager?.hasSubscribers(sessionId)) {
      let wsMessage: ServerMessage | null = null;
      if (message.type === "finalize") {
        wsMessage = { type: 'done', sessionId };
      } else if (message.type === "plan_update") {
        wsMessage = {
          type: 'plan_update',
          sessionId,
          plan: message.plan.map(p => ({ step: p.step, status: p.status as any })),
          explanation: message.explanation,
        };
      } else if (message.type === "image") {
        // For images, we send a tool_output with the path (can't send binary over text WS)
        wsMessage = {
          type: 'tool_output',
          sessionId,
          name: 'screenshot',
          output: message.caption ?? message.filename,
        };
      } else if (typeof message.text === "string") {
        wsMessage = { type: 'chunk', sessionId, content: message.text };
        if (message.final) {
          // Send chunk first, then done
          wsManager.broadcastToSession(sessionId, wsMessage);
          wsMessage = { type: 'done', sessionId };
        }
      }
      if (wsMessage) {
        wsManager.broadcastToSession(sessionId, wsMessage);
      }
    }

    // Skip platform delivery for WebSocket-only sessions
    if (session.platform === "websocket") {
      return;
    }

    const isCloudSession = typeof session.project_id === "string" && session.project_id.startsWith("cloud:");
    const handledCommitProposal = await maybeHandleCommitProposalMessage(sessionId, message);
    if (handledCommitProposal) return;
    const actionsDisabled = reviewCommitDisabled.has(sessionId);
    const telegramTopicSession = isTelegramTopicSession(session);
    if (message.type === "finalize") {
      if (suppressFinalizeForSession.has(sessionId)) {
        suppressFinalizeForSession.delete(sessionId);
        return;
      }
      await sendSessionCompleteNotice({ sessionId, session, actionsDisabled });
      return;
    }
    if (message.type === "plan_update") {
      await upsertPlanMessage(sessionId, session, lang, message.plan, message.explanation);
      return;
    }
    if (message.type === "image") {
      const caption = message.caption ?? t("image.playwright_screenshot", lang);
      const priority = message.priority ?? "user";
      void maybeUploadScreenshot(sessionId, {
        file: message.file,
        filename: message.filename,
        mimeType: message.mimeType,
        caption,
      }).catch((e) => logger.warn(`screenshot upload failed session=${sessionId}: ${String(e)}`));
      try {
        await sendSessionImage({ sessionId, session, telegramTopicSession, message, caption, priority });
        return;
      } catch (e) {
        logger.warn(`send image failed session=${sessionId}: ${String(e)}`);
      }
      await sendToSession(sessionId, { text: `${caption}\n${t("image.saved_at", lang, { path: message.path })}`, priority: "user" });
      return;
    }
    const text = message.text;
    const isFinal = message.final === true;
    const isFirst = !firstMessageSent.has(sessionId) && !firstMessageSending.has(sessionId);
    const claimedFirst = isFirst;
    if (claimedFirst) firstMessageSending.add(sessionId);
    const includeKillButton =
      isFirst &&
      !isFinal &&
      !isCloudSession &&
      (session.status === "starting" || session.status === "running") &&
      !(session.platform === "telegram" && telegramTopicSession);
    const includeReviewButton = false;
    const includeCommitButton = false;

    let messageSent = false;
    try {
      if (isFinal && text.trim().length === 0) {
        if (suppressFinalizeForSession.has(sessionId)) {
          suppressFinalizeForSession.delete(sessionId);
          messageSent = true;
          return;
        }
        await sendSessionCompleteNotice({ sessionId, session, actionsDisabled });
        messageSent = true;
        return;
      }

      if (session.platform === "telegram") {
        if (!telegram) return;
        const chatId = Number(session.chat_id);
        const space = Number(session.space_id);
        if (Number.isNaN(chatId) || Number.isNaN(space)) return;
        const priority = message.priority ?? "background";
        const markup = buildSessionActionMarkup("telegram", {
          sessionId,
          includeKill: includeKillButton,
          includeReview: includeReviewButton,
          includeCommit: includeCommitButton,
          includeStopSandbox: false,
          currentLang: lang,
        });
        const replyMarkup = getTelegramReplyMarkup(markup);

        if (isFencedCodeBlock(text)) {
          const parseMode = "Markdown" as const;
          let sent: TelegramMessage | null = null;
          try {
            sent = await telegram.sendMessageSingleStrict(
              telegramTopicSession
                ? {
                    chatId,
                    messageThreadId: space,
                    text,
                    parseMode,
                    replyMarkup,
                    priority,
                    forcePrimary: true,
                  }
                : {
                    chatId,
                    replyToMessageId: space,
                    text,
                    parseMode,
                    replyMarkup,
                    priority,
                    forcePrimary: true,
                  },
            );
          } catch {
            sent = await telegram.sendMessageSingleStrict({ chatId, text, parseMode, replyMarkup, priority, forcePrimary: true });
          }
          if (sent) trackTelegramMessage(sessionId, chatId, sent.message_id);
          messageSent = true;
          return;
        }

        let sent: TelegramMessage | null = null;
        try {
          sent = await telegram.sendMessageStrict(
            telegramTopicSession
              ? { chatId, messageThreadId: space, text, replyMarkup, priority, forcePrimary: true }
              : { chatId, replyToMessageId: space, text, replyMarkup, priority, forcePrimary: true },
          );
        } catch {
          sent = await telegram.sendMessage({ chatId, text, replyMarkup, priority, forcePrimary: true });
        }
        if (sent) trackTelegramMessage(sessionId, chatId, sent.message_id);
        messageSent = true;
        return;
      }

      if (session.platform === "slack") {
        if (!slack) return;
        const channel = session.chat_id;
        const threadTs = undefined;
        const workspaceId = session.workspace_id ?? null;
        const priority = message.priority ?? "background";
        const markup = buildSessionActionMarkup("slack", {
          sessionId,
          includeKill: includeKillButton,
          includeReview: includeReviewButton,
          includeCommit: includeCommitButton,
          includeStopSandbox: false,
          currentLang: lang,
        });
        const blocks = getSlackBlocks(markup);
        const posted = await slack.postMessageDetailed({
          channel,
          thread_ts: threadTs,
          text,
          blocks,
          blocksOnLastChunk: false,
          priority,
          workspaceId,
        });
        if (isFinal && posted.lastTs && posted.lastText !== null) {
          lastSlackMessage.set(sessionId, { ts: posted.lastTs, text: posted.lastText });
        }
        messageSent = true;
      }
    } finally {
      if (claimedFirst) {
        firstMessageSending.delete(sessionId);
        if (messageSent) firstMessageSent.add(sessionId);
      }
    }
  };

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
    telegram
      ? (chatId, messageId) => telegramMessageToSession.get(telegramMessageKey(chatId, messageId)) ?? null
      : null,
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

  const extractUiToken = (req: http.IncomingMessage, url: URL): string | null => {
    const header = readHeader(req, "authorization");
    if (header && header.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
    const fromQuery = url.searchParams.get("token");
    return fromQuery && fromQuery.length > 0 ? fromQuery : null;
  };

  const requireUiAuth = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): UiTokenPayload | null => {
    if (!uiConfig || !uiConfig.token_secret) {
      sendText(res, 503, "UI auth not configured");
      return null;
    }
    const token = extractUiToken(req, url);
    if (!token) {
      sendText(res, 401, "missing token");
      return null;
    }
    const payload = verifyUiToken(uiConfig, token);
    if (!payload) {
      sendText(res, 401, "invalid token");
      return null;
    }
    return payload;
  };

  const requireRunAccess = async (
    payload: UiTokenPayload,
    runId: string,
    res: http.ServerResponse,
  ): Promise<Awaited<ReturnType<typeof getCloudRun>> | null> => {
    const run = await getCloudRun(db, runId);
    if (!run) {
      sendText(res, 404, "run not found");
      return null;
    }
    if (payload.scope === "run" && payload.run_id !== runId) {
      sendText(res, 403, "forbidden");
      return null;
    }
    if (payload.scope === "identity" && payload.identity_id !== run.identity_id) {
      sendText(res, 403, "forbidden");
      return null;
    }
    return run;
  };

  const resolveRunLogFiles = async (sessionId: string, session: { agent: string; codex_cwd: string; codex_session_id: string | null }) => {
    if (config.cloud?.workspaces_dir) {
      const logsDir = path.join(config.cloud.workspaces_dir, "logs", sessionId);
      const fromLogs = await listJsonlFiles(logsDir);
      if (fromLogs.length > 0) return fromLogs;
    }
    if (!session.codex_session_id) return [];
    const adapter = getAgentAdapter(session.agent as any);
    const sessionsRoot = adapter.resolveSessionsRoot(session.codex_cwd, config);
    const homeDir = adapter.resolveHomeDir(sessionsRoot);
    return await adapter.findSessionJsonlFiles({
      sessionsRoot,
      homeDir,
      cwd: session.codex_cwd,
      sessionId: session.codex_session_id,
      timeoutMs: 2_000,
      pollMs: 200,
    });
  };

  const resolveAgentContext = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts?: { sessionId?: string },
  ): Promise<{ sessionId: string; identityId: string } | null> => {
    if (!cloudManager || !config.cloud?.enabled) {
      sendText(res, 404, "cloud not enabled");
      return null;
    }
    const sessionId =
      opts?.sessionId ??
      readHeader(req, "x-tintin-session") ??
      readHeader(req, "x-tintin-agent-session") ??
      "";
    if (!sessionId) {
      sendText(res, 400, "missing session id");
      return null;
    }
    const authHeader = readHeader(req, "authorization");
    const tokenHeader = readHeader(req, "x-tintin-agent-token");
    const token =
      authHeader && authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice("bearer ".length).trim()
        : tokenHeader ?? "";
    if (!token || !cloudManager.verifyAgentToken(sessionId, token)) {
      sendText(res, 403, "forbidden");
      return null;
    }
    const sessionRow = await db
      .selectFrom("sessions")
      .select(["platform", "workspace_id", "created_by_user_id"])
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (!sessionRow) {
      sendText(res, 404, "session not found");
      return null;
    }
    const identity = await getOrCreateIdentity(db, {
      platform: sessionRow.platform as "telegram" | "slack",
      workspaceId: sessionRow.workspace_id || null,
      userId: sessionRow.created_by_user_id,
    });
    return { sessionId, identityId: identity.id };
  };

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

      // OPTIONS /api/ws/token - CORS preflight
      if (req.method === "OPTIONS" && pathname === "/api/ws/token") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.statusCode = 204;
        res.end();
        return;
      }

      // GET /api/ws/token - Generate WebSocket authentication token
      if (req.method === "GET" && pathname === "/api/ws/token") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        const proxy = config.cloud?.proxy;
        if (!proxy?.shared_secret) {
          sendJson(res, 500, { error: "WebSocket token auth not configured" });
          return;
        }

        // Generate anonymous token for web clients
        // In production, this should validate user identity first
        const identityId = `ws:web:${crypto.randomUUID().slice(0, 8)}`;
        const ttlMs = proxy.token_ttl_ms ?? 3600000; // Default 1 hour
        const token = createProxyToken(proxy.shared_secret, identityId, ttlMs);

        sendJson(res, 200, { token, identityId, expiresIn: ttlMs });
        return;
      }
      if (slackInstallProvider && req.method === "GET" && pathname === SLACK_INSTALL_PATH) {
        try {
          await handleSlackInstall({ provider: slackInstallProvider, req, res, config });
        } catch (e) {
          sendText(res, 400, `Slack install failed: ${String(e)}`);
        }
        return;
      }

      if (slackInstallProvider && req.method === "GET" && pathname === SLACK_OAUTH_REDIRECT_PATH) {
        try {
          await handleSlackOauthCallback({ provider: slackInstallProvider, req, res, config });
        } catch (e) {
          sendText(res, 400, `Slack OAuth failed: ${String(e)}`);
        }
        return;
      }

      const pathParts = pathname.split("/").filter(Boolean);
      if (pathParts[0] === "api" && pathParts[1] === "cloud" && pathParts[2] === "agent") {
        if (pathParts[3] === "e2e-token") {
          if (req.method !== "POST") {
            sendText(res, 404, "not found");
            return;
          }
          if (process.env.TINTIN_E2E !== "1") {
            sendText(res, 404, "not found");
            return;
          }
          const raw = await readRequestBody(req);
          let body: any = {};
          if (raw && raw.trim().length > 0) {
            try {
              body = JSON.parse(raw);
            } catch {
              sendText(res, 400, "invalid json");
              return;
            }
          }
          if (!cloudManager || !config.cloud?.enabled) {
            sendText(res, 404, "cloud not enabled");
            return;
          }
          const now = nowMs();
          const sessionId = crypto.randomUUID();
          const platform = typeof body.platform === "string" ? body.platform : "slack";
          const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "e2e";
          const userId = typeof body.user_id === "string" ? body.user_id : "e2e-user";
          const projectPath = typeof body.project_path === "string" ? body.project_path : process.cwd();
          const sessionRow: SessionRow = {
            id: sessionId,
            agent: "codex",
            platform,
            workspace_id: workspaceId,
            chat_id: `e2e-${sessionId.slice(0, 8)}`,
            space_id: workspaceId,
            space_emoji: null,
            created_by_user_id: userId,
            project_id: "e2e-project",
            project_path_resolved: projectPath,
            codex_session_id: null,
            browserbase_session_id: null,
            hyperbrowser_session_id: null,
            codex_cwd: projectPath,
            status: "running",
            pid: null,
            exit_code: null,
            started_at: now,
            finished_at: null,
            created_at: now,
            updated_at: now,
            last_user_message_at: now,
            language: "en",
          };
          await createSession(db, sessionRow);
          const token = cloudManager.issueAgentTokenForSession(sessionId);
          sendJson(res, 200, { sessionId, token });
          return;
        }
        if (pathParts[3] === "logs") {
          if (req.method !== "POST") {
            sendText(res, 404, "not found");
            return;
          }
          const sessionId = pathParts[4] ?? "";
          const ctx = await resolveAgentContext(req, res, { sessionId });
          if (!ctx) return;
          const payload = await readRequestBody(req);
          if (!payload) {
            sendText(res, 204, "ok");
            return;
          }
          const logPath = await cloudManager!.getOrCreateAgentLogPath(ctx.sessionId);
          if (!logPath) {
            sendText(res, 500, "log path unavailable");
            return;
          }
          await appendFile(logPath, payload);
          sendText(res, 200, "ok");
          return;
        }

        const ctx = await resolveAgentContext(req, res);
        if (!ctx) return;

        const command = pathParts[3] ?? "";
        const subcommand = pathParts[4] ?? "";

        const emitAgentEvent = (payload: {
          command: string;
          subcommand: string;
          request: {
            method: string;
            path: string;
            query?: Record<string, string>;
            body?: unknown;
            meta?: unknown;
            upload_bytes?: number;
          };
          response: {
            status: number;
            body?: unknown;
            text?: string;
            error?: string;
          };
        }) => {
          if (!wsManager) return;
          wsManager.broadcastToSession(ctx.sessionId, {
            type: "agent_event",
            sessionId: ctx.sessionId,
            command: payload.command,
            subcommand: payload.subcommand,
            request: payload.request,
            response: payload.response,
          });
        };

        const sendAgentJson = (
          status: number,
          body: unknown,
          request: {
            method: string;
            path: string;
            query?: Record<string, string>;
            body?: unknown;
            meta?: unknown;
            upload_bytes?: number;
          },
        ) => {
          sendJson(res, status, body);
          emitAgentEvent({
            command,
            subcommand,
            request,
            response: { status, body },
          });
        };

        const sendAgentText = (
          status: number,
          text: string,
          request: {
            method: string;
            path: string;
            query?: Record<string, string>;
            body?: unknown;
            meta?: unknown;
            upload_bytes?: number;
          },
        ) => {
          sendText(res, status, text);
          emitAgentEvent({
            command,
            subcommand,
            request,
            response: status >= 400 ? { status, error: text } : { status, text },
          });
        };

        if (command === "code") {
          if (req.method === "POST" && subcommand === "add") {
            const raw = await readRequestBody(req);
            let body: any = {};
            if (raw && raw.trim().length > 0) {
              try {
                body = JSON.parse(raw);
              } catch {
                sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
                return;
              }
            }
            const directory = typeof body.directory === "string" ? body.directory.trim() : "";
            const summary = typeof body.summary === "string" ? body.summary.trim() : "";
            if (!directory || !summary) {
              sendAgentText(400, "missing directory or summary", { method: req.method ?? "", path: pathname, body });
              return;
            }
            const entry = await createCodeRegistryEntry(db, { identityId: ctx.identityId, directory, summary });
            sendAgentJson(
              200,
              { idx: entry.idx, directory: entry.directory, summary: entry.summary },
              { method: req.method ?? "", path: pathname, body },
            );
            return;
          }
          if (req.method === "GET" && subcommand === "list") {
            const entries = await listCodeRegistryEntries(db, ctx.identityId);
            sendAgentJson(
              200,
              { items: entries.map((row) => ({ idx: row.idx, directory: row.directory, summary: row.summary })) },
              { method: req.method ?? "", path: pathname },
            );
            return;
          }
          if (req.method === "POST" && subcommand === "ignore") {
            const raw = await readRequestBody(req);
            let body: any = {};
            if (raw && raw.trim().length > 0) {
              try {
                body = JSON.parse(raw);
              } catch {
                sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
                return;
              }
            }
            const target = typeof body.target === "string" ? body.target.trim() : "";
            if (!target) {
              sendAgentText(400, "missing target", { method: req.method ?? "", path: pathname, body });
              return;
            }
            const deleted = await ignoreCodeRegistryEntry(db, { identityId: ctx.identityId, target });
            sendAgentJson(200, { deleted }, { method: req.method ?? "", path: pathname, body });
            return;
          }
        }

        if (command === "site") {
          if (req.method === "POST" && subcommand === "add") {
            const raw = await readRequestBody(req);
            let body: any = {};
            if (raw && raw.trim().length > 0) {
              try {
                body = JSON.parse(raw);
              } catch {
                sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
                return;
              }
            }
            const port = Number(body.port);
            const summary = typeof body.summary === "string" ? body.summary.trim() : "";
            const sitePath = typeof body.path === "string" ? body.path.trim() : "";
            if (!Number.isFinite(port) || port <= 0) {
              sendAgentText(400, "invalid port", { method: req.method ?? "", path: pathname, body });
              return;
            }
            if (!summary) {
              sendAgentText(400, "missing summary", { method: req.method ?? "", path: pathname, body });
              return;
            }
            const entry = await createSiteRegistryEntry(db, { identityId: ctx.identityId, port, path: sitePath, summary });
            sendAgentJson(
              200,
              {
                idx: entry.idx,
                port: entry.port,
                path: entry.path,
                summary: entry.summary,
                url: buildLocalSiteUrl(entry.port, entry.path),
              },
              { method: req.method ?? "", path: pathname, body },
            );
            return;
          }
          if (req.method === "GET" && subcommand === "list") {
            const entries = await listSiteRegistryEntries(db, ctx.identityId);
            sendAgentJson(
              200,
              {
                items: entries.map((row) => ({
                  idx: row.idx,
                  port: row.port,
                  path: row.path,
                  summary: row.summary,
                  url: buildLocalSiteUrl(row.port, row.path),
                })),
              },
              { method: req.method ?? "", path: pathname },
            );
            return;
          }
          if (req.method === "POST" && subcommand === "ignore") {
            const raw = await readRequestBody(req);
            let body: any = {};
            if (raw && raw.trim().length > 0) {
              try {
                body = JSON.parse(raw);
              } catch {
                sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
                return;
              }
            }
            const idx = Number(body.idx);
            if (!Number.isFinite(idx)) {
              sendAgentText(400, "invalid idx", { method: req.method ?? "", path: pathname, body });
              return;
            }
            const deleted = await ignoreSiteRegistryEntry(db, { identityId: ctx.identityId, idx });
            sendAgentJson(200, { deleted }, { method: req.method ?? "", path: pathname, body });
            return;
          }
        }

        if (command === "static-deploy") {
          if (req.method === "GET" && subcommand === "list") {
            const entries = await listStaticDeploys(db, ctx.identityId);
            sendAgentJson(
              200,
              {
                items: entries.map((row) => ({
                  idx: row.idx,
                  time: row.created_at,
                  summary: row.summary,
                  app_name: row.app_name,
                  url: `http://${row.stable_host}`,
                })),
              },
              { method: req.method ?? "", path: pathname },
            );
            return;
          }
          if (req.method === "POST" && subcommand === "rollback") {
            const raw = await readRequestBody(req);
            let body: any = {};
            if (raw && raw.trim().length > 0) {
              try {
                body = JSON.parse(raw);
              } catch {
                sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
                return;
              }
            }
            const idx = Number(body.idx);
            if (!Number.isFinite(idx)) {
              sendAgentText(400, "invalid idx", { method: req.method ?? "", path: pathname, body });
              return;
            }
            const entry = await getStaticDeployByIdx(db, ctx.identityId, idx);
            if (!entry) {
              sendAgentText(404, "deploy not found", { method: req.method ?? "", path: pathname, body });
              return;
            }
            const stableHost = entry.stable_host;
            const stableConfPath = path.join(NGINX_CONF_DIR, `site-${entry.session_id}.conf`);
            await writeFile(stableConfPath, buildNginxServerBlock(stableHost, entry.root_path), "utf8");
            const reload = await runCommand("nginx", ["-s", "reload"]);
            if (reload.exitCode !== 0) {
              sendAgentText(500, `nginx reload failed: ${reload.stderr || reload.stdout}`, {
                method: req.method ?? "",
                path: pathname,
                body,
              });
              return;
            }
            await setStaticDeployActive(db, { identityId: ctx.identityId, sessionId: entry.session_id, idx: entry.idx });
            sendAgentJson(
              200,
              { status: "rolled_back", idx: entry.idx, url: `http://${stableHost}` },
              { method: req.method ?? "", path: pathname, body },
            );
            return;
          }
          if (req.method === "POST" && subcommand === "new") {
            const meta = parseAgentMeta(readHeader(req, "x-tintin-meta"));
            const summary = typeof meta?.summary === "string" ? meta.summary.trim() : "";
            const appName = typeof meta?.app_name === "string" ? meta.app_name.trim() : "";
            if (!summary || !appName) {
              sendAgentText(400, "missing summary or app_name", { method: req.method ?? "", path: pathname, meta });
              return;
            }
            const requestInfo: {
              method: string;
              path: string;
              meta?: unknown;
              upload_bytes?: number;
            } = { method: req.method ?? "", path: pathname, meta };
            const tmpArchive = path.join(DYNAMIC_DEPLOY_ROOT, "tmp", `static-${ctx.sessionId}-${Date.now()}.tar.gz`);
            try {
              const uploadBytes = await writeRequestToFile(req, tmpArchive, MAX_UPLOAD_BYTES);
              requestInfo.upload_bytes = uploadBytes;
              const entry = await createStaticDeployEntry(db, {
                identityId: ctx.identityId,
                sessionId: ctx.sessionId,
                appName,
                summary,
                rootPath: "",
                versionHost: "",
                stableHost: `${ctx.sessionId}.site.ctf.so`,
              });
              const rootPath = path.join(STATIC_SITE_ROOT, ctx.sessionId, String(entry.idx));
              const versionHost = `${ctx.sessionId}-${entry.idx}.site.ctf.so`;
              const stableHost = `${ctx.sessionId}.site.ctf.so`;
              const versionConfPath = path.join(NGINX_CONF_DIR, `site-${ctx.sessionId}-${entry.idx}.conf`);
              const stableConfPath = path.join(NGINX_CONF_DIR, `site-${ctx.sessionId}.conf`);
              let prevStableConf: string | null = null;
              try {
                prevStableConf = await readFile(stableConfPath, "utf8");
              } catch {
                prevStableConf = null;
              }
              try {
                await safeExtractTar(tmpArchive, rootPath);
                await writeFile(versionConfPath, buildNginxServerBlock(versionHost, rootPath), "utf8");
                await writeFile(stableConfPath, buildNginxServerBlock(stableHost, rootPath), "utf8");
                const reload = await runCommand("nginx", ["-s", "reload"]);
                if (reload.exitCode !== 0) {
                  throw new Error(`nginx reload failed: ${reload.stderr || reload.stdout}`);
                }
                await updateStaticDeployEntry(db, {
                  identityId: ctx.identityId,
                  idx: entry.idx,
                  patch: { root_path: rootPath, version_host: versionHost, stable_host: stableHost, is_active: 1 },
                });
                await setStaticDeployActive(db, { identityId: ctx.identityId, sessionId: ctx.sessionId, idx: entry.idx });
                sendAgentJson(
                  200,
                  { idx: entry.idx, url: `http://${stableHost}` },
                  requestInfo,
                );
                return;
              } catch (err) {
                if (prevStableConf !== null) {
                  await writeFile(stableConfPath, prevStableConf, "utf8").catch(() => {});
                } else {
                  await rm(stableConfPath, { force: true }).catch(() => {});
                }
                await rm(versionConfPath, { force: true }).catch(() => {});
                await rm(rootPath, { recursive: true, force: true }).catch(() => {});
                await db
                  .deleteFrom("static_deploys")
                  .where("identity_id", "=", ctx.identityId)
                  .where("idx", "=", entry.idx)
                  .execute()
                  .catch(() => {});
                await runCommand("nginx", ["-s", "reload"]).catch(() => {});
                sendAgentText(500, `static deploy failed: ${String(err)}`, requestInfo);
                return;
              }
            } finally {
              await rm(tmpArchive, { force: true }).catch(() => {});
            }
          }
        }

        if (command === "dynamic-deploy") {
          if (req.method === "GET" && subcommand === "list") {
            const entries = await listDynamicDeploys(db, ctx.identityId);
            sendAgentJson(
              200,
              {
                items: entries.map((row) => ({
                  idx: row.idx,
                  time: row.created_at,
                  summary: row.summary,
                  app_name: row.app_name,
                })),
              },
              { method: req.method ?? "", path: pathname },
            );
            return;
          }
          if (req.method === "GET" && subcommand === "log") {
            const idxRaw = url.searchParams.get("idx") ?? "";
            const idx = Number(idxRaw);
            if (!Number.isFinite(idx)) {
              sendAgentText(400, "invalid idx", {
                method: req.method ?? "",
                path: pathname,
                query: { idx: idxRaw },
              });
              return;
            }
            const entry = await getDynamicDeployByIdx(db, ctx.identityId, idx);
            if (!entry) {
              sendAgentText(404, "deploy not found", {
                method: req.method ?? "",
                path: pathname,
                query: { idx: idxRaw },
              });
              return;
            }
            if (!cloudManager || cloudManager.getProviderId() !== "modal") {
              sendAgentText(503, "modal provider required", {
                method: req.method ?? "",
                path: pathname,
                query: { idx: idxRaw },
              });
              return;
            }
            const modal = cloudManager.getModalProviderForDeploy();
            const sandbox = await modal.getSandboxHandle(entry.workspace_id);
            if (!sandbox) {
              sendAgentText(404, "sandbox not found", {
                method: req.method ?? "",
                path: pathname,
                query: { idx: idxRaw },
              });
              return;
            }
            const logCmd = `tail -n 400 ${JSON.stringify(entry.log_path)}`;
            const proc = await sandbox.exec(["/bin/sh", "-lc", logCmd], { workdir: "/", timeoutMs: 10_000, mode: "text" });
            const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
            if (exitCode !== 0) {
              sendAgentText(500, stderr || stdout || "log unavailable", {
                method: req.method ?? "",
                path: pathname,
                query: { idx: idxRaw },
              });
              return;
            }
            sendAgentText(200, stdout || "", {
              method: req.method ?? "",
              path: pathname,
              query: { idx: idxRaw },
            });
            return;
          }
          if (req.method === "POST" && subcommand === "rollback") {
            const raw = await readRequestBody(req);
            let body: any = {};
            if (raw && raw.trim().length > 0) {
              try {
                body = JSON.parse(raw);
              } catch {
                sendAgentText(400, "invalid json", { method: req.method ?? "", path: pathname, body: raw });
                return;
              }
            }
            const idx = Number(body.idx);
            if (!Number.isFinite(idx)) {
              sendAgentText(400, "invalid idx", { method: req.method ?? "", path: pathname, body });
              return;
            }
            const entry = await getDynamicDeployByIdx(db, ctx.identityId, idx);
            if (!entry) {
              sendAgentText(404, "deploy not found", { method: req.method ?? "", path: pathname, body });
              return;
            }
            if (!cloudManager || cloudManager.getProviderId() !== "modal") {
              sendAgentText(503, "modal provider required", { method: req.method ?? "", path: pathname, body });
              return;
            }
            const modal = cloudManager.getModalProviderForDeploy();
            const startup = entry.startup;
            const port = entry.port;
            let setupList: string[] = [];
            try {
              setupList = normalizeSetupList(JSON.parse(entry.setup_json || "[]"));
            } catch {
              setupList = [];
            }
            const archivePath = entry.archive_path;
            const imageRef = entry.image_ref;
            const useSnapshot = Boolean(entry.snapshot_id);
            let workspace = null as any;
            let usedSnapshot = false;
            if (useSnapshot && entry.snapshot_id) {
              try {
                workspace = await modal.createWorkspaceFromSnapshot(entry.snapshot_id, { encryptedPorts: [port] });
                usedSnapshot = true;
              } catch (e) {
                logger.warn(`[deploy][dynamic] snapshot restore failed idx=${entry.idx}: ${String(e)}`);
              }
            }
            if (!workspace) {
              const imageTag = imageRef && !imageRef.startsWith("modal://") ? imageRef : "";
              const imageId = imageRef && imageRef.startsWith("modal://") ? imageRef.slice("modal://".length) : "";
              workspace = await modal.createWorkspaceFromImageRef({
                imageId,
                imageTag,
                label: imageRef || "deploy",
                encryptedPorts: [port],
              });
            }
            const appDir = path.posix.join(workspace.rootPath, "app");
            const logPath = path.posix.join(workspace.rootPath, ".deploy", "startup.log");
            const commands: string[] = [`mkdir -p ${JSON.stringify(appDir)}`];
            if (!usedSnapshot) {
              await modal.uploadFileFromPath(workspace, archivePath, ".deploy/archive.tar.gz");
              const archiveRemote = path.posix.join(workspace.rootPath, ".deploy", "archive.tar.gz");
              commands.push(
                `tar -xzf ${JSON.stringify(archiveRemote)} -C ${JSON.stringify(appDir)}`,
                `rm -f ${JSON.stringify(archiveRemote)}`,
                ...setupList,
              );
            }
            commands.push(
              `cd ${JSON.stringify(appDir)} && nohup /bin/sh -lc ${JSON.stringify(startup)} > ${JSON.stringify(logPath)} 2>&1 &`,
            );
            try {
              await modal.runCommands({ workspace, cwd: "/", commands });
            } catch (e) {
              sendAgentText(500, `deploy rollback failed: ${String(e)}`, { method: req.method ?? "", path: pathname, body });
              return;
            }
            const sandbox = await modal.getSandboxHandle(workspace.id);
            const urlResult = await resolveModalTunnelUrl(sandbox, port);
            await updateDynamicDeployEntry(db, {
              identityId: ctx.identityId,
              idx: entry.idx,
              patch: { workspace_id: workspace.id, url: urlResult, status: "running", log_path: logPath },
            });
            sendAgentJson(
              200,
              { status: "rolled_back", idx: entry.idx, url: urlResult },
              { method: req.method ?? "", path: pathname, body },
            );
            return;
          }
          if (req.method === "POST" && subcommand.startsWith("new")) {
            const meta = parseAgentMeta(readHeader(req, "x-tintin-meta"));
            const summary = typeof meta?.summary === "string" ? meta.summary.trim() : "";
            const appName = typeof meta?.app_name === "string" ? meta.app_name.trim() : "";
            const startup = typeof meta?.startup === "string" ? meta.startup.trim() : "";
            const setupList = normalizeSetupList(meta?.setup);
            const ignoreList = normalizeIgnoreList(meta?.ignore);
            const metaPort = Number(meta?.port);
            const overridePort = Number.isFinite(metaPort) ? metaPort : null;
            if (!summary || !appName || !startup) {
              sendAgentText(400, "missing summary, app_name, or startup", { method: req.method ?? "", path: pathname, meta });
              return;
            }
            if (!cloudManager || cloudManager.getProviderId() !== "modal") {
              sendAgentText(503, "modal provider required", { method: req.method ?? "", path: pathname, meta });
              return;
            }
            const requestInfo: {
              method: string;
              path: string;
              meta?: unknown;
              upload_bytes?: number;
            } = { method: req.method ?? "", path: pathname, meta };
            const tmpArchive = path.join(DYNAMIC_DEPLOY_ROOT, "tmp", `dynamic-${ctx.sessionId}-${Date.now()}.tar.gz`);
            try {
              const uploadBytes = await writeRequestToFile(req, tmpArchive, MAX_UPLOAD_BYTES);
              requestInfo.upload_bytes = uploadBytes;
              const modalCfg = config.cloud?.modal;
              const imageForKind = () => {
                if (!modalCfg) return { imageTag: "", imageId: "" };
                if (subcommand === "new-next" && modalCfg.image_next) return { imageTag: modalCfg.image_next, imageId: "" };
                if (subcommand === "new-express" && modalCfg.image_express) return { imageTag: modalCfg.image_express, imageId: "" };
                if (subcommand === "new-flask" && modalCfg.image_flask) return { imageTag: modalCfg.image_flask, imageId: "" };
                if (modalCfg.image_id) return { imageTag: "", imageId: modalCfg.image_id };
                return { imageTag: modalCfg.image, imageId: "" };
              };
              const { imageTag, imageId } = imageForKind();
              const imageRef = imageId ? `modal://${imageId}` : imageTag;
              const port = overridePort ?? inferPortFromStartup(startup);
              const modal = cloudManager.getModalProviderForDeploy();
              const workspace = await modal.createWorkspaceFromImageRef({
                imageId,
                imageTag,
                label: imageRef || "deploy",
                encryptedPorts: [port],
              });
              await modal.uploadFileFromPath(workspace, tmpArchive, ".deploy/archive.tar.gz");
              const appDir = path.posix.join(workspace.rootPath, "app");
              const archiveRemote = path.posix.join(workspace.rootPath, ".deploy", "archive.tar.gz");
              const logPath = path.posix.join(workspace.rootPath, ".deploy", "startup.log");
              const commands: string[] = [
                `mkdir -p ${JSON.stringify(appDir)}`,
                `tar -xzf ${JSON.stringify(archiveRemote)} -C ${JSON.stringify(appDir)}`,
                `rm -f ${JSON.stringify(archiveRemote)}`,
                ...setupList,
                `cd ${JSON.stringify(appDir)} && nohup /bin/sh -lc ${JSON.stringify(startup)} > ${JSON.stringify(logPath)} 2>&1 &`,
              ];
              await modal.runCommands({ workspace, cwd: "/", commands });
              const sandbox = await modal.getSandboxHandle(workspace.id);
              const urlResult = await resolveModalTunnelUrl(sandbox, port);
              const entry = await createDynamicDeployEntry(db, {
                identityId: ctx.identityId,
                sessionId: ctx.sessionId,
                appName,
                summary,
                provider: "modal",
                imageRef,
                workspaceId: workspace.id,
                port,
                startup,
                setupJson: JSON.stringify(setupList),
                ignoreJson: JSON.stringify(ignoreList),
                archivePath: tmpArchive,
                logPath,
              });
              const archiveDir = path.join(DYNAMIC_DEPLOY_ROOT, "archives", ctx.sessionId);
              const archivePath = path.join(archiveDir, `${entry.idx}.tar.gz`);
              await mkdir(archiveDir, { recursive: true });
              await rename(tmpArchive, archivePath);
              let snapshotId: string | null = null;
              try {
                snapshotId = await modal.snapshotWorkspace(workspace, "deploy");
              } catch (e) {
                logger.warn(`[deploy][dynamic] snapshot failed idx=${entry.idx}: ${String(e)}`);
              }
              await updateDynamicDeployEntry(db, {
                identityId: ctx.identityId,
                idx: entry.idx,
                patch: {
                  archive_path: archivePath,
                  url: urlResult,
                  status: "running",
                  snapshot_id: snapshotId,
                },
              });
              sendAgentJson(200, { idx: entry.idx, log: entry.log_path, url: urlResult }, requestInfo);
              return;
            } finally {
              await rm(tmpArchive, { force: true }).catch(() => {});
            }
          }
        }

        sendText(res, 404, "not found");
        return;
      }

      if (pathParts[0] === "api" && pathParts[1] === "cloud") {
        const payload = requireUiAuth(req, res, url);
        if (!payload) return;

        if (pathParts[2] === "secrets") {
          if (payload.scope !== "identity") {
            sendText(res, 403, "identity token required");
            return;
          }
          if (!config.cloud?.secrets_key) {
            sendText(res, 503, "secrets not configured");
            return;
          }
          if (req.method === "GET" && pathParts.length === 3) {
            const secrets = await listSecrets(db, payload.identity_id);
            sendJson(res, 200, { secrets });
            return;
          }
          if (req.method === "POST" && pathParts.length === 3) {
            const rawBody = await readRequestBody(req);
            let parsed: any = {};
            if (rawBody && rawBody.trim().length > 0) {
              try {
                parsed = JSON.parse(rawBody);
              } catch {
                sendText(res, 400, "invalid json");
                return;
              }
            }
            const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
            const valueRaw = typeof parsed.value === "string" ? parsed.value : "";
            const value = valueRaw.trim();
            const modeRaw = typeof parsed.mode === "string" ? parsed.mode.toLowerCase() : "set";
            if (!name) {
              sendText(res, 400, "missing name");
              return;
            }
            if (!value) {
              sendText(res, 400, "missing value");
              return;
            }
            if (!["set", "create", "update"].includes(modeRaw)) {
              sendText(res, 400, "invalid mode");
              return;
            }
            const existing = await getSecret(db, payload.identity_id, name);
            if (modeRaw === "create" && existing) {
              sendText(res, 409, "secret already exists");
              return;
            }
            if (modeRaw === "update" && !existing) {
              sendText(res, 404, "secret not found");
              return;
            }
            const encrypted = encryptSecret(value, config.cloud.secrets_key);
            await setSecret(db, { identityId: payload.identity_id, name, encryptedValue: encrypted });
            sendJson(res, existing ? 200 : 201, { status: existing ? "updated" : "created" });
            return;
          }
          if (req.method === "DELETE" && pathParts.length === 4) {
            let name = pathParts[3] ?? "";
            try {
              name = decodeURIComponent(name);
            } catch {
              // keep raw
            }
            if (!name) {
              sendText(res, 400, "missing name");
              return;
            }
            const deleted = await deleteSecret(db, payload.identity_id, name);
            sendJson(res, 200, { deleted });
            return;
          }
        }

        if (req.method === "GET" && pathParts[2] === "runs" && pathParts.length === 3) {
          if (payload.scope === "run") {
            const run = await getCloudRun(db, payload.run_id);
            if (!run) {
              sendJson(res, 200, { runs: [], nextCursor: null });
              return;
            }
            sendJson(res, 200, { runs: [run], nextCursor: null });
            return;
          }
          const limitRaw = url.searchParams.get("limit");
          const cursorRaw = url.searchParams.get("cursor");
          const limit = limitRaw ? Number(limitRaw) : undefined;
          const before = cursorRaw ? Number(cursorRaw) : undefined;
          const runs = await listCloudRunsForIdentity(db, {
            identityId: payload.identity_id,
            limit: Number.isFinite(limit) ? limit : undefined,
            before: Number.isFinite(before) ? before : undefined,
          });
          const nextCursor = runs.length > 0 ? runs[runs.length - 1]!.created_at : null;
          sendJson(res, 200, { runs, nextCursor });
          return;
        }

        if (req.method === "GET" && pathParts[2] === "runs" && pathParts.length >= 4) {
          const runId = pathParts[3] ?? "";
          if (!runId) {
            sendText(res, 400, "missing run id");
            return;
          }

          if (pathParts[4] === "events") {
            const run = await requireRunAccess(payload, runId, res);
            if (!run) return;
            if (!run.session_id) {
              sendText(res, 404, "run has no session");
              return;
            }
            const session = await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst();
            if (!session) {
              sendText(res, 404, "session not found");
              return;
            }
            const once = url.searchParams.get("once") === "1";
            const pollRaw = url.searchParams.get("poll");
            const pollParsed = pollRaw ? Number(pollRaw) : NaN;
            const pollMs =
              Number.isFinite(pollParsed) && pollParsed > 0
                ? Math.max(50, Math.min(Math.floor(pollParsed), 2000))
                : 500;

            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
            });
            res.flushHeaders();
            sendSse(res, { ok: true }, "ready");

            let closed = false;
            req.on("close", () => {
              closed = true;
            });

            const offsets = new Map<string, number>();
            while (!closed) {
              let hadNew = false;
            const files = await resolveRunLogFiles(run.session_id, session);
            const lang = resolveSessionLanguage(session);
            for (const file of files) {
                const prevOffset = offsets.get(file) ?? 0;
                const { lines, newOffset } = await readNewJsonlLines(file, prevOffset);
                if (lines.length === 0) {
                  offsets.set(file, newOffset);
                  continue;
                }
                offsets.set(file, newOffset);
                hadNew = true;
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  let obj: unknown;
                  try {
                    obj = JSON.parse(trimmed);
                  } catch {
                    continue;
                  }
                  const fragments = mapEventToFragments(session.agent, obj, {
                    includeUserMessages: true,
                    verbosity: 3,
                    lang,
                  });
                  for (const frag of fragments) {
                    if (frag.kind === "final") continue;
                    if (frag.kind === "plan_update") {
                      sendSse(res, { kind: "plan_update", plan: frag.plan, explanation: frag.explanation });
                      continue;
                    }
                    sendSse(res, frag);
                  }
                }
              }
              if (once && !hadNew) {
                const current = await db
                  .selectFrom("sessions")
                  .select(["status"])
                  .where("id", "=", run.session_id)
                  .executeTakeFirst();
                if (!current || (current.status !== "running" && current.status !== "starting")) break;
              }
              await sleep(pollMs);
            }
            res.end();
            return;
          }

          if (pathParts[4] === "artifacts") {
            const run = await requireRunAccess(payload, runId, res);
            if (!run) return;
            if (!run.session_id) {
              sendJson(res, 200, { diffs: [], commands: [] });
              return;
            }
            const session = await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst();
            if (!session) {
              sendJson(res, 200, { diffs: [], commands: [] });
              return;
            }
            const files = await resolveRunLogFiles(run.session_id, session);
            let baselineResolver: ((filePath: string) => Promise<string | null>) | undefined;
            if (config.cloud?.provider === "local" && config.cloud?.workspaces_dir) {
              let root: string | null = null;
              if (run.snapshot_id) {
                root = path.join(config.cloud.workspaces_dir, "snapshots", run.snapshot_id);
              } else if (run.workspace_id) {
                root = path.join(config.cloud.workspaces_dir, run.workspace_id);
              }
              if (root) {
                const mount = run.primary_repo_id
                  ? await db
                      .selectFrom("cloud_run_repos")
                      .select(["mount_path"])
                      .where("run_id", "=", run.id)
                      .where("repo_id", "=", run.primary_repo_id)
                      .executeTakeFirst()
                  : null;
                const repoRoot = mount ? path.join(root, mount.mount_path) : root;
                baselineResolver = async (filePath: string) => {
                  const full = path.join(repoRoot, filePath);
                  if (!full.startsWith(repoRoot)) return null;
                  return await readFile(full, "utf8").catch(() => null);
                };
              }
            }
            const artifacts = await buildRunArtifactsFromJsonl(files, session.agent, {
              baselineResolver,
              fallbackPatch: run.diff_patch ?? null,
              fallbackTimestamp: run.finished_at ?? null,
            });
            sendJson(res, 200, artifacts);
            return;
          }

          if (pathParts.length === 4) {
            const run = await requireRunAccess(payload, runId, res);
            if (!run) return;
            const identity = await db.selectFrom("identities").selectAll().where("id", "=", run.identity_id).executeTakeFirst();
            const repos = await db
              .selectFrom("cloud_run_repos")
              .innerJoin("repos", "repos.id", "cloud_run_repos.repo_id")
              .select([
                "repos.id",
                "repos.name",
                "repos.url",
                "repos.default_branch",
                "cloud_run_repos.mount_path",
              ])
              .where("cloud_run_repos.run_id", "=", run.id)
              .execute();
            const session = run.session_id
              ? await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst()
              : null;
            sendJson(res, 200, { run, identity, repos, session });
            return;
          }
        }

        if (req.method === "GET" && pathParts[2] === "screenshots") {
          const runId = url.searchParams.get("runId") ?? "";
          if (!runId) {
            sendText(res, 400, "missing runId");
            return;
          }
          const run = await requireRunAccess(payload, runId, res);
          if (!run) return;
          if (!uiConfig || !uiConfig.s3_bucket || !uiConfig.s3_region) {
            sendText(res, 503, "S3 not configured");
            return;
          }
          const rows = await listCloudRunScreenshots(db, runId);
          const items = [];
          for (const row of rows) {
            try {
              const url = await signScreenshotUrl(uiConfig, row.s3_key);
              items.push({
                id: row.id,
                url,
                tool: row.tool,
                mime_type: row.mime_type,
                created_at: row.created_at,
              });
            } catch (e) {
              logger.warn(`sign screenshot failed id=${row.id}: ${String(e)}`);
            }
          }
          sendJson(res, 200, { screenshots: items });
          return;
        }
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
        githubWebhookIngestQueue.enqueue(async () => {
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
            scheduleGithubWebhookProcessing("webhook");
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
            // WebSocket notification (for web UI)
            await notifyWebSocketOAuthComplete(result.metadataJson, result.provider, result.identityId);
            // Telegram/Slack notification (for chat platforms)
            await notifyGithubConnected(result.metadataJson);
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
          // WebSocket notification (for web UI)
          await notifyWebSocketOAuthComplete(result.metadataJson, result.provider, result.identityId);
          // Telegram/Slack notification (for chat platforms)
          if (result.provider === "github") {
            await notifyGithubConnected(result.metadataJson);
          }
          sendText(res, 200, "Connected. Return to the chat.");
        } catch (e) {
          sendText(res, 400, `OAuth failed: ${String(e)}`);
        }
        return;
      }

      // Telegram webhook
      if (telegram && config.telegram?.mode === "webhook" && req.method === "POST" && pathname === config.telegram?.webhook_path) {
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
        queue.enqueue(async () => {
          try {
            await controller.handleTelegramUpdate(body as any);
          } catch (e) {
            logger.error("Telegram update handler error", e);
          }
        });
        sendText(res, 200, "ok");
        return;
      }

      // Slack Events API
      if (slack && req.method === "POST" && pathname === config.slack?.events_path) {
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
        if (eventTime !== null && eventTime < slackEventStartTs) {
          logger.info(
            `[slack] drop stale event type=${String(evType)} event_time=${eventTime} started_at=${slackEventStartTs}`,
          );
          sendText(res, 200, "ok");
          return;
        }
        logger.debug(`[slack] events type=${String(evType)}`);
        queue.enqueue(async () => {
          try {
            await controller.handleSlackEvent(body);
          } catch (e) {
            logger.error("Slack event handler error", e);
          }
        });
        sendText(res, 200, "ok");
        return;
      }

      // Slack Interactivity
      if (slack && req.method === "POST" && pathname === config.slack?.interactions_path) {
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

        // Respond quickly; do real work async.
        logger.debug(`[slack] interaction type=${String(payload?.type ?? "?")}`);
        queue.enqueue(async () => {
          try {
            await controller.handleSlackInteraction(payload);
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

  // WebSocket upgrade handler
  if (wsManager && config.websocket?.enabled) {
    server.on('upgrade', (req, socket, head) => {
      const reqUrl = req.url ?? '';
      const pathOnly = reqUrl.split('?')[0];
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
