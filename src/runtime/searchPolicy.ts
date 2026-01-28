import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { t, type UserLanguage } from "../locales/index.js";

export type SearchPolicy = {
  mode: "hyperbrowser_first" | "unrestricted";
  warn_on_shell: boolean;
};

const SEARCH_GUARD_MESSAGE = "Search policy enforced: curl/wget disabled. Use Hyperbrowser (Playwright MCP).";

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
  opts: {
    policy: SearchPolicy;
    hyperbrowserAvailable: boolean;
    enforce: boolean;
    guardDir?: string;
  },
): Record<string, string> {
  const out = { ...env };
  out.TINTIN_SEARCH_POLICY = opts.policy.mode;
  out.TINTIN_SEARCH_WARN_ON_SHELL = opts.policy.warn_on_shell ? "1" : "0";
  out.TINTIN_SEARCH_PROVIDER = opts.hyperbrowserAvailable ? "hyperbrowser" : "none";
  out.TINTIN_SEARCH_ENFORCE = opts.enforce ? "1" : "0";
  if (opts.guardDir && opts.enforce) {
    const base = out.PATH ?? process.env.PATH ?? "";
    out.PATH = base ? `${opts.guardDir}:${base}` : opts.guardDir;
  }
  return out;
}

export function isShellSearchCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return /\b(curl|wget)\b/.test(lower);
}

export async function ensureLocalSearchGuard(opts: { rootDir: string; message?: string }): Promise<string> {
  const dir = opts.rootDir;
  const message = opts.message ?? SEARCH_GUARD_MESSAGE;
  await mkdir(dir, { recursive: true });
  const script = buildSearchGuardScript(message);
  const curlPath = path.join(dir, "curl");
  const wgetPath = path.join(dir, "wget");
  await writeFile(curlPath, script, "utf8");
  await writeFile(wgetPath, script, "utf8");
  await chmod(curlPath, 0o755);
  await chmod(wgetPath, 0o755);
  return dir;
}

export function buildSearchGuardBootstrapLines(opts: { guardDir: string; message?: string }): string[] {
  const guardDir = opts.guardDir;
  const message = opts.message ?? SEARCH_GUARD_MESSAGE;
  const lines: string[] = [];
  lines.push(`SEARCH_GUARD_DIR=${shellQuote(guardDir)}`);
  lines.push('mkdir -p "$SEARCH_GUARD_DIR"');
  lines.push('cat > "$SEARCH_GUARD_DIR/curl" <<\'EOF\'');
  lines.push(...buildSearchGuardScript(message).trimEnd().split("\n"));
  lines.push("EOF");
  lines.push('cat > "$SEARCH_GUARD_DIR/wget" <<\'EOF\'');
  lines.push(...buildSearchGuardScript(message).trimEnd().split("\n"));
  lines.push("EOF");
  lines.push('chmod +x "$SEARCH_GUARD_DIR/curl" "$SEARCH_GUARD_DIR/wget"');
  lines.push('export PATH="$SEARCH_GUARD_DIR:$PATH"');
  return lines;
}

function buildSearchGuardScript(message: string): string {
  const escaped = escapeForDoubleQuotes(message);
  return `#!/bin/sh\nprintf '%s\\n' "${escaped}" >&2\nexit 23\n`;
}

function escapeForDoubleQuotes(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}
