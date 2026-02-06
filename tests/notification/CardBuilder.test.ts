import { describe, it } from "node:test";
import assert from "node:assert";
import { CardBuilder } from "../../src/runtime/notification/CardBuilder.js";

describe("CardBuilder", () => {
  describe("parseDiffStats", () => {
    it("should parse diff summary with all components", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const stats = builder.parseDiffStats("3 files changed, 45 insertions(+), 12 deletions(-)");

      assert.deepStrictEqual(stats, {
        filesChanged: 3,
        additions: 45,
        deletions: 12,
      });
    });

    it("should parse diff summary with single file", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const stats = builder.parseDiffStats("1 file changed, 10 insertions(+), 5 deletions(-)");

      assert.deepStrictEqual(stats, {
        filesChanged: 1,
        additions: 10,
        deletions: 5,
      });
    });

    it("should parse diff with only insertions", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const stats = builder.parseDiffStats("2 files changed, 100 insertions(+)");

      assert.deepStrictEqual(stats, {
        filesChanged: 2,
        additions: 100,
        deletions: 0,
      });
    });

    it("should parse diff with only deletions", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const stats = builder.parseDiffStats("1 file changed, 50 deletions(-)");

      assert.deepStrictEqual(stats, {
        filesChanged: 1,
        additions: 0,
        deletions: 50,
      });
    });

    it("should return null for invalid diff", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const stats = builder.parseDiffStats("invalid");
      assert.strictEqual(stats, null);
    });

    it("should return null for empty string", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const stats = builder.parseDiffStats("");
      assert.strictEqual(stats, null);
    });
  });

  describe("extractTitle", () => {
    it("should return short prompts unchanged", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const title = builder.extractTitle("Fix login bug");
      assert.strictEqual(title, "Fix login bug");
    });

    it("should truncate long prompts", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const longPrompt = "Fix the authentication bug in the login flow that causes users to be logged out unexpectedly when they refresh the page";
      const title = builder.extractTitle(longPrompt);

      assert.ok(title.length <= 53); // 50 + "..."
      assert.ok(title.endsWith("..."));
    });

    it("should use custom maxLength", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const title = builder.extractTitle("This is a somewhat longer prompt text", 20);

      assert.ok(title.length <= 20);
      assert.ok(title.endsWith("..."));
    });

    it("should use first line of multiline prompt", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const multilinePrompt = "Fix the bug\nThis is additional context\nAnd more details";
      const title = builder.extractTitle(multilinePrompt);

      assert.strictEqual(title, "Fix the bug");
    });

    it("should trim whitespace", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const title = builder.extractTitle("  Fix the bug  ");
      assert.strictEqual(title, "Fix the bug");
    });
  });

  describe("buildViewUrl", () => {
    it("should build correct view URL", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const url = builder.buildViewUrl("run-123");
      assert.strictEqual(url, "https://example.com/run/run-123");
    });

    it("should handle trailing slash in base URL", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com/",
      });

      const url = builder.buildViewUrl("run-456");
      assert.strictEqual(url, "https://example.com/run/run-456");
    });
  });

  describe("buildScreenshotUrl", () => {
    it("should build correct screenshot URL", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const url = builder.buildScreenshotUrl("screenshots/abc123.png");
      assert.strictEqual(url, "https://example.com/api/screenshots/screenshots/abc123.png");
    });

    it("should return null for null input", () => {
      const builder = new CardBuilder({
        publicBaseUrl: "https://example.com",
      });

      const url = builder.buildScreenshotUrl(null);
      assert.strictEqual(url, null);
    });
  });
});
