import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { WizardOrchestrator } from "../../src/runtime/orchestrator/WizardOrchestrator.js";

describe("WizardOrchestrator.handleModalSubmission", () => {
  it("starts session with project + prompt", async () => {
    const startSession = mock.fn(async () => ({ success: true, sessionId: "s1" }));
    const wizard = new WizardOrchestrator({
      logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
      getWizardState: async () => null,
      setWizardState: async () => {},
      clearWizardState: async () => {},
      getProject: (id: string) => ({ id, name: "Demo", path: "/repo", allowCustomPath: false }),
      getProjects: () => [],
      validatePath: async () => ({ valid: true, resolvedPath: "/repo" }),
      canStartSession: async () => ({ allowed: true }),
      startSession,
      generateId: () => "w1",
      nowMs: () => Date.now(),
    } as any);
    const result = await (wizard as any).handleModalSubmission(
      { platform: "slack", chatId: "C1", userId: "U1", language: "en", workspaceId: "T1", spaceId: "C1" },
      { projectId: "demo", customPath: null, prompt: "hi" },
    );
    assert.strictEqual(result.state, "completed");
    assert.strictEqual(startSession.mock.calls.length, 1);
  });
});
