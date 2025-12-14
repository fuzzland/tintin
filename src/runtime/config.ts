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
  log_level: string;
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

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
}

export interface TelegramSection {
  token: string;
  public_base_url: string;
  webhook_path: string;
  webhook_secret_token: string;
  use_topics: boolean;
  max_chars: number;
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

export interface AppConfig {
  bot: BotSection;
  db: DbSection;
  security: SecuritySection;
  codex: CodexSection;
  projects: ProjectEntry[];
  telegram?: TelegramSection;
  slack?: SlackSection;
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

function resolveEnvSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("env:")) {
      const key = value.slice("env:".length);
      const resolved = process.env[key];
      if (!resolved) throw new Error(`Missing required environment variable ${key}`);
      return resolved;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(resolveEnvSecrets);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnvSecrets(v);
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

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absPath = path.resolve(configPath);
  const configDir = path.dirname(absPath);

  const rawText = await readFile(absPath, "utf8");
  const parsed = toml.parse(rawText) as unknown;
  const resolved = resolveEnvSecrets(parsed) as unknown;
  assert(isRecord(resolved), "config.toml must parse to a table");

  const bot = resolved.bot;
  const db = resolved.db;
  const security = resolved.security;
  const codex = resolved.codex;
  const projects = resolved.projects;

  assert(isRecord(bot), "[bot] section is required");
  assert(isRecord(db), "[db] section is required");
  assert(isRecord(security), "[security] section is required");
  assert(isRecord(codex), "[codex] section is required");
  assert(Array.isArray(projects), "[[projects]] entries are required");

  const botSection: BotSection = {
    name: typeof bot.name === "string" ? bot.name : "codexbot",
    host: typeof bot.host === "string" ? bot.host : "0.0.0.0",
    port: typeof bot.port === "number" ? bot.port : 8787,
    data_dir:
      typeof bot.data_dir === "string" ? path.resolve(configDir, bot.data_dir) : path.resolve(configDir, "./data"),
    log_level: typeof bot.log_level === "string" ? bot.log_level : "info",
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

  const codexEnv = (isRecord(codex.env) ? codex.env : {}) as Record<string, unknown>;
  const codexEnvStr: Record<string, string> = {};
  for (const [k, v] of Object.entries(codexEnv)) {
    if (typeof v === "string") codexEnvStr[k] = v;
  }

  const codexSection: CodexSection = {
    binary: typeof codex.binary === "string" ? codex.binary : "codex",
    sessions_dir: typeof codex.sessions_dir === "string" ? codex.sessions_dir : ".codex/sessions",
    poll_interval_ms: typeof codex.poll_interval_ms === "number" ? codex.poll_interval_ms : 500,
    max_catchup_lines: typeof codex.max_catchup_lines === "number" ? codex.max_catchup_lines : 2000,
    timeout_seconds: typeof codex.timeout_seconds === "number" ? codex.timeout_seconds : 3600,
    env: codexEnvStr,
    full_auto: typeof codex.full_auto === "boolean" ? codex.full_auto : true,
    dangerously_bypass_approvals_and_sandbox:
      typeof codex.dangerously_bypass_approvals_and_sandbox === "boolean"
        ? codex.dangerously_bypass_approvals_and_sandbox
        : true,
    skip_git_repo_check: typeof codex.skip_git_repo_check === "boolean" ? codex.skip_git_repo_check : true,
  };

  assert(codexSection.poll_interval_ms >= 100, "[codex].poll_interval_ms must be >= 100");
  assert(codexSection.timeout_seconds >= 10, "[codex].timeout_seconds must be >= 10");

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
    telegramSection = {
      token: typeof tg.token === "string" ? tg.token : "",
      public_base_url: typeof tg.public_base_url === "string" ? tg.public_base_url : "",
      webhook_path: normalizeHttpPath(typeof tg.webhook_path === "string" ? tg.webhook_path : "/tg/webhook", "[telegram].webhook_path"),
      webhook_secret_token: typeof tg.webhook_secret_token === "string" ? tg.webhook_secret_token : "",
      use_topics: typeof tg.use_topics === "boolean" ? tg.use_topics : true,
      max_chars: typeof tg.max_chars === "number" ? tg.max_chars : 3500,
      rate_limit_msgs_per_sec: typeof tg.rate_limit_msgs_per_sec === "number" ? tg.rate_limit_msgs_per_sec : 1.0,
    };
    assert(telegramSection.token.length > 0, "[telegram].token is required");
    assert(telegramSection.webhook_secret_token.length > 0, "[telegram].webhook_secret_token is required");
    if (telegramSection.public_base_url.length > 0) {
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

  assert(telegramSection || slackSection, "At least one of [telegram] or [slack] must be configured");

  return {
    bot: botSection,
    db: dbSection,
    security: securitySection,
    codex: codexSection,
    projects: projectEntries,
    telegram: telegramSection,
    slack: slackSection,
    config_dir: configDir,
  };
}
