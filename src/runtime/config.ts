import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as toml from "@iarna/toml";

export type Platform = "telegram" | "slack";

export interface BotSection {
  name: string;
  host: string;
  port: number;
  data_dir: string;
  github_repos_dir: string;
  log_level: string;
  message_verbosity: 1 | 2 | 3;
}

export interface DbSection {
  url: string;
  echo: boolean;
}

export interface SecuritySection {
  restrict_paths: boolean;
  allow_roots: string[];
  deny_globs: string[];
  max_sessions_per_chat: number;
  max_concurrent_sessions_per_chat: number;
  telegram_allow_user_ids: string[];
  telegram_allow_chat_ids: string[];
  telegram_require_admin: boolean;
  slack_allow_user_ids: string[];
  slack_allow_channel_ids: string[];
  slack_allow_workspace_ids: string[];
}

export interface CodexSection {
  binary: string;
  sessions_dir: string;
  poll_interval_ms: number;
  max_catchup_lines: number;
  timeout_seconds: number;
  env: Record<string, string>;
  full_auto: boolean;
  dangerously_bypass_approvals_and_sandbox: boolean;
  skip_git_repo_check: boolean;
}

export type ClaudeCodeSection = CodexSection;

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
}

export type CloudProvider = "local" | "modal";
export type CloudDefaultAgent = "codex" | "claude_code";

export interface CloudModalSection {
  token_id: string;
  token_secret: string;
  environment: string;
  endpoint: string;
  app_name: string;
  image: string;
  image_id: string;
  timeout_ms: number;
  idle_timeout_ms: number;
  request_timeout_ms: number;
  command_timeout_ms: number;
  block_network: boolean;
  cidr_allowlist: string[];
  workspace_root: string;
  codex_binary: string;
  claude_binary: string;
}

export interface CloudProxySection {
  enabled: boolean;
  shared_secret: string;
  token_ttl_ms: number;
  openai_api_key: string;
  openai_base_url: string;
  anthropic_api_key: string;
  anthropic_base_url: string;
  anthropic_version: string;
  openai_path: string;
  anthropic_path: string;
}

export interface CloudOAuthProviderSection {
  client_id: string;
  client_secret: string;
  authorize_url: string;
  token_url: string;
  api_base_url: string;
  scopes: string[];
}

export interface CloudOAuthSection {
  callback_path: string;
  github?: CloudOAuthProviderSection;
  gitlab?: CloudOAuthProviderSection;
  local?: CloudOAuthProviderSection;
}

export interface CloudGithubAppSection {
  app_id: string;
  app_slug: string;
  private_key: string;
  api_base_url: string;
  app_base_url: string;
  webhook_path: string;
  webhook_secret: string;
}

export interface CloudUiSection {
  path: string;
  token_secret: string;
  token_ttl_ms: number;
  s3_bucket: string;
  s3_region: string;
  s3_prefix: string;
  s3_signed_url_ttl_ms: number;
}

export interface CloudSection {
  enabled: boolean;
  provider: CloudProvider;
  public_base_url: string;
  log_relay_enabled: boolean;
  workspaces_dir: string;
  default_agent: CloudDefaultAgent;
  secrets_key: string;
  keepalive_minutes: number;
  oauth: CloudOAuthSection;
  github_app?: CloudGithubAppSection | null;
  modal?: CloudModalSection | null;
  proxy?: CloudProxySection | null;
  ui?: CloudUiSection | null;
  snapshot_cleanup?: SnapshotCleanupSection | null;
}

export interface PineconeSection {
  api_key: string;
  index: string;
  dimension?: number;
}

export interface SnapshotCleanupSection {
  enabled?: boolean;
  ttl_days?: number;
  keep_per_identity?: number;
  sweep_minutes?: number;
}

export interface TelegramSection {
  token: string;
  additional_bot_tokens: string[];
  mode: "webhook" | "poll";
  public_base_url: string;
  webhook_path: string;
  webhook_secret_token: string;
  poll_timeout_seconds: number;
  use_topics: boolean;
  max_chars: number;
  message_queue_interval_ms: number;
  rate_limit_msgs_per_sec: number;
}

export type SlackSessionMode = "thread" | "channel";

export interface SlackSection {
  bot_token: string;
  signing_secret: string;
  events_path: string;
  interactions_path: string;
  session_mode: SlackSessionMode;
  max_chars: number;
  rate_limit_msgs_per_sec: number;
}

export type PlaywrightSnapshotMode = "incremental" | "full" | "none";
export type PlaywrightImageResponseMode = "allow" | "omit";
export type PlaywrightMcpProvider = "local" | "browserbase" | "hyperbrowser";
export type BrowserbaseProxies = boolean | Record<string, unknown> | Array<Record<string, unknown>>;

export interface PlaywrightMcpBrowserbaseSection {
  api_key: string;
  project_id: string;
  region?: string;
  keep_alive: boolean;
  timeout_sec?: number;
  proxies?: BrowserbaseProxies;
  extension_id?: string | null;
  context_id?: string | null;
  browser_settings?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}

export interface PlaywrightMcpHyperbrowserSection {
  api_key: string;
  api_base_url?: string;
  session_params?: Record<string, unknown> | null;
}

export interface PlaywrightMcpSection {
  enabled: boolean;
  provider: PlaywrightMcpProvider;
  browserbase?: PlaywrightMcpBrowserbaseSection | null;
  hyperbrowser?: PlaywrightMcpHyperbrowserSection | null;
  package: string;
  browser: string;
  host: string;
  port_start: number;
  port_end: number;
  snapshot_mode: PlaywrightSnapshotMode;
  image_responses: PlaywrightImageResponseMode;
  headless: boolean;
  user_data_dir: string;
  output_dir: string;
  executable_path?: string;
  timeout_ms: number;
  user_agent?: string;
  viewport_size?: string;
}

export interface AppConfig {
  bot: BotSection;
  db: DbSection;
  security: SecuritySection;
  codex: CodexSection;
  claude_code?: ClaudeCodeSection | null;
  projects: ProjectEntry[];
  telegram?: TelegramSection;
  slack?: SlackSection;
  playwright_mcp?: PlaywrightMcpSection | null;
  cloud?: CloudSection | null;
  pinecone?: PineconeSection | null;
  config_dir: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function toStringIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.length > 0) out.push(v);
    if (typeof v === "number" && Number.isFinite(v)) out.push(String(v));
  }
  return out;
}

function resolveEnvSecrets(
  value: unknown,
  opts: { allowMissing?: (path: string[]) => boolean } = {},
  path: string[] = [],
): unknown {
  if (typeof value === "string") {
    if (value.startsWith("env:")) {
      const key = value.slice("env:".length);
      const resolved = process.env[key];
      if (!resolved) {
        if (opts.allowMissing?.(path)) return value;
        throw new Error(`Missing required environment variable ${key}`);
      }
      return resolved;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveEnvSecrets(v, opts, [...path, String(i)]));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnvSecrets(v, opts, [...path, k]);
    return out;
  }
  return value;
}

function normalizeHttpPath(p: string, label: string): string {
  assert(p.startsWith("/"), `${label} must start with '/'`);
  return p;
}

function normalizeUrl(u: string, label: string): string {
  try {
    // eslint-disable-next-line no-new
    new URL(u);
    return u;
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
}

function normalizeMessageVerbosity(value: unknown): 1 | 2 | 3 {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (typeof value === "number") {
    if (value <= 1) return 1;
    if (value <= 2) return 2;
  }
  return 3;
}

function normalizePlaywrightSnapshotMode(value: unknown): PlaywrightSnapshotMode {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw === "incremental" || raw === "full" || raw === "none") return raw;
  return "full";
}

function normalizePlaywrightImageResponse(value: unknown): PlaywrightImageResponseMode {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw === "omit") return "omit";
  return "allow";
}

function normalizePlaywrightMcpProvider(value: unknown): PlaywrightMcpProvider {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "browserbase") return "browserbase";
  if (raw === "hyperbrowser") return "hyperbrowser";
  return "local";
}

function normalizeBrowserbaseSection(value: unknown): PlaywrightMcpBrowserbaseSection | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error("[playwright_mcp.browserbase] must be a table");

  const apiKey = typeof value.api_key === "string" ? value.api_key.trim() : "";
  const projectId = typeof value.project_id === "string" ? value.project_id.trim() : "";
  const region = typeof value.region === "string" ? value.region.trim() : "";
  const keepAlive = typeof value.keep_alive === "boolean" ? value.keep_alive : false;
  const timeoutSec =
    typeof value.timeout_sec === "number" && Number.isFinite(value.timeout_sec) ? Math.max(1, Math.floor(value.timeout_sec)) : undefined;

  let proxies: BrowserbaseProxies | undefined;
  const proxiesRaw = (value as any).proxies;
  if (typeof proxiesRaw === "boolean") proxies = proxiesRaw;
  else if (Array.isArray(proxiesRaw)) proxies = proxiesRaw as BrowserbaseProxies;
  else if (isRecord(proxiesRaw)) proxies = proxiesRaw as BrowserbaseProxies;
  else if (proxiesRaw !== undefined) throw new Error("[playwright_mcp.browserbase.proxies] must be a boolean, array, or table");

  const extensionId = typeof value.extension_id === "string" ? value.extension_id.trim() : "";
  const contextId = typeof value.context_id === "string" ? value.context_id.trim() : "";

  if ((value as any).browser_settings !== undefined && !isRecord((value as any).browser_settings)) {
    throw new Error("[playwright_mcp.browserbase.browser_settings] must be a table");
  }
  if ((value as any).user_metadata !== undefined && !isRecord((value as any).user_metadata)) {
    throw new Error("[playwright_mcp.browserbase.user_metadata] must be a table");
  }
  const browserSettings = isRecord((value as any).browser_settings) ? ((value as any).browser_settings as Record<string, unknown>) : null;
  const userMetadata = isRecord((value as any).user_metadata) ? ((value as any).user_metadata as Record<string, unknown>) : null;

  return {
    api_key: apiKey,
    project_id: projectId,
    region: region.length > 0 ? region : undefined,
    keep_alive: keepAlive,
    timeout_sec: timeoutSec,
    proxies,
    extension_id: extensionId.length > 0 ? extensionId : null,
    context_id: contextId.length > 0 ? contextId : null,
    browser_settings: browserSettings,
    user_metadata: userMetadata,
  };
}

function normalizeHyperbrowserSection(value: unknown): PlaywrightMcpHyperbrowserSection | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error("[playwright_mcp.hyperbrowser] must be a table");

  const apiKey = typeof value.api_key === "string" ? value.api_key.trim() : "";
  const apiBaseUrl =
    typeof value.api_base_url === "string" && value.api_base_url.trim().length > 0
      ? value.api_base_url.trim()
      : "https://api.hyperbrowser.ai";
  if ((value as any).session_params !== undefined && !isRecord((value as any).session_params)) {
    throw new Error("[playwright_mcp.hyperbrowser.session_params] must be a table");
  }
  const sessionParams = isRecord((value as any).session_params) ? ((value as any).session_params as Record<string, unknown>) : null;

  return {
    api_key: apiKey,
    api_base_url: apiBaseUrl,
    session_params: sessionParams,
  };
}

function normalizePlaywrightMcpSection(
  value: unknown,
  opts: { configDir: string; dataDir: string },
): PlaywrightMcpSection | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error("[playwright_mcp] must be a table");

  const enabled = typeof value.enabled === "boolean" ? value.enabled : true;
  const provider = normalizePlaywrightMcpProvider((value as any).provider);
  const browserbase = normalizeBrowserbaseSection((value as any).browserbase);
  const hyperbrowser = normalizeHyperbrowserSection((value as any).hyperbrowser);
  const pkg =
    typeof value.package === "string" && value.package.trim().length > 0 ? value.package.trim() : "@playwright/mcp@latest";
  const browser = typeof value.browser === "string" && value.browser.trim().length > 0 ? value.browser.trim() : "chrome";
  const host = typeof value.host === "string" && value.host.trim().length > 0 ? value.host.trim() : "127.0.0.1";

  let portStart = typeof value.port_start === "number" ? Math.floor(value.port_start) : 11_000;
  if (!Number.isFinite(portStart) || portStart < 10_001) portStart = 10_001;
  let portEnd = typeof value.port_end === "number" ? Math.floor(value.port_end) : portStart + 2000;
  if (!Number.isFinite(portEnd) || portEnd <= portStart) portEnd = portStart + 100;

  const snapshotMode = normalizePlaywrightSnapshotMode((value as any).snapshot_mode);
  const imageResponses = normalizePlaywrightImageResponse((value as any).image_responses);
  const headless = typeof (value as any).headless === "boolean" ? (value as any).headless : false;
  const timeoutMs =
    typeof (value as any).timeout_ms === "number" && Number.isFinite((value as any).timeout_ms)
      ? Math.max(1_000, Math.floor((value as any).timeout_ms))
      : 20_000;
  const userAgent =
    typeof (value as any).user_agent === "string" && (value as any).user_agent.trim().length > 0
      ? (value as any).user_agent.trim()
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
  const viewportSize =
    typeof (value as any).viewport_size === "string" && (value as any).viewport_size.trim().length > 0
      ? (value as any).viewport_size.trim()
      : "1366x768";

  const userDataDirRaw =
    typeof (value as any).user_data_dir === "string" && (value as any).user_data_dir.trim().length > 0
      ? (value as any).user_data_dir
      : path.join(opts.dataDir, "playwright", "profile");
  const outputDirRaw =
    typeof (value as any).output_dir === "string" && (value as any).output_dir.trim().length > 0
      ? (value as any).output_dir
      : path.join(opts.dataDir, "playwright", "artifacts");

  const user_data_dir = path.isAbsolute(userDataDirRaw) ? userDataDirRaw : path.resolve(opts.configDir, userDataDirRaw);
  const output_dir = path.isAbsolute(outputDirRaw) ? outputDirRaw : path.resolve(opts.configDir, outputDirRaw);

  const executablePathRaw =
    typeof (value as any).executable_path === "string" && (value as any).executable_path.trim().length > 0
      ? (value as any).executable_path.trim()
      : null;
  const executable_path = executablePathRaw
    ? path.isAbsolute(executablePathRaw)
      ? executablePathRaw
      : path.resolve(opts.configDir, executablePathRaw)
    : undefined;

  return {
    enabled,
    provider,
    browserbase,
    hyperbrowser,
    package: pkg,
    browser,
    host,
    port_start: portStart,
    port_end: portEnd,
    snapshot_mode: snapshotMode,
    image_responses: imageResponses,
    headless,
    user_data_dir,
    output_dir,
    executable_path,
    timeout_ms: timeoutMs,
    user_agent: userAgent,
    viewport_size: viewportSize,
  };
}

function normalizeCodexSection(value: unknown, defaults: { binary: string; sessionsDir: string; env: Record<string, string> }): CodexSection {
  assert(isRecord(value), "section must be a table");

  const envRaw = (isRecord((value as any).env) ? (value as any).env : {}) as Record<string, unknown>;
  const env: Record<string, string> = { ...defaults.env };
  for (const [k, v] of Object.entries(envRaw)) {
    if (typeof v === "string") env[k] = v;
  }

  return {
    binary: typeof (value as any).binary === "string" ? (value as any).binary : defaults.binary,
    sessions_dir: typeof (value as any).sessions_dir === "string" ? (value as any).sessions_dir : defaults.sessionsDir,
    poll_interval_ms: typeof (value as any).poll_interval_ms === "number" ? (value as any).poll_interval_ms : 500,
    max_catchup_lines: typeof (value as any).max_catchup_lines === "number" ? (value as any).max_catchup_lines : 2000,
    timeout_seconds: typeof (value as any).timeout_seconds === "number" ? (value as any).timeout_seconds : 3600,
    env,
    full_auto: typeof (value as any).full_auto === "boolean" ? (value as any).full_auto : true,
    dangerously_bypass_approvals_and_sandbox:
      typeof (value as any).dangerously_bypass_approvals_and_sandbox === "boolean"
        ? (value as any).dangerously_bypass_approvals_and_sandbox
        : true,
    skip_git_repo_check: typeof (value as any).skip_git_repo_check === "boolean" ? (value as any).skip_git_repo_check : true,
  };
}

function normalizeCloudDefaultAgent(value: unknown): CloudDefaultAgent {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw === "claude_code") return "claude_code";
  return "codex";
}

function normalizeCloudOAuthProvider(
  value: unknown,
  defaults: { authorize_url: string; token_url: string; api_base_url: string; scopes: string[] },
): CloudOAuthProviderSection {
  assert(isRecord(value), "oauth provider must be a table");
  const scopes = isStringArray((value as any).scopes) ? ((value as any).scopes as string[]) : defaults.scopes;
  return {
    client_id: typeof (value as any).client_id === "string" ? (value as any).client_id : "",
    client_secret: typeof (value as any).client_secret === "string" ? (value as any).client_secret : "",
    authorize_url:
      typeof (value as any).authorize_url === "string" && (value as any).authorize_url.length > 0
        ? (value as any).authorize_url
        : defaults.authorize_url,
    token_url:
      typeof (value as any).token_url === "string" && (value as any).token_url.length > 0
        ? (value as any).token_url
        : defaults.token_url,
    api_base_url:
      typeof (value as any).api_base_url === "string" && (value as any).api_base_url.length > 0
        ? (value as any).api_base_url
        : defaults.api_base_url,
    scopes,
  };
}

function normalizeCloudModalSection(value: unknown): CloudModalSection {
  const raw = value ?? {};
  assert(isRecord(raw), "[cloud].modal must be a table");
  const token_id = typeof (raw as any).token_id === "string" ? (raw as any).token_id : "";
  const token_secret = typeof (raw as any).token_secret === "string" ? (raw as any).token_secret : "";
  const environment = typeof (raw as any).environment === "string" ? (raw as any).environment : "";
  const endpoint = typeof (raw as any).endpoint === "string" ? (raw as any).endpoint : "";
  const app_name =
    typeof (raw as any).app_name === "string" && (raw as any).app_name.length > 0 ? (raw as any).app_name : "tintin-cloud";
  const image = typeof (raw as any).image === "string" && (raw as any).image.length > 0 ? (raw as any).image : "debian:12";
  const image_id = typeof (raw as any).image_id === "string" ? (raw as any).image_id : "";
  const timeout_ms =
    typeof (raw as any).timeout_ms === "number" && Number.isFinite((raw as any).timeout_ms) && (raw as any).timeout_ms > 0
      ? Math.floor((raw as any).timeout_ms)
      : 86_400_000;
  const idle_timeout_ms =
    typeof (raw as any).idle_timeout_ms === "number" &&
    Number.isFinite((raw as any).idle_timeout_ms) &&
    (raw as any).idle_timeout_ms > 0
      ? Math.floor((raw as any).idle_timeout_ms)
      : 86_400_000;
  const request_timeout_ms =
    typeof (raw as any).request_timeout_ms === "number" &&
    Number.isFinite((raw as any).request_timeout_ms) &&
    (raw as any).request_timeout_ms > 0
      ? Math.floor((raw as any).request_timeout_ms)
      : 60_000;
  const command_timeout_ms =
    typeof (raw as any).command_timeout_ms === "number" &&
    Number.isFinite((raw as any).command_timeout_ms) &&
    (raw as any).command_timeout_ms > 0
      ? Math.floor((raw as any).command_timeout_ms)
      : 60_000;
  const block_network = typeof (raw as any).block_network === "boolean" ? (raw as any).block_network : false;
  const cidr_allowlist = isStringArray((raw as any).cidr_allowlist) ? ((raw as any).cidr_allowlist as string[]) : [];
  const workspace_root =
    typeof (raw as any).workspace_root === "string" && (raw as any).workspace_root.length > 0
      ? (raw as any).workspace_root
      : "/workspace/tintin";
  const codex_binary = typeof (raw as any).codex_binary === "string" && (raw as any).codex_binary.length > 0 ? (raw as any).codex_binary : "codex";
  const claude_binary =
    typeof (raw as any).claude_binary === "string" && (raw as any).claude_binary.length > 0 ? (raw as any).claude_binary : "claude";

  return {
    token_id,
    token_secret,
    environment,
    endpoint,
    app_name,
    image,
    image_id,
    timeout_ms,
    idle_timeout_ms,
    request_timeout_ms,
    command_timeout_ms,
    block_network,
    cidr_allowlist,
    workspace_root,
    codex_binary,
    claude_binary,
  };
}

function normalizeCloudProxySection(value: unknown): CloudProxySection {
  const raw = value ?? {};
  assert(isRecord(raw), "[cloud].proxy must be a table");
  const enabled = typeof (raw as any).enabled === "boolean" ? (raw as any).enabled : true;
  const shared_secret = typeof (raw as any).shared_secret === "string" ? (raw as any).shared_secret : "";
  const token_ttl_ms =
    typeof (raw as any).token_ttl_ms === "number" && Number.isFinite((raw as any).token_ttl_ms) && (raw as any).token_ttl_ms > 0
      ? Math.floor((raw as any).token_ttl_ms)
      : 60 * 60 * 1000;
  const openai_api_key = typeof (raw as any).openai_api_key === "string" ? (raw as any).openai_api_key : "";
  const openai_base_url =
    typeof (raw as any).openai_base_url === "string" && (raw as any).openai_base_url.length > 0
      ? (raw as any).openai_base_url
      : "https://api.openai.com/v1";
  const anthropic_api_key = typeof (raw as any).anthropic_api_key === "string" ? (raw as any).anthropic_api_key : "";
  const anthropic_base_url =
    typeof (raw as any).anthropic_base_url === "string" && (raw as any).anthropic_base_url.length > 0
      ? (raw as any).anthropic_base_url
      : "https://api.anthropic.com";
  const anthropic_version =
    typeof (raw as any).anthropic_version === "string" && (raw as any).anthropic_version.length > 0
      ? (raw as any).anthropic_version
      : "2023-06-01";
  const openai_path =
    typeof (raw as any).openai_path === "string" && (raw as any).openai_path.length > 0
      ? normalizeHttpPath((raw as any).openai_path, "[cloud].proxy.openai_path")
      : "/cloud/proxy/openai";
  const anthropic_path =
    typeof (raw as any).anthropic_path === "string" && (raw as any).anthropic_path.length > 0
      ? normalizeHttpPath((raw as any).anthropic_path, "[cloud].proxy.anthropic_path")
      : "/cloud/proxy/anthropic";

  return {
    enabled,
    shared_secret,
    token_ttl_ms,
    openai_api_key,
    openai_base_url,
    anthropic_api_key,
    anthropic_base_url,
    anthropic_version,
    openai_path,
    anthropic_path,
  };
}

function decodeBase64PrivateKey(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes("BEGIN") && trimmed.includes("PRIVATE KEY")) {
    throw new Error(`${label} must be base64-encoded PEM (not raw PEM)`);
  }
  const normalized = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    throw new Error(`${label} must be base64-encoded PEM`);
  }
  let decoded = "";
  try {
    decoded = Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    throw new Error(`${label} must be base64-encoded PEM`);
  }
  if (!decoded.includes("PRIVATE KEY") || !decoded.includes("BEGIN")) {
    throw new Error(`${label} must decode to a PEM private key`);
  }
  return decoded;
}

function normalizeCloudGithubAppSection(value: unknown): CloudGithubAppSection {
  const raw = value ?? {};
  assert(isRecord(raw), "[cloud].github_app must be a table");
  const app_id = typeof (raw as any).app_id === "string" ? (raw as any).app_id : "";
  const app_slug = typeof (raw as any).app_slug === "string" ? (raw as any).app_slug : "";
  const private_key_raw = typeof (raw as any).private_key === "string" ? (raw as any).private_key : "";
  const private_key = decodeBase64PrivateKey(private_key_raw, "[cloud].github_app.private_key");
  const api_base_url =
    typeof (raw as any).api_base_url === "string" && (raw as any).api_base_url.length > 0
      ? (raw as any).api_base_url
      : "https://api.github.com";
  const app_base_url =
    typeof (raw as any).app_base_url === "string" && (raw as any).app_base_url.length > 0
      ? (raw as any).app_base_url
      : "https://github.com";
  const webhookPathRaw = typeof (raw as any).webhook_path === "string" ? (raw as any).webhook_path : "/github/webhook";
  const webhook_path = normalizeHttpPath(webhookPathRaw, "[cloud].github_app.webhook_path");
  const webhookSecretRaw = typeof (raw as any).webhook_secret === "string" ? (raw as any).webhook_secret : "";
  const webhook_secret = webhookSecretRaw.trim();
  assert(webhook_secret.length > 0, "[cloud].github_app.webhook_secret is required");
  return {
    app_id,
    app_slug,
    private_key,
    api_base_url,
    app_base_url,
    webhook_path,
    webhook_secret,
  };
}

function normalizeCloudUiSection(value: unknown): CloudUiSection {
  const raw = value ?? {};
  assert(isRecord(raw), "[cloud].ui must be a table");
  const pathRaw = typeof (raw as any).path === "string" ? (raw as any).path : "/ui";
  const path = normalizeHttpPath(pathRaw, "[cloud].ui.path");
  const token_secret = typeof (raw as any).token_secret === "string" ? (raw as any).token_secret : "";
  const token_ttl_ms =
    typeof (raw as any).token_ttl_ms === "number" && Number.isFinite((raw as any).token_ttl_ms) && (raw as any).token_ttl_ms > 0
      ? Math.floor((raw as any).token_ttl_ms)
      : 24 * 60 * 60 * 1000;
  const s3_bucket = typeof (raw as any).s3_bucket === "string" ? (raw as any).s3_bucket : "";
  const s3_region = typeof (raw as any).s3_region === "string" ? (raw as any).s3_region : "";
  const s3_prefix = typeof (raw as any).s3_prefix === "string" ? (raw as any).s3_prefix : "tintin/ui";
  const s3_signed_url_ttl_ms =
    typeof (raw as any).s3_signed_url_ttl_ms === "number" &&
    Number.isFinite((raw as any).s3_signed_url_ttl_ms) &&
    (raw as any).s3_signed_url_ttl_ms > 0
      ? Math.floor((raw as any).s3_signed_url_ttl_ms)
      : 5 * 60 * 1000;
  return {
    path,
    token_secret,
    token_ttl_ms,
    s3_bucket,
    s3_region,
    s3_prefix,
    s3_signed_url_ttl_ms,
  };
}

function normalizeCloudSection(value: unknown, opts: { configDir: string; dataDir: string }): CloudSection | null {
  if (value === undefined) return null;
  assert(isRecord(value), "[cloud] must be a table");

  const enabled = typeof (value as any).enabled === "boolean" ? (value as any).enabled : true;
  const providerRaw = typeof (value as any).provider === "string" ? (value as any).provider.toLowerCase() : "local";
  const provider: CloudProvider = providerRaw === "modal" ? "modal" : "local";
  const publicBaseUrl = typeof (value as any).public_base_url === "string" ? (value as any).public_base_url : "";
  const log_relay_enabled =
    typeof (value as any).log_relay_enabled === "boolean" ? (value as any).log_relay_enabled : true;

  const workspacesDirRaw =
    typeof (value as any).workspaces_dir === "string" && (value as any).workspaces_dir.length > 0
      ? (value as any).workspaces_dir
      : path.join(opts.dataDir, "cloud", "workspaces");
  const workspaces_dir = path.isAbsolute(workspacesDirRaw) ? workspacesDirRaw : path.resolve(opts.configDir, workspacesDirRaw);

  const default_agent = normalizeCloudDefaultAgent((value as any).default_agent);
  const secrets_key = typeof (value as any).secrets_key === "string" ? (value as any).secrets_key : "";
  const keepalive_minutes =
    typeof (value as any).keepalive_minutes === "number" &&
    Number.isFinite((value as any).keepalive_minutes) &&
    (value as any).keepalive_minutes >= 0
      ? Math.floor((value as any).keepalive_minutes)
      : 10;

  const oauthRaw = isRecord((value as any).oauth) ? ((value as any).oauth as Record<string, unknown>) : {};
  const callback_path =
    typeof oauthRaw.callback_path === "string" && oauthRaw.callback_path.length > 0
      ? normalizeHttpPath(oauthRaw.callback_path, "[cloud].oauth.callback_path")
      : "/oauth/callback";

  const oauth: CloudOAuthSection = { callback_path };
  if (oauthRaw.github !== undefined) {
    oauth.github = normalizeCloudOAuthProvider(oauthRaw.github, {
      authorize_url: "https://github.com/login/oauth/authorize",
      token_url: "https://github.com/login/oauth/access_token",
      api_base_url: "https://api.github.com",
      scopes: ["repo", "read:user"],
    });
  }
  if (oauthRaw.gitlab !== undefined) {
    oauth.gitlab = normalizeCloudOAuthProvider(oauthRaw.gitlab, {
      authorize_url: "https://gitlab.com/oauth/authorize",
      token_url: "https://gitlab.com/oauth/token",
      api_base_url: "https://gitlab.com/api/v4",
      scopes: ["read_api"],
    });
  }
  if (oauthRaw.local !== undefined) {
    oauth.local = normalizeCloudOAuthProvider(oauthRaw.local, {
      authorize_url: "",
      token_url: "",
      api_base_url: "",
      scopes: [],
    });
  }

  if (enabled && publicBaseUrl.length > 0) {
    normalizeUrl(publicBaseUrl, "[cloud].public_base_url");
  }

  const github_app = (value as any).github_app !== undefined ? normalizeCloudGithubAppSection((value as any).github_app) : null;
  const modal = (value as any).modal !== undefined || provider === "modal" ? normalizeCloudModalSection((value as any).modal) : null;
  const proxy = (value as any).proxy !== undefined ? normalizeCloudProxySection((value as any).proxy) : null;
  const ui = (value as any).ui !== undefined ? normalizeCloudUiSection((value as any).ui) : null;
  const snapshot_cleanup =
    (value as any).snapshot_cleanup !== undefined ? normalizeSnapshotCleanupSection((value as any).snapshot_cleanup) : null;

  return {
    enabled,
    provider,
    public_base_url: publicBaseUrl,
    log_relay_enabled,
    workspaces_dir,
    default_agent,
    secrets_key,
    keepalive_minutes,
    oauth,
    github_app,
    modal,
    proxy,
    ui,
    snapshot_cleanup,
  };
}

function normalizePineconeSection(value: unknown): PineconeSection | null {
  if (value === undefined) return null;
  if (value === null) return null;
  assert(isRecord(value), "[pinecone] must be a table");
  const api_key = typeof value.api_key === "string" ? value.api_key.trim() : "";
  const index = typeof value.index === "string" ? value.index.trim() : "";
  assert(api_key.length > 0, "[pinecone].api_key is required");
  assert(index.length > 0, "[pinecone].index is required");
  return { api_key, index };
}

function normalizeSnapshotCleanupSection(value: unknown): SnapshotCleanupSection | null {
  if (value === undefined || value === null) return null;
  assert(isRecord(value), "[cloud.snapshot_cleanup] must be a table");
  const enabled = value.enabled !== undefined ? Boolean(value.enabled) : true;
  const ttl_days =
    typeof (value as any).ttl_days === "number" && Number.isFinite((value as any).ttl_days) && (value as any).ttl_days > 0
      ? Math.floor((value as any).ttl_days)
      : 30;
  const keep_per_identity =
    typeof (value as any).keep_per_identity === "number" &&
    Number.isFinite((value as any).keep_per_identity) &&
    (value as any).keep_per_identity > 0
      ? Math.floor((value as any).keep_per_identity)
      : 50;
  const sweep_minutes =
    typeof (value as any).sweep_minutes === "number" &&
    Number.isFinite((value as any).sweep_minutes) &&
    (value as any).sweep_minutes > 0
      ? Math.floor((value as any).sweep_minutes)
      : 360;
  return { enabled, ttl_days, keep_per_identity, sweep_minutes };
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absPath = path.resolve(configPath);
  const configDir = path.dirname(absPath);

  const rawText = await readFile(absPath, "utf8");
  const parsed = toml.parse(rawText) as unknown;
  const cloudEnabled = (() => {
    if (!isRecord(parsed)) return false;
    const cloud = (parsed as any).cloud;
    if (!isRecord(cloud)) return false;
    return cloud.enabled === true;
  })();
  const resolved = resolveEnvSecrets(parsed, {
    allowMissing: (path) => !cloudEnabled && path[0] === "cloud",
  }) as unknown;
  assert(isRecord(resolved), "config.toml must parse to a table");

  const bot = resolved.bot;
  const db = resolved.db;
  const security = resolved.security;
  const codex = resolved.codex;
  const claudeCode = (resolved as any).claude_code as unknown;
  const projects = resolved.projects;

  assert(isRecord(bot), "[bot] section is required");
  assert(isRecord(db), "[db] section is required");
  assert(isRecord(security), "[security] section is required");
  assert(isRecord(codex), "[codex] section is required");
  assert(Array.isArray(projects), "[[projects]] entries are required");

  const rawDataDir =
    typeof bot.data_dir === "string" ? path.resolve(configDir, bot.data_dir) : path.resolve(configDir, "./data");
  const rawGithubReposDir = (bot as any).github_repos_dir;
  const githubReposDir =
    typeof rawGithubReposDir === "string" && rawGithubReposDir.length > 0
      ? path.isAbsolute(rawGithubReposDir)
        ? rawGithubReposDir
        : path.resolve(configDir, rawGithubReposDir)
      : path.join(rawDataDir, "repos");

  const botSection: BotSection = {
    name: typeof bot.name === "string" ? bot.name : "codexbot",
    host: typeof bot.host === "string" ? bot.host : "0.0.0.0",
    port: typeof bot.port === "number" ? bot.port : 8787,
    data_dir: rawDataDir,
    github_repos_dir: githubReposDir,
    log_level: typeof bot.log_level === "string" ? bot.log_level : "info",
    message_verbosity: normalizeMessageVerbosity((bot as any).message_verbosity),
  };

  const dbSection: DbSection = {
    url: typeof db.url === "string" ? db.url : "",
    echo: typeof db.echo === "boolean" ? db.echo : false,
  };
  assert(dbSection.url.length > 0, "[db].url is required");

  const securitySection: SecuritySection = {
    restrict_paths: typeof security.restrict_paths === "boolean" ? security.restrict_paths : true,
    allow_roots: isStringArray(security.allow_roots)
      ? security.allow_roots.map((p) => (path.isAbsolute(p) ? p : path.resolve(configDir, p)))
      : [],
    deny_globs: isStringArray(security.deny_globs) ? security.deny_globs : [],
    max_sessions_per_chat:
      typeof security.max_sessions_per_chat === "number" ? security.max_sessions_per_chat : 20,
    max_concurrent_sessions_per_chat:
      typeof security.max_concurrent_sessions_per_chat === "number"
        ? security.max_concurrent_sessions_per_chat
        : 2,
    telegram_allow_user_ids: toStringIdArray((security as any).telegram_allow_user_ids),
    telegram_allow_chat_ids: toStringIdArray((security as any).telegram_allow_chat_ids),
    telegram_require_admin: typeof (security as any).telegram_require_admin === "boolean" ? (security as any).telegram_require_admin : false,
    slack_allow_user_ids: toStringIdArray((security as any).slack_allow_user_ids),
    slack_allow_channel_ids: toStringIdArray((security as any).slack_allow_channel_ids),
    slack_allow_workspace_ids: toStringIdArray((security as any).slack_allow_workspace_ids),
  };

  if (securitySection.restrict_paths) {
    assert(securitySection.allow_roots.length > 0, "[security].allow_roots must be non-empty when restrict_paths=true");
  }

  const codexSection = normalizeCodexSection(codex, {
    binary: "codex",
    sessionsDir: ".codex/sessions",
    env: {},
  });

  assert(codexSection.poll_interval_ms >= 100, "[codex].poll_interval_ms must be >= 100");
  assert(codexSection.timeout_seconds >= 10, "[codex].timeout_seconds must be >= 10");

  let claudeCodeSection: ClaudeCodeSection | null = null;
  if (claudeCode !== undefined) {
    if (!isRecord(claudeCode)) throw new Error("[claude_code] must be a table");
    claudeCodeSection = normalizeCodexSection(claudeCode, {
      binary: "claude",
      sessionsDir: ".claude/sessions",
      env: {},
    });
    assert(claudeCodeSection.poll_interval_ms >= 100, "[claude_code].poll_interval_ms must be >= 100");
    assert(claudeCodeSection.timeout_seconds >= 10, "[claude_code].timeout_seconds must be >= 10");
  }

  const projectEntries: ProjectEntry[] = projects.map((p, idx) => {
    assert(isRecord(p), `projects[${idx}] must be a table`);
    assert(typeof p.id === "string" && p.id.length > 0, `projects[${idx}].id is required`);
    assert(typeof p.name === "string" && p.name.length > 0, `projects[${idx}].name is required`);
    assert(typeof p.path === "string" && p.path.length > 0, `projects[${idx}].path is required`);
    return { id: p.id, name: p.name, path: p.path };
  });
  {
    const seen = new Set<string>();
    for (const p of projectEntries) {
      assert(!seen.has(p.id), `Duplicate project id: ${p.id}`);
      seen.add(p.id);
    }
  }

  let telegramSection: TelegramSection | undefined;
  if (resolved.telegram !== undefined) {
    const tg = resolved.telegram;
    assert(isRecord(tg), "[telegram] must be a table");
    const additionalTokensRaw = Array.isArray((tg as any).additional_bot_tokens) ? (tg as any).additional_bot_tokens : [];
    const additionalTokens: string[] = [];
    for (const t of additionalTokensRaw) {
      if (typeof t === "string" && t.length > 0) additionalTokens.push(t);
    }
    const mode: TelegramSection["mode"] =
      tg.mode === "poll" || tg.mode === "webhook" ? tg.mode : "webhook";
    telegramSection = {
      token: typeof tg.token === "string" ? tg.token : "",
      additional_bot_tokens: additionalTokens,
      mode,
      public_base_url: typeof tg.public_base_url === "string" ? tg.public_base_url : "",
      webhook_path: normalizeHttpPath(typeof tg.webhook_path === "string" ? tg.webhook_path : "/tg/webhook", "[telegram].webhook_path"),
      webhook_secret_token: typeof tg.webhook_secret_token === "string" ? tg.webhook_secret_token : "",
      poll_timeout_seconds: typeof tg.poll_timeout_seconds === "number" ? tg.poll_timeout_seconds : 30,
      use_topics: typeof tg.use_topics === "boolean" ? tg.use_topics : true,
      max_chars: typeof tg.max_chars === "number" ? tg.max_chars : 3500,
      message_queue_interval_ms:
        typeof (tg as any).message_queue_interval_ms === "number"
          ? (tg as any).message_queue_interval_ms
          : 3000,
      rate_limit_msgs_per_sec: typeof tg.rate_limit_msgs_per_sec === "number" ? tg.rate_limit_msgs_per_sec : 1.0,
    };
    assert(telegramSection.token.length > 0, "[telegram].token is required");
    assert(telegramSection.message_queue_interval_ms >= 0, "[telegram].message_queue_interval_ms must be >= 0");
    if (telegramSection.mode === "webhook") {
      assert(
        telegramSection.webhook_secret_token.length > 0,
        "[telegram].webhook_secret_token is required in webhook mode",
      );
      if (telegramSection.public_base_url.length > 0) {
        telegramSection.public_base_url = normalizeUrl(
          telegramSection.public_base_url,
          "[telegram].public_base_url",
        );
      }
    } else {
      assert(
        telegramSection.poll_timeout_seconds >= 0 && telegramSection.poll_timeout_seconds <= 50,
        "[telegram].poll_timeout_seconds must be between 0 and 50",
      );
    }
    if (telegramSection.public_base_url.length > 0 && telegramSection.mode === "poll") {
      telegramSection.public_base_url = normalizeUrl(telegramSection.public_base_url, "[telegram].public_base_url");
    }
  }

  let slackSection: SlackSection | undefined;
  if (resolved.slack !== undefined) {
    const s = resolved.slack;
    assert(isRecord(s), "[slack] must be a table");
    const mode = typeof s.session_mode === "string" ? s.session_mode : "thread";
    assert(mode === "thread" || mode === "channel", "[slack].session_mode must be 'thread' or 'channel'");
    slackSection = {
      bot_token: typeof s.bot_token === "string" ? s.bot_token : "",
      signing_secret: typeof s.signing_secret === "string" ? s.signing_secret : "",
      events_path: normalizeHttpPath(typeof s.events_path === "string" ? s.events_path : "/slack/events", "[slack].events_path"),
      interactions_path: normalizeHttpPath(
        typeof s.interactions_path === "string" ? s.interactions_path : "/slack/interactions",
        "[slack].interactions_path",
      ),
      session_mode: mode,
      max_chars: typeof s.max_chars === "number" ? s.max_chars : 3000,
      rate_limit_msgs_per_sec: typeof s.rate_limit_msgs_per_sec === "number" ? s.rate_limit_msgs_per_sec : 1.0,
    };
    assert(slackSection.bot_token.length > 0, "[slack].bot_token is required");
    assert(slackSection.signing_secret.length > 0, "[slack].signing_secret is required");
  }

  const playwrightMcp = normalizePlaywrightMcpSection((resolved as any).playwright_mcp, {
    configDir,
    dataDir: botSection.data_dir,
  });

  const cloud = normalizeCloudSection((resolved as any).cloud, { configDir, dataDir: botSection.data_dir });
  const pinecone = normalizePineconeSection((resolved as any).pinecone);
  if (cloud?.enabled && cloud.public_base_url.length > 0) {
    cloud.public_base_url = normalizeUrl(cloud.public_base_url, "[cloud].public_base_url");
  }
  if (cloud?.proxy?.enabled) {
    assert(cloud.public_base_url.length > 0, "[cloud].public_base_url is required when proxy is enabled");
    cloud.public_base_url = normalizeUrl(cloud.public_base_url, "[cloud].public_base_url");
    assert(cloud.proxy.shared_secret.length > 0, "[cloud].proxy.shared_secret is required when proxy is enabled");
    cloud.proxy.openai_base_url = normalizeUrl(cloud.proxy.openai_base_url, "[cloud].proxy.openai_base_url");
    cloud.proxy.anthropic_base_url = normalizeUrl(cloud.proxy.anthropic_base_url, "[cloud].proxy.anthropic_base_url");
  }

  assert(telegramSection || slackSection, "At least one of [telegram] or [slack] must be configured");

  return {
    bot: botSection,
    db: dbSection,
    security: securitySection,
    codex: codexSection,
    claude_code: claudeCodeSection,
    projects: projectEntries,
    telegram: telegramSection,
    slack: slackSection,
    playwright_mcp: playwrightMcp,
    cloud,
    pinecone,
    config_dir: configDir,
  };
}
