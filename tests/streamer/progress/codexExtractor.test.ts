import test from "node:test";
import assert from "node:assert/strict";
import { extractCodexProgress } from "../../../src/runtime/streamer/progress/codexExtractor.js";

test("extractCodexProgress event_msg begin/end pairs", async (t) => {
  await t.test("should extract tool_call_start from exec_command_begin", () => {
    const obj = { type: "event_msg", payload: { type: "exec_command_begin", command: ["npm", "test"] } };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "tool_call_start");
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.tool, "Bash");
      assert.equal(events[0]!.input, "npm test");
    }
  });

  await t.test("should extract tool_call_end from exec_command_end", () => {
    const obj = { type: "event_msg", payload: { type: "exec_command_end" } };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "tool_call_end");
  });

  await t.test("should extract tool_call_start from patch_apply_begin", () => {
    const obj = { type: "event_msg", payload: { type: "patch_apply_begin", changes: { "src/foo.ts": {} } } };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.tool, "Patch");
    }
  });

  await t.test("should extract mcp_tool_call_begin with server.tool name", () => {
    const obj = { type: "event_msg", payload: { type: "mcp_tool_call_begin", invocation: { server: "github", tool: "create_issue" } } };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.tool, "mcp:github.create_issue");
    }
  });

  await t.test("should extract web_search_begin", () => {
    const obj = { type: "event_msg", payload: { type: "web_search_begin", query: "typescript generics" } };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.tool, "WebSearch");
      assert.equal(events[0]!.input, "typescript generics");
    }
  });
});

test("extractCodexProgress response_item", async (t) => {
  await t.test("should extract tool_call_start from function_call", () => {
    const obj = {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "fc_1",
        name: "shell_command",
        arguments: '{"command":"ls -la"}',
      },
    };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "tool_call_start");
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.id, "fc_1");
      assert.equal(events[0]!.input, "ls -la");
    }
  });

  await t.test("should extract tool_call_end + result from function_call_output", () => {
    const obj = {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "fc_1",
        output: "total 42\ndrwxr-xr-x...",
      },
    };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.kind, "tool_call_end");
    assert.equal(events[1]!.kind, "tool_call_result");
  });

  await t.test("should extract local_shell_call", () => {
    const obj = {
      type: "response_item",
      payload: {
        type: "local_shell_call",
        call_id: "lsc_1",
        action: { command: "git status" },
      },
    };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.tool, "Bash");
      assert.equal(events[0]!.input, "git status");
    }
  });
});

test("extractCodexProgress item.* events", async (t) => {
  await t.test("should extract command_execution start", () => {
    const obj = {
      type: "item.started",
      item: { type: "command_execution", command: "npm install", status: "in_progress" },
    };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.tool, "Bash");
      assert.equal(events[0]!.input, "npm install");
    }
  });

  await t.test("should extract command_execution completed", () => {
    const obj = {
      type: "item.completed",
      item: { type: "command_execution", command: "npm install", exit_code: 0, aggregated_output: "added 100 packages" },
    };
    const events = extractCodexProgress(obj);
    assert.ok(events.length >= 1);
    assert.ok(events.some((e) => e.kind === "tool_call_end"));
  });

  await t.test("should extract mcp_tool_call start", () => {
    const obj = {
      type: "item.started",
      item: { type: "mcp_tool_call", server: "exa", tool: "search", status: "in_progress" },
    };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    if (events[0]!.kind === "tool_call_start") {
      assert.equal(events[0]!.tool, "mcp:exa.search");
    }
  });
});

test("extractCodexProgress error events", async (t) => {
  await t.test("should extract run_error from turn.failed", () => {
    const obj = { type: "turn.failed", message: "rate limit exceeded" };
    const events = extractCodexProgress(obj);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "run_error");
    if (events[0]!.kind === "run_error") {
      assert.equal(events[0]!.message, "rate limit exceeded");
    }
  });
});

test("extractCodexProgress edge cases", async (t) => {
  await t.test("should return empty for null/undefined", () => {
    assert.deepEqual(extractCodexProgress(null), []);
    assert.deepEqual(extractCodexProgress(undefined), []);
  });

  await t.test("should return empty for token_count events", () => {
    assert.deepEqual(extractCodexProgress({ type: "event_msg", payload: { type: "token_count" } }), []);
  });
});
