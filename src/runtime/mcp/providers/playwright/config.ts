import path from "node:path";

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

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const DEFAULT_VIEWPORT_SIZE = "1366x768";
const PLAYWRIGHT_CONFIG_LABEL = "[mcp.providers.playwright]";
const BROWSERBASE_LABEL = "[mcp.providers.playwright.browserbase]";
const HYPERBROWSER_LABEL = "[mcp.providers.playwright.hyperbrowser]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`${BROWSERBASE_LABEL} must be a table`);

  const apiKey = typeof value.api_key === "string" ? value.api_key.trim() : "";
  const projectId = typeof value.project_id === "string" ? value.project_id.trim() : "";
  const region = typeof value.region === "string" ? value.region.trim() : "";
  const keepAlive = typeof value.keep_alive === "boolean" ? value.keep_alive : false;
  const timeoutSec =
    typeof value.timeout_sec === "number" && Number.isFinite(value.timeout_sec)
      ? Math.max(1, Math.floor(value.timeout_sec))
      : undefined;

  let proxies: BrowserbaseProxies | undefined;
  const proxiesRaw = (value as { proxies?: unknown }).proxies;
  if (typeof proxiesRaw === "boolean") proxies = proxiesRaw;
  else if (Array.isArray(proxiesRaw)) proxies = proxiesRaw as BrowserbaseProxies;
  else if (isRecord(proxiesRaw)) proxies = proxiesRaw as BrowserbaseProxies;
  else if (proxiesRaw !== undefined && proxiesRaw !== null)
    throw new Error(`${BROWSERBASE_LABEL}.proxies must be a boolean, array, or table`);

  const extensionId = typeof value.extension_id === "string" ? value.extension_id.trim() : "";
  const contextId = typeof value.context_id === "string" ? value.context_id.trim() : "";

  const browserSettingsRaw = (value as { browser_settings?: unknown }).browser_settings;
  if (browserSettingsRaw !== undefined && browserSettingsRaw !== null && !isRecord(browserSettingsRaw)) {
    throw new Error(`${BROWSERBASE_LABEL}.browser_settings must be a table`);
  }
  const userMetadataRaw = (value as { user_metadata?: unknown }).user_metadata;
  if (userMetadataRaw !== undefined && userMetadataRaw !== null && !isRecord(userMetadataRaw)) {
    throw new Error(`${BROWSERBASE_LABEL}.user_metadata must be a table`);
  }
  const browserSettings = isRecord(browserSettingsRaw)
    ? (browserSettingsRaw as Record<string, unknown>)
    : null;
  const userMetadata = isRecord(userMetadataRaw)
    ? (userMetadataRaw as Record<string, unknown>)
    : null;

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
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`${HYPERBROWSER_LABEL} must be a table`);

  const apiKey = typeof value.api_key === "string" ? value.api_key.trim() : "";
  const apiBaseUrl =
    typeof value.api_base_url === "string" && value.api_base_url.trim().length > 0
      ? value.api_base_url.trim()
      : "https://api.hyperbrowser.ai";
  const sessionParamsRaw = (value as { session_params?: unknown }).session_params;
  if (sessionParamsRaw !== undefined && sessionParamsRaw !== null && !isRecord(sessionParamsRaw)) {
    throw new Error(`${HYPERBROWSER_LABEL}.session_params must be a table`);
  }
  const sessionParams = isRecord(sessionParamsRaw) ? (sessionParamsRaw as Record<string, unknown>) : null;

  return {
    api_key: apiKey,
    api_base_url: apiBaseUrl,
    session_params: sessionParams,
  };
}

export function normalizePlaywrightMcpSection(
  value: unknown,
  opts: { configDir: string; dataDir: string },
): PlaywrightMcpSection | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`${PLAYWRIGHT_CONFIG_LABEL} must be a table`);

  const enabled = typeof value.enabled === "boolean" ? value.enabled : true;
  const provider = normalizePlaywrightMcpProvider((value as { provider?: unknown }).provider);
  const browserbase = normalizeBrowserbaseSection((value as { browserbase?: unknown }).browserbase);
  const hyperbrowser = normalizeHyperbrowserSection((value as { hyperbrowser?: unknown }).hyperbrowser);
  const pkg =
    typeof value.package === "string" && value.package.trim().length > 0 ? value.package.trim() : "@playwright/mcp@latest";
  const browser = typeof value.browser === "string" && value.browser.trim().length > 0 ? value.browser.trim() : "chrome";
  const host = typeof value.host === "string" && value.host.trim().length > 0 ? value.host.trim() : "127.0.0.1";

  let portStart = typeof value.port_start === "number" ? Math.floor(value.port_start) : 11_000;
  if (!Number.isFinite(portStart) || portStart < 10_001) portStart = 10_001;
  let portEnd = typeof value.port_end === "number" ? Math.floor(value.port_end) : portStart + 2000;
  if (!Number.isFinite(portEnd) || portEnd <= portStart) portEnd = portStart + 100;

  const snapshotMode = normalizePlaywrightSnapshotMode((value as { snapshot_mode?: unknown }).snapshot_mode);
  const imageResponses = normalizePlaywrightImageResponse((value as { image_responses?: unknown }).image_responses);
  const headless = typeof (value as { headless?: unknown }).headless === "boolean" ? (value as { headless: boolean }).headless : false;
  const timeoutMs =
    typeof (value as { timeout_ms?: unknown }).timeout_ms === "number" &&
    Number.isFinite((value as { timeout_ms: number }).timeout_ms)
      ? Math.max(1_000, Math.floor((value as { timeout_ms: number }).timeout_ms))
      : 20_000;
  const userAgent =
    typeof (value as { user_agent?: unknown }).user_agent === "string" && (value as { user_agent: string }).user_agent.trim().length > 0
      ? (value as { user_agent: string }).user_agent.trim()
      : DEFAULT_USER_AGENT;
  const viewportSize =
    typeof (value as { viewport_size?: unknown }).viewport_size === "string" &&
      (value as { viewport_size: string }).viewport_size.trim().length > 0
      ? (value as { viewport_size: string }).viewport_size.trim()
      : DEFAULT_VIEWPORT_SIZE;

  const userDataDirRaw =
    typeof (value as { user_data_dir?: unknown }).user_data_dir === "string" &&
      (value as { user_data_dir: string }).user_data_dir.trim().length > 0
      ? (value as { user_data_dir: string }).user_data_dir
      : path.join(opts.dataDir, "playwright", "profile");
  const outputDirRaw =
    typeof (value as { output_dir?: unknown }).output_dir === "string" && (value as { output_dir: string }).output_dir.trim().length > 0
      ? (value as { output_dir: string }).output_dir
      : path.join(opts.dataDir, "playwright", "artifacts");

  const user_data_dir = path.isAbsolute(userDataDirRaw) ? userDataDirRaw : path.resolve(opts.configDir, userDataDirRaw);
  const output_dir = path.isAbsolute(outputDirRaw) ? outputDirRaw : path.resolve(opts.configDir, outputDirRaw);

  const executablePathRaw =
    typeof (value as { executable_path?: unknown }).executable_path === "string" &&
      (value as { executable_path: string }).executable_path.trim().length > 0
      ? (value as { executable_path: string }).executable_path.trim()
      : null;
  const executable_path = executablePathRaw
    ? path.isAbsolute(executablePathRaw)
      ? executablePathRaw
      : path.resolve(opts.configDir, executablePathRaw)
    : undefined;

  if (provider === "browserbase") {
    if (!browserbase) throw new Error(`${BROWSERBASE_LABEL} is required when provider="browserbase"`);
    if (!browserbase.api_key || !browserbase.project_id) {
      throw new Error(`${BROWSERBASE_LABEL}.api_key and project_id are required when provider="browserbase"`);
    }
  }
  if (provider === "hyperbrowser") {
    if (!hyperbrowser) throw new Error(`${HYPERBROWSER_LABEL} is required when provider="hyperbrowser"`);
    if (!hyperbrowser.api_key) {
      throw new Error(`${HYPERBROWSER_LABEL}.api_key is required when provider="hyperbrowser"`);
    }
  }

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
