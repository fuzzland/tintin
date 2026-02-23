# Progress Display Design — Parallel Progress Pipeline

**Date:** 2026-02-23
**Target:** WebSocket (Cloud UI) only — Telegram/Slack unaffected
**Agents:** Codex + Claude Code, extensible to future agents
**Reference:** AG-UI Protocol event conventions

## Overview

Add a parallel progress pipeline that extracts structured progress events from agent JSONL logs and delivers them exclusively to WebSocket clients. Supports real-time display and historical replay via HTTP API.

The design follows the AG-UI protocol's flat event stream pattern: the backend emits raw events, the frontend manages state and rendering.

## Architecture

```
JSONL Raw Events
    │
    ├── Existing path (unchanged):
    │   EventMappers → StreamFragment → SessionMessenger
    │                                    ├── Telegram  (unaffected)
    │                                    ├── Slack     (unaffected)
    │                                    └── WebSocket (chat messages)
    │
    └── New path (Progress):
        ProgressExtractors → ProgressEvent[] → SessionMessenger
                                                └── WebSocket only
                                                    └── progress_event messages
```

**No server-side state aggregation.** Extractors emit raw events with timestamps; the frontend computes durations, builds tool stacks, and manages UI state. This aligns with AG-UI and avoids duplicating ToolCallManager's existing FIFO pairing logic.

## Part 1: Data Model — ProgressEvent

Aligned with AG-UI naming conventions. All agent events map to a unified type.

```typescript
// src/runtime/streamer/progress/types.ts

/** Unified progress event — agent-agnostic, flat event stream */
export type ProgressEvent =
  | ToolCallStartEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | PlanUpdateEvent
  | ThinkingStartEvent
  | ThinkingEndEvent
  | RunErrorEvent;

export interface ToolCallStartEvent {
  kind: "tool_call_start";
  id: string;              // correlation ID for pairing start/end/result
  tool: string;            // unified: "Read", "Bash", "mcp:server.tool"
  input?: string;          // input summary: "src/foo.ts", "npm test"
  ts: number;              // millisecond epoch timestamp
}

export interface ToolCallEndEvent {
  kind: "tool_call_end";
  id: string;              // matches ToolCallStartEvent.id
  ts: number;
}

export interface ToolCallResultEvent {
  kind: "tool_call_result";
  id: string;              // matches ToolCallStartEvent.id
  output?: string;         // truncated output summary
  ts: number;
}

export interface PlanUpdateEvent {
  kind: "plan_update";
  steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" | "failed" }>;
  progress: number;        // 0-100 (completed / total * 100)
  currentStep?: number;    // index of first in_progress step
  explanation?: string;
  ts: number;
}

export interface ThinkingStartEvent {
  kind: "thinking_start";
  ts: number;
}

export interface ThinkingEndEvent {
  kind: "thinking_end";
  ts: number;
}

export interface RunErrorEvent {
  kind: "run_error";
  message: string;
  ts: number;
}
```

**Design notes:**
- `id` field on tool events enables frontend pairing (AG-UI `toolCallId` pattern)
- `tool` uses unified naming: native tools by original name, MCP tools as `mcp:server.tool`
- No `duration` field — frontend computes from `tool_call_start.ts` to `tool_call_end.ts`
- `plan_update` sends full snapshot (data is small); no delta/patch needed
- `thinking_start` / `thinking_end` bracket reasoning phases for frontend spinner

## Part 2: ProgressExtractor — Agent Adapter Layer

Each agent implements one function: `(obj: unknown) => ProgressEvent[]`.

```typescript
// src/runtime/streamer/progress/index.ts

import type { SessionAgent } from "../../db.js";
import type { ProgressEvent } from "./types.js";

export type ProgressExtractorFn = (obj: unknown) => ProgressEvent[];

export const PROGRESS_EXTRACTORS: Record<SessionAgent, ProgressExtractorFn> = {
  codex: extractCodexProgress,
  claude_code: extractClaudeProgress,
};

export function extractProgress(agent: SessionAgent, obj: unknown): ProgressEvent[] {
  const extractor = PROGRESS_EXTRACTORS[agent];
  return extractor ? extractor(obj) : [];
}
```

### Claude Code Extractor

Source: `assistant` messages with `tool_use` / `tool_result` content blocks.

```typescript
// src/runtime/streamer/progress/claudeExtractor.ts

export function extractClaudeProgress(obj: unknown): ProgressEvent[] {
  const type = (obj as any)?.type;

  if (type === "assistant") {
    const content = (obj as any)?.message?.content;
    if (!Array.isArray(content)) return [];

    const events: ProgressEvent[] = [];
    let hasToolUse = false;

    for (const block of content) {
      if (block?.type === "tool_use") {
        hasToolUse = true;
        const id = block.id ?? crypto.randomUUID();
        events.push({
          kind: "tool_call_start",
          id,
          tool: normalizeToolName(block.name),
          input: extractInputSummary(block.name, block.input),
          ts: Date.now(),
        });
      }
      if (block?.type === "tool_result") {
        const id = block.tool_use_id ?? "";
        events.push(
          { kind: "tool_call_end", id, ts: Date.now() },
          { kind: "tool_call_result", id, output: truncateOutput(block.content), ts: Date.now() },
        );
      }
    }

    // Text-only assistant message = thinking
    if (!hasToolUse && hasTextContent(content)) {
      events.push({ kind: "thinking_start", ts: Date.now() });
    }
    return events;
  }

  if (type === "result") {
    const isError = (obj as any)?.is_error;
    if (isError) {
      return [{ kind: "run_error", message: (obj as any)?.error ?? "unknown", ts: Date.now() }];
    }
  }

  return [];
}
```

### Codex Extractor

Source: `event_msg` with explicit begin/end pairs, `response_item` with function calls.

```typescript
// src/runtime/streamer/progress/codexExtractor.ts

export function extractCodexProgress(obj: unknown): ProgressEvent[] {
  const eventType = resolveEventType(obj);  // handles payload.type and top-level type

  switch (eventType) {
    // Explicit begin/end pairs in event_msg
    case "exec_command_begin":
      return [{ kind: "tool_call_start", id: genId(), tool: "Bash",
                input: extractCommand(obj), ts: Date.now() }];
    case "exec_command_end":
      return [{ kind: "tool_call_end", id: lastId("Bash"), ts: Date.now() }];

    case "mcp_tool_call_begin":
      return [{ kind: "tool_call_start", id: genId(),
                tool: `mcp:${extractMcpName(obj)}`, ts: Date.now() }];
    case "mcp_tool_call_end":
      return [{ kind: "tool_call_end", id: lastId("mcp"), ts: Date.now() },
              { kind: "tool_call_result", id: lastId("mcp"),
                output: extractMcpResult(obj), ts: Date.now() }];

    case "patch_apply_begin":
      return [{ kind: "tool_call_start", id: genId(), tool: "Patch",
                input: extractPatchTarget(obj), ts: Date.now() }];
    case "patch_apply_end":
      return [{ kind: "tool_call_end", id: lastId("Patch"), ts: Date.now() }];

    case "web_search_begin":
      return [{ kind: "tool_call_start", id: genId(), tool: "WebSearch",
                input: extractSearchQuery(obj), ts: Date.now() }];
    case "web_search_end":
      return [{ kind: "tool_call_end", id: lastId("WebSearch"), ts: Date.now() }];

    // Single-shot items (command_execution, mcp_tool_call)
    // → emit start + end + result as a batch

    // response_item function_call / function_call_output
    // → tool_call_start / tool_call_end + tool_call_result

    default:
      return [];
  }
}
```

### Plan Update Extraction

Reuses existing `parsePlanUpdatePayload()`, adds `progress` percentage.

```typescript
// In both extractors, plan detection delegates to existing logic:
import { parsePlanUpdatePayload } from "../PlanUpdateHandler.js";

function extractPlanProgress(obj: unknown): PlanUpdateEvent | null {
  // Reuse existing plan detection (tool call or event_msg)
  const payload = parsePlanUpdatePayload(/* extracted args */);
  if (!payload) return null;

  const steps = payload.plan.map(s => ({
    step: s.step,
    status: normalizePlanStatus(s.status),
  }));
  const completed = steps.filter(s => s.status === "completed").length;

  return {
    kind: "plan_update",
    steps,
    progress: steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0,
    currentStep: steps.findIndex(s => s.status === "in_progress"),
    explanation: payload.explanation,
    ts: Date.now(),
  };
}
```

## Part 3: Integration Points

### JsonlStreamer — 1 hook added

In `pollOnce()`, after existing fragment processing (around line 243):

```typescript
// Existing code (unchanged):
const mapper = EVENT_MAPPERS[session.agent];
fragments.push(...mapper(obj, { ... }));

// NEW (1 line):
this.emitProgressEvents(session.id, session.agent, obj);
```

New private method on JsonlStreamer:

```typescript
private emitProgressEvents(sessionId: string, agent: SessionAgent, obj: unknown): void {
  const events = extractProgress(agent, obj);
  if (events.length === 0) return;
  for (const evt of events) {
    void this.sendToSession(sessionId, { type: "progress_event", event: evt });
  }
}
```

### SessionMessenger — 1 early-return branch

In `sendToSession()`, before platform-specific logic:

```typescript
// NEW: WebSocket-only progress events
if (message.type === "progress_event") {
  if (wsManager?.hasSubscribers(sessionId)) {
    wsManager.broadcastToSession(sessionId, {
      type: "progress_event",
      sessionId,
      event: message.event,
    });
  }
  return;  // Skip Telegram/Slack entirely
}
```

### messaging.ts — 1 type added to SessionMessage union

```typescript
| {
    type: "progress_event";
    event: ProgressEvent;
    priority?: SendPriority;
  }
```

## Part 4: WebSocket Message Protocol

### New server message type

```typescript
// websocket/types.ts

export interface ProgressEventMessage {
  type: "progress_event";
  sessionId: string;
  event: ProgressEvent;  // from streamer/progress/types.ts
}

// Added to ServerMessage union:
export type ServerMessage =
  | ... // existing types
  | ProgressEventMessage;
```

### Example message stream (frontend receives)

```jsonc
// Agent starts thinking
{"type":"progress_event","sessionId":"s1","event":{"kind":"thinking_start","ts":1708700000000}}

// Tool: read file
{"type":"progress_event","sessionId":"s1","event":{"kind":"tool_call_start","id":"tc_1","tool":"Read","input":"src/main.ts","ts":1708700001000}}
{"type":"progress_event","sessionId":"s1","event":{"kind":"tool_call_end","id":"tc_1","ts":1708700001120}}

// Tool: run tests
{"type":"progress_event","sessionId":"s1","event":{"kind":"tool_call_start","id":"tc_2","tool":"Bash","input":"npm test","ts":1708700002000}}
{"type":"progress_event","sessionId":"s1","event":{"kind":"tool_call_end","id":"tc_2","ts":1708700007200}}
{"type":"progress_event","sessionId":"s1","event":{"kind":"tool_call_result","id":"tc_2","output":"12 tests passed","ts":1708700007200}}

// Plan update with progress
{"type":"progress_event","sessionId":"s1","event":{"kind":"plan_update","steps":[
  {"step":"Read codebase","status":"completed"},
  {"step":"Fix bug","status":"in_progress"},
  {"step":"Run tests","status":"pending"}
],"progress":33,"currentStep":1,"ts":1708700008000}}
```

## Part 5: Replay API

### Endpoint

```
GET /api/sessions/:sessionId/progress-timeline
```

### Implementation

Added to `agentRoutes.ts`, follows existing authentication and response patterns:

```typescript
async function handleProgressTimeline(sessionId: string, deps: AgentRouteDeps): Promise<ProgressEvent[]> {
  const session = await getSession(deps.db, sessionId);
  if (!session) throw new NotFoundError();

  const offsets = await listSessionOffsets(deps.db, sessionId);
  const events: ProgressEvent[] = [];

  for (const off of offsets) {
    const content = await readFile(off.jsonl_path, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        events.push(...extractProgress(session.agent, obj));
      } catch {
        continue;  // skip malformed lines
      }
    }
  }

  return events;
}
```

### Response format

```json
{
  "sessionId": "s1",
  "agent": "claude_code",
  "events": [
    {"kind": "thinking_start", "ts": 1708700000000},
    {"kind": "tool_call_start", "id": "tc_1", "tool": "Read", "input": "src/main.ts", "ts": 1708700001000},
    {"kind": "tool_call_end", "id": "tc_1", "ts": 1708700001120}
  ]
}
```

### Frontend usage

- **Real-time**: WebSocket `progress_event` messages, render as received
- **Replay**: Fetch `/progress-timeline`, replay by computing `ts` deltas between consecutive events
- **Same `ProgressEvent` structure** for both — frontend rendering logic is shared

## Part 6: Code Cleanup (Bundled)

Issues discovered during code review, fixed as part of this work:

| Issue | File | Fix |
|-------|------|-----|
| `stringOrEmpty()` duplicated | PlanUpdateHandler.ts:141 | Import from helpers.ts |
| `hasPending()`, `pendingCount()`, `getSessionIds()` unused | ToolCallManager.ts | Remove dead methods |
| `normalizePlanStatus()` duplicated | sessionMessenger.ts:283 + PlanUpdateHandler | Extract shared `normalizePlanStatus()` to helpers.ts |
| `status as any` type cast | sessionMessenger.ts:487 | Use proper `normalizePlanStatus()` return type |
| Buffer flush magic numbers | JsonlStreamer.ts | Extract to named constants: `FLUSH_CHAR_THRESHOLD`, `FLUSH_INTERVAL_MS` |

## File Changes Summary

| File | Change | Impact |
|------|--------|--------|
| `streamer/progress/types.ts` | **NEW** | ProgressEvent type definitions |
| `streamer/progress/claudeExtractor.ts` | **NEW** | Claude Code JSONL → ProgressEvent |
| `streamer/progress/codexExtractor.ts` | **NEW** | Codex JSONL → ProgressEvent |
| `streamer/progress/index.ts` | **NEW** | Registry + `extractProgress()` |
| `streamer/JsonlStreamer.ts` | **MODIFY** | +1 method call in pollOnce, +1 private method, extract constants |
| `service/sessionMessenger.ts` | **MODIFY** | +1 early-return branch, deduplicate normalizePlanStatus |
| `messaging.ts` | **MODIFY** | +progress_event to SessionMessage union |
| `websocket/types.ts` | **MODIFY** | +ProgressEventMessage to ServerMessage |
| `service/http/agentRoutes.ts` | **MODIFY** | +1 replay endpoint |
| `streamer/PlanUpdateHandler.ts` | **MODIFY** | Remove duplicated stringOrEmpty |
| `streamer/ToolCallManager.ts` | **MODIFY** | Remove unused methods |
| `streamer/eventMappers/helpers.ts` | **MODIFY** | Export shared normalizePlanStatus |

**New files:** 4 (all in `streamer/progress/`)
**Modified files:** 8 (minimal, focused changes)
**Telegram/Slack impact:** Zero
