#!/usr/bin/env node
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const url = process.env.TINTIN_AGENT_URL ?? "";
const token = process.env.TINTIN_AGENT_TOKEN ?? "";
const agent = process.env.TINTIN_AGENT_AGENT ?? "";
const session = process.env.TINTIN_AGENT_SESSION ?? "";

function fail(message) {
  console.error(`[tintin-helper] ${message}`);
  process.exit(1);
}

function ensureEnv() {
  if (!url || !token) {
    const missing = !url ? "TINTIN_AGENT_URL" : "TINTIN_AGENT_TOKEN";
    fail(`missing ${missing}`);
  }
}

function resolveBaseUrl(rawUrl, sessionId) {
  const trimmed = String(rawUrl || "").replace(/\/+$/g, "");
  if (!trimmed) return "";
  const logsMatch = trimmed.match(/^(.*\/api\/cloud\/agent)\/logs\/[^/]+$/);
  if (logsMatch) return logsMatch[1];
  if (sessionId && trimmed.endsWith(`/logs/${sessionId}`)) {
    return trimmed.slice(0, -(`/logs/${sessionId}`.length));
  }
  return trimmed;
}

const baseUrl = resolveBaseUrl(url, session);

function buildUrl(pathname) {
  if (!baseUrl) return "";
  if (pathname.startsWith("/")) return `${baseUrl}${pathname}`;
  return `${baseUrl}/${pathname}`;
}

function baseHeaders(extra) {
  return {
    ...(extra || {}),
    authorization: `Bearer ${token}`,
    ...(agent ? { "x-tintin-agent": agent } : {}),
    ...(session ? { "x-tintin-session": session } : {}),
  };
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseListValue(value) {
  if (!value) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      // fall through to loose parsing
    }
    return inner
      .split(/[\s,]+/g)
      .map((v) => v.trim())
      .filter(Boolean)
      .map(stripQuotes);
  }
  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map(stripQuotes);
  }
  return [stripQuotes(trimmed)];
}

function stripQuotes(value) {
  if (!value) return value;
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArgs(argv) {
  const args = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.trim();
    if (!key) continue;
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = "";
      }
    }
    if (key === "ignore" || key === "setup") {
      const list = parseListValue(value);
      options[key] = (options[key] || []).concat(list);
    } else {
      options[key] = value;
    }
  }
  return { args, options };
}

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

function normalizeIgnoreEntries(entries, baseDir) {
  const normalized = [];
  for (const entry of entries || []) {
    if (!entry) continue;
    const trimmed = String(entry).trim();
    if (!trimmed) continue;
    if (path.isAbsolute(trimmed)) {
      const rel = path.relative(baseDir, trimmed);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        normalized.push(toPosixPath(rel));
      } else {
        normalized.push(toPosixPath(trimmed));
      }
    } else {
      normalized.push(toPosixPath(trimmed));
    }
  }
  return normalized;
}

async function runCommand(cmd, args, opts) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    if (child.stderr) child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}: ${stderr || stdout}`));
    });
  });
}

async function createArchive(dir, ignoreEntries) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tintin-archive-"));
  const archivePath = path.join(tmpDir, "payload.tar.gz");
  const excludeArgs = [];
  for (const entry of ignoreEntries || []) {
    if (!entry) continue;
    excludeArgs.push(`--exclude=${entry}`);
  }
  const args = ["-czf", archivePath, ...excludeArgs, "-C", dir, "."];
  await runCommand("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
  const cleanup = async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };
  return { archivePath, cleanup };
}

async function requestJson(method, pathname, body) {
  const endpoint = buildUrl(pathname);
  if (!endpoint) fail("invalid base URL");
  const headers = baseHeaders({ "content-type": "application/json" });
  const res = await fetch(endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text && text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    throw new Error(`request failed (${res.status}): ${text || res.statusText}`);
  }
  return { data, text };
}

async function requestUpload(pathname, meta, archivePath) {
  const endpoint = buildUrl(pathname);
  if (!endpoint) fail("invalid base URL");
  const stat = await fsp.stat(archivePath);
  const metaPayload = { ...meta, session, agent };
  const metaHeader = base64UrlEncode(Buffer.from(JSON.stringify(metaPayload)));
  const headers = baseHeaders({
    "content-type": "application/octet-stream",
    "content-length": String(stat.size),
    "x-tintin-meta": metaHeader,
  });
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: fs.createReadStream(archivePath),
    duplex: "half",
  });
  const text = await res.text();
  let data = null;
  if (text && text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    throw new Error(`request failed (${res.status}): ${text || res.statusText}`);
  }
  return { data, text };
}

function formatTuple(values) {
  return `(${values.map((v) => (v === undefined || v === null ? "" : String(v))).join(", ")})`;
}

function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.entries)) return data.entries;
  if (Array.isArray(data.rows)) return data.rows;
  return null;
}

function readTimeField(item) {
  if (!item || typeof item !== "object") return "";
  return item.time ?? item.created_at ?? item.createdAt ?? item.timestamp ?? "";
}

function printList(command, items) {
  const lines = [];
  for (const item of items) {
    if (command === "code") {
      lines.push(formatTuple([item.idx ?? item.id ?? "", item.directory ?? item.path ?? "", item.summary ?? ""]));
      continue;
    }
  if (command === "site") {
      const values = [item.idx ?? item.id ?? "", item.port ?? "", item.path ?? "", item.summary ?? ""];
      if (item.url) values.push(item.url);
      lines.push(formatTuple(values));
      continue;
    }
    if (command === "static-deploy") {
      lines.push(formatTuple([item.idx ?? item.id ?? "", readTimeField(item), item.summary ?? "", item.app_name ?? item.appName ?? "", item.url ?? ""]));
      continue;
    }
    if (command === "dynamic-deploy") {
      lines.push(formatTuple([item.idx ?? item.id ?? "", readTimeField(item), item.summary ?? "", item.app_name ?? item.appName ?? ""]));
      continue;
    }
  }
  if (lines.length > 0) {
    process.stdout.write(lines.join("\n") + "\n");
  }
}

function printResult(command, subcommand, data, text) {
  const items = extractItems(data);
  if (items && (subcommand === "list" || subcommand === "ls")) {
    printList(command, items);
    return;
  }
  if (data && typeof data === "object") {
    if (command === "code" && subcommand === "add") {
      if ("idx" in data || "id" in data) {
        const dir = data.directory ?? data.path ?? "";
        const summary = data.summary ?? "";
        process.stdout.write(formatTuple([data.idx ?? data.id, dir, summary]) + "\n");
        return;
      }
    }
    if (command === "site" && subcommand === "add") {
      if ("idx" in data || "id" in data) {
        const values = [data.idx ?? data.id, data.port ?? "", data.path ?? "", data.summary ?? ""];
        if (data.url) values.push(data.url);
        process.stdout.write(formatTuple(values) + "\n");
        return;
      }
    }
    if (command === "static-deploy" && subcommand === "new") {
      if ("idx" in data || "id" in data) {
        process.stdout.write(formatTuple([data.idx ?? data.id, data.url ?? ""]) + "\n");
        return;
      }
    }
    if (command === "dynamic-deploy" && subcommand.startsWith("new")) {
      if ("idx" in data || "id" in data) {
        if (data.log) {
          process.stdout.write(formatTuple([data.idx ?? data.id, data.log, data.url ?? ""]) + "\n");
        } else {
          process.stdout.write(formatTuple([data.idx ?? data.id, data.url ?? ""]) + "\n");
        }
        return;
      }
    }
  }
  if (text && text.trim().length > 0) {
    process.stdout.write(text.trimEnd() + "\n");
  } else if (data !== null && data !== undefined) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
}

async function handleCode(argv) {
  const { args, options } = parseArgs(argv);
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log("Usage: code add <directory> <summary> | code list | code ignore <directory|idx>");
    return;
  }
  if (sub === "list") {
    const res = await requestJson("GET", "/code/list");
    printResult("code", "list", res.data, res.text);
    return;
  }
  if (sub === "ignore") {
    const target = args[1];
    if (!target) fail("code ignore requires <directory|idx>");
    const res = await requestJson("POST", "/code/ignore", { target });
    printResult("code", "ignore", res.data, res.text);
    return;
  }
  if (sub === "add") {
    const directory = args[1];
    const summary = args[2];
    if (!directory || !summary) fail("code add requires <directory> <summary>");
    const stat = await fsp.stat(directory).catch(() => null);
    if (!stat || !stat.isDirectory()) fail(`directory not found: ${directory}`);
    const res = await requestJson("POST", "/code/add", { directory, summary });
    printResult("code", "add", res.data, res.text);
    return;
  }
  fail(`unknown code subcommand: ${sub}`);
}

async function handleSite(argv) {
  const { args } = parseArgs(argv);
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log("Usage: site add <port> <summary> [path] | site list | site ignore <idx>");
    return;
  }
  if (sub === "list") {
    const res = await requestJson("GET", "/site/list");
    printResult("site", "list", res.data, res.text);
    return;
  }
  if (sub === "ignore") {
    const idx = args[1];
    if (!idx) fail("site ignore requires <idx>");
    const res = await requestJson("POST", "/site/ignore", { idx });
    printResult("site", "ignore", res.data, res.text);
    return;
  }
  if (sub === "add") {
    const portRaw = args[1];
    const summary = args[2];
    const sitePath = args[3] ?? "";
    if (!portRaw || !summary) fail("site add requires <port> <summary> [path]");
    const port = Number(portRaw);
    if (!Number.isFinite(port)) fail("site add requires numeric <port>");
    const res = await requestJson("POST", "/site/add", { port, summary, path: sitePath });
    printResult("site", "add", res.data, res.text);
    return;
  }
  fail(`unknown site subcommand: ${sub}`);
}

async function handleStaticDeploy(argv) {
  const { args, options } = parseArgs(argv);
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log("Usage: static-deploy new <directory> <summary> <app_name> [--ignore <list>] | static-deploy list | static-deploy rollback <idx>");
    return;
  }
  if (sub === "list") {
    const res = await requestJson("GET", "/static-deploy/list");
    printResult("static-deploy", "list", res.data, res.text);
    return;
  }
  if (sub === "rollback") {
    const idx = args[1];
    if (!idx) fail("static-deploy rollback requires <idx>");
    const res = await requestJson("POST", "/static-deploy/rollback", { idx });
    printResult("static-deploy", "rollback", res.data, res.text);
    return;
  }
  if (sub === "new") {
    const directory = args[1];
    const summary = args[2];
    const appName = args[3];
    if (!directory || !summary || !appName) fail("static-deploy new requires <directory> <summary> <app_name>");
    const stat = await fsp.stat(directory).catch(() => null);
    if (!stat || !stat.isDirectory()) fail(`directory not found: ${directory}`);
    const ignore = Array.isArray(options.ignore) ? options.ignore : [];
    const normalizedIgnore = normalizeIgnoreEntries(ignore, directory);
    const meta = { command: "static-deploy.new", summary, app_name: appName, directory, ignore };
    const { archivePath, cleanup } = await createArchive(directory, normalizedIgnore);
    try {
      const res = await requestUpload("/static-deploy/new", meta, archivePath);
      printResult("static-deploy", "new", res.data, res.text);
    } finally {
      await cleanup();
    }
    return;
  }
  fail(`unknown static-deploy subcommand: ${sub}`);
}

async function handleDynamicDeploy(argv) {
  const { args, options } = parseArgs(argv);
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log("Usage: dynamic-deploy new|new-next|new-flask|new-express <directory> <summary> <app_name> [--ignore <list>] [--setup <list>] --startup <cmd>");
    console.log("       dynamic-deploy list | dynamic-deploy rollback <idx> | dynamic-deploy log <idx>");
    return;
  }
  if (sub === "list") {
    const res = await requestJson("GET", "/dynamic-deploy/list");
    printResult("dynamic-deploy", "list", res.data, res.text);
    return;
  }
  if (sub === "rollback") {
    const idx = args[1];
    if (!idx) fail("dynamic-deploy rollback requires <idx>");
    const res = await requestJson("POST", "/dynamic-deploy/rollback", { idx });
    printResult("dynamic-deploy", "rollback", res.data, res.text);
    return;
  }
  if (sub === "log") {
    const idx = args[1];
    if (!idx) fail("dynamic-deploy log requires <idx>");
    const res = await requestJson("GET", `/dynamic-deploy/log?idx=${encodeURIComponent(idx)}`);
    printResult("dynamic-deploy", "log", res.data, res.text);
    return;
  }
  if (sub.startsWith("new")) {
    const directory = args[1];
    const summary = args[2];
    const appName = args[3];
    if (!directory || !summary || !appName) fail(`dynamic-deploy ${sub} requires <directory> <summary> <app_name>`);
    const startup = options.startup || "";
    if (!startup) fail("dynamic-deploy requires --startup <cmd>");
    const portOption = options.port ? Number(options.port) : null;
    const stat = await fsp.stat(directory).catch(() => null);
    if (!stat || !stat.isDirectory()) fail(`directory not found: ${directory}`);
    const ignore = Array.isArray(options.ignore) ? options.ignore : [];
    const setup = Array.isArray(options.setup) ? options.setup : [];
    const normalizedIgnore = normalizeIgnoreEntries(ignore, directory);
    const meta = {
      command: `dynamic-deploy.${sub}`,
      summary,
      app_name: appName,
      directory,
      ignore,
      setup,
      startup,
      ...(Number.isFinite(portOption) ? { port: portOption } : {}),
    };
    const { archivePath, cleanup } = await createArchive(directory, normalizedIgnore);
    try {
      const pathName = `/dynamic-deploy/${sub}`;
      const res = await requestUpload(pathName, meta, archivePath);
      printResult("dynamic-deploy", sub, res.data, res.text);
    } finally {
      await cleanup();
    }
    return;
  }
  fail(`unknown dynamic-deploy subcommand: ${sub}`);
}

async function run(command, argv) {
  ensureEnv();
  if (command === "code") return await handleCode(argv);
  if (command === "site") return await handleSite(argv);
  if (command === "static-deploy") return await handleStaticDeploy(argv);
  if (command === "dynamic-deploy") return await handleDynamicDeploy(argv);
  fail(`unknown helper command: ${command}`);
}

module.exports = { run };
