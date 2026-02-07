import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { CommitProposalOrchestrator } from "../../src/runtime/orchestrator/CommitProposalOrchestrator.js";

describe("CommitProposalOrchestrator", () => {
  it("push action consumes proposal and commits run", async () => {
    const store = {
      getProposal: () => ({
        id: "p1",
        sessionId: "s1",
        platform: "slack",
        chatId: "C1",
        userId: "U1",
        commitMessage: "msg",
        branchName: "b1",
        gitUserName: null,
        gitUserEmail: null,
        summary: "",
      }),
      consumeProposal: mock.fn(),
    };
    const cloud = { commitAndPushRun: mock.fn(async () => {}) };
    const orch = new CommitProposalOrchestrator({
      logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
      db: {
        selectFrom: () => ({
          selectAll: () => ({
            where: () => ({
              executeTakeFirst: async () => ({
                id: "s1",
                platform: "slack",
                chat_id: "C1",
                project_id: "cloud:1",
              }),
            }),
          }),
        }),
      } as any,
      commitProposalStore: store as any,
      cloudManager: cloud as any,
      sendPlatformMessage: mock.fn(async () => {}),
      resolveUserLanguage: async () => "en",
    } as any);
    const result = await orch.handle({
      platform: "slack",
      chatId: "C1",
      userId: "U1",
      workspaceId: "T1",
      proposalId: "p1",
      action: "push",
    });
    assert.strictEqual(result.handled, true);
    assert.strictEqual(cloud.commitAndPushRun.mock.calls.length, 1);
  });
});
