import type { UserLanguage } from "../../locales/index.js";
import type { SessionListIntent } from "./types.js";
import { parseSettingsArgs } from "./settings.js";
import { parseSessionStatusFilter } from "./commands.js";

export function parseSessionsArgs(args: string): SessionListIntent {
  const tokens = args.split(/\s+/).filter(Boolean);
  let page = 1;
  const remaining: string[] = [];

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
    remaining.push(token);
  }

  const statuses = parseSessionStatusFilter(remaining.join(" "));
  return { page, statuses };
}

export { parseSettingsArgs };

// Status parsing is handled by shared/commands.ts to keep parity with legacy behavior.

export function normalizeLanguageToken(raw: string): UserLanguage | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === "en" || value === "english") return "en";
  if (value === "zh" || value === "chinese" || value === "zh-cn") return "zh";
  return null;
}
