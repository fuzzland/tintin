import type { AppConfig } from "../config.js";
import type { Db, SessionAgent } from "../db.js";
import { getAgentAdapter } from "../agents.js";
import { encryptSecret } from "../cloud/secrets.js";
import {
  deleteSecret,
  setIdentityBranchNameRule,
  setIdentityGitUserEmail,
  setIdentityGitUserName,
  setIdentityKeepaliveMinutes,
  setIdentityMessageVerbosity,
  setSecret,
} from "../cloud/store.js";
import { redactText } from "../redact.js";
import { t, type UserLanguage } from "../../locales/index.js";
import type { SettingsCommand } from "./commands.js";
import { normalizeEnvKey } from "./commands.js";

const AGENT_PREFIX: Record<SessionAgent, string> = { codex: "codex", claude_code: "claude_code" };

export function applySettingsCommand(
  config: AppConfig,
  cmd: SettingsCommand,
  defaultAgent: SessionAgent,
  platform: "telegram" | "slack",
  lang: UserLanguage,
): string {
  if (cmd.kind === "list") return formatSettingsSummary(config, defaultAgent, platform, lang, null, null);

  const parsed = resolveSettingTarget(cmd.target, defaultAgent);
  if (!parsed) {
    return `${t("settings.unknown", lang, { key: cmd.target })}\n${t("settings.supported", lang, {
      keys: formatSupportedSettingKeys(),
    })}`;
  }

  const adapter = getAgentAdapter(parsed.agent);
  let agentConfig;
  try {
    agentConfig = adapter.requireConfig(config);
  } catch (e) {
    return t("error.generic", lang, { message: String(e) });
  }

  const prefix = AGENT_PREFIX[parsed.agent];

  if (parsed.type === "bool") {
    if (cmd.kind !== "set") return t("settings.use_set", lang, { cmd: `settings set ${parsed.label} <on|off>` });
    const value = parseBool(cmd.value);
    if (value === null) return t("settings.expected_bool", lang, { key: parsed.label });
    const prev = agentConfig[parsed.key];
    (agentConfig as any)[parsed.key] = value;
    return t("settings.updated", lang, {
      key: parsed.label,
      prev: String(prev),
      next: String(value),
      agent: adapter.displayName,
    });
  }

  if (parsed.type === "number") {
    if (cmd.kind !== "set") return t("settings.use_set", lang, { cmd: `settings set ${parsed.label} <number>` });
    const n = Number(cmd.value);
    if (!Number.isFinite(n)) return t("settings.expected_number", lang, { key: parsed.label });
    const next = Math.floor(n);
    if (next < parsed.min) return t("settings.min_value", lang, { key: parsed.label, min: parsed.min });
    const prev = agentConfig[parsed.key];
    (agentConfig as any)[parsed.key] = next;
    return t("settings.updated", lang, {
      key: parsed.label,
      prev: String(prev),
      next: String(next),
      agent: adapter.displayName,
    });
  }

  if (parsed.type === "string") {
    if (cmd.kind !== "set") return t("settings.use_set", lang, { cmd: `settings set ${parsed.label} <value>` });
    const value = cmd.value.trim();
    if (!value) return t("settings.empty_value", lang, { key: parsed.label });
    const prev = agentConfig[parsed.key];
    (agentConfig as any)[parsed.key] = value;
    return t("settings.updated", lang, {
      key: parsed.label,
      prev: String(prev),
      next: String(value),
      agent: adapter.displayName,
    });
  }

  if (parsed.type === "env") {
    const key = normalizeEnvKey(parsed.envKey);
    if (!key) return t("settings.cloud_key.empty", lang, { target: "env" });
    if (cmd.kind === "unset") {
      if (!(key in agentConfig.env)) return t("settings.env_already_unset", lang, { key, prefix });
      delete agentConfig.env[key];
      return t("settings.env_unset", lang, { key });
    }
    const value = cmd.value.trim();
    if (!value) return t("settings.empty_value", lang, { key: parsed.label });
    const prev = agentConfig.env[key];
    agentConfig.env[key] = value;
    const current = formatEnvValue(value, lang);
    const suffix = prev ? t("settings.env_set_prev", lang, { value: formatEnvValue(prev, lang) }) : "";
    return t("settings.env_set", lang, {
      key: parsed.label,
      value: current,
      suffix,
      agent: adapter.displayName,
    });
  }

  return t("settings.unsupported", lang);
}

type BoolSettingKey = "full_auto" | "dangerously_bypass_approvals_and_sandbox" | "skip_git_repo_check";
type NumberSettingKey = "timeout_seconds" | "poll_interval_ms" | "max_catchup_lines";
type StringSettingKey = "binary" | "sessions_dir";

type SettingTarget =
  | { type: "bool"; agent: SessionAgent; key: BoolSettingKey; label: string }
  | { type: "number"; agent: SessionAgent; key: NumberSettingKey; label: string; min: number }
  | { type: "string"; agent: SessionAgent; key: StringSettingKey; label: string }
  | { type: "env"; agent: SessionAgent; envKey: string; label: string };

function resolveSettingTarget(raw: string, defaultAgent: SessionAgent): SettingTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  const agentPrefix = lower.startsWith("codex.")
    ? ("codex" as const)
    : lower.startsWith("claude_code.")
      ? ("claude_code" as const)
      : null;

  const agent: SessionAgent = agentPrefix ?? defaultAgent;
  const prefix = AGENT_PREFIX[agent];
  const rest = agentPrefix ? trimmed.slice(`${agentPrefix}.`.length) : trimmed;
  const restLower = rest.toLowerCase();

  if (restLower === "full_auto") return { type: "bool", agent, key: "full_auto", label: `\`${prefix}.full_auto\`` };
  if (restLower === "dangerously_bypass_approvals_and_sandbox")
    return {
      type: "bool",
      agent,
      key: "dangerously_bypass_approvals_and_sandbox",
      label: `\`${prefix}.dangerously_bypass_approvals_and_sandbox\``,
    };
  if (restLower === "skip_git_repo_check") return { type: "bool", agent, key: "skip_git_repo_check", label: `\`${prefix}.skip_git_repo_check\`` };

  if (restLower === "timeout_seconds") return { type: "number", agent, key: "timeout_seconds", label: `\`${prefix}.timeout_seconds\``, min: 10 };
  if (restLower === "poll_interval_ms") return { type: "number", agent, key: "poll_interval_ms", label: `\`${prefix}.poll_interval_ms\``, min: 100 };
  if (restLower === "max_catchup_lines") return { type: "number", agent, key: "max_catchup_lines", label: `\`${prefix}.max_catchup_lines\``, min: 1 };

  if (restLower === "binary") return { type: "string", agent, key: "binary", label: `\`${prefix}.binary\`` };
  if (restLower === "sessions_dir") return { type: "string", agent, key: "sessions_dir", label: `\`${prefix}.sessions_dir\`` };

  if (restLower.startsWith("env.")) {
    const key = rest.slice("env.".length).trim();
    if (!key) return null;
    return { type: "env", agent, envKey: key, label: `Env \`${key}\`` };
  }

  if (restLower.startsWith("mcp.")) {
    const key = rest.slice("mcp.".length).trim();
    if (!key) return null;
    const envKey = normalizeEnvKey(key, { forceMcp: true });
    if (!envKey) return null;
    return { type: "env", agent, envKey, label: `MCP \`${envKey}\`` };
  }

  return null;
}

function formatSupportedSettingKeys(): string {
  return [
    "`message_verbosity`",
    "`bot.message_verbosity`",
    "`branch_name_rule`",
    "`codex.full_auto`",
    "`claude_code.full_auto`",
    "`codex.dangerously_bypass_approvals_and_sandbox`",
    "`claude_code.dangerously_bypass_approvals_and_sandbox`",
    "`codex.skip_git_repo_check`",
    "`claude_code.skip_git_repo_check`",
    "`codex.timeout_seconds`",
    "`claude_code.timeout_seconds`",
    "`codex.poll_interval_ms`",
    "`claude_code.poll_interval_ms`",
    "`codex.max_catchup_lines`",
    "`claude_code.max_catchup_lines`",
    "`codex.binary`",
    "`claude_code.binary`",
    "`codex.sessions_dir`",
    "`codex.env.<KEY>`",
    "`claude_code.sessions_dir`",
    "`claude_code.env.<KEY>`",
    "`mcp.<NAME>`",
    "`cloud.keepalive_minutes`",
    "`cloud.git_user_name`",
    "`cloud.git_user_email`",
    "`cloud.openai_api_key`",
    "`cloud.anthropic_api_key`",
  ].join(", ");
}

export function formatSettingsSummary(
  config: AppConfig,
  agent: SessionAgent,
  platform: "telegram" | "slack",
  lang: UserLanguage,
  identity: {
    keepalive_minutes: number | null;
    message_verbosity: number | null;
    branch_name_rule: string | null;
    git_user_name: string | null;
    git_user_email: string | null;
  } | null,
  cloudKeyStatus: { openai: boolean; anthropic: boolean } | null,
): string {
  const adapter = getAgentAdapter(agent);
  let section;
  try {
    section = adapter.requireConfig(config);
  } catch (e) {
    return t("error.generic", lang, { message: String(e) });
  }
  const cmdPrefix = platform === "telegram" ? "/" : "@bot ";
  const prefix = AGENT_PREFIX[agent];

  const identityVerbosity = identity?.message_verbosity ?? null;
  const effectiveVerbosity =
    typeof identityVerbosity === "number" && Number.isFinite(identityVerbosity)
      ? identityVerbosity
      : config.bot.message_verbosity;
  const verbositySuffix =
    typeof identityVerbosity === "number" && Number.isFinite(identityVerbosity)
      ? t("settings.suffix_per_user", lang)
      : t("settings.suffix_default", lang);
  const identityBranchRule = identity?.branch_name_rule?.trim() || "";
  const branchRuleLabel = identityBranchRule
    ? t("settings.branch_rule_custom", lang, { rule: identityBranchRule })
    : t("settings.branch_rule_default", lang);

  const lines = [
    t("settings.title", lang, { agent: adapter.displayName }),
    `- \`${prefix}.binary\`: ${section.binary}`,
    `- \`${prefix}.sessions_dir\`: ${section.sessions_dir}`,
    `- \`${prefix}.timeout_seconds\`: ${String(section.timeout_seconds)}`,
    `- \`${prefix}.poll_interval_ms\`: ${String(section.poll_interval_ms)}`,
    `- \`${prefix}.max_catchup_lines\`: ${String(section.max_catchup_lines)}`,
    `- \`${prefix}.full_auto\`: ${String(section.full_auto)}`,
    `- \`${prefix}.dangerously_bypass_approvals_and_sandbox\`: ${String(section.dangerously_bypass_approvals_and_sandbox)}`,
    `- \`${prefix}.skip_git_repo_check\`: ${String(section.skip_git_repo_check)}`,
    "",
    t("settings.user_section", lang),
    `- \`message_verbosity\`: ${String(effectiveVerbosity)}${verbositySuffix}`,
    `- \`branch_name_rule\`: ${branchRuleLabel}`,
  ];

  const envEntries = Object.entries(section.env);
  if (envEntries.length === 0) lines.push(t("settings.env_overrides_none", lang));
  else {
    lines.push(t("settings.env_overrides", lang));
    for (const [k, v] of envEntries) lines.push(`  - \`${k}\` = ${formatEnvValue(v, lang)}`);
  }

  const mcpEntries = envEntries.filter(([k]) => k.toUpperCase().startsWith("MCP_"));
  if (mcpEntries.length === 0) lines.push(t("settings.mcp_env_none", lang));
  else {
    lines.push(t("settings.mcp_env", lang));
    for (const [k, v] of mcpEntries) lines.push(`  - \`${k}\` = ${formatEnvValue(v, lang)}`);
  }

  if (config.cloud?.enabled) {
    const identityKeepaliveMinutes = identity?.keepalive_minutes ?? null;
    const effective =
      typeof identityKeepaliveMinutes === "number" && Number.isFinite(identityKeepaliveMinutes)
        ? identityKeepaliveMinutes
        : config.cloud.keepalive_minutes;
    const suffix =
      typeof identityKeepaliveMinutes === "number" && Number.isFinite(identityKeepaliveMinutes)
        ? t("settings.suffix_per_user", lang)
        : t("settings.suffix_default", lang);
    const openaiStatus = cloudKeyStatus?.openai ? t("settings.key_set", lang) : t("settings.key_unset", lang);
    const anthropicStatus = cloudKeyStatus?.anthropic ? t("settings.key_set", lang) : t("settings.key_unset", lang);
    const gitName = identity?.git_user_name?.trim() || null;
    const gitEmail = identity?.git_user_email?.trim() || null;
    const gitNameLabel = gitName
      ? t("settings.value_per_user", lang, { value: gitName })
      : t("settings.value_default", lang, { value: "tintin[bot]" });
    const gitEmailLabel = gitEmail
      ? t("settings.value_per_user", lang, { value: gitEmail })
      : t("settings.value_default", lang, { value: "tintin@fuzz.land" });
    lines.push(
      "",
      t("settings.cloud_section", lang),
      `- \`cloud.keepalive_minutes\`: ${String(effective)}${suffix}`,
      `- \`cloud.git_user_name\`: ${gitNameLabel}`,
      `- \`cloud.git_user_email\`: ${gitEmailLabel}`,
      `- \`cloud.openai_api_key\`: ${openaiStatus}`,
      `- \`cloud.anthropic_api_key\`: ${anthropicStatus}`,
    );
  }

  lines.push(
    "",
    t("settings.examples", lang),
    `- ${cmdPrefix}settings set ${prefix}.timeout_seconds 1800`,
    `- ${cmdPrefix}settings set message_verbosity 2`,
    `- ${cmdPrefix}settings set branch_name_rule \"feature/{date}-{slug}\"`,
    `- ${cmdPrefix}settings set mcp.SEARCH http://localhost:3000`,
    `- ${cmdPrefix}settings set cloud.keepalive_minutes 10`,
    `- ${cmdPrefix}settings set cloud.git_user_name \"Tintin Bot\"`,
    `- ${cmdPrefix}settings set cloud.git_user_email tintin@fuzz.land`,
    `- ${cmdPrefix}settings set cloud.openai_api_key sk-...`,
    `- ${cmdPrefix}settings set cloud.anthropic_api_key sk-ant-...`,
    `- ${cmdPrefix}settings unset cloud.keepalive_minutes`,
    `- ${cmdPrefix}settings unset cloud.git_user_name`,
    `- ${cmdPrefix}settings unset cloud.git_user_email`,
    `- ${cmdPrefix}settings unset cloud.openai_api_key`,
    `- ${cmdPrefix}settings unset cloud.anthropic_api_key`,
    `- ${cmdPrefix}settings unset mcp.SEARCH`,
  );
  return lines.join("\n");
}

export async function applyIdentitySettingsCommand(opts: {
  config: AppConfig;
  db: Db;
  cmd: SettingsCommand;
  identityId: string;
  lang: UserLanguage;
}): Promise<string | null> {
  if (opts.cmd.kind === "list") return null;
  const target = opts.cmd.target.trim().toLowerCase();
  if (
    target !== "message_verbosity" &&
    target !== "bot.message_verbosity" &&
    target !== "branch_name_rule" &&
    target !== "branchname_rule" &&
    target !== "branch-rule"
  )
    return null;

  if (opts.cmd.kind === "unset") {
    if (target === "message_verbosity" || target === "bot.message_verbosity") {
      await setIdentityMessageVerbosity(opts.db, opts.identityId, null);
      return t("settings.message_verbosity.reset", opts.lang);
    }
    await setIdentityBranchNameRule(opts.db, opts.identityId, null);
    return t("settings.branch_rule.reset", opts.lang);
  }

  if (target === "message_verbosity" || target === "bot.message_verbosity") {
    const raw = opts.cmd.value.trim();
    const next = Number(raw);
    if (!Number.isFinite(next)) return t("settings.message_verbosity.expected_number", opts.lang);
    const value = Math.floor(next);
    if (value < 1 || value > 3) return t("settings.message_verbosity.range", opts.lang);
    await setIdentityMessageVerbosity(opts.db, opts.identityId, value);
    return t("settings.message_verbosity.updated", opts.lang, { value });
  }

  const rule = opts.cmd.value.trim();
  if (!rule) return t("settings.branch_rule.empty", opts.lang);
  await setIdentityBranchNameRule(opts.db, opts.identityId, rule);
  return t("settings.branch_rule.updated", opts.lang);
}

export async function applyCloudSettingsCommand(opts: {
  config: AppConfig;
  db: Db;
  cmd: SettingsCommand;
  identityId: string;
  lang: UserLanguage;
}): Promise<string | null> {
  if (opts.cmd.kind === "list") return null;
  const target = opts.cmd.target.trim().toLowerCase();
  if (
    target !== "cloud.keepalive_minutes" &&
    target !== "cloud.git_user_name" &&
    target !== "cloud.git_user_email" &&
    target !== "cloud.openai_api_key" &&
    target !== "cloud.anthropic_api_key"
  )
    return null;
  if (!opts.config.cloud) return t("cloud.config_missing", opts.lang);

  if (opts.cmd.kind === "unset") {
    if (target === "cloud.keepalive_minutes") {
      await setIdentityKeepaliveMinutes(opts.db, opts.identityId, null);
      return t("settings.cloud_keepalive.reset", opts.lang);
    }
    if (target === "cloud.git_user_name") {
      await setIdentityGitUserName(opts.db, opts.identityId, null);
      return t("settings.cloud_git_user_name.reset", opts.lang);
    }
    if (target === "cloud.git_user_email") {
      await setIdentityGitUserEmail(opts.db, opts.identityId, null);
      return t("settings.cloud_git_user_email.reset", opts.lang);
    }
    const name = target === "cloud.openai_api_key" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const ok = await deleteSecret(opts.db, opts.identityId, name);
    return ok ? t("settings.cloud_key.cleared", opts.lang, { target }) : t("settings.cloud_key.already_unset", opts.lang, { target });
  }

  if (target === "cloud.git_user_name") {
    if (opts.cmd.kind !== "set") {
      return t("settings.use_set", opts.lang, { cmd: "settings set cloud.git_user_name <name>" });
    }
    const value = opts.cmd.value.trim();
    if (!value) return t("settings.cloud_git_user_name.empty", opts.lang);
    await setIdentityGitUserName(opts.db, opts.identityId, value);
    return t("settings.cloud_git_user_name.updated", opts.lang, { value });
  }

  if (target === "cloud.git_user_email") {
    if (opts.cmd.kind !== "set") {
      return t("settings.use_set", opts.lang, { cmd: "settings set cloud.git_user_email <email>" });
    }
    const value = opts.cmd.value.trim();
    if (!value) return t("settings.cloud_git_user_email.empty", opts.lang);
    await setIdentityGitUserEmail(opts.db, opts.identityId, value);
    return t("settings.cloud_git_user_email.updated", opts.lang, { value });
  }

  if (target === "cloud.keepalive_minutes") {
    if (opts.cmd.kind !== "set") {
      return t("settings.use_set", opts.lang, { cmd: "settings set cloud.keepalive_minutes <number>" });
    }
    const n = Number(opts.cmd.value);
    if (!Number.isFinite(n)) return t("settings.cloud_keepalive.expected_number", opts.lang);
    const next = Math.floor(n);
    if (next < 0) return t("settings.cloud_keepalive.min", opts.lang);
    await setIdentityKeepaliveMinutes(opts.db, opts.identityId, next);
    return t("settings.cloud_keepalive.updated", opts.lang, { value: next });
  }

  if (opts.cmd.kind !== "set") {
    return t("settings.use_set", opts.lang, { cmd: `settings set ${target} <key>` });
  }
  const value = opts.cmd.value.trim();
  if (!value) return t("settings.cloud_key.empty", opts.lang, { target });
  if (!opts.config.cloud.secrets_key) return t("cloud.secrets_missing", opts.lang);
  const encrypted = encryptSecret(value, opts.config.cloud.secrets_key);
  const name = target === "cloud.openai_api_key" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  await setSecret(opts.db, { identityId: opts.identityId, name, encryptedValue: encrypted });
  return t("settings.cloud_key.updated", opts.lang, { target });
}

function formatEnvValue(value: string, lang: UserLanguage): string {
  const redacted = redactText(value);
  if (!redacted) return t("settings.value_empty", lang);
  if (redacted.length > 80) {
    return t("settings.value_truncated", lang, { value: redacted.slice(0, 60), count: redacted.length });
  }
  return redacted;
}

function parseBool(input: string): boolean | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  if (["1", "true", "yes", "y", "on"].includes(t)) return true;
  if (["0", "false", "no", "n", "off"].includes(t)) return false;
  return null;
}
