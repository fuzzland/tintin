import type { AppConfig } from "./config.js";
import { t, type UserLanguage } from "../locales/index.js";

export type SearchPolicy = {
  mode: "hyperbrowser_first" | "unrestricted";
  warn_on_shell: boolean;
};

export function resolveSearchPolicy(config: AppConfig): SearchPolicy {
  const hyperbrowserAvailable = isHyperbrowserAvailable(config);
  return { mode: hyperbrowserAvailable ? "hyperbrowser_first" : "unrestricted", warn_on_shell: true };
}

export function isHyperbrowserAvailable(config: AppConfig): boolean {
  const mcp = config.playwright_mcp;
  if (!mcp || !mcp.enabled) return false;
  if (mcp.provider !== "hyperbrowser") return false;
  const apiKey = mcp.hyperbrowser?.api_key ?? "";
  return apiKey.trim().length > 0;
}

export function buildSearchDirective(opts: {
  policy: SearchPolicy;
  lang: UserLanguage;
  hyperbrowserAvailable: boolean;
}): string | null {
  if (opts.policy.mode !== "hyperbrowser_first") return null;
  if (!opts.hyperbrowserAvailable) return null;
  return t("prompt.search_directive", opts.lang);
}

export function applySearchEnv(
  env: Record<string, string>,
  policy: SearchPolicy,
  hyperbrowserAvailable: boolean,
): Record<string, string> {
  const out = { ...env };
  out.TINTIN_SEARCH_POLICY = policy.mode;
  out.TINTIN_SEARCH_WARN_ON_SHELL = policy.warn_on_shell ? "1" : "0";
  out.TINTIN_SEARCH_PROVIDER = hyperbrowserAvailable ? "hyperbrowser" : "none";
  return out;
}

export function isShellSearchCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return /\b(curl|wget)\b/.test(lower);
}
