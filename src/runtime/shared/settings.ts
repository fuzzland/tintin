import type { SettingsCommand } from "./types.js";

export function parseSettingsArgs(args: string): SettingsCommand {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "list" };
  const parts = trimmed.split(/\s+/);
  const head = (parts.shift() ?? "").toLowerCase();
  if (!head) return { kind: "list" };
  if (head === "list") return { kind: "list" };

  if (head === "mcp") {
    const sub = (parts.shift() ?? "").toLowerCase();
    if (!sub) return { kind: "list" };
    if (sub === "set" && parts.length >= 2) {
      const target = `mcp.${parts.shift()!}`;
      return { kind: "set", target, value: parts.join(" ") };
    }
    if (sub === "unset" && parts.length >= 1) {
      return { kind: "unset", target: `mcp.${parts.join(" ")}` };
    }
    return { kind: "list" };
  }

  if (head === "set" && parts.length >= 2) {
    const target = parts.shift()!;
    return { kind: "set", target, value: parts.join(" ") };
  }
  if (head === "unset" && parts.length >= 1) {
    return { kind: "unset", target: parts.join(" ") };
  }

  if (parts.length >= 1) return { kind: "set", target: head, value: parts.join(" ") };
  return { kind: "list" };
}
