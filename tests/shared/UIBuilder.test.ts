import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildTelegramRunKeyboard,
  buildSlackRunBlocks,
  buildRunActionMarkup,
} from "../../src/runtime/shared/UIBuilder.js";

describe("UIBuilder", () => {
  describe("buildTelegramRunKeyboard", () => {
    it("should build keyboard with stop and status buttons", () => {
      const result = buildTelegramRunKeyboard({
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
      });

      assert.strictEqual(result.inline_keyboard.length, 1);
      assert.strictEqual(result.inline_keyboard[0]!.length, 2);
      assert.strictEqual(result.inline_keyboard[0]![0]!.callback_data, "kill:session-123");
      assert.strictEqual(result.inline_keyboard[0]![1]!.callback_data, "run_status:run-456");
    });

    it("should include view URL button when provided", () => {
      const result = buildTelegramRunKeyboard({
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
        viewUrl: "https://example.com/view",
      });

      assert.strictEqual(result.inline_keyboard.length, 2);
      assert.strictEqual(result.inline_keyboard[1]!.length, 1);
      assert.strictEqual(result.inline_keyboard[1]![0]!.url, "https://example.com/view");
    });

    it("should include vscode URL button when provided", () => {
      const result = buildTelegramRunKeyboard({
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
        vscodeUrl: "https://example.com/vscode",
      });

      assert.strictEqual(result.inline_keyboard.length, 2);
      assert.strictEqual(result.inline_keyboard[1]![0]!.url, "https://example.com/vscode");
    });

    it("should exclude stop button when includeStop is false", () => {
      const result = buildTelegramRunKeyboard({
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
        includeStop: false,
      });

      assert.strictEqual(result.inline_keyboard.length, 1);
      assert.strictEqual(result.inline_keyboard[0]!.length, 1);
      assert.strictEqual(result.inline_keyboard[0]![0]!.callback_data, "run_status:run-456");
    });

    it("should exclude status button when includeStatus is false", () => {
      const result = buildTelegramRunKeyboard({
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
        includeStatus: false,
      });

      assert.strictEqual(result.inline_keyboard.length, 1);
      assert.strictEqual(result.inline_keyboard[0]!.length, 1);
      assert.strictEqual(result.inline_keyboard[0]![0]!.callback_data, "kill:session-123");
    });
  });

  describe("buildSlackRunBlocks", () => {
    it("should build blocks with stop and status buttons", () => {
      const result = buildSlackRunBlocks({
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
      });

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.type, "actions");
      assert.strictEqual(result[0]!.elements.length, 2);
      assert.strictEqual(result[0]!.elements[0]!.action_id, "kill_session");
      assert.strictEqual(result[0]!.elements[0]!.value, "session-123");
      assert.strictEqual(result[0]!.elements[1]!.action_id, "run_status");
      assert.strictEqual(result[0]!.elements[1]!.value, "run-456");
    });

    it("should include view URL button when provided", () => {
      const result = buildSlackRunBlocks({
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
        viewUrl: "https://example.com/view",
      });

      assert.strictEqual(result[0]!.elements.length, 3);
      assert.strictEqual(result[0]!.elements[2]!.action_id, "view_run");
      assert.strictEqual(result[0]!.elements[2]!.url, "https://example.com/view");
    });

    it("should set danger style on stop button", () => {
      const result = buildSlackRunBlocks({
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
      });

      assert.strictEqual(result[0]!.elements[0]!.style, "danger");
    });

    it("should return empty array when no buttons", () => {
      const result = buildSlackRunBlocks({
        sessionId: "session-123",
        lang: "en",
        includeStop: false,
        includeStatus: false,
      });

      assert.strictEqual(result.length, 0);
    });
  });

  describe("buildRunActionMarkup", () => {
    it("should build run action markup for telegram", () => {
      const result = buildRunActionMarkup("telegram", {
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
      });

      assert.strictEqual(result.type, "inline_keyboard");
    });

    it("should build run action markup for slack", () => {
      const result = buildRunActionMarkup("slack", {
        sessionId: "session-123",
        runId: "run-456",
        lang: "en",
      });

      assert.strictEqual(result.type, "blocks");
    });
  });

  // Note: UIBuilder class was removed - use standalone functions directly
});
