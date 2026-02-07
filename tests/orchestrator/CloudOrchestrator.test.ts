import { describe, it } from "node:test";
import assert from "node:assert";
import { CloudOrchestrator } from "../../src/runtime/orchestrator/CloudOrchestrator.js";

describe("CloudOrchestrator", () => {
  it("handles /status without CloudHandler", async () => {
    const orch = new CloudOrchestrator({
      logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
      config: { cloud: { enabled: false } } as any,
      db: {} as any,
      cloudManager: null,
      telegram: null,
      slack: null,
      sendPlatformMessage: async () => {},
      resolveUserLanguage: async () => "en",
    });
    const result = await orch.handle(
      {
        platform: "telegram",
        chatId: "1",
        userId: "u1",
        language: "en",
        workspaceId: null,
        isDirect: true,
        spaceId: "1",
      },
      { kind: "setup_status" } as any,
    );
    assert.strictEqual(result.handled, true);
  });
});
