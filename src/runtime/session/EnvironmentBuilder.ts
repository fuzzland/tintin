import type { AppConfig } from "../config.js";
import type { UserLanguage } from "../../locales/index.js";
import { t } from "../../locales/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProxyToken } from "../cloud/proxy.js";
import type { CloudProxyResult } from "./types.js";

/**
 * EnvironmentBuilder - Fluent builder for constructing agent environment variables.
 *
 * Follows the builder pattern to construct environment variables for agent processes.
 * Each method returns `this` to allow chaining.
 */
export class EnvironmentBuilder {
  private env: Record<string, string> = {};

  /**
   * Start with base environment variables (optional overrides).
   */
  withBase(overrides?: Record<string, string>): this {
    if (overrides) {
      this.env = { ...this.env, ...overrides };
    }
    return this;
  }

  /**
   * Add language-related environment variables.
   */
  withLanguage(lang: UserLanguage): this {
    const directive = t("prompt.language_directive", lang);
    if (directive) {
      this.env.CHATGPT_PROXY_LANGUAGE_PROMPT = directive;
      this.env.CHATGPT_PROXY_LANGUAGE_PROMPT_B64 = Buffer.from(directive, "utf8").toString("base64");
    }
    this.env.CHATGPT_PROXY_LANGUAGE = lang;
    if (!this.env.CHATGPT_PROXY_LANGUAGE_STRICT) this.env.CHATGPT_PROXY_LANGUAGE_STRICT = "1";
    if (!this.env.CHATGPT_PROXY_LANGUAGE_CHECK) this.env.CHATGPT_PROXY_LANGUAGE_CHECK = "1";
    this.env.TINTIN_USER_LANGUAGE = lang;

    // Set locale
    const locale = lang === "zh" ? "zh_CN.UTF-8" : "en_US.UTF-8";
    if (!this.env.LANG) this.env.LANG = locale;
    if (!this.env.LC_ALL) this.env.LC_ALL = locale;

    return this;
  }

  /**
   * Add cloud proxy environment variables for local sessions.
   * This allows local/WebSocket sessions to use the centralized API key
   * configured in [cloud.proxy] without needing to set OPENAI_API_KEY in config.
   */
  async withCloudProxy(
    config: AppConfig,
    identityId: string,
  ): Promise<CloudProxyResult> {
    const proxy = config.cloud?.proxy;
    if (!proxy?.enabled || !proxy.openai_api_key || !proxy.shared_secret) {
      return { env: this.env };
    }

    // Generate proxy token
    const token = createProxyToken(proxy.shared_secret, identityId, proxy.token_ttl_ms);

    // Build proxy URL
    const baseUrl = config.cloud?.public_base_url ?? `http://127.0.0.1:${config.bot.port}`;
    const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const proxyUrl = `${trimmedBase}${proxy.openai_path}`;

    // Create a proxy-specific CODEX_HOME directory
    const proxyCodexHome = path.join(config.bot.data_dir, "codex-proxy-home");
    try {
      await mkdir(proxyCodexHome, { recursive: true });
      await mkdir(path.join(proxyCodexHome, "sessions"), { recursive: true });
      const authJson = JSON.stringify({ OPENAI_API_KEY: token }, null, 2);
      await writeFile(path.join(proxyCodexHome, "auth.json"), authJson, "utf8");
    } catch {
      // Ignore errors, will fall back to env vars
    }

    this.env.OPENAI_API_KEY = token;
    this.env.OPENAI_BASE_URL = proxyUrl;
    this.env.OPENAI_API_BASE = proxyUrl;
    this.env.CODEX_HOME = proxyCodexHome;

    return {
      env: this.env,
      codexHome: proxyCodexHome,
    };
  }

  /**
   * Add ChatGPT proxy environment variables.
   */
  withChatGptProxy(
    host: string,
    port: number,
    accessToken: string,
    refreshToken: string,
    expiresAt: number,
    chatgptUserId: string,
    sessionId: string,
    refreshPath: string,
    languageDirective: string,
    languageDirectiveB64: string,
  ): this {
    this.env.CHATGPT_PROXY_ENABLED = "1";
    this.env.CHATGPT_ACCESS_TOKEN = accessToken;
    this.env.CHATGPT_REFRESH_TOKEN = refreshToken;
    this.env.CHATGPT_EXPIRES_AT = String(expiresAt);
    this.env.CHATGPT_ACCOUNT_ID = chatgptUserId;
    this.env.CHATGPT_PROXY_PORT = String(port);
    this.env.CHATGPT_PROXY_HOST = host;
    this.env.CHATGPT_REFRESH_OUT = refreshPath;
    this.env.CHATGPT_PROXY_LOG_PREFIX = this.env.CHATGPT_PROXY_LOG_PREFIX ?? `[chatgpt][proxy][${sessionId}]`;
    this.env.CHATGPT_REFRESH_PREFIX = this.env.CHATGPT_REFRESH_PREFIX ?? `[chatgpt][refresh][${sessionId}]`;
    this.env.CHATGPT_PROXY_LANGUAGE_PROMPT = languageDirective;
    this.env.CHATGPT_PROXY_LANGUAGE_PROMPT_B64 = languageDirectiveB64;

    // Set OPENAI_* vars to point to proxy
    if (!this.env.OPENAI_BASE_URL) this.env.OPENAI_BASE_URL = `http://${host}:${port}`;
    if (!this.env.OPENAI_API_BASE) this.env.OPENAI_API_BASE = this.env.OPENAI_BASE_URL;
    if (!this.env.OPENAI_API_KEY) this.env.OPENAI_API_KEY = "chatgpt-oauth";

    return this;
  }

  /**
   * Add Playwright MCP environment variables.
   */
  withPlaywright(server: { url: string }): this {
    // Playwright config is typically handled via CLI args, not env vars
    // This is a placeholder for any future env-based configuration
    return this;
  }

  /**
   * Set a single environment variable.
   */
  set(key: string, value: string): this {
    this.env[key] = value;
    return this;
  }

  /**
   * Set multiple environment variables.
   */
  setAll(vars: Record<string, string>): this {
    for (const [key, value] of Object.entries(vars)) {
      this.env[key] = value;
    }
    return this;
  }

  /**
   * Get the current environment variables.
   */
  getEnv(): Record<string, string> {
    return { ...this.env };
  }

  /**
   * Build and return an immutable copy of the environment.
   */
  build(): Record<string, string> {
    return Object.freeze({ ...this.env });
  }

  /**
   * Create a new builder with a copy of the current state.
   */
  clone(): EnvironmentBuilder {
    const builder = new EnvironmentBuilder();
    builder.env = { ...this.env };
    return builder;
  }
}
