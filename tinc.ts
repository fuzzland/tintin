#!/usr/bin/env node
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { generateSetupSpecFromPath } from "./src/runtime/cloud/lift.js";
import { stringifySetupSpec } from "./src/runtime/cloud/setupSpec.js";

interface CliArgs {
  command: string | null;
  url: string | null;
  token: string | null;
  rest: string[];
}

interface ApiConfig {
  baseUrl: string;
  token: string;
}

type AttachFragment = { text: string; continuous?: boolean };

type SseEvent = { event: string; data: unknown };

const ENV_URL_KEYS = ["TINC_URL", "TINTIN_CLOUD_URL", "TINTIN_URL"];
const ENV_TOKEN_KEYS = ["TINC_TOKEN", "TINTIN_CLOUD_TOKEN", "TINTIN_TOKEN"];

function envFirst(keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
}

function parseCliArgs(argv: string[]): CliArgs {
  let command: string | null = null;
  let url: string | null = envFirst(ENV_URL_KEYS);
  let token: string | null = envFirst(ENV_TOKEN_KEYS);
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--url" || arg === "--base-url") {
      const v = argv[i + 1];
      if (!v) throw new Error(`${arg} requires a value`);
      url = v;
      i++;
      continue;
    }
    if (arg.startsWith("--url=") || arg.startsWith("--base-url=")) {
      url = arg.split("=", 2)[1] ?? "";
      continue;
    }
    if (arg === "--token") {
      const v = argv[i + 1];
      if (!v) throw new Error("--token requires a value");
      token = v;
      i++;
      continue;
    }
    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }
    if (!command) {
      command = arg;
      continue;
    }
    rest.push(arg);
  }
  return { command, url, token, rest };
}

function showHelp() {
  console.log(`tinc cloud CLI

Usage:
  tinc pull --run <id> [--output <path>] [--url <base>] [--token <token>]
  tinc attach --run <id> [--raw] [--once] [--poll <ms>] [--url <base>] [--token <token>]
  tinc lift [--repo <path>] [--output tintin-setup.yml] [--force]
  tinc secrets set <name> <value> [--from-stdin] [--url <base>] [--token <token>]
  tinc secrets create <name> <value> [--from-stdin] [--url <base>] [--token <token>]
  tinc secrets update <name> <value> [--from-stdin] [--url <base>] [--token <token>]
  tinc secrets list [--url <base>] [--token <token>]
  tinc secrets delete <name> [--url <base>] [--token <token>]

Environment:
  ${ENV_URL_KEYS.join(" ")} (API base URL, default: http://127.0.0.1:8787)
  ${ENV_TOKEN_KEYS.join(" ")} (API token; run "tinc token" in chat)
`);
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Missing API base URL.");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/g, "");
}

function resolveApiConfig(args: CliArgs): ApiConfig {
  const baseUrl = normalizeBaseUrl(args.url ?? "http://127.0.0.1:8787");
  const token = args.token ?? "";
  if (!token) {
    throw new Error("Missing API token. Run \"tinc token\" in chat or set TINC_TOKEN.");
  }
  return { baseUrl, token };
}

function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/g, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/api/cloud")) return `${base}${suffix}`;
  if (base.endsWith("/api")) return `${base}/cloud${suffix}`;
  return `${base}/api/cloud${suffix}`;
}

async function apiRequest<T>(cfg: ApiConfig, method: string, path: string, body?: unknown): Promise<T> {
  const url = buildApiUrl(cfg.baseUrl, path);
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    const message = text || res.statusText;
    throw new Error(`Request failed (${res.status}): ${message}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
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
  const api = resolveApiConfig(args);
  const run = await apiRequest<any>(api, "GET", `/runs/${encodeURIComponent(runId)}`);
  if (!run || typeof run !== "object") throw new Error("Run not found.");
  const diff = run.diff_patch ?? run.diff_summary ?? "";
  if (outputFlag.value) {
    await writeFile(outputFlag.value, diff, "utf8");
    console.log(`Wrote diff to ${outputFlag.value}`);
  } else {
    console.log(diff);
  }
}

async function streamSse(url: string, headers: Record<string, string>, onEvent: (event: SseEvent) => void) {
  const res = await fetch(url, {
    method: "GET",
    headers: { ...headers, Accept: "text/event-stream" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed (${res.status}): ${text || res.statusText}`);
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (dataLines.length > 0) {
          const dataText = dataLines.join("\n");
          let data: unknown = dataText;
          try {
            data = JSON.parse(dataText);
          } catch {
            // keep as string
          }
          onEvent({ event: eventName || "message", data });
        }
        eventName = "";
        dataLines = [];
        idx = buffer.indexOf("\n");
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
      idx = buffer.indexOf("\n");
    }
  }
}

function formatPlanUpdate(plan: unknown, explanation: unknown): string {
  const lines: string[] = ["Plan update"];
  if (typeof explanation === "string" && explanation.trim().length > 0) lines.push(explanation.trim());
  if (Array.isArray(plan)) {
    const steps = plan
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const step = typeof (item as any).step === "string" ? (item as any).step : "";
        const status = typeof (item as any).status === "string" ? (item as any).status : "";
        if (!step && !status) return null;
        return `- [${status || "?"}] ${step}`.trim();
      })
      .filter((v): v is string => Boolean(v));
    if (steps.length > 0) lines.push(...steps);
  }
  return lines.join("\n");
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
  const pollMs = Number.isFinite(parsedPoll) && parsedPoll > 0 ? Math.floor(parsedPoll) : null;

  const api = resolveApiConfig(args);
  const params = new URLSearchParams();
  if (once) params.set("once", "1");
  if (pollMs) params.set("poll", String(pollMs));
  const base = buildApiUrl(api.baseUrl, `/runs/${encodeURIComponent(runId)}/events`);
  const url = params.toString() ? `${base}?${params.toString()}` : base;

  let lastWasContinuous = false;
  const emit = (frag: AttachFragment) => {
    if (!frag.text) return;
    if (!frag.continuous && lastWasContinuous) process.stdout.write("\n");
    if (frag.continuous) process.stdout.write(frag.text);
    else process.stdout.write(`${frag.text}\n`);
    lastWasContinuous = Boolean(frag.continuous);
  };

  await streamSse(url, { Authorization: `Bearer ${api.token}` }, ({ event, data }) => {
    if (event === "ready") return;
    if (raw) {
      const output = typeof data === "string" ? data : JSON.stringify(data);
      process.stdout.write(`${output}\n`);
      return;
    }
    if (data && typeof data === "object") {
      const kind = typeof (data as any).kind === "string" ? (data as any).kind : "";
      if (kind === "plan_update") {
        emit({ text: formatPlanUpdate((data as any).plan, (data as any).explanation) });
        return;
      }
      if (kind === "final") return;
      const text = typeof (data as any).text === "string" ? (data as any).text : "";
      if (text) {
        const continuous = Boolean((data as any).continuous);
        emit({ text, continuous });
        return;
      }
    }
    if (typeof data === "string") emit({ text: data });
  });

  if (lastWasContinuous) process.stdout.write("\n");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
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

async function runSecrets(args: CliArgs) {
  const [sub, ...rest] = args.rest;
  if (!sub) throw new Error("secrets requires a subcommand");
  const normalizeSub = sub.toLowerCase();
  const api = resolveApiConfig(args);

  if (normalizeSub === "list") {
    const result = await apiRequest<{ secrets: Array<{ name: string }> }>(api, "GET", "/secrets");
    const secrets = result?.secrets ?? [];
    if (secrets.length === 0) {
      console.log("No secrets.");
      return;
    }
    for (const s of secrets) console.log(s.name);
    return;
  }

  if (normalizeSub === "create" || normalizeSub === "update" || normalizeSub === "set") {
    const name = rest[0];
    if (!name) throw new Error(`secrets ${normalizeSub} requires a name`);
    const fromStdin = rest.includes("--from-stdin");
    const valueParts = rest.slice(1).filter((v) => v !== "--from-stdin");
    const value = fromStdin ? await readStdin() : valueParts.join(" ");
    if (!value) throw new Error("Missing secret value.");
    const mode = normalizeSub === "create" ? "create" : normalizeSub === "update" ? "update" : "set";
    await apiRequest(api, "POST", "/secrets", { name, value: value.trim(), mode });
    if (normalizeSub === "create") console.log(`Created ${name}`);
    else if (normalizeSub === "update") console.log(`Updated ${name}`);
    else console.log(`Saved ${name}`);
    return;
  }

  if (normalizeSub === "delete") {
    const name = rest[0];
    if (!name) throw new Error("secrets delete requires a name");
    const result = await apiRequest<{ deleted: boolean }>(api, "DELETE", `/secrets/${encodeURIComponent(name)}`);
    console.log(result?.deleted ? `Deleted ${name}` : "Secret not found.");
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
