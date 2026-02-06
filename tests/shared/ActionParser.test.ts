import { describe, it } from "node:test";
import assert from "node:assert";
import { parseTelegramAction, parseSlackAction, ActionParser } from "../../src/runtime/shared/ActionParser.js";

describe("ActionParser", () => {
  describe("parseTelegramAction", () => {
    it("should parse lang action", () => {
      const result = parseTelegramAction("lang:en");
      assert.deepStrictEqual(result, { kind: "lang", value: "en" });
    });

    it("should parse lang action with zh", () => {
      const result = parseTelegramAction("lang:zh");
      assert.deepStrictEqual(result, { kind: "lang", value: "zh" });
    });

    it("should return null for invalid lang value", () => {
      const result = parseTelegramAction("lang:invalid");
      assert.strictEqual(result, null);
    });

    it("should parse kill action", () => {
      const result = parseTelegramAction("kill:session-123");
      assert.deepStrictEqual(result, { kind: "kill", sessionId: "session-123" });
    });

    it("should parse review action", () => {
      const result = parseTelegramAction("review:session-456");
      assert.deepStrictEqual(result, { kind: "review", sessionId: "session-456" });
    });

    it("should parse commit action", () => {
      const result = parseTelegramAction("commit:session-789");
      assert.deepStrictEqual(result, { kind: "commit", sessionId: "session-789" });
    });

    it("should parse run_status action", () => {
      const result = parseTelegramAction("run_status:run-abc");
      assert.deepStrictEqual(result, { kind: "run_status", runId: "run-abc" });
    });

    it("should parse stop_sandbox action", () => {
      const result = parseTelegramAction("stop_sandbox:session-xyz");
      assert.deepStrictEqual(result, { kind: "stop_sandbox", sessionId: "session-xyz" });
    });

    it("should parse cpr cancel action", () => {
      const result = parseTelegramAction("cpr:proposal-id:cancel");
      assert.deepStrictEqual(result, { kind: "commit_proposal", proposalId: "proposal-id", action: "cancel" });
    });

    it("should parse cpr push action", () => {
      const result = parseTelegramAction("cpr:proposal-id:push");
      assert.deepStrictEqual(result, { kind: "commit_proposal", proposalId: "proposal-id", action: "push" });
    });

    it("should parse cpr pr action", () => {
      const result = parseTelegramAction("cpr:proposal-id:pr");
      assert.deepStrictEqual(result, { kind: "commit_proposal", proposalId: "proposal-id", action: "pr" });
    });

    it("should return null for invalid cpr action", () => {
      const result = parseTelegramAction("cpr:proposal-id:invalid");
      assert.strictEqual(result, null);
    });

    it("should return null for empty string", () => {
      const result = parseTelegramAction("");
      assert.strictEqual(result, null);
    });

    it("should return null for unknown action", () => {
      const result = parseTelegramAction("unknown:value");
      assert.strictEqual(result, null);
    });
  });

  describe("parseSlackAction", () => {
    it("should parse switch_language action", () => {
      const result = parseSlackAction("switch_language", "en");
      assert.deepStrictEqual(result, { kind: "lang", value: "en" });
    });

    it("should return null for invalid language", () => {
      const result = parseSlackAction("switch_language", "invalid");
      assert.strictEqual(result, null);
    });

    it("should parse kill_session action", () => {
      const result = parseSlackAction("kill_session", "session-123");
      assert.deepStrictEqual(result, { kind: "kill", sessionId: "session-123" });
    });

    it("should parse review_session action", () => {
      const result = parseSlackAction("review_session", "session-456");
      assert.deepStrictEqual(result, { kind: "review", sessionId: "session-456" });
    });

    it("should parse commit_session action", () => {
      const result = parseSlackAction("commit_session", "session-789");
      assert.deepStrictEqual(result, { kind: "commit", sessionId: "session-789" });
    });

    it("should parse run_status action", () => {
      const result = parseSlackAction("run_status", "run-abc");
      assert.deepStrictEqual(result, { kind: "run_status", runId: "run-abc" });
    });

    it("should parse stop_sandbox action", () => {
      const result = parseSlackAction("stop_sandbox", "session-xyz");
      assert.deepStrictEqual(result, { kind: "stop_sandbox", sessionId: "session-xyz" });
    });

    it("should parse commit_cancel action", () => {
      const result = parseSlackAction("commit_cancel", "proposal-id");
      assert.deepStrictEqual(result, { kind: "commit_proposal", proposalId: "proposal-id", action: "cancel" });
    });

    it("should parse commit_push action", () => {
      const result = parseSlackAction("commit_push", "proposal-id");
      assert.deepStrictEqual(result, { kind: "commit_proposal", proposalId: "proposal-id", action: "push" });
    });

    it("should parse commit_pr action", () => {
      const result = parseSlackAction("commit_pr", "proposal-id");
      assert.deepStrictEqual(result, { kind: "commit_proposal", proposalId: "proposal-id", action: "pr" });
    });

    it("should return null for empty actionId", () => {
      const result = parseSlackAction("", "value");
      assert.strictEqual(result, null);
    });

    it("should return null for unknown action", () => {
      const result = parseSlackAction("unknown_action", "value");
      assert.strictEqual(result, null);
    });
  });

  describe("ActionParser class", () => {
    it("should parse Telegram actions via class method", () => {
      const parser = new ActionParser();
      const result = parser.fromTelegram("kill:session-123");
      assert.deepStrictEqual(result, { kind: "kill", sessionId: "session-123" });
    });

    it("should parse Slack actions via class method", () => {
      const parser = new ActionParser();
      const result = parser.fromSlack("kill_session", "session-123");
      assert.deepStrictEqual(result, { kind: "kill", sessionId: "session-123" });
    });
  });
});
