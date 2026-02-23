import test from "node:test";
import assert from "node:assert/strict";
import { extractProgress } from "../../../src/runtime/streamer/progress/index.js";

test("extractProgress registry", async (t) => {
  await t.test("should dispatch to claude_code extractor", () => {
    const obj = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
      },
    };
    const events = extractProgress("claude_code", obj);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "tool_call_start");
  });

  await t.test("should dispatch to codex extractor", () => {
    const obj = { type: "event_msg", payload: { type: "exec_command_begin", command: "ls" } };
    const events = extractProgress("codex", obj);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "tool_call_start");
  });

  await t.test("should return empty for unknown agent", () => {
    const events = extractProgress("unknown_agent" as any, {});
    assert.deepEqual(events, []);
  });

  await t.test("should return empty for null obj", () => {
    assert.deepEqual(extractProgress("claude_code", null), []);
    assert.deepEqual(extractProgress("codex", null), []);
  });
});
