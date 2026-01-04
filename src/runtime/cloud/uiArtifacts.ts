import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyPatch, parsePatch } from "diff";
import type { SessionAgent } from "../db.js";

export interface DiffFileView {
  path: string;
  before: string;
  after: string;
}

export interface DiffEntry {
  id: string;
  timestamp: number | null;
  patch: string;
  files: DiffFileView[];
}

export interface CommandEntry {
  id: string;
  timestamp: number | null;
  cwd: string | null;
  command: string;
  output: string;
  exitCode: number | null;
}

function safeJsonParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function decodeBase64ToString(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return value;
  }
}

function eventTimestamp(obj: any): number | null {
  if (typeof obj?.timestamp === "number") return obj.timestamp;
  const payloadTs = typeof obj?.payload?.timestamp === "number" ? obj.payload.timestamp : null;
  return payloadTs;
}

function normalizeFilePath(p: string | undefined): string {
  if (!p) return "";
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function buildPartialView(patch: ReturnType<typeof parsePatch>[number]): DiffFileView | null {
  const filePath = normalizeFilePath(patch.newFileName || patch.oldFileName || "");
  if (!filePath) return null;
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  for (const hunk of patch.hunks ?? []) {
    if (beforeLines.length > 0 || afterLines.length > 0) {
      beforeLines.push("");
      afterLines.push("");
    }
    for (const line of hunk.lines) {
      if (!line) continue;
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === " ") {
        beforeLines.push(content);
        afterLines.push(content);
      } else if (prefix === "-") {
        beforeLines.push(content);
      } else if (prefix === "+") {
        afterLines.push(content);
      }
    }
  }
  return { path: filePath, before: beforeLines.join("\n"), after: afterLines.join("\n") };
}

async function buildFileViewsFromPatch(
  unified: string,
  state: Map<string, string>,
  baselineResolver?: (filePath: string) => Promise<string | null>,
): Promise<DiffFileView[]> {
  const patches = parsePatch(unified);
  const files: DiffFileView[] = [];
  for (const patch of patches) {
    const filePath = normalizeFilePath(patch.newFileName || patch.oldFileName || "");
    if (!filePath) continue;
    let before = state.get(filePath);
    const hasState = before !== undefined;
    let baselineMissing = false;
    if (!hasState && baselineResolver) {
      const resolved = await baselineResolver(filePath);
      if (resolved === null) {
        baselineMissing = true;
      } else {
        before = resolved;
      }
    }
    if (before === undefined) baselineMissing = true;
    if (baselineMissing) {
      const partial = buildPartialView(patch);
      if (partial) files.push(partial);
      continue;
    }
    const beforeText = before ?? "";
    const applied = applyPatch(beforeText, patch);
    if (applied === false) {
      const partial = buildPartialView(patch);
      if (partial) files.push(partial);
      continue;
    }
    const after = String(applied);
    state.set(filePath, after);
    files.push({ path: filePath, before: beforeText, after });
  }
  return files;
}

function extractClaudeTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const t = (item as { type?: unknown }).type;
    if (t === "text" && typeof (item as { text?: unknown }).text === "string") {
      out.push((item as { text: string }).text);
    }
  }
  return out.join("");
}

export async function buildRunArtifactsFromJsonl(
  files: string[],
  agent: SessionAgent,
  opts?: {
    baselineResolver?: (filePath: string) => Promise<string | null>;
    fallbackPatch?: string | null;
    fallbackTimestamp?: number | null;
  },
): Promise<{
  diffs: DiffEntry[];
  commands: CommandEntry[];
}> {
  const diffs: DiffEntry[] = [];
  const commands: CommandEntry[] = [];
  let currentCommand: CommandEntry | null = null;
  const fileState = new Map<string, string>();
  const claudeToolMap = new Map<string, CommandEntry>();
  const codexCommandMap = new Map<string, CommandEntry>();

  for (const file of files) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (!raw) continue;
    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const obj = safeJsonParse(trimmed);
      if (!obj) continue;

      const ts = eventTimestamp(obj);
      if (agent === "claude_code") {
        if (obj.type === "assistant" || obj.type === "user") {
          const message = obj.message && typeof obj.message === "object" ? obj.message : null;
          const content = message ? (message as any).content : null;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const blockType = (block as any).type;
            if (blockType === "tool_use") {
              const name = typeof (block as any).name === "string" ? (block as any).name : "";
              if (name !== "Bash") continue;
              const input = (block as any).input;
              const cmd = input && typeof input === "object" ? (input as any).command : null;
              if (!cmd || typeof cmd !== "string") continue;
              const entry: CommandEntry = {
                id: `${path.basename(file)}:${commands.length}`,
                timestamp: ts,
                cwd: null,
                command: cmd,
                output: "",
                exitCode: null,
              };
              commands.push(entry);
              const callId = typeof (block as any).id === "string" ? (block as any).id : null;
              if (callId) claudeToolMap.set(callId, entry);
            }
            if (blockType === "tool_result") {
              const callId = typeof (block as any).tool_use_id === "string" ? (block as any).tool_use_id : null;
              const entry = callId ? claudeToolMap.get(callId) : null;
              const output =
                typeof (block as any).content === "string"
                  ? (block as any).content
                  : extractClaudeTextBlocks((block as any).content);
              if (entry && output) {
                entry.output += output;
              }
              if (callId) claudeToolMap.delete(callId);
            }
          }
        }
        continue;
      }

      if (obj && typeof obj === "object") {
        const type = typeof (obj as any).type === "string" ? (obj as any).type : "";
        const item = (obj as any).item;
        if (type.startsWith("item.") && item && typeof item === "object") {
          const itemType = typeof (item as any).type === "string" ? (item as any).type : "";
          if (itemType === "command_execution") {
            const itemId = typeof (item as any).id === "string" ? (item as any).id : `${commands.length}`;
            const key = `${path.basename(file)}:${itemId}`;
            let entry = codexCommandMap.get(key);
            if (!entry) {
              const cmd = typeof (item as any).command === "string" ? (item as any).command : "";
              if (cmd) {
                entry = {
                  id: key,
                  timestamp: ts,
                  cwd: null,
                  command: cmd,
                  output: "",
                  exitCode: null,
                };
                commands.push(entry);
                codexCommandMap.set(key, entry);
              }
            }
            if (entry) {
              if (entry.timestamp === null && ts !== null) entry.timestamp = ts;
              const output = typeof (item as any).aggregated_output === "string" ? (item as any).aggregated_output : "";
              if (output) entry.output = output;
              if (typeof (item as any).exit_code === "number") entry.exitCode = (item as any).exit_code;
            }
          }
        }
      }

      if (obj.type === "event_msg" && obj.payload && typeof obj.payload === "object") {
        const payload = obj.payload;
        if (payload.type === "exec_command_begin") {
          const cmd = Array.isArray(payload.command) ? payload.command.join(" ") : String(payload.command ?? "");
          if (cmd) {
            currentCommand = {
              id: `${path.basename(file)}:${commands.length}`,
              timestamp: ts,
              cwd: typeof payload.cwd === "string" ? payload.cwd : null,
              command: cmd,
              output: "",
              exitCode: null,
            };
            commands.push(currentCommand);
          }
        } else if (payload.type === "exec_command_output_delta") {
          if (currentCommand) {
            currentCommand.output += decodeBase64ToString(payload.chunk);
          }
        } else if (payload.type === "exec_command_end") {
          if (currentCommand) {
            currentCommand.exitCode = typeof payload.exit_code === "number" ? payload.exit_code : null;
            currentCommand = null;
          }
        } else if (payload.type === "turn_diff") {
          const patch = typeof payload.unified_diff === "string" ? payload.unified_diff : "";
          if (patch) {
            const files = await buildFileViewsFromPatch(patch, fileState, opts?.baselineResolver);
            diffs.push({
              id: `${path.basename(file)}:${diffs.length}`,
              timestamp: ts,
              patch,
              files,
            });
          }
        }
      }
    }
  }

  if (diffs.length === 0 && opts?.fallbackPatch) {
    const files = await buildFileViewsFromPatch(opts.fallbackPatch, fileState, opts?.baselineResolver);
    if (files.length > 0) {
      diffs.push({
        id: `fallback:${diffs.length}`,
        timestamp: opts.fallbackTimestamp ?? null,
        patch: opts.fallbackPatch,
        files,
      });
    }
  }

  return { diffs, commands };
}
