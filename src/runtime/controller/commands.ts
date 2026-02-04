import type { SessionAgent, SessionStatus } from "../db.js";
import { t, type UserLanguage } from "../../locales/index.js";

export const PLAYGROUND_REPO_ID = "__playground__";

export type SessionListIntent = { statuses?: SessionStatus[]; page: number };

export type SettingsCommand =
  | { kind: "list" }
  | { kind: "set"; target: string; value: string }
  | { kind: "unset"; target: string };

export type SettingsIntent = { cmd: SettingsCommand; defaultAgent: SessionAgent };

export type LanguageCommand = { raw: string };

export type CloudCommand =
  | { kind: "connect"; provider: string; subcommand?: string; payload?: string }
  | { kind: "disconnect"; provider: string; installationId?: string; confirmToken?: string; all?: boolean }
  | { kind: "connections" }
  | { kind: "repos"; provider?: string; search?: string }
  | { kind: "repo_select"; target: string }
  | { kind: "repo_current" }
  | { kind: "repo_share"; target: string }
  | { kind: "repo_unshare"; target: string }
  | { kind: "actions_list" }
  | { kind: "action_run"; prompt: string; repoIds: string[] }
  | { kind: "action_status"; runId: string }
  | { kind: "action_pull"; runId: string }
  | { kind: "setup_status" }
  | { kind: "setup_lift" }
  | { kind: "tinc_token" }
  | { kind: "secrets_set"; name: string; value: string | null }
  | { kind: "secrets_create"; name: string; value: string | null }
  | { kind: "secrets_update"; name: string; value: string | null }
  | { kind: "secrets_list" }
  | { kind: "secrets_delete"; name: string }
  | { kind: "mcp_github_token_set"; token: string | null }
  | { kind: "mcp_notion_connect" }
  | { kind: "mcp_notion_status" }
  | { kind: "snapshot_save"; note?: string }
  | { kind: "snapshot_list"; limit?: number }
  | { kind: "snapshot_search"; query: string }
  | { kind: "snapshot_restore"; target: string }
  | { kind: "snapshot_clear" };

export const TELEGRAM_COMMAND_AGENT: Record<string, SessionAgent> = { codex: "codex", cc: "claude_code" };

export function safeParseMeta(metaRaw: string): { channelId?: string; userId?: string } | null {
  try {
    const v = JSON.parse(metaRaw) as unknown;
    if (!v || typeof v !== "object") return null;
    const channelId = typeof (v as any).channelId === "string" ? (v as any).channelId : undefined;
    const userId = typeof (v as any).userId === "string" ? (v as any).userId : undefined;
    return { channelId, userId };
  } catch {
    return null;
  }
}

export function parseListSessionsArgs(text: string): SessionListIntent {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const remaining: string[] = [];
  let page: number | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const lower = token.toLowerCase();
    const eqMatch = lower.match(/^(?:page|p)=(\d+)$/);
    if (eqMatch) {
      const n = Number(eqMatch[1]);
      if (Number.isFinite(n) && n > 0) {
        page = n;
        continue;
      }
    }

    if (lower === "page" || lower === "p") {
      const next = tokens[i + 1];
      const n = next ? Number(next) : NaN;
      if (Number.isFinite(n) && n > 0) {
        page = n;
        i++;
        continue;
      }
    }

    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n > 0) {
        page = n;
        continue;
      }
    }

    remaining.push(token);
  }

  const statuses = parseSessionStatusFilter(remaining.join(" "));
  return { statuses, page: page ?? 1 };
}

export function parseRepoIndex(target: string): number | null {
  const cleaned = target.trim().replace(/[.)]$/, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function isPlaygroundRepoId(value: string | null | undefined): boolean {
  return value === PLAYGROUND_REPO_ID;
}

export function isPlaygroundTarget(value: string): boolean {
  const cleaned = value.trim().toLowerCase().replace(/[.)]$/, "");
  if (!cleaned) return false;
  if (cleaned === "0") return true;
  if (cleaned === "playground") return true;
  if (cleaned === "none") return true;
  if (cleaned === "norepo") return true;
  if (cleaned === "no-repo") return true;
  if (cleaned === "no_repo") return true;
  if (cleaned === "no repo") return true;
  return false;
}

export function parseListSessionsIntentFromTelegram(text: string): SessionListIntent | null {
  const cmd = parseTelegramCommand(text);
  if (!cmd) return null;
  if (cmd.command === "sessions") return parseListSessionsArgs(cmd.args);
  if (cmd.command === "codex" || cmd.command === "cc") {
    const rest = cmd.args.trim();
    if (!rest.toLowerCase().startsWith("sessions")) return null;
    return parseListSessionsArgs(rest.slice("sessions".length).trim());
  }
  return null;
}

export function parseTelegramCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  const head = parts[0] ?? "";
  const raw = head.slice(1);
  if (!raw) return null;
  const at = raw.indexOf("@");
  const command = (at >= 0 ? raw.slice(0, at) : raw).toLowerCase();
  const args = parts.slice(1).join(" ").trim();
  return { command, args };
}

export function parseListSessionsIntentFromSlack(text: string): SessionListIntent | null {
  const m = text.match(/\bsessions\b(.*)$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  return parseListSessionsArgs(rest);
}

export function parseSettingsIntentFromTelegram(text: string): SettingsIntent | null {
  const cmd = parseTelegramCommand(text);
  if (!cmd) return null;
  if (cmd.command === "settings") {
    const parsed = parseSettingsArgs(cmd.args);
    return parsed ? { cmd: parsed, defaultAgent: "codex" } : null;
  }
  const defaultAgent = TELEGRAM_COMMAND_AGENT[cmd.command];
  if (!defaultAgent) return null;
  const rest = cmd.args.trim();
  if (!rest.toLowerCase().startsWith("settings")) return null;
  const parsed = parseSettingsArgs(rest.slice("settings".length));
  if (!parsed) return null;
  return { cmd: parsed, defaultAgent };
}

export function parseSettingsIntentFromSlack(text: string): SettingsIntent | null {
  const m = text.match(/\bsettings\b(.*)$/i);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  const parsed = parseSettingsArgs(rest);
  return parsed ? { cmd: parsed, defaultAgent: "codex" } : null;
}

export function parseLanguageCommandFromTelegram(text: string): LanguageCommand | null {
  const cmd = parseTelegramCommand(text);
  if (!cmd) return null;
  if (cmd.command !== "lang" && cmd.command !== "language") return null;
  return { raw: cmd.args.trim() };
}

export function parseLanguageCommandFromSlack(text: string): LanguageCommand | null {
  const normalized = normalizeCloudText(text);
  if (!normalized) return null;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens.shift()!.toLowerCase();
  if (head !== "lang" && head !== "language") return null;
  return { raw: tokens.join(" ").trim() };
}

export function isSlackHelpCommand(text: string): boolean {
  const normalized = normalizeCloudText(text);
  if (!normalized) return false;
  const trimmed = normalized.trim().toLowerCase();
  return trimmed === "help" || trimmed === "/help";
}

export function normalizeCloudText(text: string): string {
  let out = text.trim();
  // Unwrap Slack link markup: <url|text> or <url>
  out = out.replace(/<([^>|]+)\|[^>]+>/g, "$1").replace(/<([^>]+)>/g, "$1");
  // Decode common HTML entities Slack may inject in URLs.
  out = out.replace(/&amp;/g, "&");
  out = out.replace(/<@[^>]+>/g, "").trim();
  if (out.startsWith("/")) {
    const parts = out.slice(1).split(/\s+/);
    const head = parts.shift() ?? "";
    const cleanHead = head.includes("@") ? head.split("@")[0] ?? "" : head;
    out = [cleanHead, ...parts].join(" ").trim();
  }
  return out;
}

export function normalizeLanguageToken(raw: string): UserLanguage | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === "en" || value === "english") return "en";
  if (value === "zh" || value === "chinese" || value === "zh-cn") return "zh";
  return null;
}

export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function humanStatus(status: string | null | undefined, lang: UserLanguage): string {
  const s = (status ?? "").toLowerCase();
  if (s === "finished") return t("status.run_completed", lang);
  if (s === "killed") return t("status.stopped_by_user", lang);
  if (s === "error") return t("status.run_failed", lang);
  if (s === "termination") return t("status.termination", lang);
  if (s === "manual") return t("status.manual_snapshot", lang);
  return s || t("status.unknown", lang);
}

export function parseCloudCommand(text: string): CloudCommand | null {
  const normalized = normalizeCloudText(text);
  if (!normalized) return null;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens.shift()!.toLowerCase();

  if (head === "connect" && tokens.length >= 1) {
    const provider = tokens.shift()!.toLowerCase();
    let subcommand: string | undefined;
    if (tokens[0] && (tokens[0]!.toLowerCase() === "status" || tokens[0]!.toLowerCase() === "revoke")) {
      subcommand = tokens.shift()!.toLowerCase();
    }
    const payload = tokens.length > 0 ? tokens.join(" ").trim() : undefined;
    return { kind: "connect", provider, subcommand, payload };
  }
  if (head === "disconnect" && tokens.length >= 1) {
    const provider = tokens.shift()!.toLowerCase();
    let installationId: string | undefined;
    let confirmToken: string | undefined;
    let all = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === "confirm" && tokens[i + 1]) {
        confirmToken = tokens[i + 1]!;
        i++;
        continue;
      }
      if (t === "--all") {
        all = true;
        continue;
      }
      if (t.startsWith("--installation=")) {
        installationId = t.split("=", 2)[1];
        continue;
      }
      if (t === "--installation" && tokens[i + 1]) {
        installationId = tokens[i + 1]!;
        i++;
        continue;
      }
    }
    return { kind: "disconnect", provider, installationId, confirmToken, all };
  }
  if (head === "connections") return { kind: "connections" };
  if (head === "repos") {
    let provider: string | undefined;
    let search: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.startsWith("--provider=")) {
        provider = t.split("=", 2)[1];
        continue;
      }
      if (t === "--provider" && tokens[i + 1]) {
        provider = tokens[i + 1]!;
        i++;
        continue;
      }
      if (t.startsWith("--search=")) {
        search = t.split("=", 2)[1];
        continue;
      }
      if (t === "--search" && tokens[i + 1]) {
        search = tokens[i + 1]!;
        i++;
        continue;
      }
      if (!search) search = t;
    }
    return { kind: "repos", provider, search };
  }
  if (head === "repo" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "select" && tokens.length >= 1) return { kind: "repo_select", target: tokens.join(" ") };
    if (sub === "current") return { kind: "repo_current" };
    if (sub === "share" && tokens.length >= 1) return { kind: "repo_share", target: tokens.join(" ") };
    if (sub === "unshare" && tokens.length >= 1) return { kind: "repo_unshare", target: tokens.join(" ") };
  }
  if (head === "snapshot") {
    const sub = tokens.shift()?.toLowerCase() ?? "";
    if (sub === "save") {
      const note = tokens.join(" ").trim();
      return { kind: "snapshot_save", note: note || undefined };
    }
    if (sub === "list") {
      const raw = tokens[0];
      const n = raw ? Number(raw) : NaN;
      const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
      return { kind: "snapshot_list", limit };
    }
    if (sub === "search" && tokens.length > 0) {
      return { kind: "snapshot_search", query: tokens.join(" ").trim() };
    }
    if (sub === "restore" && tokens.length > 0) {
      return { kind: "snapshot_restore", target: tokens.join(" ").trim() };
    }
    if (sub === "clear") {
      return { kind: "snapshot_clear" };
    }
  }
  if (head === "actions") return { kind: "actions_list" };
  if (head === "run") {
    const repoIds: string[] = [];
    const promptParts: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.startsWith("--repos=")) {
        repoIds.push(...t.split("=", 2)[1]!.split(",").map((v) => v.trim()).filter(Boolean));
        continue;
      }
      if (t === "--repos" && tokens[i + 1]) {
        repoIds.push(...tokens[i + 1]!.split(",").map((v) => v.trim()).filter(Boolean));
        i++;
        continue;
      }
      promptParts.push(t);
    }
    return { kind: "action_run", prompt: promptParts.join(" "), repoIds };
  }
  if (head === "status" && tokens.length >= 1) return { kind: "action_status", runId: tokens[0]! };
  if (head === "pull" && tokens.length >= 1) return { kind: "action_pull", runId: tokens[0]! };
  if (head === "action" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "run") {
      const repoIds: string[] = [];
      const promptParts: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t.startsWith("--repos=")) {
          repoIds.push(...t.split("=", 2)[1]!.split(",").map((v) => v.trim()).filter(Boolean));
          continue;
        }
        if (t === "--repos" && tokens[i + 1]) {
          repoIds.push(...tokens[i + 1]!.split(",").map((v) => v.trim()).filter(Boolean));
          i++;
          continue;
        }
        promptParts.push(t);
      }
      return { kind: "action_run", prompt: promptParts.join(" "), repoIds };
    }
    if (sub === "status" && tokens.length >= 1) return { kind: "action_status", runId: tokens[0]! };
    if (sub === "pull" && tokens.length >= 1) return { kind: "action_pull", runId: tokens[0]! };
  }
  if (head === "setup" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "status") return { kind: "setup_status" };
    if (sub === "lift") return { kind: "setup_lift" };
  }
  if (head === "tinc" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "token" || sub === "auth") return { kind: "tinc_token" };
  }
  if (head === "secrets" && tokens.length >= 1) {
    const sub = tokens.shift()!.toLowerCase();
    if (sub === "list") return { kind: "secrets_list" };
    if (sub === "set" && tokens.length >= 1) {
      const name = tokens.shift()!;
      const value = tokens.length > 0 ? tokens.join(" ") : null;
      return { kind: "secrets_set", name, value };
    }
    if (sub === "create" && tokens.length >= 1) {
      const name = tokens.shift()!;
      const value = tokens.length > 0 ? tokens.join(" ") : null;
      return { kind: "secrets_create", name, value };
    }
    if (sub === "update" && tokens.length >= 1) {
      const name = tokens.shift()!;
      const value = tokens.length > 0 ? tokens.join(" ") : null;
      return { kind: "secrets_update", name, value };
    }
    if (sub === "delete" && tokens.length >= 1) return { kind: "secrets_delete", name: tokens[0]! };
  }
  if (head === "mcp" && tokens.length >= 1) {
    const provider = tokens.shift()!.toLowerCase();
    if (provider === "notion") {
      const action = tokens.shift()?.toLowerCase() ?? "";
      if (action === "connect") return { kind: "mcp_notion_connect" };
      if (action === "status") return { kind: "mcp_notion_status" };
    }
    if (provider === "github" && tokens.length >= 1) {
      const sub = tokens.shift()!.toLowerCase();
      if (sub === "token") {
        const action = tokens.shift()?.toLowerCase() ?? "";
        if (action === "set") {
          const token = tokens.length > 0 ? tokens.join(" ").trim() : null;
          return { kind: "mcp_github_token_set", token };
        }
      }
    }
  }
  return null;
}

export function parseSettingsArgs(args: string): SettingsCommand | null {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "list" };
  const parts = trimmed.split(/\s+/);
  const head = (parts.shift() ?? "").toLowerCase();
  if (!head) return { kind: "list" };
  if (head === "list") return { kind: "list" };

  if (head === "mcp") {
    const sub = (parts.shift() ?? "").toLowerCase();
    if (!sub) return { kind: "list" };
    if (sub === "set" && parts.length >= 2) {
      const target = `mcp.${parts.shift()!}`;
      return { kind: "set", target, value: parts.join(" ") };
    }
    if (sub === "unset" && parts.length >= 1) {
      return { kind: "unset", target: `mcp.${parts.join(" ")}` };
    }
    return { kind: "list" };
  }

  if (head === "set" && parts.length >= 2) {
    const target = parts.shift()!;
    return { kind: "set", target, value: parts.join(" ") };
  }
  if (head === "unset" && parts.length >= 1) {
    return { kind: "unset", target: parts.join(" ") };
  }

  // Shorthand: `settings foo bar` -> treat as set
  if (parts.length >= 1) return { kind: "set", target: head, value: parts.join(" ") };
  return { kind: "list" };
}

export function parseSessionStatusFilter(text: string): SessionStatus[] | undefined {
  const t = text.toLowerCase();
  if (!t) return undefined;
  if (/\bactive\b/.test(t)) return ["starting", "running"];
  if (/\brunning\b/.test(t)) return ["running"];
  if (/\bstarting\b/.test(t)) return ["starting"];
  if (/\bfinished\b/.test(t)) return ["finished"];
  if (/\berror\b/.test(t)) return ["error"];
  if (/\bkilled\b/.test(t)) return ["killed"];
  return undefined;
}

export function normalizeEnvKey(raw: string, opts?: { forceMcp?: boolean }): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const normalized = trimmed.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (opts?.forceMcp) {
    const upper = normalized.toUpperCase();
    return upper.startsWith("MCP_") ? upper : `MCP_${upper}`;
  }
  return normalized;
}
