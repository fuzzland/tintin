import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { SlackAdapter } from "../../src/runtime/adapters/SlackAdapter.js";

describe("SlackAdapter view_submission", () => {
  it("routes view_submission to wizard modal handler", async () => {
    const wizardOrchestrator = {
      handleModalSubmission: mock.fn(async () => ({ state: "completed", message: "ok" })),
    };
    const slack = { postMessage: mock.fn(async () => "123.456") };
    const adapter = new SlackAdapter({
      slack: slack as any,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
      wizardOrchestrator,
    } as any);
    const payload = {
      type: "view_submission",
      view: {
        callback_id: "codex_wizard",
        private_metadata: JSON.stringify({
          projectId: "demo",
          channelId: "C1",
          userId: "U1",
          teamId: "T1",
        }),
        state: { values: { prompt: { input: { value: "hi" } } } },
      },
    };
    const result = await adapter.handleInteractionPayload(payload);
    assert.strictEqual(result.handled, true);
    assert.strictEqual(wizardOrchestrator.handleModalSubmission.mock.calls.length, 1);
  });
});
