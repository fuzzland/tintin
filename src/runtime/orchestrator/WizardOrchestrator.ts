/**
 * WizardOrchestrator - Handles new session creation wizard flow.
 *
 * The wizard guides users through:
 * 1. Project selection (or use default)
 * 2. Custom path input (if project allows)
 * 3. Initial prompt capture
 * 4. Session creation
 */

import type { UserLanguage } from "../../locales/index.js";
import { t } from "../../locales/index.js";
import type { SessionAgent, WizardState } from "../db.js";
import type { Logger } from "../log.js";
import type { SessionPlatform } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Wizard context from the caller.
 */
export interface WizardContext {
  platform: SessionPlatform;
  chatId: string;
  userId: string;
  language: UserLanguage;
  workspaceId: string | null;
  /** For Telegram forum topics */
  spaceId?: string | null;
}

/**
 * Project entry from config.
 */
export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  allowCustomPath: boolean;
}

/**
 * Wizard state stored in database.
 */
export interface WizardStateRecord {
  id: string;
  agent: SessionAgent;
  platform: string;
  chatId: string;
  userId: string;
  state: WizardState;
  projectId: string | null;
  customPathCandidate: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Result of a wizard operation.
 */
export interface WizardResult {
  /** Current wizard state or 'completed' if session started */
  state: WizardState | "completed" | "error";
  /** Message to display to user */
  message: string;
  /** Whether to show project selection keyboard */
  showProjectKeyboard?: boolean;
  /** Session ID if wizard completed and session started */
  sessionId?: string;
  /** Error message if state is 'error' */
  error?: string;
}

/**
 * Path validation result.
 */
export interface PathValidationResult {
  valid: boolean;
  resolvedPath: string | null;
  error?: string;
}

/**
 * Session start result.
 */
export interface SessionStartResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

// ============================================================================
// Dependencies
// ============================================================================

export interface WizardOrchestratorDeps {
  logger: Logger;

  /** Get current wizard state for user */
  getWizardState: (
    platform: string,
    chatId: string,
    userId: string,
  ) => Promise<WizardStateRecord | null>;

  /** Save wizard state */
  setWizardState: (record: WizardStateRecord) => Promise<void>;

  /** Clear wizard state */
  clearWizardState: (platform: string, chatId: string, userId: string) => Promise<void>;

  /** Get project by ID */
  getProject: (projectId: string) => ProjectInfo | null;

  /** Get list of available projects */
  getProjects: () => ProjectInfo[];

  /** Validate and resolve a custom path */
  validatePath: (project: ProjectInfo, path: string) => Promise<PathValidationResult>;

  /** Check if a new session can be started */
  canStartSession: (ctx: WizardContext) => Promise<{ allowed: boolean; error?: string }>;

  /** Start a new session */
  startSession: (
    ctx: WizardContext,
    agent: SessionAgent,
    projectPath: string,
    prompt: string,
  ) => Promise<SessionStartResult>;

  /** Generate a unique ID */
  generateId: () => string;

  /** Get current timestamp in milliseconds */
  nowMs: () => number;
}

// ============================================================================
// WizardOrchestrator Implementation
// ============================================================================

export class WizardOrchestrator {
  constructor(private readonly deps: WizardOrchestratorDeps) {}

  /**
   * Start a new wizard session.
   */
  async start(ctx: WizardContext, agent: SessionAgent): Promise<WizardResult> {
    const { platform, chatId, userId, language } = ctx;

    // Check if can start a session
    const canStart = await this.deps.canStartSession(ctx);
    if (!canStart.allowed) {
      return {
        state: "error",
        message: canStart.error || t("error.generic", language, { message: "Cannot start session" }),
        error: canStart.error,
      };
    }

    // Get available projects
    const projects = this.deps.getProjects();

    if (projects.length === 0) {
      return {
        state: "error",
        message: t("error.generic", language, { message: "No projects configured" }),
        error: "No projects configured",
      };
    }

    // If only one project and it has a fixed path, skip to prompt
    if (projects.length === 1 && !projects[0]!.allowCustomPath) {
      const project = projects[0]!;
      return this.transitionToAwaitPrompt(ctx, agent, project.id, null);
    }

    // Create wizard state for project selection
    const record: WizardStateRecord = {
      id: this.deps.generateId(),
      agent,
      platform,
      chatId,
      userId,
      state: "await_project",
      projectId: null,
      customPathCandidate: null,
      createdAt: this.deps.nowMs(),
      updatedAt: this.deps.nowMs(),
    };

    await this.deps.setWizardState(record);

    return {
      state: "await_project",
      message: t("wizard.choose_project", language),
      showProjectKeyboard: true,
    };
  }

  /**
   * Handle project selection.
   */
  async handleProjectSelect(
    ctx: WizardContext,
    projectId: string,
  ): Promise<WizardResult> {
    const { platform, chatId, userId, language } = ctx;

    // Get current wizard state
    const wizard = await this.deps.getWizardState(platform, chatId, userId);
    if (!wizard) {
      return {
        state: "error",
        message: t("wizard.expired", language),
        error: "No active wizard session",
      };
    }

    // Get the project
    const project = this.deps.getProject(projectId);
    if (!project) {
      return {
        state: "await_project",
        message: t("wizard.choose_project_buttons", language),
        showProjectKeyboard: true,
      };
    }

    // Transition based on project type
    if (project.allowCustomPath) {
      return this.transitionToAwaitCustomPath(ctx, wizard.agent, projectId);
    } else {
      return this.transitionToAwaitPrompt(ctx, wizard.agent, projectId, null);
    }
  }

  /**
   * Handle custom path input.
   */
  async handleCustomPath(
    ctx: WizardContext,
    path: string,
  ): Promise<WizardResult> {
    const { platform, chatId, userId, language } = ctx;

    // Get current wizard state
    const wizard = await this.deps.getWizardState(platform, chatId, userId);
    if (!wizard || wizard.state !== "await_custom_path") {
      return {
        state: "error",
        message: t("wizard.expired", language),
        error: "Invalid wizard state",
      };
    }

    // Get the project
    const project = this.deps.getProject(wizard.projectId!);
    if (!project) {
      return {
        state: "error",
        message: t("wizard.expired", language),
        error: "Project not found",
      };
    }

    // Validate the path
    const validation = await this.deps.validatePath(project, path);
    if (!validation.valid) {
      return {
        state: "await_custom_path",
        message: validation.error || t("wizard.path_invalid", language),
      };
    }

    return this.transitionToAwaitPrompt(ctx, wizard.agent, wizard.projectId!, validation.resolvedPath);
  }

  /**
   * Handle initial prompt and start session.
   */
  async handlePrompt(
    ctx: WizardContext,
    prompt: string,
  ): Promise<WizardResult> {
    const { platform, chatId, userId, language } = ctx;

    // Get current wizard state
    const wizard = await this.deps.getWizardState(platform, chatId, userId);
    if (!wizard || wizard.state !== "await_initial_prompt") {
      return {
        state: "error",
        message: t("wizard.expired", language),
        error: "Invalid wizard state",
      };
    }

    // Get the project
    const project = this.deps.getProject(wizard.projectId!);
    if (!project) {
      return {
        state: "error",
        message: t("wizard.expired", language),
        error: "Project not found",
      };
    }

    // Determine the project path
    const projectPath = wizard.customPathCandidate || project.path;

    // Start the session
    const result = await this.deps.startSession(ctx, wizard.agent, projectPath, prompt);

    // Clear wizard state
    await this.deps.clearWizardState(platform, chatId, userId);

    if (!result.success) {
      return {
        state: "error",
        message: result.error || t("session.error", language, { error: "Failed to start" }),
        error: result.error,
      };
    }

    return {
      state: "completed",
      message: t("session.starting", language),
      sessionId: result.sessionId,
    };
  }

  /**
   * Continue wizard based on current state.
   * Called when user sends a message while in wizard mode.
   */
  async continue(ctx: WizardContext, text: string): Promise<WizardResult> {
    const { platform, chatId, userId, language } = ctx;

    // Get current wizard state
    const wizard = await this.deps.getWizardState(platform, chatId, userId);
    if (!wizard) {
      return {
        state: "error",
        message: t("wizard.expired", language),
        error: "No active wizard session",
      };
    }

    switch (wizard.state) {
      case "await_project":
        // User should click a button, not type
        return {
          state: "await_project",
          message: t("wizard.choose_project_buttons", language),
          showProjectKeyboard: true,
        };

      case "await_custom_path":
        return this.handleCustomPath(ctx, text);

      case "await_initial_prompt":
        return this.handlePrompt(ctx, text);

      default:
        return {
          state: "error",
          message: t("wizard.expired", language),
          error: `Unknown wizard state: ${wizard.state}`,
        };
    }
  }

  /**
   * Get current wizard state for a user.
   */
  async getState(ctx: WizardContext): Promise<WizardState | null> {
    const wizard = await this.deps.getWizardState(ctx.platform, ctx.chatId, ctx.userId);
    return wizard?.state || null;
  }

  /**
   * Clear wizard state for a user.
   */
  async clear(ctx: WizardContext): Promise<void> {
    await this.deps.clearWizardState(ctx.platform, ctx.chatId, ctx.userId);
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private async transitionToAwaitCustomPath(
    ctx: WizardContext,
    agent: SessionAgent,
    projectId: string,
  ): Promise<WizardResult> {
    const { platform, chatId, userId, language } = ctx;

    const record: WizardStateRecord = {
      id: this.deps.generateId(),
      agent,
      platform,
      chatId,
      userId,
      state: "await_custom_path",
      projectId,
      customPathCandidate: null,
      createdAt: this.deps.nowMs(),
      updatedAt: this.deps.nowMs(),
    };

    await this.deps.setWizardState(record);

    return {
      state: "await_custom_path",
      message: t("wizard.send_custom_path", language),
    };
  }

  private async transitionToAwaitPrompt(
    ctx: WizardContext,
    agent: SessionAgent,
    projectId: string,
    customPath: string | null,
  ): Promise<WizardResult> {
    const { platform, chatId, userId, language } = ctx;

    const record: WizardStateRecord = {
      id: this.deps.generateId(),
      agent,
      platform,
      chatId,
      userId,
      state: "await_initial_prompt",
      projectId,
      customPathCandidate: customPath,
      createdAt: this.deps.nowMs(),
      updatedAt: this.deps.nowMs(),
    };

    await this.deps.setWizardState(record);

    return {
      state: "await_initial_prompt",
      message: t("wizard.send_prompt", language),
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createWizardOrchestrator(deps: WizardOrchestratorDeps): WizardOrchestrator {
  return new WizardOrchestrator(deps);
}
