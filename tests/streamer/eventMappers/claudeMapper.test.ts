import test from "node:test";
import assert from "node:assert/strict";
import { mapClaudeEventToFragments } from "../../../src/runtime/streamer/eventMappers/claudeMapper.js";
import type { StreamFragment } from "../../../src/runtime/streamer/types.js";

// Helper to safely get text from fragment
function getFragmentText(fragment: StreamFragment | undefined): string {
  if (!fragment) return "";
  if ("text" in fragment) return fragment.text;
  return "";
}

test("mapClaudeEventToFragments result type", async (t) => {
  await t.test("should return final fragment for result", () => {
    const result = mapClaudeEventToFragments({ type: "result", subtype: "success" });
    assert.ok(result.some((f) => f.kind === "final"));
  });

  await t.test("should include error text for error result with verbosity >= 2", () => {
    const result = mapClaudeEventToFragments(
      { type: "result", subtype: "error", is_error: true },
      { verbosity: 2 }
    );
    assert.ok(result.some((f) => f.kind === "text"));
    assert.ok(result.some((f) => f.kind === "final"));
  });

  await t.test("should skip error text with low verbosity", () => {
    const result = mapClaudeEventToFragments(
      { type: "result", subtype: "error", is_error: true },
      { verbosity: 1 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "final");
  });
});

test("mapClaudeEventToFragments assistant message", async (t) => {
  await t.test("should extract text from assistant message string content", () => {
    const result = mapClaudeEventToFragments({
      type: "assistant",
      message: { content: "Hello from assistant" },
    });
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
    assert.equal(getFragmentText(result[0]), "Hello from assistant");
  });

  await t.test("should extract text blocks from array content", () => {
    const result = mapClaudeEventToFragments({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "First paragraph" },
          { type: "text", text: "Second paragraph" },
        ],
      },
    });
    assert.equal(result.length, 2);
    assert.ok(result.every((f) => f.kind === "text"));
  });

  await t.test("should map tool_use to tool_call with verbosity 3", () => {
    const result = mapClaudeEventToFragments(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "ls -la" },
            },
          ],
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_call");
    assert.equal(getFragmentText(result[0]), "$ ls -la");
  });

  await t.test("should format MCP tool names", () => {
    const result = mapClaudeEventToFragments(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__playwright__screenshot",
              input: {},
            },
          ],
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_call");
    assert.ok(getFragmentText(result[0]).includes("MCP"));
  });

  await t.test("should skip tool_use with verbosity < 3", () => {
    const result = mapClaudeEventToFragments(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: {} }],
        },
      },
      { verbosity: 2 }
    );
    assert.equal(result.length, 0);
  });

  await t.test("should map tool_result to tool_output", () => {
    const result = mapClaudeEventToFragments(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_result", content: "Command output here" }],
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_output");
    assert.equal(getFragmentText(result[0]), "Command output here");
  });

  await t.test("should handle tool_result with array content", () => {
    const result = mapClaudeEventToFragments(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "Line 1" },
                { type: "text", text: "Line 2" },
              ],
            },
          ],
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_output");
    assert.ok(getFragmentText(result[0]).includes("Line 1"));
    assert.ok(getFragmentText(result[0]).includes("Line 2"));
  });
});

test("mapClaudeEventToFragments user message", async (t) => {
  await t.test("should include user message by default", () => {
    const result = mapClaudeEventToFragments({
      type: "user",
      message: { content: "User question" },
    });
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
  });

  await t.test("should skip user message when includeUserMessages is false", () => {
    const result = mapClaudeEventToFragments(
      {
        type: "user",
        message: { content: "User question" },
      },
      { includeUserMessages: false }
    );
    assert.equal(result.length, 0);
  });

  await t.test("should handle user message with array content", () => {
    const result = mapClaudeEventToFragments({
      type: "user",
      message: {
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    });
    assert.equal(result.length, 2);
  });
});

test("mapClaudeEventToFragments system type", async (t) => {
  await t.test("should map system event with verbosity >= 2", () => {
    const result = mapClaudeEventToFragments(
      { type: "system", subtype: "init" },
      { verbosity: 2 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
    assert.ok(getFragmentText(result[0]).includes("init"));
  });

  await t.test("should skip system event with verbosity < 2", () => {
    const result = mapClaudeEventToFragments(
      { type: "system", subtype: "init" },
      { verbosity: 1 }
    );
    assert.equal(result.length, 0);
  });
});

test("mapClaudeEventToFragments tool_progress type", async (t) => {
  await t.test("should map tool_progress with verbosity >= 2", () => {
    const result = mapClaudeEventToFragments(
      { type: "tool_progress", tool_name: "Read", elapsed_time_seconds: 5 },
      { verbosity: 2 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
    assert.ok(getFragmentText(result[0]).includes("Read"));
  });

  await t.test("should skip tool_progress with verbosity < 2", () => {
    const result = mapClaudeEventToFragments(
      { type: "tool_progress", tool_name: "Read" },
      { verbosity: 1 }
    );
    assert.equal(result.length, 0);
  });
});

test("mapClaudeEventToFragments edge cases", async (t) => {
  await t.test("should return empty for null input", () => {
    assert.deepEqual(mapClaudeEventToFragments(null), []);
  });

  await t.test("should return empty for non-object", () => {
    assert.deepEqual(mapClaudeEventToFragments("string"), []);
  });

  await t.test("should return empty for unknown type", () => {
    assert.deepEqual(mapClaudeEventToFragments({ type: "unknown" }), []);
  });

  await t.test("should handle missing message object", () => {
    const result = mapClaudeEventToFragments({ type: "assistant" });
    assert.deepEqual(result, []);
  });

  await t.test("should handle empty content array", () => {
    const result = mapClaudeEventToFragments({
      type: "assistant",
      message: { content: [] },
    });
    assert.deepEqual(result, []);
  });
});
