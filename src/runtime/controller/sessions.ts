import type { SessionAgent, SessionStatus } from "../db.js";
import type { SessionListPage, SessionRow } from "../store.js";
import { getAgentAdapter } from "../agents.js";
import { t, type UserLanguage } from "../../locales/index.js";
import { parseTelegramCommand, TELEGRAM_COMMAND_AGENT } from "./commands.js";

export function formatSessionFilterLabel(statuses?: SessionStatus[]): string | undefined {
  if (!statuses || statuses.length === 0) return undefined;
  const set = new Set(statuses);
  if (set.size === 2 && set.has("starting") && set.has("running")) return "active";
  if (set.size === 1) return Array.from(set)[0];
  return undefined;
}

export function agentDisplayName(agent: SessionAgent): string {
  return getAgentAdapter(agent).displayName;
}

export function agentShortName(agent: SessionAgent): string {
  return getAgentAdapter(agent).shortName;
}

export function detectAgentFromTelegramMessageText(text: string): SessionAgent {
  const cmd = parseTelegramCommand(text);
  const mapped = cmd ? TELEGRAM_COMMAND_AGENT[cmd.command] : undefined;
  return mapped ?? "codex";
}

export function buildMenuText(platform: "telegram" | "slack", agent: SessionAgent, lang: UserLanguage): string {
  const commands =
    platform === "telegram"
      ? [t("menu.sessions_hint_tg", lang), t("menu.settings_hint_tg", lang)]
      : [t("menu.sessions_hint_slack", lang), t("menu.settings_hint_slack", lang)];
  const examples = buildCommandExamples(platform, lang);
  const lines = [t("menu.intro", lang, { agent: agentDisplayName(agent) }), ...commands, "", examples];
  return lines.join("\n");
}

export function buildCloudHelpText(platform: "telegram" | "slack", lang: UserLanguage): string {
  const title = platform === "slack" ? `*${t("cloud.help.title", lang)}*` : t("cloud.help.title", lang);
  const cmdPrefix = platform === "telegram" ? "/" : "";
  const cmd = (value: string) => `${cmdPrefix}${value}`;
  const repoShareCmd = `\`${cmd("repo share <number>")}\``;
  const notes = [t("cloud.help.note_group", lang, { cmd: repoShareCmd })];
  notes.push(t("cloud.help.note_disconnect", lang, { cmd: `\`${cmd("disconnect github")}\`` }));
  notes.push(t("cloud.help.note_lang", lang, { cmd: `\`${cmd("lang zh")}\`` }));
  if (platform === "slack") {
    notes.push(t("cloud.help.note_slack_dm", lang));
    notes.push(t("cloud.help.note_slack_slash", lang));
  }
  const lines = [
    title,
    t("cloud.help.enabled", lang),
    "",
    t("cloud.help.quick_start", lang),
    t("cloud.help.step_connect", lang),
    t("cloud.help.cmd.connect_chatgpt", lang, { cmd: `\`${cmd("connect chatgpt")}\`` }),
    t("cloud.help.cmd.connect_chatgpt_status", lang, { cmd: `\`${cmd("connect chatgpt status")}\`` }),
    t("cloud.help.cmd.connect_chatgpt_revoke", lang, { cmd: `\`${cmd("connect chatgpt revoke")}\`` }),
    t("cloud.help.cmd.connect_github", lang, {
      cmd: `\`${cmd("connect github")}\``,
      cmd2: `\`${cmd("connect gitlab")}\``,
      cmd3: `\`${cmd("connect local")}\``,
    }),
    t("cloud.help.cmd.mcp_github_token", lang, { cmd: `\`${cmd("mcp github token set <token>")}\`` }),
    t("cloud.help.cmd.mcp_notion_connect", lang, { cmd: `\`${cmd("mcp notion connect")}\`` }),
    t("cloud.help.cmd.mcp_notion_status", lang, { cmd: `\`${cmd("mcp notion status")}\`` }),
    "",
    t("cloud.help.step_pick_repos", lang),
    t("cloud.help.cmd.repos", lang, {
      cmd: `\`${cmd("repos")}\``,
      cmd2: `\`${cmd("repos --provider github --search <term>")}\``,
    }),
    t("cloud.help.cmd.repo_select", lang, {
      cmd: `\`${cmd("repo select <number>")}\``,
      cmd2: `\`${cmd("repo select playground")}\``,
    }),
    "",
    t("cloud.help.step_share_group", lang),
    `- ${repoShareCmd}`,
    "",
    t("cloud.help.step_run_action", lang),
    t("cloud.help.cmd.run", lang, { cmd: `\`${cmd("run <prompt>")}\``, arg: "`--repos id1,id2`" }),
    "",
    t("cloud.help.step_check_results", lang),
    `- \`${cmd("status <runId>")}\``,
    `- \`${cmd("pull <runId>")}\``,
    "",
    t("cloud.help.step_secrets", lang),
    `- \`${cmd("secrets create NAME VALUE")}\``,
    `- \`${cmd("secrets update NAME VALUE")}\``,
    `- \`${cmd("secrets list")}\``,
    `- \`${cmd("secrets delete NAME")}\``,
    "",
    t("cloud.help.step_cli", lang),
    t("cloud.help.cmd.tinc_token", lang, { cmd: `\`${cmd("tinc token")}\`` }),
    "",
    t("cloud.help.step_snapshots", lang),
    `- \`${cmd("snapshot save [note]")}\``,
    `- \`${cmd("snapshot list [limit]")}\``,
    `- \`${cmd("snapshot search <query>")}\``,
    `- \`${cmd("snapshot restore <index|snapshotId>")}\``,
    "",
    t("cloud.help.step_disconnect", lang),
    `- \`${cmd("disconnect github")}\``,
    `- \`${cmd("disconnect github --installation <id>")}\``,
    `- \`${cmd("disconnect github --all")}\``,
    `- \`${cmd("disconnect github confirm <token>")}\``,
    "",
    t("cloud.help.notes", lang),
    ...notes,
  ];
  return lines.join("\n");
}

export function buildCommandExamples(platform: "telegram" | "slack", lang: UserLanguage): string {
  const sessions = platform === "telegram" ? "/sessions active" : "sessions active";
  const sessionsPage = platform === "telegram" ? "/sessions page 2" : "sessions page 2";
  const settings = platform === "telegram" ? "/settings" : "settings";
  const prefix = platform === "telegram" ? "/" : "";
  const envSet = `${prefix}settings set mcp.SEARCH http://localhost:3000`;
  const envUnset = `${prefix}settings unset mcp.SEARCH`;
  return [
    t("menu.examples", lang),
    `- \`${sessions}\``,
    `- \`${sessionsPage}\``,
    `- \`${settings}\``,
    `- \`${prefix}lang zh\``,
    `- \`${prefix}settings set codex.timeout_seconds 1800\``,
    `- \`${envSet}\``,
    `- \`${envUnset}\``,
  ].join("\n");
}

function buildSessionsCommand(platform: "telegram" | "slack", filterLabel: string | undefined, page: number): string {
  const parts = [platform === "telegram" ? "/sessions" : "@bot sessions"];
  if (filterLabel) parts.push(filterLabel);
  if (page > 1) parts.push("page", String(page));
  return parts.join(" ");
}

export function formatSessionList(
  platform: "telegram" | "slack",
  lang: UserLanguage,
  opts: SessionListPage & { filterLabel?: string },
): string {
  const filterSuffix = opts.filterLabel ? ` (${opts.filterLabel})` : "";
  if (opts.sessions.length === 0) {
    if (opts.page <= 1) return t("sessions.empty", lang);
    const prev = opts.page > 1 ? buildSessionsCommand(platform, opts.filterLabel, opts.page - 1) : null;
    const hint = prev ? t("sessions.empty_page_hint", lang, { cmd: prev }) : "";
    return `${t("sessions.empty_page", lang, { filter: filterSuffix, page: opts.page })}${hint}`;
  }

  const header = t("sessions.title", lang, { filter: filterSuffix, page: opts.page, limit: opts.limit });
  const lines = opts.sessions.map((s) => formatSessionLine(platform, lang, s));
  const nav: string[] = [];
  if (opts.page > 1) nav.push(buildSessionsCommand(platform, opts.filterLabel, opts.page - 1));
  if (opts.hasMore) nav.push(buildSessionsCommand(platform, opts.filterLabel, opts.page + 1));
  const navText = nav.length > 0 ? `\n\n${t("sessions.navigation", lang)} \`${nav.join("` | `")}\`` : "";
  return `${header}\n${lines.map((l) => `- ${l}`).join("\n")}${navText}`;
}

function formatSessionLine(platform: "telegram" | "slack", lang: UserLanguage, s: SessionRow): string {
  const emoji = formatSessionEmoji(platform, s);
  const url = formatSessionLink(platform, s);
  const emojiLabel = url ? formatEmojiLink(platform, emoji, url) : emoji;
  const age = formatRelativeAge(s.created_at, lang);
  const status = formatSessionStatus(s.status, lang);
  return `${emojiLabel} ${status} ${agentShortName(s.agent)} ${s.project_id} ${age}`;
}

function formatSessionStatus(status: SessionStatus, lang: UserLanguage): string {
  switch (status) {
    case "wizard":
      return t("session.status.wizard", lang);
    case "starting":
      return t("session.status.starting", lang);
    case "running":
      return t("session.status.running", lang);
    case "finished":
      return t("session.status.finished", lang);
    case "error":
      return t("session.status.error", lang);
    case "killed":
      return t("session.status.killed", lang);
    default:
      return String(status);
  }
}

function formatSessionEmoji(platform: "telegram" | "slack", s: SessionRow): string {
  const stored = (s.space_emoji ?? "").trim();
  if (stored) return stored;
  return platform === "telegram" ? "🧠" : "💬";
}

function formatEmojiLink(platform: "telegram" | "slack", emoji: string, url: string): string {
  if (platform === "slack") return `<${url}|${emoji}>`;
  return `[${emoji}](${url})`;
}

function formatSessionLink(platform: "telegram" | "slack", s: SessionRow): string | null {
  if (platform === "telegram") return buildTelegramTopicUrl(s.chat_id, s.space_id);
  return buildSlackPermalink(s.workspace_id, s.chat_id, s.space_id);
}

function buildTelegramTopicUrl(chatId: string, spaceId: string): string | null {
  const normalizedChat = normalizeTelegramChatIdForUrl(chatId);
  const topic = spaceId.trim();
  if (!normalizedChat || !topic) return null;
  const chatPart = encodeURIComponent(normalizedChat);
  const topicPart = encodeURIComponent(topic);
  return `https://t.me/c/${chatPart}/${topicPart}`;
}

function normalizeTelegramChatIdForUrl(chatId: string): string | null {
  const trimmed = chatId.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("-100") && trimmed.length > 4) return trimmed.slice(4);
  if (trimmed.startsWith("-") && trimmed.length > 1) return trimmed.slice(1);
  return trimmed;
}

function buildSlackPermalink(workspaceId: string | null, channelId: string, spaceId: string): string | null {
  if (!workspaceId) return null;
  const base = `https://app.slack.com/client/${encodeURIComponent(workspaceId)}/${encodeURIComponent(channelId)}`;
  const threadTs = spaceId.trim();
  if (!threadTs || threadTs === channelId) return base;
  return `${base}/thread/${encodeURIComponent(channelId)}-${encodeURIComponent(threadTs)}`;
}

function formatRelativeAge(createdAt: unknown, lang: UserLanguage): string {
  const ts = toNumber(createdAt);
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const diffMs = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return t("time.just_now", lang);
  if (seconds < 60) return t("time.seconds_ago", lang, { n: seconds });

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutes_ago", lang, { n: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("time.hours_ago", lang, { n: hours });

  const days = Math.floor(hours / 24);
  if (days < 14) return t("time.days_ago", lang, { n: days });

  const weeks = Math.floor(days / 7);
  if (weeks < 9) return t("time.weeks_ago", lang, { n: weeks });

  const months = Math.floor(days / 30);
  if (months < 18) return t("time.months_ago", lang, { n: months });

  const years = Math.floor(days / 365);
  return t("time.years_ago", lang, { n: years });
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return NaN;
}
