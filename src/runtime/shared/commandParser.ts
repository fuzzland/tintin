import type { SessionStatus } from "../db.js";
import type { UserLanguage } from "../../locales/index.js";
import type { SessionListIntent } from "./types.js";
import { parseSettingsArgs } from "./settings.js";

export function parseSessionsArgs(args: string): SessionListIntent {
  const tokens = args.split(/\s+/).filter(Boolean);
  let page = 1;
  const statuses: SessionStatus[] = [];

  for (const token of tokens) {
    const pageMatch = token.match(/^(?:page|p)=?(\d+)$/i);
    if (pageMatch) {
      page = parseInt(pageMatch[1]!, 10);
      continue;
    }
    if (/^\d+$/.test(token)) {
      page = parseInt(token, 10);
      continue;
    }
    const status = parseSessionStatus(token);
    if (status) {
      statuses.push(status);
    }
  }

  return { page, statuses: statuses.length > 0 ? statuses : undefined };
}

export { parseSettingsArgs };

function parseSessionStatus(token: string): SessionStatus | null {
  const normalized = token.toLowerCase();
  const statusMap: Record<string, SessionStatus> = {
    running: "running",
    run: "running",
    active: "running",
    finished: "finished",
    done: "finished",
    complete: "finished",
    completed: "finished",
    error: "error",
    err: "error",
    failed: "error",
    killed: "killed",
    kill: "killed",
    stopped: "killed",
    wizard: "wizard",
    starting: "starting",
  };
  return statusMap[normalized] || null;
}

export function normalizeLanguageToken(raw: string): UserLanguage | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === "en" || value === "english") return "en";
  if (value === "zh" || value === "chinese" || value === "zh-cn") return "zh";
  return null;
}
