/**
 * RequestRouter - Intent detection and request routing.
 *
 * Routes incoming messages to the appropriate orchestrator based on content analysis.
 * This is the central decision point for all platform adapters.
 */

import type { SessionAgent } from "../db.js";
import type { SessionPlatform, SessionInfo } from "../orchestrator/types.js";
import type { CloudCommand, SessionListIntent, SettingsCommand } from "../shared/types.js";
import { parseSessionsArgs, parseSettingsArgs } from "../shared/commandParser.js";
import type { Logger } from "../log.js";

// ============================================================================
// Intent Types
// ============================================================================

/**
 * Command types that can be parsed from messages.
 */
export type CommandIntent =
  | { kind: "sessions"; intent: SessionListIntent }
  | { kind: "settings"; command: SettingsCommand }
  | { kind: "lang"; target?: string }
  | { kind: "help" }
  | { kind: "kill"; sessionId?: string }
  | { kind: "version" };

/**
 * Wizard action types.
 */
export type WizardAction = "start" | "continue" | "project_select" | "path_input";

/**
 * Request intent - the detected purpose of an incoming message.
 */
export type RequestIntent =
  | { type: "wizard"; action: WizardAction; agent?: SessionAgent; projectId?: string; path?: string }
  | { type: "command"; command: CommandIntent }
  | { type: "cloud"; command: CloudCommand }
  | { type: "session"; prompt: string }
  | { type: "unknown" };

// ============================================================================
// Routing Context
// ============================================================================

/**
 * Context needed to route a request.
 */
export interface RoutingContext {
  platform: SessionPlatform;
  chatId: string;
  spaceId: string | null;
  userId: string;
  /** Whether the user has an active wizard session */
  hasActiveWizard: boolean;
  /** The active session if one exists */
  activeSession: SessionInfo | null;
  /** Whether cloud features are enabled */
  cloudEnabled: boolean;
}

// ============================================================================
// Router Dependencies
// ============================================================================

export interface RouterDeps {
  logger: Logger;
  /** Get active wizard state for a chat */
  getWizardState?: (chatId: string, spaceId: string | null) => Promise<WizardAction | null>;
  /** Find active session for a chat */
  findActiveSession?: (platform: SessionPlatform, chatId: string, spaceId: string | null) => Promise<SessionInfo | null>;
}

// ============================================================================
// Command Patterns
// ============================================================================

/** Commands that start a new wizard session */
const WIZARD_START_COMMANDS = new Set(["/start", "/codex", "/cc", "/claude"]);

/** Known command tokens (normalized, without @bot suffix) */
const KNOWN_COMMANDS = new Set([
  "/start", "/codex", "/cc", "/claude",
  "/sessions", "/session", "/settings", "/setting",
  "/lang", "/help", "/kill", "/stop", "/version",
  "/run", "/repos", "/repo", "/connect", "/disconnect",
  "/connections", "/connection", "/status", "/pull",
  "/secrets", "/secret", "/runs", "/snapshots", "/snapshot",
  "/lift", "/token",
]);

/** Commands that need special handling */
const COMMAND_PATTERNS: Array<{ pattern: RegExp; kind: CommandIntent["kind"] }> = [
  { pattern: /^\/sessions?(?:\s|$)/i, kind: "sessions" },
  { pattern: /^\/settings?(?:\s|$)/i, kind: "settings" },
  { pattern: /^\/lang(?:\s|$)/i, kind: "lang" },
  { pattern: /^\/help(?:\s|$)/i, kind: "help" },
  { pattern: /^\/kill(?:\s|$)/i, kind: "kill" },
  { pattern: /^\/stop(?:\s|$)/i, kind: "kill" },
  { pattern: /^\/version(?:\s|$)/i, kind: "version" },
];

/** Cloud command patterns */
const CLOUD_COMMAND_PATTERNS: Array<{ pattern: RegExp; parser: (text: string) => CloudCommand | null }> = [
  {
    pattern: /^\/run(?:\s|$)/i,
    parser: (text) => {
      const prompt = text.replace(/^\/run\s*/i, "").trim();
      return { kind: "action_run", prompt, repoIds: [] };
    },
  },
  {
    pattern: /^\/repos?(?:\s|$)/i,
    parser: (text) => {
      const args = text.replace(/^\/repos?\s*/i, "").trim();
      if (!args) return { kind: "repos" };
      const selectMatch = args.match(/^(\d+)$/);
      if (selectMatch) return { kind: "repo_select", target: selectMatch[1]! };
      return { kind: "repos", search: args };
    },
  },
  {
    pattern: /^\/connect(?:\s|$)/i,
    parser: (text) => {
      const args = text.replace(/^\/connect\s*/i, "").trim();
      const provider = args.split(/\s+/)[0] || "github";
      return { kind: "connect", provider };
    },
  },
  {
    pattern: /^\/disconnect(?:\s|$)/i,
    parser: (text) => {
      const args = text.replace(/^\/disconnect\s*/i, "").trim();
      const provider = args.split(/\s+/)[0] || "github";
      return { kind: "disconnect", provider };
    },
  },
  {
    pattern: /^\/connections?(?:\s|$)/i,
    parser: () => ({ kind: "connections" }),
  },
  {
    pattern: /^\/status(?:\s|$)/i,
    parser: (text) => {
      const runId = text.replace(/^\/status\s*/i, "").trim();
      return runId ? { kind: "action_status", runId } : { kind: "setup_status" };
    },
  },
  {
    pattern: /^\/pull(?:\s|$)/i,
    parser: (text) => {
      const runId = text.replace(/^\/pull\s*/i, "").trim();
      return { kind: "action_pull", runId };
    },
  },
  {
    pattern: /^\/secrets?(?:\s|$)/i,
    parser: (text) => {
      const args = text.replace(/^\/secrets?\s*/i, "").trim();
      if (!args) return { kind: "secrets_list" };
      const setMatch = args.match(/^set\s+(\w+)\s*=\s*(.*)$/i);
      if (setMatch) return { kind: "secrets_set", name: setMatch[1]!, value: setMatch[2] || null };
      const delMatch = args.match(/^(?:del|delete|rm|remove)\s+(\w+)$/i);
      if (delMatch) return { kind: "secrets_delete", name: delMatch[1]! };
      return { kind: "secrets_list" };
    },
  },
  {
    pattern: /^\/runs?(?:\s|$)/i,
    parser: (text) => {
      const args = text.replace(/^\/runs?\s*/i, "").trim();
      const limit = parseInt(args, 10);
      return { kind: "runs", limit: Number.isFinite(limit) ? limit : undefined };
    },
  },
  {
    pattern: /^\/snapshots?(?:\s|$)/i,
    parser: (text) => {
      const args = text.replace(/^\/snapshots?\s*/i, "").trim();
      if (!args) return { kind: "snapshot_list" };
      if (args === "save") return { kind: "snapshot_save" };
      if (args === "clear") return { kind: "snapshot_clear" };
      const searchMatch = args.match(/^search\s+(.+)$/i);
      if (searchMatch) return { kind: "snapshot_search", query: searchMatch[1]! };
      const restoreMatch = args.match(/^restore\s+(.+)$/i);
      if (restoreMatch) return { kind: "snapshot_restore", target: restoreMatch[1]! };
      return { kind: "snapshot_list", limit: parseInt(args, 10) || undefined };
    },
  },
  {
    pattern: /^\/lift(?:\s|$)/i,
    parser: () => ({ kind: "setup_lift" }),
  },
  {
    pattern: /^\/token(?:\s|$)/i,
    parser: () => ({ kind: "tinc_token" }),
  },
  {
    pattern: /^\/mcp(?:\s|$)/i,
    parser: (text) => {
      const args = text.replace(/^\/mcp\s*/i, "").trim();
      const parts = args.split(/\s+/);
      if (parts[0] === "github" && parts[1] === "token" && parts[2] === "set") {
        const token = parts.slice(3).join(" ") || null;
        return { kind: "mcp_github_token_set", token };
      }
      if (parts[0] === "notion" && parts[1] === "connect") {
        return { kind: "mcp_notion_connect" };
      }
      if (parts[0] === "notion" && parts[1] === "status") {
        return { kind: "mcp_notion_status" };
      }
      return null;
    },
  },
  {
    pattern: /^\/repo(?:\s|$)/i,
    parser: (text) => {
      const args = text.replace(/^\/repo\s*/i, "").trim();
      if (!args) return null;
      const selectMatch = args.match(/^select\s+(\d+)$/i);
      if (selectMatch) return { kind: "repo_select", target: selectMatch[1]! };
      const shareMatch = args.match(/^share\s+(\d+)$/i);
      if (shareMatch) return { kind: "repo_share", target: shareMatch[1]! };
      const unshareMatch = args.match(/^unshare\s+(\d+)$/i);
      if (unshareMatch) return { kind: "repo_unshare", target: unshareMatch[1]! };
      if (args === "current") return { kind: "repo_current" };
      return null;
    },
  },
];

// ============================================================================
// RequestRouter Implementation
// ============================================================================

export class RequestRouter {
  constructor(private readonly deps: RouterDeps) {}

  /**
   * Detect the intent of an incoming message.
   */
  async detectIntent(
    text: string,
    context: RoutingContext,
  ): Promise<RequestIntent> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { type: "unknown" };
    }
    const normalized = this.normalizeCommandText(trimmed);

    // 1. Check for wizard start commands
    const wizardIntent = this.detectWizardIntent(normalized, context);
    if (wizardIntent) {
      return wizardIntent;
    }

    // 2. Check for cloud commands (if enabled)
    if (context.cloudEnabled) {
      const cloudIntent = this.detectCloudIntent(normalized);
      if (cloudIntent) {
        return cloudIntent;
      }
    }

    // 3. Check for local commands
    const commandIntent = this.detectCommandIntent(normalized);
    if (commandIntent) {
      return commandIntent;
    }

    // 4. If in wizard mode, treat as wizard continuation
    if (context.hasActiveWizard) {
      return { type: "wizard", action: "continue" };
    }

    // 5. If has active session, treat as session message
    if (context.activeSession) {
      return { type: "session", prompt: trimmed };
    }

    // 6. Unknown intent - could be starting a new conversation
    return { type: "unknown" };
  }

  /**
   * Detect wizard-related intents.
   */
  private detectWizardIntent(
    text: string,
    context: RoutingContext,
  ): RequestIntent | null {
    const firstWord = text.split(/\s+/)[0]?.toLowerCase() || "";

    // Check for wizard start commands
    if (WIZARD_START_COMMANDS.has(firstWord)) {
      const agent = this.extractAgentFromCommand(firstWord);
      return { type: "wizard", action: "start", agent };
    }

    // If already in wizard, check for project selection or path input
    if (context.hasActiveWizard) {
      // Project selection (numeric or id-based)
      const projectMatch = text.match(/^(?:project[:\s]*)?(\d+|[a-z0-9_-]+)$/i);
      if (projectMatch && !text.startsWith("/")) {
        return { type: "wizard", action: "project_select", projectId: projectMatch[1] };
      }

      // Path input (looks like a file path)
      if (text.startsWith("/") && !this.looksLikeCommand(text)) {
        return { type: "wizard", action: "path_input", path: text };
      }
    }

    return null;
  }

  /**
   * Detect cloud command intents.
   */
  private detectCloudIntent(text: string): RequestIntent | null {
    for (const { pattern, parser } of CLOUD_COMMAND_PATTERNS) {
      if (pattern.test(text)) {
        const command = parser(text);
        if (command) {
          return { type: "cloud", command };
        }
      }
    }
    return null;
  }

  /**
   * Detect local command intents.
   */
  private detectCommandIntent(text: string): RequestIntent | null {
    for (const { pattern, kind } of COMMAND_PATTERNS) {
      if (pattern.test(text)) {
        const command = this.parseCommand(text, kind);
        if (command) {
          return { type: "command", command };
        }
      }
    }
    return null;
  }

  /**
   * Parse a command based on its kind.
   */
  private parseCommand(text: string, kind: CommandIntent["kind"]): CommandIntent | null {
    switch (kind) {
      case "sessions": {
        const args = text.replace(/^\/sessions?\s*/i, "").trim();
        return { kind: "sessions", intent: parseSessionsArgs(args) };
      }
      case "settings": {
        const args = text.replace(/^\/settings?\s*/i, "").trim();
        return { kind: "settings", command: parseSettingsArgs(args) };
      }
      case "lang": {
        const target = text.replace(/^\/lang\s*/i, "").trim() || undefined;
        return { kind: "lang", target };
      }
      case "help":
        return { kind: "help" };
      case "kill": {
        const sessionId = text.replace(/^\/(?:kill|stop)\s*/i, "").trim() || undefined;
        return { kind: "kill", sessionId };
      }
      case "version":
        return { kind: "version" };
      default:
        return null;
    }
  }

  /**
   * Parse /sessions command arguments.
   */
  private parseSessionsArgs(args: string): SessionListIntent {
    return parseSessionsArgs(args);
  }

  private parseSettingsArgs(args: string): SettingsCommand {
    return parseSettingsArgs(args);
  }

  /**
   * Extract agent type from wizard start command.
   */
  private extractAgentFromCommand(command: string): SessionAgent | undefined {
    switch (command) {
      case "/codex":
        return "codex";
      case "/cc":
      case "/claude":
        return "claude_code";
      default:
        return undefined;
    }
  }

  /**
   * Check if text looks like a command (known command pattern).
   * Returns true for known commands, false for file paths.
   */
  private looksLikeCommand(text: string): boolean {
    // Must start with /letter
    if (!/^\/[a-z]/i.test(text)) {
      return false;
    }
    // Check against all known command patterns
    const normalized = this.normalizeCommandText(text);
    const firstWord = normalized.split(/\s+/)[0]?.toLowerCase() || "";
    return KNOWN_COMMANDS.has(firstWord);
  }

  /**
   * Normalize Telegram /cmd@bot to /cmd when it matches known commands.
   */
  private normalizeCommandText(text: string): string {
    if (!text.startsWith("/")) return text;
    const firstSpace = text.search(/\s/);
    const token = firstSpace === -1 ? text : text.slice(0, firstSpace);
    if (!token.includes("@")) return text;
    const base = token.split("@")[0] ?? token;
    if (!base) return text;
    const normalized = base.toLowerCase();
    if (!KNOWN_COMMANDS.has(normalized)) return text;
    const rest = firstSpace === -1 ? "" : text.slice(firstSpace);
    return `${base}${rest}`;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRequestRouter(deps: RouterDeps): RequestRouter {
  return new RequestRouter(deps);
}
