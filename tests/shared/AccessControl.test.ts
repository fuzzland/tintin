import { describe, it } from "node:test";
import assert from "node:assert";
import { telegramChatIdMatchesAllowlist } from "../../src/runtime/shared/AccessControl.js";

describe("AccessControl", () => {
  describe("telegramChatIdMatchesAllowlist", () => {
    it("should return true for empty allowlist", () => {
      const result = telegramChatIdMatchesAllowlist("12345", []);
      assert.strictEqual(result, true);
    });

    it("should match exact chat ID", () => {
      const result = telegramChatIdMatchesAllowlist("12345", ["12345"]);
      assert.strictEqual(result, true);
    });

    it("should not match different chat ID", () => {
      const result = telegramChatIdMatchesAllowlist("12345", ["67890"]);
      assert.strictEqual(result, false);
    });

    it("should match supergroup ID with -100 prefix", () => {
      // -100123456789 should match both "123456789" and "-100123456789"
      const result = telegramChatIdMatchesAllowlist("-100123456789", ["123456789"]);
      assert.strictEqual(result, true);
    });

    it("should match group ID with - prefix", () => {
      // -123456 should match both "123456" and "-123456"
      const result = telegramChatIdMatchesAllowlist("-123456", ["123456"]);
      assert.strictEqual(result, true);
    });

    it("should match allowlist entry with -100 prefix", () => {
      const result = telegramChatIdMatchesAllowlist("-100123456789", ["-100123456789"]);
      assert.strictEqual(result, true);
    });

    it("should handle whitespace in chat ID", () => {
      const result = telegramChatIdMatchesAllowlist("  12345  ", ["12345"]);
      assert.strictEqual(result, true);
    });

    it("should handle multiple allowlist entries", () => {
      const result = telegramChatIdMatchesAllowlist("12345", ["67890", "12345", "11111"]);
      assert.strictEqual(result, true);
    });

    it("should return false when no match in multiple entries", () => {
      const result = telegramChatIdMatchesAllowlist("12345", ["67890", "11111", "22222"]);
      assert.strictEqual(result, false);
    });
  });
});
