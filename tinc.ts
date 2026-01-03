#!/usr/bin/env node
import { open, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "./src/runtime/config.js";
import { createDatabase } from "./src/runtime/db.js";
import { createLogger } from "./src/runtime/log.js";
import { encryptSecret } from "./src/runtime/cloud/secrets.js";
import { generateSetupSpecFromPath } from "./src/runtime/cloud/lift.js";
import { stringifySetupSpec } from "./src/runtime/cloud/setupSpec.js";
import { getCloudRun, getOrCreateIdentity, listSecrets, setSecret, deleteSecret } from "./src/runtime/cloud/store.js";
import { getAgentAdapter } from "./src/runtime/agents.js";
import { sleep } from "./src/runtime/util.js";


interface CliArgs {
  command: string | null;
  configPath: string;
  rest: string[];
}

function parseCliArgs(argv: string[]): CliArgs {
  let command: string | null = null;
  let configPath = process.env.CONFIG_PATH ?? "./config.toml";
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--config" || arg === "-c") {
      const v = argv[i + 1];
      if (!v) throw new Error("--config requires a value");
      configPath = v;
      i++;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (!command) {
      command = arg;
      continue;
    }
    rest.push(arg);
  }
  return { command, configPath, rest };
}

function showHelp() {
  console.log(`tinc cloud CLI

Usage:
  tinc pull --run <id> [--output <path>]
  tinc attach --run <id> [--raw] [--once] [--poll <ms>]
  tinc lift [--repo <path>] [--output tintin-setup.yml] [--force]
  tinc secrets set <name> <value> --platform <slack|telegram> --user <id> [--workspace <id>]
  tinc secrets set <name> --from-stdin --platform <slack|telegram> --user <id> [--workspace <id>]
  tinc secrets create <name> <value> --platform <slack|telegram> --user <id> [--workspace <id>]
  tinc secrets update <name> <value> --platform <slack|telegram> --user <id> [--workspace <id>]
  tinc secrets read <name> --platform <slack|telegram> --user <id> [--workspace <id>]
  tinc secrets list --platform <slack|telegram> --user <id> [--workspace <id>]
  tinc secrets delete <name> --platform <slack|telegram> --user <id> [--workspace <id>]
`);
}

async function ensureConfig(configPath: string) {
  const config = await loadConfig(configPath);
  const logger = createLogger(config.bot.log_level);
  const db = await createDatabase(config, logger);
  return { config, logger, db };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function parseFlagValue(rest: string[], flag: string): { value: string | null; rest: string[] } {
  const out: string[] = [];
  let value: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === flag && rest[i + 1]) {
      value = rest[i + 1]!;
      i++;
      continue;
    }
    if (token.startsWith(`${flag}=`)) {
      value = token.split("=", 2)[1]!;
      continue;
    }
    out.push(token);
  }
  return { value, rest: out };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as any));
  return Buffer.concat(chunks).toString("utf8");
}

async function runPull(args: CliArgs) {
  let rest = [...args.rest];
  const runFlag = parseFlagValue(rest, "--run");
  rest = runFlag.rest;
  const outputFlag = parseFlagValue(rest, "--output");
  rest = outputFlag.rest;
  const runId = runFlag.value ?? rest[0];
  if (!runId) throw new Error("pull requires --run <id>");
  const { config, db } = await ensureConfig(args.configPath);
  if (!config.cloud?.enabled) throw new Error("Cloud mode is disabled.");
  const run = await getCloudRun(db, runId);
  if (!run) throw new Error("Run not found.");
  const diff = run.diff_patch ?? run.diff_summary ?? "";
  if (outputFlag.value) {
    await writeFile(outputFlag.value, diff, "utf8");
    console.log(`Wrote diff to ${outputFlag.value}`);
  } else {
    console.log(diff);
  }
}

type AttachFragment = { text: string; continuous?: boolean };

function decodeBase64ToString(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return value;
  }
}

function formatCommand(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(" ");
  return "";
}

function extractTextBlocks(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const block of value) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("");
}

function formatCodexLine(obj: any): AttachFragment[] {
  if (!obj || typeof obj !== "object") return [];
  const type = typeof obj.type === "string" ? obj.type : "";

  if (type === "event_msg" && obj.payload && typeof obj.payload === "object") {
    const payload = obj.payload as Record<string, unknown>;
    const evType = typeof payload.type === "string" ? payload.type : "";
    switch (evType) {
      case "agent_message": {
        const msg = typeof payload.message === "string" ? payload.message : "";
        return msg ? [{ text: msg }] : [];
      }
      case "agent_message_delta":
      case "agent_message_content_delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        return delta ? [{ text: delta, continuous: true }] : [];
      }
      case "exec_command_begin": {
        const cmd = formatCommand(payload.command);
        return cmd ? [{ text: `$ ${cmd}` }] : [];
      }
      case "exec_command_output_delta": {
        const chunk = decodeBase64ToString(payload.chunk);
        return chunk ? [{ text: chunk, continuous: true }] : [];
      }
      case "exec_command_end": {
        const cmd = formatCommand(payload.command);
        const exit = typeof payload.exit_code === "number" ? payload.exit_code : null;
        if (!cmd) return [];
        const suffix = exit !== null ? ` (exit ${exit})` : "";
        return [{ text: `$ ${cmd} completed${suffix}` }];
      }
      case "error": {
        const msg = typeof payload.message === "string" ? payload.message : "";
        return msg ? [{ text: `Error: ${msg}` }] : [];
      }
      case "warning": {
        const msg = typeof payload.message === "string" ? payload.message : "";
        return msg ? [{ text: `Warning: ${msg}` }] : [];
      }
      default:
        return [];
    }
  }

  if (type === "response_item" && obj.payload && typeof obj.payload === "object") {
    const payload = obj.payload as Record<string, unknown>;
    const itemType = typeof payload.type === "string" ? payload.type : "";
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      return [{ text: `Tool: ${name}` }];
    }
    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const output = typeof payload.output === "string" ? payload.output : "";
      return output ? [{ text: output }] : [];
    }
  }

  if (typeof type === "string" && type.startsWith("item.") && obj.item && typeof obj.item === "object") {
    if (obj.item.type === "agent_message" && typeof obj.item.text === "string") {
      return [{ text: obj.item.text }];
    }
  }

  return [];
}

function formatClaudeLine(obj: any): AttachFragment[] {
  if (!obj || typeof obj !== "object") return [];
  const type = typeof obj.type === "string" ? obj.type : "";

  if (type === "result") {
    const isError = Boolean(obj.is_error);
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
    if (isError || (subtype && subtype !== "success")) {
      return [{ text: `Result: ${subtype || "error"}` }];
    }
    return [];
  }

  if (type === "assistant" || type === "user") {
    const message = obj.message && typeof obj.message === "object" ? obj.message : null;
    const content = message ? (message as any).content : null;
    if (Array.isArray(content)) {
      const text = extractTextBlocks(content);
      const fragments: AttachFragment[] = [];
      if (text) fragments.push({ text });
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if ((block as any).type === "tool_use") {
          const name = typeof (block as any).name === "string" ? (block as any).name : "tool";
          fragments.push({ text: `Tool: ${name}` });
        }
        if ((block as any).type === "tool_result") {
          const resultText =
            typeof (block as any).content === "string"
              ? (block as any).content
              : extractTextBlocks((block as any).content);
          if (resultText) fragments.push({ text: resultText });
        }
      }
      return fragments;
    }
  }

  return [];
}

async function readNewJsonlLines(filePath: string, offset: number): Promise<{ lines: string[]; newOffset: number }> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (offset >= stat.size) return { lines: [], newOffset: offset };

    const maxBytes = 2_000_000;
    const remaining = stat.size - offset;
    const toRead = Math.min(remaining, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, offset);
    const slice = buf.subarray(0, bytesRead);

    const lastNewline = slice.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], newOffset: offset };

    const complete = slice.subarray(0, lastNewline);
    const text = complete.toString("utf8");
    const lines = text.split("\n");
    const newOffset = offset + lastNewline + 1;
    return { lines, newOffset };
  } finally {
    await handle.close();
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path.join(dir, e.name));
  files.sort();
  return files;
}

async function runAttach(args: CliArgs) {
  let rest = [...args.rest];
  const runFlag = parseFlagValue(rest, "--run");
  rest = runFlag.rest;
  const runId = runFlag.value ?? rest[0];
  if (!runId) throw new Error("attach requires --run <id>");
  const raw = rest.includes("--raw");
  const once = rest.includes("--once");
  const pollFlag = parseFlagValue(rest, "--poll");
  const parsedPoll = pollFlag.value ? Number(pollFlag.value) : NaN;
  const pollMs = Number.isFinite(parsedPoll) && parsedPoll > 0 ? parsedPoll : 500;

  const { config, db } = await ensureConfig(args.configPath);
  if (!config.cloud?.enabled) throw new Error("Cloud mode is disabled.");
  const run = await getCloudRun(db, runId);
  if (!run) throw new Error("Run not found.");
  if (!run.session_id) throw new Error("Run has no session id yet.");

  let session = await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id).executeTakeFirst();
  if (!session) throw new Error("Session not found.");

  let files: string[] = [];
  const follow = !once;
  const isE2B = run.provider === "e2b";
  const logsDir = isE2B && config.cloud?.workspaces_dir ? path.join(config.cloud.workspaces_dir, "logs", run.session_id) : null;

  const resolveFiles = async (): Promise<string[]> => {
    if (isE2B) {
      if (!logsDir) return [];
      return await listJsonlFiles(logsDir);
    }
    if (!session?.codex_session_id) {
      session = await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id!).executeTakeFirst();
    }
    if (!session?.codex_session_id) return [];
    const adapter = getAgentAdapter(session.agent);
    const sessionsRoot = adapter.resolveSessionsRoot(session.codex_cwd, config);
    const homeDir = adapter.resolveHomeDir(sessionsRoot);
    return await adapter.findSessionJsonlFiles({
      sessionsRoot,
      homeDir,
      cwd: session.codex_cwd,
      sessionId: session.codex_session_id,
      timeoutMs: 5_000,
      pollMs: 200,
    });
  };

  const waitForFiles = async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      files = await resolveFiles();
      if (files.length > 0) return;
      await sleep(250);
      session = await db.selectFrom("sessions").selectAll().where("id", "=", run.session_id!).executeTakeFirst();
    }
  };

  await waitForFiles();
  if (files.length === 0 && !follow) throw new Error("No JSONL logs found.");

  const offsets = new Map<string, number>();
  let lastWasContinuous = false;
  const emit = (frag: AttachFragment) => {
    if (!frag.text) return;
    if (!frag.continuous && lastWasContinuous) process.stdout.write("\n");
    if (frag.continuous) process.stdout.write(frag.text);
    else process.stdout.write(`${frag.text}\n`);
    lastWasContinuous = Boolean(frag.continuous);
  };

  while (true) {
    let hadNew = false;
    if (follow) {
      const latest = await resolveFiles();
      for (const f of latest) {
        if (!files.includes(f)) files.push(f);
      }
    }

    for (const file of files) {
      const offset = offsets.get(file) ?? 0;
      const { lines, newOffset } = await readNewJsonlLines(file, offset);
      if (lines.length === 0) continue;
      offsets.set(file, newOffset);
      hadNew = true;
      for (const line of lines) {
        if (raw) {
          emit({ text: line });
          continue;
        }
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          emit({ text: line });
          continue;
        }
        const fragments = session?.agent === "claude_code" ? formatClaudeLine(obj) : formatCodexLine(obj);
        for (const frag of fragments) emit(frag);
      }
    }

    if (!follow) break;
    if (!hadNew) {
      const current = await db
        .selectFrom("sessions")
        .select(["status"])
        .where("id", "=", run.session_id!)
        .executeTakeFirst();
      if (current && current.status !== "running" && current.status !== "starting") break;
    }
    await sleep(pollMs);
  }

  if (lastWasContinuous) process.stdout.write("\n");
}

async function runLift(args: CliArgs) {
  let rest = [...args.rest];
  const repoFlag = parseFlagValue(rest, "--repo");
  rest = repoFlag.rest;
  const outputFlag = parseFlagValue(rest, "--output");
  rest = outputFlag.rest;
  const force = rest.includes("--force");
  const repoPath = repoFlag.value ?? ".";
  const outputPath = outputFlag.value ?? "tintin-setup.yml";
  const absRepo = path.resolve(process.cwd(), repoPath);
  if (!(await pathExists(absRepo))) throw new Error(`Repo path not found: ${absRepo}`);
  const absOut = path.resolve(absRepo, outputPath);
  if ((await pathExists(absOut)) && !force) {
    throw new Error(`File already exists: ${absOut} (use --force to overwrite)`);
  }
  const spec = await generateSetupSpecFromPath(absRepo);
  const yml = stringifySetupSpec(spec);
  await writeFile(absOut, yml, "utf8");
  console.log(`Wrote ${absOut}`);
}

function parseIdentityFlags(rest: string[]) {
  const platformFlag = parseFlagValue(rest, "--platform");
  rest = platformFlag.rest;
  const userFlag = parseFlagValue(rest, "--user");
  rest = userFlag.rest;
  const workspaceFlag = parseFlagValue(rest, "--workspace");
  rest = workspaceFlag.rest;
  const platform = platformFlag.value;
  const userId = userFlag.value;
  const workspaceId = workspaceFlag.value ?? null;
  if (!platform || !userId) throw new Error("--platform and --user are required");
  return { platform, userId, workspaceId, rest };
}

async function runSecrets(args: CliArgs) {
  const [sub, ...rest] = args.rest;
  if (!sub) throw new Error("secrets requires a subcommand");
  const normalizeSub = sub.toLowerCase();
  if (normalizeSub === "list") {
    const identity = parseIdentityFlags(rest);
    const { config, db } = await ensureConfig(args.configPath);
    if (!config.cloud?.enabled) throw new Error("Cloud mode is disabled.");
    const ident = await getOrCreateIdentity(db, {
      platform: identity.platform,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
    });
    const secrets = await listSecrets(db, ident.id);
    if (secrets.length === 0) {
      console.log("No secrets.");
      return;
    }
    for (const s of secrets) console.log(s.name);
    return;
  }

  if (normalizeSub === "read" || normalizeSub === "get" || normalizeSub === "info") {
    const name = rest[0];
    if (!name) throw new Error("secrets read requires a name");
    const identity = parseIdentityFlags(rest.slice(1));
    const { config, db } = await ensureConfig(args.configPath);
    if (!config.cloud?.enabled) throw new Error("Cloud mode is disabled.");
    const ident = await getOrCreateIdentity(db, {
      platform: identity.platform,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
    });
    const secrets = await listSecrets(db, ident.id);
    const secret = secrets.find((s) => s.name === name) ?? null;
    if (!secret) throw new Error("Secret not found.");
    const createdAt = secret.created_at ? new Date(secret.created_at).toISOString() : "unknown";
    const updatedAt = secret.updated_at ? new Date(secret.updated_at).toISOString() : "unknown";
    console.log(`${secret.name}`);
    console.log(`created: ${createdAt}`);
    console.log(`updated: ${updatedAt}`);
    return;
  }

  if (normalizeSub === "create") {
    const name = rest[0];
    if (!name) throw new Error("secrets create requires a name");
    const identity = parseIdentityFlags(rest.slice(1));
    const { config, db } = await ensureConfig(args.configPath);
    if (!config.cloud?.enabled) throw new Error("Cloud mode is disabled.");
    const ident = await getOrCreateIdentity(db, {
      platform: identity.platform,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
    });
    const secrets = await listSecrets(db, ident.id);
    if (secrets.some((s) => s.name === name)) throw new Error("Secret already exists.");
    const fromStdin = identity.rest.includes("--from-stdin");
    const value = fromStdin ? (await readStdin()) : identity.rest.join(" ");
    if (!value) throw new Error("Missing secret value.");
    const encrypted = encryptSecret(value.trim(), config.cloud.secrets_key);
    await setSecret(db, { identityId: ident.id, name, encryptedValue: encrypted });
    console.log(`Created ${name}`);
    return;
  }

  if (normalizeSub === "update") {
    const name = rest[0];
    if (!name) throw new Error("secrets update requires a name");
    const identity = parseIdentityFlags(rest.slice(1));
    const { config, db } = await ensureConfig(args.configPath);
    if (!config.cloud?.enabled) throw new Error("Cloud mode is disabled.");
    const ident = await getOrCreateIdentity(db, {
      platform: identity.platform,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
    });
    const secrets = await listSecrets(db, ident.id);
    if (!secrets.some((s) => s.name === name)) throw new Error("Secret not found.");
    const fromStdin = identity.rest.includes("--from-stdin");
    const value = fromStdin ? (await readStdin()) : identity.rest.join(" ");
    if (!value) throw new Error("Missing secret value.");
    const encrypted = encryptSecret(value.trim(), config.cloud.secrets_key);
    await setSecret(db, { identityId: ident.id, name, encryptedValue: encrypted });
    console.log(`Updated ${name}`);
    return;
  }

  if (normalizeSub === "set") {
    const name = rest[0];
    if (!name) throw new Error("secrets set requires a name");
    const identity = parseIdentityFlags(rest.slice(1));
    const { config, db } = await ensureConfig(args.configPath);
    if (!config.cloud?.enabled) throw new Error("Cloud mode is disabled.");
    const ident = await getOrCreateIdentity(db, {
      platform: identity.platform,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
    });
    const fromStdin = identity.rest.includes("--from-stdin");
    const value = fromStdin ? (await readStdin()) : identity.rest.join(" ");
    if (!value) throw new Error("Missing secret value.");
    const encrypted = encryptSecret(value.trim(), config.cloud.secrets_key);
    await setSecret(db, { identityId: ident.id, name, encryptedValue: encrypted });
    console.log(`Saved ${name}`);
    return;
  }

  if (normalizeSub === "delete") {
    const name = rest[0];
    if (!name) throw new Error("secrets delete requires a name");
    const identity = parseIdentityFlags(rest.slice(1));
    const { config, db } = await ensureConfig(args.configPath);
    if (!config.cloud?.enabled) throw new Error("Cloud mode is disabled.");
    const ident = await getOrCreateIdentity(db, {
      platform: identity.platform,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
    });
    const ok = await deleteSecret(db, ident.id, name);
    console.log(ok ? `Deleted ${name}` : "Secret not found.");
    return;
  }

  throw new Error(`Unknown secrets subcommand: ${sub}`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  switch (args.command) {
    case "pull":
      await runPull(args);
      return;
    case "attach":
      await runAttach(args);
      return;
    case "lift":
      await runLift(args);
      return;
    case "secrets":
      await runSecrets(args);
      return;
    case null:
    case undefined:
    case "help":
    case "--help":
    case "-h":
      showHelp();
      return;
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
