import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import {
  WizardOrchestrator,
  createWizardOrchestrator,
} from "../../src/runtime/orchestrator/WizardOrchestrator.js";
import type {
  WizardOrchestratorDeps,
  WizardContext,
  WizardStateRecord,
  ProjectInfo,
} from "../../src/runtime/orchestrator/WizardOrchestrator.js";
import type { Logger } from "../../src/runtime/log.js";

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as Logger;
}

function createMockDeps(overrides: Partial<WizardOrchestratorDeps> = {}): WizardOrchestratorDeps {
  const projects: ProjectInfo[] = [
    { id: "project-1", name: "Project 1", path: "/path/to/project1", allowCustomPath: false },
    { id: "project-2", name: "Project 2", path: "*", allowCustomPath: true },
  ];

  let wizardState: WizardStateRecord | null = null;

  return {
    logger: createMockLogger(),
    getWizardState: mock.fn(async () => wizardState),
    setWizardState: mock.fn(async (record: WizardStateRecord) => {
      wizardState = record;
    }),
    clearWizardState: mock.fn(async () => {
      wizardState = null;
    }),
    getProject: mock.fn((id: string) => projects.find((p) => p.id === id) || null),
    getProjects: mock.fn(() => projects),
    validatePath: mock.fn(async () => ({ valid: true, resolvedPath: "/resolved/path" })),
    canStartSession: mock.fn(async () => ({ allowed: true })),
    startSession: mock.fn(async () => ({ success: true, sessionId: "session-123" })),
    generateId: mock.fn(() => "wizard-id-123"),
    nowMs: mock.fn(() => 1234567890),
    ...overrides,
  };
}

function createWizardContext(overrides: Partial<WizardContext> = {}): WizardContext {
  return {
    platform: "telegram",
    chatId: "chat-123",
    userId: "user-456",
    language: "en",
    workspaceId: null,
    ...overrides,
  };
}

describe("WizardOrchestrator", () => {
  let deps: WizardOrchestratorDeps;
  let orchestrator: WizardOrchestrator;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = createWizardOrchestrator(deps);
  });

  describe("start", () => {
    it("should create wizard state and return await_project", async () => {
      const ctx = createWizardContext();
      const result = await orchestrator.start(ctx, "codex");

      assert.strictEqual(result.state, "await_project");
      assert.strictEqual(result.showProjectKeyboard, true);
      assert.ok(result.message);
    });

    it("should skip to await_prompt if only one fixed-path project", async () => {
      const singleProjectDeps = createMockDeps({
        getProjects: mock.fn(() => [
          { id: "single", name: "Single", path: "/fixed/path", allowCustomPath: false },
        ]),
      });
      const orch = createWizardOrchestrator(singleProjectDeps);
      const ctx = createWizardContext();

      const result = await orch.start(ctx, "codex");

      assert.strictEqual(result.state, "await_initial_prompt");
    });

    it("should return error if cannot start session", async () => {
      const blockedDeps = createMockDeps({
        canStartSession: mock.fn(async () => ({
          allowed: false,
          error: "Max sessions reached",
        })),
      });
      const orch = createWizardOrchestrator(blockedDeps);
      const ctx = createWizardContext();

      const result = await orch.start(ctx, "codex");

      assert.strictEqual(result.state, "error");
      assert.ok(result.error);
    });

    it("should return error if no projects configured", async () => {
      const noProjectsDeps = createMockDeps({
        getProjects: mock.fn(() => []),
      });
      const orch = createWizardOrchestrator(noProjectsDeps);
      const ctx = createWizardContext();

      const result = await orch.start(ctx, "codex");

      assert.strictEqual(result.state, "error");
    });
  });

  describe("handleProjectSelect", () => {
    it("should transition to await_prompt for fixed-path project", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");

      const result = await orchestrator.handleProjectSelect(ctx, "project-1");

      assert.strictEqual(result.state, "await_initial_prompt");
    });

    it("should transition to await_custom_path for custom-path project", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");

      const result = await orchestrator.handleProjectSelect(ctx, "project-2");

      assert.strictEqual(result.state, "await_custom_path");
    });

    it("should return error if no wizard state", async () => {
      const ctx = createWizardContext();
      // Don't start wizard first

      const result = await orchestrator.handleProjectSelect(ctx, "project-1");

      assert.strictEqual(result.state, "error");
    });

    it("should return await_project if invalid project ID", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");

      const result = await orchestrator.handleProjectSelect(ctx, "invalid-project");

      assert.strictEqual(result.state, "await_project");
      assert.strictEqual(result.showProjectKeyboard, true);
    });
  });

  describe("handleCustomPath", () => {
    it("should transition to await_prompt with valid path", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");
      await orchestrator.handleProjectSelect(ctx, "project-2");

      const result = await orchestrator.handleCustomPath(ctx, "/custom/path");

      assert.strictEqual(result.state, "await_initial_prompt");
    });

    it("should return error for invalid path", async () => {
      const invalidPathDeps = createMockDeps({
        validatePath: mock.fn(async () => ({
          valid: false,
          resolvedPath: null,
          error: "Path not allowed",
        })),
      });
      const orch = createWizardOrchestrator(invalidPathDeps);
      const ctx = createWizardContext();
      await orch.start(ctx, "codex");
      await orch.handleProjectSelect(ctx, "project-2");

      const result = await orch.handleCustomPath(ctx, "/invalid/path");

      assert.strictEqual(result.state, "await_custom_path");
      assert.ok(result.message.includes("Path") || result.message.includes("path"));
    });

    it("should return error if not in await_custom_path state", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");
      // Still in await_project state

      const result = await orchestrator.handleCustomPath(ctx, "/some/path");

      assert.strictEqual(result.state, "error");
    });
  });

  describe("handlePrompt", () => {
    it("should start session and return completed", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");
      await orchestrator.handleProjectSelect(ctx, "project-1");

      const result = await orchestrator.handlePrompt(ctx, "Fix the bug");

      assert.strictEqual(result.state, "completed");
      assert.strictEqual(result.sessionId, "session-123");
    });

    it("should clear wizard state after completion", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");
      await orchestrator.handleProjectSelect(ctx, "project-1");
      await orchestrator.handlePrompt(ctx, "Fix the bug");

      const state = await orchestrator.getState(ctx);
      assert.strictEqual(state, null);
    });

    it("should return error if session start fails", async () => {
      const failedStartDeps = createMockDeps({
        startSession: mock.fn(async () => ({
          success: false,
          error: "Session start failed",
        })),
      });
      const orch = createWizardOrchestrator(failedStartDeps);
      const ctx = createWizardContext();
      await orch.start(ctx, "codex");
      await orch.handleProjectSelect(ctx, "project-1");

      const result = await orch.handlePrompt(ctx, "Fix the bug");

      assert.strictEqual(result.state, "error");
    });

    it("should return error if not in await_initial_prompt state", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");
      // Still in await_project state

      const result = await orchestrator.handlePrompt(ctx, "Fix the bug");

      assert.strictEqual(result.state, "error");
    });
  });

  describe("continue", () => {
    it("should return project buttons hint when in await_project", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");

      const result = await orchestrator.continue(ctx, "some text");

      assert.strictEqual(result.state, "await_project");
      assert.strictEqual(result.showProjectKeyboard, true);
    });

    it("should handle custom path input", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");
      await orchestrator.handleProjectSelect(ctx, "project-2");

      const result = await orchestrator.continue(ctx, "/custom/path");

      assert.strictEqual(result.state, "await_initial_prompt");
    });

    it("should handle prompt input", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");
      await orchestrator.handleProjectSelect(ctx, "project-1");

      const result = await orchestrator.continue(ctx, "Fix the bug");

      assert.strictEqual(result.state, "completed");
      assert.strictEqual(result.sessionId, "session-123");
    });

    it("should return error if no wizard state", async () => {
      const ctx = createWizardContext();

      const result = await orchestrator.continue(ctx, "some text");

      assert.strictEqual(result.state, "error");
    });
  });

  describe("getState", () => {
    it("should return current wizard state", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");

      const state = await orchestrator.getState(ctx);

      assert.strictEqual(state, "await_project");
    });

    it("should return null if no wizard state", async () => {
      const ctx = createWizardContext();

      const state = await orchestrator.getState(ctx);

      assert.strictEqual(state, null);
    });
  });

  describe("clear", () => {
    it("should clear wizard state", async () => {
      const ctx = createWizardContext();
      await orchestrator.start(ctx, "codex");
      await orchestrator.clear(ctx);

      const state = await orchestrator.getState(ctx);

      assert.strictEqual(state, null);
    });
  });
});
