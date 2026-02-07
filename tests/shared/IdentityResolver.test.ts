import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseWebSocketIdentity,
  createAnonymousIdentity,
} from "../../src/runtime/shared/IdentityResolver.js";

describe("IdentityResolver utilities", () => {
  describe("parseWebSocketIdentity", () => {
    it("should remove ws: prefix", () => {
      const result = parseWebSocketIdentity("ws:anonymous:abc123");
      assert.strictEqual(result, "anonymous:abc123");
    });

    it("should remove ws: prefix for token identity", () => {
      const result = parseWebSocketIdentity("ws:token-xyz");
      assert.strictEqual(result, "token-xyz");
    });

    it("should return unchanged if no ws: prefix", () => {
      const result = parseWebSocketIdentity("no-prefix-identity");
      assert.strictEqual(result, "no-prefix-identity");
    });

    it("should handle empty string", () => {
      const result = parseWebSocketIdentity("");
      assert.strictEqual(result, "");
    });

    it("should handle ws: only", () => {
      const result = parseWebSocketIdentity("ws:");
      assert.strictEqual(result, "");
    });
  });

  describe("createAnonymousIdentity", () => {
    it("should create proper anonymous identity format", () => {
      const result = createAnonymousIdentity("connection-id-12345");
      assert.strictEqual(result, "ws:anonymous:connecti");
    });

    it("should truncate connection ID to 8 characters", () => {
      const result = createAnonymousIdentity("abcdefghijklmnop");
      assert.strictEqual(result, "ws:anonymous:abcdefgh");
    });

    it("should handle short connection ID", () => {
      const result = createAnonymousIdentity("abc");
      assert.strictEqual(result, "ws:anonymous:abc");
    });

    it("should handle empty connection ID", () => {
      const result = createAnonymousIdentity("");
      assert.strictEqual(result, "ws:anonymous:");
    });
  });
});
