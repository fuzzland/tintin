import { z } from "zod";

export const McpLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type McpLogLevel = z.infer<typeof McpLogLevelSchema>;

export const BaseMcpProviderSchema = z.object({
  enabled: z.boolean().default(true),
  type: z.string(),
  startup_timeout_sec: z.number().min(1).optional(),
});

export const StdioMcpProviderSchema = BaseMcpProviderSchema.extend({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

const HttpBaseSchema = BaseMcpProviderSchema.extend({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  bearer_token_env_var: z.string().min(1).optional(),
});

export const HttpMcpProviderSchema = HttpBaseSchema.extend({
  type: z.literal("http"),
});

export const SseMcpProviderSchema = HttpBaseSchema.extend({
  type: z.literal("sse"),
});

export const GitHubMcpProviderSchema = BaseMcpProviderSchema.extend({
  type: z.literal("github"),
  github_host: z.string().url().optional(),
  toolsets: z.array(z.string()).optional(),
});

export const NotionMcpProviderSchema = BaseMcpProviderSchema.extend({
  type: z.literal("notion"),
  headers: z.record(z.string(), z.string()).default({}),
  bearer_token_env_var: z.string().min(1).optional(),
});

export const ExaMcpProviderSchema = BaseMcpProviderSchema.extend({
  type: z.literal("exa"),
  api_key: z.string().min(1),
});

const PlaywrightSnapshotModeSchema = z.enum(["incremental", "full", "none"]);
const PlaywrightImageResponseSchema = z.enum(["allow", "omit"]);
const PlaywrightProviderSchema = z.enum(["local", "browserbase", "hyperbrowser"]);

const BrowserbaseProxiesSchema = z.union([
  z.boolean(),
  z.record(z.string(), z.unknown()),
  z.array(z.record(z.string(), z.unknown())),
]);

export const BrowserbaseConfigSchema = z.object({
  api_key: z.string().min(1),
  project_id: z.string().min(1),
  region: z.string().optional(),
  keep_alive: z.boolean().default(false),
  timeout_sec: z.number().min(1).optional(),
  proxies: BrowserbaseProxiesSchema.optional(),
  extension_id: z.string().optional().nullable(),
  context_id: z.string().optional().nullable(),
  browser_settings: z.record(z.string(), z.unknown()).optional().nullable(),
  user_metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const HyperbrowserConfigSchema = z.object({
  api_key: z.string().min(1),
  api_base_url: z.string().url().optional(),
  session_params: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const PlaywrightMcpProviderSchema = BaseMcpProviderSchema.extend({
  type: z.literal("playwright"),
  provider: PlaywrightProviderSchema.default("local"),
  browserbase: BrowserbaseConfigSchema.optional().nullable(),
  hyperbrowser: HyperbrowserConfigSchema.optional().nullable(),
  package: z.string().min(1).default("@playwright/mcp@latest"),
  browser: z.string().min(1).default("chrome"),
  host: z.string().min(1).default("127.0.0.1"),
  port_start: z.number().int().min(1).default(11_000),
  port_end: z.number().int().min(1).optional(),
  snapshot_mode: PlaywrightSnapshotModeSchema.default("full"),
  image_responses: PlaywrightImageResponseSchema.default("allow"),
  headless: z.boolean().default(false),
  user_data_dir: z.string().optional(),
  output_dir: z.string().optional(),
  executable_path: z.string().optional(),
  timeout_ms: z.number().int().min(1_000).default(20_000),
  user_agent: z.string().optional(),
  viewport_size: z.string().optional(),
});

export const McpProviderConfigSchema = z.discriminatedUnion("type", [
  StdioMcpProviderSchema,
  HttpMcpProviderSchema,
  SseMcpProviderSchema,
  PlaywrightMcpProviderSchema,
  GitHubMcpProviderSchema,
  NotionMcpProviderSchema,
  ExaMcpProviderSchema,
]);

export const McpConfigSchema = z.object({
  global_timeout_sec: z.number().min(1).default(60),
  log_level: McpLogLevelSchema.default("info"),
  providers: z.record(z.string(), McpProviderConfigSchema).default({}),
});
