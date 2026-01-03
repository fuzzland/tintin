import crypto from "node:crypto";

export interface SetupSpecEnv {
  name: string;
  value?: string;
}

export interface SetupSpecFile {
  path: string;
  mode?: string;
  content?: string;
}

export interface SetupSpec {
  version: number;
  name?: string;
  provider?: string;
  env?: SetupSpecEnv[];
  files?: SetupSpecFile[];
  commands?: string[];
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    if (trimmed.startsWith("\"")) return inner.replace(/\\"/g, "\"");
    return inner.replace(/''/g, "'");
  }
  return trimmed;
}

function parseKeyValue(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(":");
  if (idx <= 0) return null;
  const key = line.slice(0, idx).trim();
  const value = stripQuotes(line.slice(idx + 1));
  if (!key) return null;
  return { key, value };
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

export function parseSetupSpec(text: string): SetupSpec {
  const lines = text.split(/\r?\n/);
  const spec: SetupSpec = { version: 1 };
  let currentKey: string | null = null;

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = indentOf(rawLine);
    if (indent === 0) {
      const kv = parseKeyValue(trimmed);
      if (!kv) {
        i++;
        continue;
      }
      currentKey = kv.key;
      if (kv.value.length === 0) {
        i++;
        continue;
      }
      if (kv.key === "version") spec.version = Number(kv.value) || 1;
      else if (kv.key === "name") spec.name = kv.value;
      else if (kv.key === "provider") spec.provider = kv.value;
      i++;
      continue;
    }

    if (!currentKey) {
      i++;
      continue;
    }

    if (currentKey === "commands") {
      if (trimmed.startsWith("-")) {
        const cmd = stripQuotes(trimmed.replace(/^-+/, ""));
        if (!spec.commands) spec.commands = [];
        if (cmd.length > 0) spec.commands.push(cmd);
      }
      i++;
      continue;
    }

    if (currentKey === "env" || currentKey === "files") {
      if (!trimmed.startsWith("-")) {
        i++;
        continue;
      }
      const item: Record<string, string> = {};
      const first = trimmed.replace(/^-+/, "").trim();
      const firstKv = parseKeyValue(first);
      if (firstKv) item[firstKv.key] = firstKv.value;
      i++;

      while (i < lines.length) {
        const nextRaw = lines[i] ?? "";
        if (!nextRaw.trim()) {
          i++;
          continue;
        }
        const nextIndent = indentOf(nextRaw);
        if (nextIndent <= indent) break;
        const nextTrim = nextRaw.trim();
        if (nextTrim.startsWith("-")) break;
        const nextKv = parseKeyValue(nextTrim);
        if (nextKv) item[nextKv.key] = nextKv.value;
        i++;
      }

      if (currentKey === "env") {
        if (!spec.env) spec.env = [];
        if (typeof item.name === "string" && item.name.length > 0) {
          spec.env.push({ name: item.name, value: item.value });
        }
      } else {
        if (!spec.files) spec.files = [];
        if (typeof item.path === "string" && item.path.length > 0) {
          spec.files.push({ path: item.path, mode: item.mode, content: item.content });
        }
      }
      continue;
    }

    i++;
  }

  return spec;
}

function quote(value: string): string {
  const escaped = value.replace(/"/g, "\\\"");
  return `"${escaped}"`;
}

export function stringifySetupSpec(spec: SetupSpec): string {
  const lines: string[] = [];
  lines.push(`version: ${spec.version ?? 1}`);
  if (spec.name) lines.push(`name: ${quote(spec.name)}`);
  if (spec.provider) lines.push(`provider: ${quote(spec.provider)}`);

  if (spec.env && spec.env.length > 0) {
    lines.push("env:");
    for (const entry of spec.env) {
      lines.push(`  - name: ${quote(entry.name)}`);
      if (entry.value !== undefined) lines.push(`    value: ${quote(entry.value)}`);
    }
  }

  if (spec.files && spec.files.length > 0) {
    lines.push("files:");
    for (const file of spec.files) {
      lines.push(`  - path: ${quote(file.path)}`);
      if (file.mode) lines.push(`    mode: ${quote(file.mode)}`);
      if (file.content !== undefined) lines.push(`    content: ${quote(file.content)}`);
    }
  }

  if (spec.commands && spec.commands.length > 0) {
    lines.push("commands:");
    for (const cmd of spec.commands) {
      lines.push(`  - ${quote(cmd)}`);
    }
  }

  return lines.join("\n") + "\n";
}

export function hashSetupSpec(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
