/**
 * ActionParser - Unified parsing of button/interaction actions.
 *
 * Consolidates duplicate logic from:
 * - TelegramHandler.parseTelegramInteractionAction()
 * - SlackHandler.parseSlackInteractionAction()
 *
 * Follows SRP: Only responsible for parsing interaction data to actions.
 */

import { isUserLanguage } from "../../locales/index.js";
import type { InteractionAction, CommitProposalAction } from "./types.js";

/**
 * Parse Telegram callback_data to InteractionAction.
 *
 * Telegram callback_data format: "action:value" or "action:value:extra"
 * Examples:
 * - "kill:session-123"
 * - "review:session-123"
 * - "cpr:proposal-id:push"
 */
export function parseTelegramAction(data: string): InteractionAction | null {
  if (!data) return null;

  if (data.startsWith("project:")) {
    const projectId = data.slice("project:".length);
    return projectId ? { kind: "project_select", projectId } : null;
  }

  if (data.startsWith("lang:")) {
    const value = data.slice("lang:".length);
    return isUserLanguage(value) ? { kind: "lang", value } : null;
  }

  if (data.startsWith("kill:")) {
    const sessionId = data.slice("kill:".length);
    return sessionId ? { kind: "kill", sessionId } : null;
  }

  if (data.startsWith("review:")) {
    const sessionId = data.slice("review:".length);
    return sessionId ? { kind: "review", sessionId } : null;
  }

  if (data.startsWith("commit:")) {
    const sessionId = data.slice("commit:".length);
    return sessionId ? { kind: "commit", sessionId } : null;
  }

  if (data.startsWith("run_status:")) {
    const runId = data.slice("run_status:".length).trim();
    return runId ? { kind: "run_status", runId } : null;
  }

  if (data.startsWith("stop_sandbox:")) {
    const sessionId = data.slice("stop_sandbox:".length);
    return sessionId ? { kind: "stop_sandbox", sessionId } : null;
  }

  if (data.startsWith("cpr:")) {
    const rest = data.slice("cpr:".length);
    const colonIndex = rest.indexOf(":");
    if (colonIndex === -1) return null;

    const proposalId = rest.slice(0, colonIndex);
    const actionRaw = rest.slice(colonIndex + 1).trim() as CommitProposalAction;

    if (!proposalId) return null;
    if (actionRaw !== "cancel" && actionRaw !== "push" && actionRaw !== "pr") return null;

    return { kind: "commit_proposal", proposalId, action: actionRaw };
  }

  return null;
}

/**
 * Parse Slack action_id and value to InteractionAction.
 *
 * Slack uses action_id to identify the action type, and value for the payload.
 * Examples:
 * - action_id: "kill_session", value: "session-123"
 * - action_id: "switch_language", value: "zh"
 */
export function parseSlackAction(actionId: string, value: string | null): InteractionAction | null {
  if (!actionId) return null;

  if (actionId === "select_project" && value) {
    return { kind: "project_select", projectId: value };
  }

  if (actionId === "switch_language") {
    if (!value || (value !== "en" && value !== "zh")) return null;
    return { kind: "lang", value };
  }

  if (actionId === "kill_session" && value) {
    return { kind: "kill", sessionId: value };
  }

  if (actionId === "review_session" && value) {
    return { kind: "review", sessionId: value };
  }

  if (actionId === "commit_session" && value) {
    return { kind: "commit", sessionId: value };
  }

  if (actionId === "run_status" && value) {
    return { kind: "run_status", runId: value };
  }

  if (actionId === "stop_sandbox" && value) {
    return { kind: "stop_sandbox", sessionId: value };
  }

  if (actionId === "commit_cancel" && value) {
    return { kind: "commit_proposal", proposalId: value, action: "cancel" };
  }

  if (actionId === "commit_push" && value) {
    return { kind: "commit_proposal", proposalId: value, action: "push" };
  }

  if (actionId === "commit_pr" && value) {
    return { kind: "commit_proposal", proposalId: value, action: "pr" };
  }

  return null;
}

// Note: ActionParser class removed - use standalone functions directly:
// - parseTelegramAction(data)
// - parseSlackAction(actionId, value)
