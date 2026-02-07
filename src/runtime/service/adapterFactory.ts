/**
 * AdapterFactory - Creates platform adapters with full orchestrator support.
 *
 * This factory wires up adapters with all required orchestrators for
 * handling messages without falling back to the old controller.
 */

import crypto from "node:crypto";
import type { AppConfig, ProjectEntry } from "../config.js";
import type { Db, SessionAgent } from "../db.js";
import type { Logger } from "../log.js";
import type { TelegramClient, TelegramChat, TelegramMessageEntity } from "../platform/telegram.js";
import type { SlackClient } from "../platform/slack.js";
import type { SessionManager } from "../sessionManager.js";
import type { CloudManager } from "../cloud/manager.js";
import type { UserLanguage } from "../../locales/index.js";
import { t } from "../../locales/index.js";
import type { IMessagingPlatform, InteractiveMarkup } from "../platform/base.js";
import type { SessionInfo, OrchestratorDeps } from "../orchestrator/types.js";
import type { WizardStateRecord, ProjectInfo, WizardContext, PrepareSpaceResult } from "../orchestrator/WizardOrchestrator.js";
import { TelegramAdapter } from "../adapters/TelegramAdapter.js";
import { SlackAdapter } from "../adapters/SlackAdapter.js";
import { RequestRouter } from "../adapters/RequestRouter.js";
import { SessionOrchestrator } from "../orchestrator/SessionOrchestrator.js";
import { createWizardOrchestrator } from "../orchestrator/WizardOrchestrator.js";
import { createCommandOrchestrator } from "../orchestrator/CommandOrchestrator.js";
import { createCloudOrchestrator } from "../orchestrator/CloudOrchestrator.js";
import { CommitProposalOrchestrator } from "../orchestrator/CommitProposalOrchestrator.js";
import { createForumTopicManager } from "../adapters/telegram/ForumTopicManager.js";
import type { CommitProposalStore } from "../controller/types.js";
import {
  getUserLanguage,
  getWizardState,
  setWizardState,
  clearWizardState,
  listSessionsForChat,
  countPendingMessages,
  enqueuePendingMessage,
} from "../store.js";
import { getCloudRunBySession } from "../cloud/store.js";

export interface AdapterFactoryDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  telegram: TelegramClient | null;
  slack: SlackClient | null;
  sessionManager: SessionManager;
  cloudManager: CloudManager | null;
  commitProposalStore?: CommitProposalStore | null;
  sendPlatformMessage: (opts: {
    platform: IMessagingPlatform | null;
    chatId: string;
    text: string;
    markup?: InteractiveMarkup;
    threadId?: string | number;
    replyToMessageId?: string | number;
    priority?: "user" | "background";
    workspaceId?: string | null;
  }) => Promise<void>;
  /** Look up session ID by Telegram reply message */
  lookupTelegramSessionByReply?: (chatId: string, messageId: number) => string | null;
}

export interface AdapterFactoryResult {
  telegramAdapter: TelegramAdapter | null;
  slackAdapter: SlackAdapter | null;
}

/**
 * Create platform adapters with full orchestrator support.
 */
export function createAdapters(deps: AdapterFactoryDeps): AdapterFactoryResult {
  const {
    config,
    db,
    logger,
    telegram,
    slack,
    sessionManager,
    cloudManager,
    sendPlatformMessage,
    commitProposalStore,
  } = deps;

  // Create request router
  const router = new RequestRouter({ logger });

  const forumTopicManager = telegram
    ? createForumTopicManager({
        telegram,
        logger,
        useTopics: config.telegram?.use_topics ?? true,
        maxChars: telegram.maxChars,
      })
    : null;

  // Resolve user language helper
  const resolveUserLanguage = async (
    platform: "telegram" | "slack",
    userId: string,
  ): Promise<UserLanguage> => {
    try {
      return await getUserLanguage(db, platform, userId);
    } catch {
      return "en";
    }
  };

  const buildTelegramCustomEmojiEntity = (
    text: string,
    emoji: string,
    customEmojiId: string,
  ): TelegramMessageEntity | null => {
    const offset = text.lastIndexOf(emoji);
    if (offset < 0) return null;
    return { type: "custom_emoji", offset, length: emoji.length, custom_emoji_id: customEmojiId };
  };

  // Convert ProjectEntry to ProjectInfo
  const toProjectInfo = (p: ProjectEntry): ProjectInfo => ({
    id: p.id,
    name: p.name,
    path: p.path,
    allowCustomPath: false, // ProjectEntry doesn't have this field
  });

  const getProjects = (): ProjectInfo[] => config.projects.map(toProjectInfo);

  const getProject = (projectId: string): ProjectInfo | null => {
    const p = config.projects.find((x) => x.id === projectId);
    return p ? toProjectInfo(p) : null;
  };

  // Create SessionOrchestrator dependencies
  const orchestratorDeps: OrchestratorDeps = {
    enqueueMessage: async (sessionId, userId, text) => {
      await enqueuePendingMessage(db, {
        id: crypto.randomUUID(),
        session_id: sessionId,
        user_id: userId,
        message_text: text,
      });
    },
    countPendingMessages: async (sessionId) => {
      return countPendingMessages(db, sessionId);
    },
    resumeCloudSession: async (session, prompt) => {
      if (!cloudManager) return "not_found";
      const sessionRow = await db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", session.id)
        .executeTakeFirst();
      if (!sessionRow) return "not_found";
      try {
        const result = await cloudManager.resumeCloudSession(sessionRow as any, prompt);
        // Map CloudManager result to OrchestratorDeps result
        if (result === "not_cloud") return "not_found";
        return result as "resumed" | "expired";
      } catch {
        return "error";
      }
    },
    restartCloudSession: async (session, prompt) => {
      if (!cloudManager) return "failed";
      const sessionRow = await db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", session.id)
        .executeTakeFirst();
      if (!sessionRow) return "failed";
      try {
        const result = await cloudManager.restartCloudSession(sessionRow as any, prompt);
        // Map CloudManager result to OrchestratorDeps result
        if (result === "not_cloud") return "failed";
        return result as "restarted";
      } catch {
        return "failed";
      }
    },
    resumeLocalSession: async (session, prompt) => {
      const sessionRow = await db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", session.id)
        .executeTakeFirst();
      if (!sessionRow) return;
      await sessionManager.resumeSession(sessionRow as any, prompt);
    },
    isCloudSession: async (session) => {
      const run = await getCloudRunBySession(db, session.id);
      return !!run;
    },
    stopCloudSandbox: async (sessionId) => {
      if (!cloudManager) return;
      await cloudManager.stopSandboxForSession(sessionId);
    },
    killLocalSession: async (sessionId, reason) => {
      await sessionManager.killSession(sessionId, reason);
    },
    getSession: async (sessionId) => {
      const row = await db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        status: row.status as any,
        platform: row.platform as any,
        chatId: row.chat_id,
        createdByUserId: row.created_by_user_id,
        workspaceId: row.workspace_id ?? null,
        spaceId: row.space_id ?? null,
        language: row.language as any,
      };
    },
    getCloudRunStatus: async (runId) => {
      if (!cloudManager) return null;
      const run = await db
        .selectFrom("cloud_runs")
        .select(["status"])
        .where("id", "=", runId)
        .executeTakeFirst();
      if (!run) return null;
      return { status: run.status };
    },
  };

  // Create SessionOrchestrator
  const sessionOrchestrator = new SessionOrchestrator(orchestratorDeps, logger);

  // Create WizardOrchestrator
  const wizardOrchestrator = createWizardOrchestrator({
    logger,
    getWizardState: async (platform, chatId, userId) => {
      const row = await getWizardState(db, platform, chatId, userId);
      if (!row) return null;
      return {
        id: row.id,
        agent: row.agent,
        platform: row.platform,
        chatId: row.chat_id,
        userId: row.user_id,
        state: row.state,
        projectId: row.project_id,
        customPathCandidate: row.custom_path_candidate,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    setWizardState: async (record) => {
      await setWizardState(db, {
        id: record.id,
        platform: record.platform,
        chat_id: record.chatId,
        user_id: record.userId,
        agent: record.agent,
        state: record.state,
        project_id: record.projectId,
        custom_path_candidate: record.customPathCandidate,
      });
    },
    clearWizardState: async (platform, chatId, userId) => {
      await clearWizardState(db, platform, chatId, userId);
    },
    getProject,
    getProjects,
    validatePath: async (project, path) => {
      // Simple path validation
      const fs = await import("node:fs/promises");
      const nodePath = await import("node:path");
      const resolvedPath = nodePath.resolve(project.path, path);
      try {
        const stat = await fs.stat(resolvedPath);
        if (!stat.isDirectory()) {
          return { valid: false, resolvedPath: null, error: "Path is not a directory" };
        }
        return { valid: true, resolvedPath };
      } catch {
        return { valid: false, resolvedPath: null, error: "Path does not exist" };
      }
    },
    canStartSession: async (ctx) => {
      // Check session limits
      const count = await db
        .selectFrom("sessions")
        .select(db.fn.countAll().as("count"))
        .where("platform", "=", ctx.platform)
        .where("chat_id", "=", ctx.chatId)
        .where("status", "in", ["running", "starting"])
        .executeTakeFirst();
      const running = Number(count?.count ?? 0);
      const max = config.security.max_concurrent_sessions_per_chat ?? 3;
      if (running >= max) {
        return { allowed: false, error: `Maximum ${max} concurrent sessions allowed` };
      }
      return { allowed: true };
    },
    prepareSessionSpace: forumTopicManager
      ? async (ctx, agent, projectName) => {
          if (ctx.platform !== "telegram" || !forumTopicManager) {
            return { spaceId: ctx.spaceId ?? ctx.chatId, announce: false };
          }
          if (!ctx.telegramChat || typeof ctx.anchorMessageId !== "number") {
            const fallbackSpaceId =
              ctx.spaceId ?? (typeof ctx.anchorMessageId === "number" ? String(ctx.anchorMessageId) : ctx.chatId);
            return { spaceId: fallbackSpaceId, announce: false };
          }
          const result = await forumTopicManager.createSessionSpace({
            chat: ctx.telegramChat,
            projectName,
            anchorMessageId: ctx.anchorMessageId,
            anchorMessageThreadId: ctx.anchorMessageThreadId,
            agent,
            lang: ctx.language,
          });
          return {
            spaceId: result.spaceId,
            announce: result.announce,
            spaceEmoji: result.topicEmoji,
            topicId: result.topicId,
            customEmojiId: result.topicCustomEmojiId,
            projectName,
            agent,
          };
        }
      : undefined,
    startSession: async (ctx, agent, projectPath, prompt) => {
      try {
        // Get project by path
        const project = config.projects.find((p) => p.path === projectPath);
        const projectId = project?.id ?? "custom";

        const sessionId = await sessionManager.startNewSession({
          platform: ctx.platform,
          chatId: ctx.chatId,
          userId: ctx.userId,
          initialPrompt: prompt,
          agent,
          projectId,
          projectPathResolved: projectPath,
          workspaceId: ctx.workspaceId,
          spaceId: ctx.spaceId ?? "",
          spaceEmoji: ctx.spaceEmoji ?? null,
        });
        return { success: true, sessionId };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
    finalizeSessionStart: forumTopicManager
      ? async (ctx, sessionId, spaceResult, prompt) => {
          if (ctx.platform !== "telegram" || !forumTopicManager || !telegram) return;

          if (spaceResult.topicId) {
            await forumTopicManager.pinTopicHeader({
              chatId: ctx.chatId,
              topicId: spaceResult.topicId,
              initialPrompt: prompt,
              sessionId,
              lang: ctx.language,
            });
          }

          if (spaceResult.announce) {
            const emoji = spaceResult.spaceEmoji ?? "";
            const announceText = t("session.started_topic_hint", ctx.language, { emoji });
            const entity =
              spaceResult.customEmojiId && spaceResult.spaceEmoji
                ? buildTelegramCustomEmojiEntity(announceText, spaceResult.spaceEmoji, spaceResult.customEmojiId)
                : null;
            try {
              await telegram.sendMessageSingle({
                chatId: ctx.chatId,
                messageThreadId: ctx.anchorMessageThreadId,
                replyToMessageId: ctx.anchorMessageId,
                text: announceText,
                entities: entity ? [entity] : undefined,
                priority: "user",
              });
            } catch {
              await telegram.sendMessage({
                chatId: ctx.chatId,
                messageThreadId: ctx.anchorMessageThreadId,
                replyToMessageId: ctx.anchorMessageId,
                text: announceText,
                priority: "user",
              });
            }
          }

          if (spaceResult.topicId && spaceResult.spaceEmoji && spaceResult.projectName && spaceResult.agent) {
            void forumTopicManager.updateTopicTitle({
              chatId: ctx.chatId,
              topicId: spaceResult.topicId,
              topicEmoji: spaceResult.spaceEmoji,
              projectName: spaceResult.projectName,
              agent: spaceResult.agent,
            });
          }
        }
      : undefined,
    generateId: () => crypto.randomUUID(),
    nowMs: () => Date.now(),
  });

  // Create CommandOrchestrator
  const commandOrchestrator = createCommandOrchestrator({
    logger,
    config,
    db,
    listSessions: async (opts) => {
      return listSessionsForChat({
        db,
        platform: opts.platform,
        chatId: opts.chatId,
        statuses: opts.statuses,
        page: opts.page,
        limit: opts.limit,
      });
    },
    getOrCreateIdentity: async (ctx) => {
      // Simple stub - return minimal identity
      return {
        id: `${ctx.platform}:${ctx.userId}`,
        keepalive_minutes: null,
        message_verbosity: null,
        branch_name_rule: null,
        git_user_name: null,
        git_user_email: null,
      };
    },
    setUserLanguage: async (platform, userId, lang) => {
      // Use upsert pattern for user language
      try {
        await db
          .insertInto("user_preferences")
          .values({
            id: crypto.randomUUID(),
            platform,
            user_id: userId,
            language: lang,
            created_at: Date.now(),
            updated_at: Date.now(),
          })
          .onConflict((oc) =>
            oc.columns(["platform", "user_id"]).doUpdateSet({
              language: lang,
              updated_at: Date.now(),
            }),
          )
          .execute();
      } catch {
        // Ignore if table doesn't exist - language change will work next time
      }
    },
    getDefaultAgent: () => "codex" as SessionAgent,
    getVersion: () => "1.0.0",
    killSession: async (sessionId, reason) => {
      await sessionManager.killSession(sessionId, reason);
      return true;
    },
    findSession: async (sessionId) => {
      const row = await db
        .selectFrom("sessions")
        .select(["id", "platform", "chat_id"])
        .where("id", "=", sessionId)
        .executeTakeFirst();
      return row ? { id: row.id, platform: row.platform, chat_id: row.chat_id } : null;
    },
  });

  // Create CloudOrchestrator (if cloud enabled)
  const cloudOrchestrator = cloudManager
    ? createCloudOrchestrator({
        logger,
        config,
        db,
        cloudManager,
        telegram,
        slack,
        sendPlatformMessage,
        resolveUserLanguage,
      })
    : undefined;

  const commitProposalOrchestrator = commitProposalStore
    ? new CommitProposalOrchestrator({
        logger,
        db,
        cloudManager,
        commitProposalStore,
        telegram,
        slack,
        sendPlatformMessage,
        resolveUserLanguage,
      })
    : undefined;

  // Helper functions for adapters
  const findActiveSession = async (
    platform: string,
    chatId: string,
    spaceId: string | null,
  ): Promise<SessionInfo | null> => {
    const result = await listSessionsForChat({
      db,
      platform,
      chatId,
      statuses: ["running", "starting"],
      page: 1,
      limit: 1,
    });
    if (result.sessions.length === 0) return null;
    const s = result.sessions[0]!;
    return {
      id: s.id,
      status: s.status as any,
      platform: s.platform as any,
      chatId: s.chat_id,
      createdByUserId: s.created_by_user_id,
      workspaceId: s.workspace_id ?? null,
      spaceId: s.space_id ?? null,
      language: s.language as any,
    };
  };

  const hasActiveWizard = async (
    platform: string,
    chatId: string,
    userId: string,
  ): Promise<boolean> => {
    const state = await getWizardState(db, platform, chatId, userId);
    return state !== null;
  };

  // Create Telegram adapter
  const telegramAdapter = telegram
    ? new TelegramAdapter({
        telegram,
        logger,
        orchestrator: sessionOrchestrator,
        wizardOrchestrator,
        commandOrchestrator,
        cloudOrchestrator,
        commitProposalOrchestrator,
        router,
        forumTopicManager: forumTopicManager ?? undefined,
        getUserLanguage: (userId) => resolveUserLanguage("telegram", userId),
        findActiveSession: (chatId, spaceId) => findActiveSession("telegram", chatId, spaceId),
        hasActiveWizard: async (chatId, spaceId) => {
          // Extract userId from context - this is a limitation
          // For now, check if any wizard state exists for this chat
          const rows = await db
            .selectFrom("wizard_states")
            .select(["id"])
            .where("chat_id", "=", chatId)
            .limit(1)
            .execute();
          return rows.length > 0;
        },
        getProjects,
        cloudEnabled: !!config.cloud?.enabled,
        lookupSessionByReply: deps.lookupTelegramSessionByReply,
      })
    : null;

  // Create Slack adapter
  const slackAdapter = slack
    ? new SlackAdapter({
        slack,
        logger,
        orchestrator: sessionOrchestrator,
        wizardOrchestrator,
        commandOrchestrator,
        cloudOrchestrator,
        commitProposalOrchestrator,
        router,
        getUserLanguage: (userId) => resolveUserLanguage("slack", userId),
        findActiveSession: (chatId, spaceId) => findActiveSession("slack", chatId, spaceId),
        hasActiveWizard: async (chatId, spaceId) => {
          const rows = await db
            .selectFrom("wizard_states")
            .select(["id"])
            .where("chat_id", "=", chatId)
            .limit(1)
            .execute();
          return rows.length > 0;
        },
        getProjects,
        cloudEnabled: !!config.cloud?.enabled,
      })
    : null;

  return {
    telegramAdapter,
    slackAdapter,
  };
}
