import test from "node:test";
import assert from "node:assert/strict";
import { mapCodexEventToFragments } from "../../../src/runtime/streamer/eventMappers/codexMapper.js";
import type { StreamFragment } from "../../../src/runtime/streamer/types.js";

// Helper to safely get text from fragment
function getFragmentText(fragment: StreamFragment | undefined): string {
  if (!fragment) return "";
  if ("text" in fragment) return fragment.text;
  return "";
}

test("mapCodexEventToFragments turn events", async (t) => {
  await t.test("should return final fragment for turn.completed", () => {
    const result = mapCodexEventToFragments({ type: "turn.completed" });
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "final");
  });

  await t.test("should return final fragment for thread.completed", () => {
    const result = mapCodexEventToFragments({ type: "thread.completed" });
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "final");
  });

  await t.test("should return error text for turn.failed with verbosity >= 2", () => {
    const result = mapCodexEventToFragments(
      { type: "turn.failed", message: "Something went wrong" },
      { verbosity: 2 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
    assert.ok(getFragmentText(result[0]).includes("Something went wrong"));
  });

  await t.test("should return empty for turn.failed with verbosity < 2", () => {
    const result = mapCodexEventToFragments(
      { type: "turn.failed", message: "Error" },
      { verbosity: 1 }
    );
    assert.equal(result.length, 0);
  });
});

test("mapCodexEventToFragments error type", async (t) => {
  await t.test("should map error event with verbosity >= 2", () => {
    const result = mapCodexEventToFragments(
      { type: "error", message: "Connection lost" },
      { verbosity: 2 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
  });

  await t.test("should skip reconnecting errors", () => {
    const result = mapCodexEventToFragments(
      { type: "error", message: "Reconnecting to server..." },
      { verbosity: 2 }
    );
    assert.equal(result.length, 0);
  });
});

test("mapCodexEventToFragments response_item function_call", async (t) => {
  await t.test("should map function_call to tool_call with verbosity 3", () => {
    const result = mapCodexEventToFragments(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: "ls -la" }),
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_call");
    assert.equal(getFragmentText(result[0]), "$ ls -la");
  });

  await t.test("should skip function_call with verbosity < 3", () => {
    const result = mapCodexEventToFragments(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: "pwd" }),
        },
      },
      { verbosity: 2 }
    );
    assert.equal(result.length, 0);
  });

  await t.test("should format non-shell tools", () => {
    const result = mapCodexEventToFragments(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "read_file",
          arguments: "{}",
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_call");
    assert.ok(getFragmentText(result[0]).includes("read_file"));
  });
});

test("mapCodexEventToFragments response_item function_call_output", async (t) => {
  await t.test("should map function_call_output to tool_output", () => {
    const result = mapCodexEventToFragments(
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: "file contents here",
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_output");
    assert.equal(getFragmentText(result[0]), "file contents here");
  });

  await t.test("should skip with verbosity < 3", () => {
    const result = mapCodexEventToFragments(
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: "output",
        },
      },
      { verbosity: 2 }
    );
    assert.equal(result.length, 0);
  });
});

test("mapCodexEventToFragments response_item custom_tool_call", async (t) => {
  await t.test("should map custom_tool_call to tool_call", () => {
    const result = mapCodexEventToFragments(
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "my_tool",
          input: "test input",
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_call");
    assert.ok(getFragmentText(result[0]).includes("my_tool"));
  });
});

test("mapCodexEventToFragments response_item web_search_call", async (t) => {
  await t.test("should map web_search_call", () => {
    const result = mapCodexEventToFragments(
      {
        type: "response_item",
        payload: {
          type: "web_search_call",
          action: { query: "typescript tutorials" },
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
    assert.ok(getFragmentText(result[0]).includes("typescript tutorials"));
  });
});

test("mapCodexEventToFragments response_item local_shell_call", async (t) => {
  await t.test("should map local_shell_call to tool_call", () => {
    const result = mapCodexEventToFragments(
      {
        type: "response_item",
        payload: {
          type: "local_shell_call",
          action: { command: "git status" },
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_call");
    assert.equal(getFragmentText(result[0]), "$ git status");
  });
});

test("mapCodexEventToFragments item.* events", async (t) => {
  await t.test("should map agent_message item", () => {
    const result = mapCodexEventToFragments({
      type: "item.completed",
      item: {
        type: "agent_message",
        message: "Hello from agent",
      },
    });
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
    assert.equal(getFragmentText(result[0]), "Hello from agent");
  });

  await t.test("should map reasoning item with verbosity >= 2", () => {
    const result = mapCodexEventToFragments(
      {
        type: "item.completed",
        item: {
          type: "reasoning",
          text: "Thinking about the problem...",
        },
      },
      { verbosity: 2 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
  });

  await t.test("should skip reasoning with verbosity < 2", () => {
    const result = mapCodexEventToFragments(
      {
        type: "item.completed",
        item: {
          type: "reasoning",
          text: "Thinking...",
        },
      },
      { verbosity: 1 }
    );
    assert.equal(result.length, 0);
  });

  await t.test("should map command_execution started", () => {
    const result = mapCodexEventToFragments(
      {
        type: "item.started",
        item: {
          type: "command_execution",
          command: "npm test",
          status: "in_progress",
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_call");
    assert.equal(getFragmentText(result[0]), "$ npm test");
  });

  await t.test("should map command_execution completed with output", () => {
    const result = mapCodexEventToFragments(
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "pwd",
          status: "completed",
          aggregated_output: "/home/user",
          exit_code: 0,
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_output");
    assert.ok(getFragmentText(result[0]).includes("/home/user"));
  });

  await t.test("should map mcp_tool_call started", () => {
    const result = mapCodexEventToFragments(
      {
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          server: "playwright",
          tool: "screenshot",
          status: "in_progress",
        },
      },
      { verbosity: 3 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "tool_call");
    assert.ok(getFragmentText(result[0]).includes("playwright"));
  });

  await t.test("should map file_change item with verbosity >= 2", () => {
    const result = mapCodexEventToFragments(
      {
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [
            { kind: "add", path: "/src/new.ts" },
            { kind: "modify", path: "/src/existing.ts" },
          ],
        },
      },
      { verbosity: 2 }
    );
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].kind, "text");
    assert.ok(getFragmentText(result[0]).includes("/src/new.ts"));
  });
});

test("mapCodexEventToFragments edge cases", async (t) => {
  await t.test("should return empty for null input", () => {
    assert.deepEqual(mapCodexEventToFragments(null), []);
  });

  await t.test("should return empty for non-object", () => {
    assert.deepEqual(mapCodexEventToFragments("string"), []);
  });

  await t.test("should return empty for unknown type", () => {
    assert.deepEqual(mapCodexEventToFragments({ type: "unknown_event" }), []);
  });

  await t.test("should skip message response_item to avoid duplicates", () => {
    const result = mapCodexEventToFragments({
      type: "response_item",
      payload: {
        type: "message",
        content: "Agent message",
      },
    });
    assert.equal(result.length, 0);
  });
});
