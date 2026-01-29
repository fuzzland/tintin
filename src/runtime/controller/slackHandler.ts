import crypto from "node:crypto";
import type { AppConfig, ProjectEntry } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionManager } from "../sessionManager.js";
import { SlackClient } from "../platform/slack.js";
import { validateAndResolveProjectPath } from "../security.js";
import { nowMs } from "../util.js";
import { getOtherLanguage, isUserLanguage, t, type UserLanguage } from "../../locales/index.js";
import { parseCloudCommand, parseLanguageCommandFromSlack, isSlackHelpCommand, safeParseMeta } from "./commands.js";
import { buildCommandExamples, buildMenuText } from "./sessions.js";
import { safeSnippet } from "./utils.js";
import { clearWizardState, getLatestSessionForChat, setUserLanguage, setWizardState, updateSession } from "../store.js";
import type { CloudCommand } from "./commands.js";
import type { SharedInteractionAction } from "./types.js";
import type { SessionRow } from "../store.js";

export type SlackAccessDecision = { allowed: boolean; reason?: string };

export type HandleCloudHelp = (opts: {
  platform: "slack";
  chatId: string;
  userId: string;
  workspaceId: string | null;
}) => Promise<void>;

export type HandleCloudCommand = (opts: {
  platform: "slack";
  command: CloudCommand;
  chatId: string;
  workspaceId: string | null;
  userId: string;
  isDirect: boolean;
  spaceId: string;
}) => Promise<boolean>;

export type HandleSharedInteractionAction = (opts: {
  platform: "slack";
  action: SharedInteractionAction;
  chatId: string;
  userId: string;
  workspaceId: string | null;
  messageId?: string;
  messageText?: string;
  threadTs?: string;
  isDirect: boolean;
}) => Promise<boolean>;

export interface SlackHandlerDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  slack: SlackClient | null;
  sessionManager: SessionManager;
  resolveUserLanguage: (platform: "telegram" | "slack", userId: string) => Promise<UserLanguage>;
  slackAccessDecision: (workspaceId: string | null, channelId: string, userId: string) => SlackAccessDecision;
  sendCloudHelp: HandleCloudHelp;
  handleCloudCommand: HandleCloudCommand;
  handleSharedInteractionAction: HandleSharedInteractionAction;
  handleSessionMessage: (session: SessionRow, userId: string, text: string) => Promise<void>;
  projectById: (projectId: string) => ProjectEntry;
}

export class SlackHandler {
  constructor(private readonly deps: SlackHandlerDeps) {}

  async handleSlackEvent(body: any): Promise<void> {
    const slack = this.deps.slack;
    if (!slack) return;
    if (body?.type !== "event_callback" || !body.event) return;

    const ev = body.event;
    const teamId = typeof body.team_id === "string" ? body.team_id : null;
    const enterpriseId = typeof body.enterprise_id === "string" ? body.enterprise_id : null;
    const registerWorkspace = (channelId: string | null) => {
      if (!channelId) return;
      slack.registerWorkspaceForChannel(channelId, { workspaceId: teamId, enterpriseId });
    };

    if (ev.type === "app_mention") {
      this.deps.logger.debug("[slack] ignore app_mention (DM-only mode)");
      return;
    }

    if (ev.type === "message") {
      if (ev.subtype) return;
      if (typeof ev.bot_id === "string" || ev.bot_profile) {
        this.deps.logger.debug("[slack] ignore bot message");
        return;
      }
      const channelId = ev.channel as string | undefined;
      const userId = ev.user as string | undefined;
      const text = typeof ev.text === "string" ? ev.text.trim() : "";
      if (!channelId || !userId || !text) return;
      if (!channelId.startsWith("D")) {
        this.deps.logger.debug(`[slack] ignore channel message (DM-only mode) channel=${channelId} user=${userId}`);
        return;
      }
      registerWorkspace(channelId);
      const access = this.deps.slackAccessDecision(teamId, channelId, userId);
      if (!access.allowed) {
        this.deps.logger.warn(`[slack] rejected message channel=${channelId} user=${userId} reason=${access.reason ?? "-"}`);
        return;
      }
      const threadTs = typeof ev.thread_ts === "string" ? ev.thread_ts : null;
      if (threadTs && threadTs !== ev.ts) {
        const lang = await this.deps.resolveUserLanguage("slack", userId);
        await slack.postMessageDetailed({
          channel: channelId,
          thread_ts: threadTs,
          text: t("slack.thread_unsupported", lang),
          blocksOnLastChunk: false,
          workspaceId: teamId,
        });
        return;
      }

      const cmdSpaceId = channelId;

      this.deps.logger.debug(
        `[slack] message received workspace=${String(teamId ?? "-")} channel=${channelId} user=${userId} space=${cmdSpaceId} text=${JSON.stringify(
          safeSnippet(text),
        )}`,
      );

      if (isSlackHelpCommand(text)) {
        await this.deps.sendCloudHelp({
          platform: "slack",
          chatId: channelId,
          userId,
          workspaceId: teamId,
        });
        return;
      }

      const languageCmd = parseLanguageCommandFromSlack(text);
      if (languageCmd) {
        await this.handleLanguageCommandSlack({
          channelId,
          userId,
          teamId,
          spaceId: cmdSpaceId,
          isDirect: channelId.startsWith("D"),
          rawArg: languageCmd.raw,
        });
        return;
      }

      const cloudCmd = parseCloudCommand(text);
      if (cloudCmd) {
        const spaceId = cloudCmd.kind === "action_run" ? `run:${crypto.randomUUID()}` : cmdSpaceId;
        await this.deps.handleCloudCommand({
          platform: "slack",
          command: cloudCmd,
          chatId: channelId,
          workspaceId: teamId,
          userId,
          isDirect: channelId.startsWith("D"),
          spaceId,
        });
        return;
      }

      const spaceId = channelId;
      if (!spaceId) return;

      const session = await getLatestSessionForChat(this.deps.db, "slack", channelId, ["starting", "running"]);
      if (!session) {
        this.deps.logger.debug(`[slack] no session for space=${spaceId} channel=${channelId}; starting wizard`);
        await this.startSlackWizard(teamId, channelId, userId);
        return;
      }
      this.deps.logger.debug(
        `[slack] routed message channel=${channelId} user=${userId} space=${spaceId} session=${session.id} text=${JSON.stringify(
          safeSnippet(text),
        )}`,
      );
      await updateSession(this.deps.db, session.id, { last_user_message_at: nowMs() });
      await this.deps.handleSessionMessage(session, userId, text);
    }
  }

  async handleSlackInteraction(payload: any): Promise<void> {
    const slack = this.deps.slack;
    if (!slack) return;
    this.deps.logger.debug(`[slack] interaction received type=${String(payload?.type ?? "?")}`);
    try {
      if (payload?.type === "block_actions") {
        await this.handleSlackBlockActions(payload);
        return;
      }
      if (payload?.type === "view_submission" && payload.view?.callback_id === "codex_wizard") {
        await this.handleSlackViewSubmission(payload);
        return;
      }
    } catch (e) {
      this.deps.logger.warn("slack interaction error", e);
      const channel =
        (payload?.channel?.id as string | undefined) ??
        (payload?.view?.private_metadata ? (safeParseMeta(payload.view.private_metadata)?.channelId as string | undefined) : undefined);
      const user =
        (payload?.user?.id as string | undefined) ??
        (payload?.view?.private_metadata ? (safeParseMeta(payload.view.private_metadata)?.userId as string | undefined) : undefined);
      const teamId = (payload?.team?.id as string | undefined) ?? null;
      if (channel && user) {
        const lang = await this.deps.resolveUserLanguage("slack", user);
        await slack.postEphemeral({
          channel,
          user,
          text: t("error.generic", lang, { message: String(e) }),
          workspaceId: teamId,
        });
      }
    }
  }

  private async handleLanguageCommandSlack(opts: {
    channelId: string;
    userId: string;
    teamId: string | null;
    spaceId: string;
    isDirect: boolean;
    rawArg: string;
  }) {
    const slack = this.deps.slack;
    if (!slack) return;
    const fallbackLang = await this.deps.resolveUserLanguage("slack", opts.userId);
    const access = this.deps.slackAccessDecision(opts.teamId, opts.channelId, opts.userId);
    if (!access.allowed) {
      await slack.postEphemeral({
        channel: opts.channelId,
        user: opts.userId,
        text: t("error.not_authorized", fallbackLang),
        workspaceId: opts.teamId,
      });
      return;
    }
    const raw = opts.rawArg.trim();
    const cmdHint = opts.isDirect ? "lang en" : "@bot lang en";
    const requested = raw ? this.normalizeLanguageToken(raw) : null;
    const sendText = async (text: string) => {
      await slack.postMessageDetailed({
        channel: opts.channelId,
        text,
        blocksOnLastChunk: false,
        workspaceId: opts.teamId ?? null,
      });
    };
    if (raw && !requested) {
      await sendText(`${t("lang.invalid", fallbackLang)}\n${t("lang.usage", fallbackLang, { cmd: cmdHint })}`);
      return;
    }
    const session = await getLatestSessionForChat(this.deps.db, "slack", opts.channelId, ["starting", "running"]);
    if (!session) {
      const nextLang = requested ?? getOtherLanguage(fallbackLang);
      await setUserLanguage(this.deps.db, "slack", opts.userId, nextLang);
      await this.deps.db
        .updateTable("sessions")
        .set({ language: nextLang, updated_at: nowMs() })
        .where("platform", "=", "slack")
        .where("chat_id", "=", opts.channelId)
        .where("created_by_user_id", "=", opts.userId)
        .where("status", "in", ["starting", "running"])
        .execute();
      const confirmKey = nextLang === "zh" ? "lang.default_set_zh" : "lang.default_set_en";
      await sendText(t(confirmKey, nextLang));
      return;
    }

    const currentLang = isUserLanguage(session.language) ? session.language : fallbackLang;
    const nextLang = requested ?? getOtherLanguage(currentLang);
    await updateSession(this.deps.db, session.id, { language: nextLang });
    await setUserLanguage(this.deps.db, "slack", opts.userId, nextLang);
    const confirmKey = nextLang === "zh" ? "lang.switched_zh" : "lang.switched_en";
    await sendText(t(confirmKey, nextLang));
  }

  private normalizeLanguageToken(raw: string): UserLanguage | null {
    const value = raw.trim().toLowerCase();
    if (!value) return null;
    if (value === "en" || value === "english") return "en";
    if (value === "zh" || value === "chinese" || value === "zh-cn") return "zh";
    return null;
  }

  private async startSlackWizard(teamId: string | null, channelId: string, userId: string) {
    const slack = this.deps.slack;
    if (!slack) return;
    slack.registerWorkspaceForChannel(channelId, { workspaceId: teamId });
    const lang = await this.deps.resolveUserLanguage("slack", userId);
    await setWizardState(this.deps.db, {
      id: crypto.randomUUID(),
      agent: "codex",
      platform: "slack",
      chat_id: channelId,
      user_id: userId,
      state: "await_project",
      project_id: null,
      custom_path_candidate: null,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    const options = this.deps.config.projects.map((p) => ({
      text: { type: "plain_text", text: p.name },
      value: p.id,
    }));

    const menuText = buildMenuText("slack", "codex", lang);
    const commandExamples = buildCommandExamples("slack", lang);

    await slack.postMessageDetailed({
      channel: channelId,
      text: menuText,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `${t("wizard.choose_project", lang, { agent: "Codex" })}:` },
          accessory: {
            type: "static_select",
            action_id: "project_select",
            placeholder: { type: "plain_text", text: t("wizard.select_project", lang) },
            options,
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: commandExamples },
        },
      ],
      blocksOnLastChunk: false,
      workspaceId: teamId,
    });
  }

  private async handleSlackBlockActions(payload: any) {
    const slack = this.deps.slack;
    if (!slack) return;
    const action = payload.actions?.[0];
    if (!action) return;
    const actionId = action.action_id as string;
    const actionValue = typeof action.value === "string" ? action.value : null;
    const sharedAction = this.parseSlackInteractionAction(actionId, actionValue);
    if (sharedAction) {
      const channelId = payload.channel?.id as string | undefined;
      const userId = payload.user?.id as string | undefined;
      const teamId = payload.team?.id as string | undefined;
      const messageTs = (payload.message?.ts ?? payload.container?.message_ts) as string | undefined;
      const threadTs =
        typeof payload.message?.thread_ts === "string"
          ? payload.message.thread_ts
          : messageTs;
      const messageText = typeof payload.message?.text === "string" ? payload.message.text : undefined;
      if (!channelId || !userId) return;
      slack.registerWorkspaceForChannel(channelId, { workspaceId: teamId ?? null });
      const handled = await this.deps.handleSharedInteractionAction({
        platform: "slack",
        action: sharedAction,
        chatId: channelId,
        userId,
        workspaceId: teamId ?? null,
        messageId: messageTs,
        messageText,
        threadTs,
        isDirect: channelId.startsWith("D"),
      });
      if (handled) return;
    }

    if (action.action_id !== "project_select") return;

    const projectId = action.selected_option?.value as string | undefined;
    const triggerId = payload.trigger_id as string | undefined;
    const channelId = payload.channel?.id as string | undefined;
    const userId = payload.user?.id as string | undefined;
    const teamId = payload.team?.id as string | undefined;
    if (!projectId || !triggerId || !channelId || !userId) return;
    slack.registerWorkspaceForChannel(channelId, { workspaceId: teamId ?? null });
    const lang = await this.deps.resolveUserLanguage("slack", userId);
    const access = this.deps.slackAccessDecision(teamId ?? null, channelId, userId);
    if (!access.allowed) {
      this.deps.logger.warn(
        `[slack] rejected block_actions channel=${channelId} user=${userId} reason=${access.reason ?? "-"}`,
      );
      return;
    }

    const project = this.deps.projectById(projectId);

    await setWizardState(this.deps.db, {
      id: crypto.randomUUID(),
      agent: "codex",
      platform: "slack",
      chat_id: channelId,
      user_id: userId,
      state: project.path === "*" ? "await_custom_path" : "await_initial_prompt",
      project_id: projectId,
      custom_path_candidate: null,
      created_at: nowMs(),
      updated_at: nowMs(),
    });

    await slack.openModal(triggerId, this.buildSlackWizardModal({ project, channelId, userId, teamId: teamId ?? null, lang }), {
      workspaceId: teamId ?? null,
    });
  }

  private buildSlackWizardModal(opts: {
    project: ProjectEntry;
    channelId: string;
    userId: string;
    teamId: string | null;
    lang: UserLanguage;
  }) {
    const blocks: any[] = [];

    if (opts.project.path === "*") {
      blocks.push({
        type: "input",
        block_id: "custom_path",
        label: { type: "plain_text", text: t("wizard.project_path_label", opts.lang) },
        element: { type: "plain_text_input", action_id: "input" },
        hint: { type: "plain_text", text: t("wizard.project_path_hint", opts.lang) },
      });
    }

    blocks.push({
      type: "input",
      block_id: "prompt",
      label: { type: "plain_text", text: t("wizard.prompt_label", opts.lang) },
      element: { type: "plain_text_input", action_id: "input", multiline: true },
    });

    return {
      type: "modal",
      callback_id: "codex_wizard",
      private_metadata: JSON.stringify({
        projectId: opts.project.id,
        channelId: opts.channelId,
        userId: opts.userId,
        teamId: opts.teamId,
      }),
      title: { type: "plain_text", text: t("wizard.modal_title", opts.lang) },
      submit: { type: "plain_text", text: t("wizard.modal_submit", opts.lang) },
      close: { type: "plain_text", text: t("wizard.modal_cancel", opts.lang) },
      blocks,
    };
  }

  private async handleSlackViewSubmission(payload: any) {
    const slack = this.deps.slack;
    if (!slack) return;
    const metaRaw = payload.view?.private_metadata as string | undefined;
    if (!metaRaw) return;
    const meta = JSON.parse(metaRaw) as { projectId: string; channelId: string; userId: string; teamId: string | null };
    const access = this.deps.slackAccessDecision(meta.teamId, meta.channelId, meta.userId);
    if (!access.allowed) {
      this.deps.logger.warn(
        `[slack] rejected view_submission channel=${meta.channelId} user=${meta.userId} reason=${access.reason ?? "-"}`,
      );
      return;
    }
    const values = payload.view.state?.values as Record<string, any> | undefined;

    const prompt = values?.prompt?.input?.value as string | undefined;
    const customPath = values?.custom_path?.input?.value as string | undefined;
    if (!prompt) return;

    const project = this.deps.projectById(meta.projectId);
    const resolved = await validateAndResolveProjectPath(this.deps.config, project, project.path === "*" ? customPath ?? null : null);

    const lang = await this.deps.resolveUserLanguage("slack", meta.userId);
    slack.registerWorkspaceForChannel(meta.channelId, { workspaceId: meta.teamId });
    const rootTs = await slack.postMessage({
      channel: meta.channelId,
      text: t("session.starting", lang),
      workspaceId: meta.teamId,
    });
    if (!rootTs) throw new Error("Failed to create Slack thread");

    await clearWizardState(this.deps.db, "slack", meta.channelId, meta.userId);

    await this.deps.sessionManager.startNewSession({
      platform: "slack",
      workspaceId: meta.teamId,
      chatId: meta.channelId,
      spaceId: rootTs,
      spaceEmoji: null,
      userId: meta.userId,
      projectId: resolved.project_id,
      projectPathResolved: resolved.project_path_resolved,
      initialPrompt: prompt,
      agent: "codex",
    });
  }

  private parseSlackInteractionAction(actionId: string, value: string | null): SharedInteractionAction | null {
    if (actionId === "switch_language") {
      if (!value || (value !== "en" && value !== "zh")) return null;
      return { kind: "lang", value };
    }
    if (actionId === "kill_session" && value) return { kind: "kill", sessionId: value };
    if (actionId === "review_session" && value) return { kind: "review", sessionId: value };
    if (actionId === "commit_session" && value) return { kind: "commit", sessionId: value };
    if (actionId === "run_status" && value) return { kind: "run_status", runId: value };
    if (actionId === "stop_sandbox" && value) return { kind: "stop_sandbox", sessionId: value };
    if (actionId === "commit_cancel" && value) return { kind: "commit_proposal", proposalId: value, action: "cancel" };
    if (actionId === "commit_push" && value) return { kind: "commit_proposal", proposalId: value, action: "push" };
    if (actionId === "commit_pr" && value) return { kind: "commit_proposal", proposalId: value, action: "pr" };
    return null;
  }
}
