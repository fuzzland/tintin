// src/runtime/streamer/progress/types.ts

/** Unified progress event — agent-agnostic, flat event stream.
 *  Aligned with AG-UI naming conventions. */
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
  id: string;
  tool: string;
  input?: string;
  ts: number;
}

export interface ToolCallEndEvent {
  kind: "tool_call_end";
  id: string;
  ts: number;
}

export interface ToolCallResultEvent {
  kind: "tool_call_result";
  id: string;
  output?: string;
  ts: number;
}

export interface PlanUpdateEvent {
  kind: "plan_update";
  steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" | "failed" }>;
  progress: number;
  currentStep?: number;
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
