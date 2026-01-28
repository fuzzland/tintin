import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createConnection, createServer } from "node:net";
import process from "node:process";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionRow } from "../store.js";
import { redactText } from "../redact.js";
import { nowMs, sleep } from "../util.js";
import { getChatgptAccountForIdentity, persistChatgptProxyTokens } from "../chatgpt/oauth.js";
import { getIdentity } from "../cloud/store.js";
import { t, type UserLanguage, isUserLanguage } from "../../locales/index.js";
import type { ChatGptProxyContext } from "./types.js";

/**
 * ChatGptProxyManager - Manages ChatGPT OAuth proxy processes.
 *
 * For Codex sessions, this manager:
 * - Starts a local ChatGPT proxy process per session
 * - Manages OAuth token refresh
 * - Persists refreshed tokens to the database
 * - Cleans up proxy processes on session end
 */
export class ChatGptProxyManager {
  private readonly chatgptProxies = new Map<string, ChatGptProxyContext>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  /**
   * Prepare the ChatGPT proxy for a session if needed.
   * Returns the modified environment variables.
   */
  async prepare(
    session: SessionRow,
    baseEnv: Record<string, string>,
  ): Promise<Record<string, string>> {
    if (session.agent !== "codex") return baseEnv;
    if (this.chatgptProxies.has(session.id)) return baseEnv;

    const base = { ...baseEnv };
    try {
      const identity = await getIdentity(this.db, {
        platform: session.platform,
        workspaceId: session.workspace_id ?? null,
        userId: session.created_by_user_id,
      });
      if (!identity) return base;

      const account = await getChatgptAccountForIdentity({
        db: this.db,
        config: this.config,
        identityId: identity.id,
      });
      if (!account) return base;

      const proxyBin = await this.resolveChatgptProxyBin();
      if (!proxyBin) throw new Error("ChatGPT proxy binary not found");

      const refreshPath = path.join(os.tmpdir(), `tintin-chatgpt-refresh-${session.id}.json`);
      const requestedPort = base.CHATGPT_PROXY_PORT ? Number(base.CHATGPT_PROXY_PORT) : 0;
      let port = 0;

      if (Number.isFinite(requestedPort) && requestedPort > 0) {
        port = requestedPort;
      } else {
        port = await this.allocateLoopbackPort();
        if (!port) {
          port = await this.allocateLoopbackPort();
          if (!port) {
            throw new Error(
              "Failed to allocate ChatGPT proxy port (localhost). Retry or set CHATGPT_PROXY_PORT to a free port.",
            );
          }
        }
      }

      const host = base.CHATGPT_PROXY_HOST || "127.0.0.1";
      const lang = this.resolveSessionLanguage(session);
      const languageDirective = base.CHATGPT_PROXY_LANGUAGE_PROMPT ?? t("prompt.language_directive", lang);
      const languageDirectiveB64 =
        base.CHATGPT_PROXY_LANGUAGE_PROMPT_B64 ??
        (languageDirective ? Buffer.from(languageDirective, "utf8").toString("base64") : "");

      const proxyEnv: Record<string, string> = {
        ...base,
        CHATGPT_PROXY_ENABLED: "1",
        CHATGPT_ACCESS_TOKEN: account.accessToken,
        CHATGPT_REFRESH_TOKEN: account.refreshToken,
        CHATGPT_EXPIRES_AT: String(account.expiresAt),
        CHATGPT_ACCOUNT_ID: account.chatgptUserId,
        CHATGPT_PROXY_PORT: String(port),
        CHATGPT_PROXY_HOST: host,
        CHATGPT_REFRESH_OUT: refreshPath,
        CHATGPT_PROXY_LOG_PREFIX: base.CHATGPT_PROXY_LOG_PREFIX ?? `[chatgpt][proxy][${session.id}]`,
        CHATGPT_REFRESH_PREFIX: base.CHATGPT_REFRESH_PREFIX ?? `[chatgpt][refresh][${session.id}]`,
        CHATGPT_PROXY_LANGUAGE_PROMPT: languageDirective,
        CHATGPT_PROXY_LANGUAGE_PROMPT_B64: languageDirectiveB64,
      };

      const proc = spawn(process.execPath, [proxyBin], {
        env: { ...process.env, ...proxyEnv },
        stdio: ["ignore", "ignore", "pipe"],
      });

      let proxyReady = false;
      let exitInfo: string | null = null;

      const recordExit = (info: string) => {
        if (exitInfo) return;
        exitInfo = info;
      };

      const handleProxyExit = (info: string) => {
        const entry = this.chatgptProxies.get(session.id);
        if (!entry || entry.proc !== proc) return;
        this.chatgptProxies.delete(session.id);
        void this.persistRefreshFile(session.id, entry.refreshPath, entry.identityId);
        if (proxyReady) {
          this.logger.warn(`[chatgpt][proxy] exited session=${session.id} ${info}`);
        }
      };

      proc.once("error", (err) => {
        const info = `error=${String(err)}`;
        recordExit(info);
        handleProxyExit(info);
      });

      proc.once("exit", (code, signal) => {
        const info = `exit code=${code ?? "null"} signal=${signal ?? "none"}`;
        recordExit(info);
        handleProxyExit(info);
      });

      proc.stderr?.on("data", (buf) => {
        const line = buf.toString("utf8").trim();
        if (line) this.logger.debug(redactText(line));
      });

      this.chatgptProxies.set(session.id, { proc, refreshPath, identityId: identity.id });
      this.logger.debug(
        `[chatgpt][proxy] spawn session=${session.id} port=${port} account=${account.chatgptUserId}`,
      );

      const startupTimeoutMsRaw = Number(base.CHATGPT_PROXY_STARTUP_TIMEOUT_MS ?? 5000);
      const startupTimeoutMs =
        Number.isFinite(startupTimeoutMsRaw) && startupTimeoutMsRaw > 0 ? startupTimeoutMsRaw : 5000;

      const ready = await this.waitForProxyReady(host, port, startupTimeoutMs, () => exitInfo !== null);
      if (!ready || exitInfo) {
        const reason = exitInfo ?? "not ready before timeout";
        this.logger.warn(`[chatgpt][proxy] startup failed session=${session.id} ${reason}`);
        this.chatgptProxies.delete(session.id);
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        await this.persistRefreshFile(session.id, refreshPath, identity.id);
        return base;
      }

      proxyReady = true;
      const envWithProxy: Record<string, string> = { ...proxyEnv };
      if (!envWithProxy.OPENAI_BASE_URL) envWithProxy.OPENAI_BASE_URL = `http://${host}:${port}`;
      if (!envWithProxy.OPENAI_API_BASE) envWithProxy.OPENAI_API_BASE = envWithProxy.OPENAI_BASE_URL;
      if (!envWithProxy.OPENAI_API_KEY) envWithProxy.OPENAI_API_KEY = "chatgpt-oauth";

      this.logger.info(
        `[chatgpt][proxy] ready session=${session.id} port=${port} account=${account.chatgptUserId} exp=${new Date(account.expiresAt).toISOString()}`,
      );
      return envWithProxy;
    } catch (e) {
      this.logger.warn(`[chatgpt][proxy] setup failed session=${session.id}: ${String(e)}`);
      return base;
    }
  }

  /**
   * Teardown the ChatGPT proxy for a session.
   */
  async teardown(
    sessionId: string,
    workspaceId: string | null,
    platform: string | null,
    userId: string | null,
  ): Promise<void> {
    const entry = this.chatgptProxies.get(sessionId);
    if (entry) {
      try {
        entry.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.chatgptProxies.delete(sessionId);
      await this.persistRefreshFile(sessionId, entry.refreshPath, entry.identityId);
      return;
    }

    // Even if no proxy was running, try to persist any refresh file that may exist
    if (platform && userId) {
      const identity = await getIdentity(this.db, { platform, workspaceId, userId });
      await this.persistRefreshFile(
        sessionId,
        path.join(os.tmpdir(), `tintin-chatgpt-refresh-${sessionId}.json`),
        identity?.id ?? null,
      );
    }
  }

  /**
   * Check if a session has an active ChatGPT proxy.
   */
  has(sessionId: string): boolean {
    return this.chatgptProxies.has(sessionId);
  }

  /**
   * Get proxy info for a session.
   */
  get(sessionId: string): ChatGptProxyContext | undefined {
    return this.chatgptProxies.get(sessionId);
  }

  // Private helper methods

  private resolveSessionLanguage(session: { language?: string | null }): UserLanguage {
    const language = session.language;
    return typeof language === "string" && isUserLanguage(language) ? language : "en";
  }

  private async resolveChatgptProxyBin(): Promise<string | null> {
    const candidates = [
      "/usr/local/bin/tintin-chatgpt-proxy.js",
      path.resolve(this.config.config_dir ?? process.cwd(), "image/tintin-chatgpt-proxy.js"),
      path.resolve(process.cwd(), "image/tintin-chatgpt-proxy.js"),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async allocateLoopbackPort(): Promise<number> {
    return await new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(0));
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr && typeof addr.port === "number" ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
  }

  private async tryConnectToProxy(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return await new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const socket = createConnection({ host, port });
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  private async waitForProxyReady(
    host: string,
    port: number,
    timeoutMs: number,
    shouldAbort?: () => boolean,
  ): Promise<boolean> {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      if (shouldAbort?.()) return false;
      const ok = await this.tryConnectToProxy(host, port, 500);
      if (ok) return true;
      await sleep(200);
    }
    return false;
  }

  private async persistRefreshFile(
    sessionId: string,
    refreshPath: string,
    identityId: string | null,
  ): Promise<void> {
    if (!refreshPath || !identityId) return;
    let raw: string;
    try {
      raw = await readFile(refreshPath, "utf8");
    } catch {
      return;
    }
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    let updated = false;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, any>;
        const accessToken = typeof obj.access_token === "string" ? obj.access_token : "";
        const refreshToken = typeof obj.refresh_token === "string" ? obj.refresh_token : "";
        const expRaw = obj.expires_at ?? obj.expiresAt;
        const exp = typeof expRaw === "number" ? expRaw : Number(expRaw);
        if (!accessToken || !refreshToken || !Number.isFinite(exp)) continue;

        await persistChatgptProxyTokens({
          db: this.db,
          config: this.config,
          identityId,
          accessToken,
          refreshToken,
          expiresAt: exp,
          scope: typeof obj.scope === "string" ? obj.scope : null,
          expectedAccountId: typeof obj.account_id === "string" ? obj.account_id : undefined,
        });
        updated = true;
      } catch {
        continue;
      }
    }
    if (updated) {
      this.logger.info(`[chatgpt][oauth] persisted refreshed tokens session=${sessionId} identity=${identityId}`);
    }
  }
}
