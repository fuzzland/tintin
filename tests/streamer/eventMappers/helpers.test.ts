import test from "node:test";
import assert from "node:assert/strict";
import {
  stringOrEmpty,
  numberOrNull,
  firstNonEmptyString,
  safeJson,
  truncateJson,
  truncateLogLine,
  normalizeMessageVerbosity,
  formatTitledText,
  formatCommand,
  decodeBase64ToString,
  normalizeAgentMessage,
  extractTitleFromPayload,
  getTextFromContentItems,
  extractMcpResultText,
  extractCommandFromToolArgs,
} from "../../../src/runtime/streamer/eventMappers/helpers.js";

test("stringOrEmpty", async (t) => {
  await t.test("should return string for string input", () => {
    assert.equal(stringOrEmpty("hello"), "hello");
    assert.equal(stringOrEmpty(""), "");
  });

  await t.test("should return empty string for non-string", () => {
    assert.equal(stringOrEmpty(null), "");
    assert.equal(stringOrEmpty(undefined), "");
    assert.equal(stringOrEmpty(123), "");
    assert.equal(stringOrEmpty({}), "");
  });
});

test("numberOrNull", async (t) => {
  await t.test("should return number for number input", () => {
    assert.equal(numberOrNull(42), 42);
    assert.equal(numberOrNull(0), 0);
    assert.equal(numberOrNull(-5), -5);
  });

  await t.test("should return null for non-number", () => {
    assert.equal(numberOrNull("42"), null);
    assert.equal(numberOrNull(null), null);
    assert.equal(numberOrNull(undefined), null);
  });
});

test("firstNonEmptyString", async (t) => {
  await t.test("should return first non-empty string", () => {
    assert.equal(firstNonEmptyString(["", "hello", "world"]), "hello");
    assert.equal(firstNonEmptyString([null, undefined, "test"]), "test");
  });

  await t.test("should return empty string when none found", () => {
    assert.equal(firstNonEmptyString([null, "", undefined]), "");
    assert.equal(firstNonEmptyString([]), "");
  });

  await t.test("should skip whitespace-only strings", () => {
    assert.equal(firstNonEmptyString(["  ", "\t", "valid"]), "valid");
  });
});

test("safeJson", async (t) => {
  await t.test("should stringify valid JSON", () => {
    assert.equal(safeJson({ a: 1 }), '{"a":1}');
    assert.equal(safeJson([1, 2, 3]), "[1,2,3]");
  });

  await t.test("should handle circular references", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    // Should not throw, should return string representation
    const result = safeJson(circular);
    assert.equal(typeof result, "string");
  });
});

test("truncateJson", async (t) => {
  await t.test("should not truncate short JSON", () => {
    assert.equal(truncateJson({ a: 1 }), '{"a":1}');
  });

  await t.test("should truncate long JSON", () => {
    const long = { data: "x".repeat(500) };
    const result = truncateJson(long, 100);
    assert.ok(result.endsWith("..."));
    assert.ok(result.length <= 103); // 100 + "..."
  });
});

test("truncateLogLine", async (t) => {
  await t.test("should not truncate short text", () => {
    assert.equal(truncateLogLine("short", 100), "short");
  });

  await t.test("should truncate long text", () => {
    const result = truncateLogLine("this is a long line", 10);
    assert.equal(result, "this is a ...");
  });

  await t.test("should handle empty text", () => {
    assert.equal(truncateLogLine("", 10), "");
  });
});

test("normalizeMessageVerbosity", async (t) => {
  await t.test("should return exact values 1, 2, 3", () => {
    assert.equal(normalizeMessageVerbosity(1), 1);
    assert.equal(normalizeMessageVerbosity(2), 2);
    assert.equal(normalizeMessageVerbosity(3), 3);
  });

  await t.test("should normalize low values to 1", () => {
    assert.equal(normalizeMessageVerbosity(0), 1);
    assert.equal(normalizeMessageVerbosity(-5), 1);
  });

  await t.test("should normalize values between 1 and 2 to 2", () => {
    assert.equal(normalizeMessageVerbosity(1.5), 2);
  });

  await t.test("should default to 3 for invalid values", () => {
    assert.equal(normalizeMessageVerbosity(undefined), 3);
    assert.equal(normalizeMessageVerbosity("high"), 3);
    assert.equal(normalizeMessageVerbosity(5), 3);
  });
});

test("formatTitledText", async (t) => {
  await t.test("should format with inline body", () => {
    const result = formatTitledText("Title", "body text");
    assert.equal(result, "*Title* body text");
  });

  await t.test("should format multiline body with newline", () => {
    const result = formatTitledText("Title", "line1\nline2");
    assert.equal(result, "*Title*\nline1\nline2");
  });

  await t.test("should handle empty body", () => {
    assert.equal(formatTitledText("Title", null), "*Title*");
    assert.equal(formatTitledText("Title", ""), "*Title*");
  });

  await t.test("should respect inline option", () => {
    const result = formatTitledText("Title", "body", { inline: false });
    assert.equal(result, "*Title*\nbody");
  });
});

test("formatCommand", async (t) => {
  await t.test("should return string command as-is", () => {
    assert.equal(formatCommand("ls -la"), "ls -la");
  });

  await t.test("should join array commands", () => {
    assert.equal(formatCommand(["ls", "-la", "/tmp"]), "ls -la /tmp");
  });

  await t.test("should return empty for other types", () => {
    assert.equal(formatCommand(null), "");
    assert.equal(formatCommand(123), "");
  });
});

test("decodeBase64ToString", async (t) => {
  await t.test("should decode valid base64", () => {
    const encoded = Buffer.from("hello world").toString("base64");
    assert.equal(decodeBase64ToString(encoded), "hello world");
  });

  await t.test("should return null for non-string", () => {
    assert.equal(decodeBase64ToString(123), null);
    assert.equal(decodeBase64ToString(null), null);
  });
});

test("normalizeAgentMessage", async (t) => {
  await t.test("should extract message field", () => {
    assert.equal(normalizeAgentMessage({ message: "hello" }), "hello");
  });

  await t.test("should extract text field", () => {
    assert.equal(normalizeAgentMessage({ text: "hello" }), "hello");
  });

  await t.test("should extract content field", () => {
    assert.equal(normalizeAgentMessage({ content: "hello" }), "hello");
  });

  await t.test("should prefer message over text over content", () => {
    assert.equal(normalizeAgentMessage({ message: "msg", text: "txt", content: "cnt" }), "msg");
    assert.equal(normalizeAgentMessage({ text: "txt", content: "cnt" }), "txt");
  });

  await t.test("should return null for empty or invalid", () => {
    assert.equal(normalizeAgentMessage(null), null);
    assert.equal(normalizeAgentMessage({}), null);
    assert.equal(normalizeAgentMessage({ message: "" }), null);
  });
});

test("extractTitleFromPayload", async (t) => {
  await t.test("should extract title from agent_reasoning", () => {
    const result = extractTitleFromPayload({
      type: "agent_reasoning",
      text: "**My Title** Some content here",
    });
    assert.equal(result.title, "My Title");
    assert.equal(result.content, "Some content here");
  });

  await t.test("should return nulls for non-agent_reasoning", () => {
    const result = extractTitleFromPayload({
      type: "other",
      text: "**Title** Content",
    });
    assert.equal(result.title, null);
    assert.equal(result.content, null);
  });

  await t.test("should handle text without title", () => {
    const result = extractTitleFromPayload({
      type: "agent_reasoning",
      text: "Just some content",
    });
    assert.equal(result.title, null);
    assert.equal(result.content, "Just some content");
  });
});

test("getTextFromContentItems", async (t) => {
  await t.test("should extract output_text items", () => {
    const content = [
      { type: "output_text", text: "Hello " },
      { type: "output_text", text: "World" },
    ];
    assert.equal(getTextFromContentItems(content), "Hello World");
  });

  await t.test("should skip non-output_text items", () => {
    const content = [
      { type: "image", data: "..." },
      { type: "output_text", text: "Text" },
    ];
    assert.equal(getTextFromContentItems(content), "Text");
  });

  await t.test("should return empty for non-array", () => {
    assert.equal(getTextFromContentItems("not array"), "");
    assert.equal(getTextFromContentItems(null), "");
  });
});

test("extractMcpResultText", async (t) => {
  await t.test("should extract text from content array", () => {
    const result = {
      content: [
        { text: "Line 1" },
        { text: "Line 2" },
      ],
    };
    assert.equal(extractMcpResultText(result), "Line 1Line 2");
  });

  await t.test("should extract text field directly", () => {
    assert.equal(extractMcpResultText({ text: "Direct text" }), "Direct text");
  });

  await t.test("should return empty for invalid input", () => {
    assert.equal(extractMcpResultText(null), "");
    assert.equal(extractMcpResultText({}), "");
  });
});

test("extractCommandFromToolArgs", async (t) => {
  await t.test("should extract command from shell_command", () => {
    const args = JSON.stringify({ command: "ls -la" });
    assert.equal(extractCommandFromToolArgs("shell_command", args), "ls -la");
  });

  await t.test("should extract command from shell", () => {
    const args = JSON.stringify({ command: "pwd" });
    assert.equal(extractCommandFromToolArgs("shell", args), "pwd");
  });

  await t.test("should return apply_patch for apply_patch tool", () => {
    const args = JSON.stringify({ patch: "diff content..." });
    assert.equal(extractCommandFromToolArgs("apply_patch", args), "apply_patch");
  });

  await t.test("should return null for unknown tools", () => {
    const args = JSON.stringify({ data: "something" });
    assert.equal(extractCommandFromToolArgs("other_tool", args), null);
  });

  await t.test("should return null for invalid JSON", () => {
    assert.equal(extractCommandFromToolArgs("shell", "not json"), null);
  });
});
