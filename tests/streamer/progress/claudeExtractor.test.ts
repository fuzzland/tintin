import test from "node:test";
import assert from "node:assert/strict";
import { extractClaudeProgress } from "../../../src/runtime/streamer/progress/claudeExtractor.js";

test("extractClaudeProgress tool_use", async (t) => {
  await t.test("should extract tool_call_start from tool_use block", () => {
    const obj = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "src/main.ts" } },
        ],
      },
    };
    const events = extractClaudeProgress(obj);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "tool_call_start");
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.id, "tu_1");
      assert.equal(events[0]!.tool, "Read");
      assert.equal(events[0]!.input, "src/main.ts");
      assert.equal(typeof events[0]!.ts, "number");
    }
  });

  await t.test("should extract Bash command as input", () => {
    const obj = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu_2", name: "Bash", input: { command: "npm test" } },
        ],
      },
    };
    const events = extractClaudeProgress(obj);
    assert.equal(events.length, 1);
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.tool, "Bash");
      assert.equal(events[0]!.input, "npm test");
    }
  });

  await t.test("should normalize MCP tool names", () => {
    const obj = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu_3", name: "mcp__playwright__screenshot", input: {} },
        ],
      },
    };
    const events = extractClaudeProgress(obj);
    assert.equal(events.length, 1);
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.tool, "mcp:playwright.screenshot");
    }
  });
});

test("extractClaudeProgress tool_result", async (t) => {
  await t.test("should extract tool_call_end and tool_call_result from tool_result block", () => {
    const obj = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "file contents here" },
        ],
      },
    };
    const events = extractClaudeProgress(obj);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.kind, "tool_call_end");
    assert.equal(events[1]!.kind, "tool_call_result");
    if (events[0]!.kind === "tool_call_end") {
      assert.equal(events[0]!.id, "tu_1");
    }
    if (events[1]!.kind === "tool_call_result") {
      assert.equal(events[1]!.id, "tu_1");
      assert.ok(events[1]!.output);
    }
  });
});

test("extractClaudeProgress thinking", async (t) => {
  await t.test("should emit thinking_start for text-only assistant message", () => {
    const obj = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Let me think about this..." }],
      },
    };
    const events = extractClaudeProgress(obj);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "thinking_start");
  });

  await t.test("should NOT emit thinking for assistant message with tool_use", () => {
    const obj = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "tu_1", name: "Read", input: {} },
        ],
      },
    };
    const events = extractClaudeProgress(obj);
    // Should only have tool_call_start, no thinking_start
    assert.ok(events.every((e) => e.kind !== "thinking_start"));
  });
});

test("extractClaudeProgress result", async (t) => {
  await t.test("should emit run_error for error result", () => {
    const obj = { type: "result", is_error: true, error: "token limit exceeded" };
    const events = extractClaudeProgress(obj);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "run_error");
    if (events[0]!.kind === "run_error") {
      assert.equal(events[0]!.message, "token limit exceeded");
    }
  });

  await t.test("should return empty for success result", () => {
    const obj = { type: "result", is_error: false, subtype: "success" };
    const events = extractClaudeProgress(obj);
    assert.equal(events.length, 0);
  });
});

test("extractClaudeProgress edge cases", async (t) => {
  await t.test("should return empty for null/undefined", () => {
    assert.deepEqual(extractClaudeProgress(null), []);
    assert.deepEqual(extractClaudeProgress(undefined), []);
  });

  await t.test("should return empty for unknown type", () => {
    assert.deepEqual(extractClaudeProgress({ type: "system" }), []);
  });

  await t.test("should return empty for assistant without content", () => {
    assert.deepEqual(extractClaudeProgress({ type: "assistant", message: {} }), []);
  });
});
