import type { SettingsCommand } from "./types.js";

export function parseSettingsArgs(args: string): SettingsCommand {
  if (!args) {
    return { kind: "list" };
  }
  const setMatch = args.match(/^set\s+(\S+)\s+(.+)$/i);
  if (setMatch) {
    return { kind: "set", target: setMatch[1]!, value: setMatch[2]! };
  }
  const unsetMatch = args.match(/^(?:unset|del|delete|rm)\s+(\S+)$/i);
  if (unsetMatch) {
    return { kind: "unset", target: unsetMatch[1]! };
  }
  return { kind: "list" };
}
