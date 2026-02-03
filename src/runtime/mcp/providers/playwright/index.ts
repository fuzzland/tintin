import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { PlaywrightMcpProviderConfig } from "../../config.js";
import type { McpProviderContext, McpScreenshotProvider, McpServerInfo } from "../../types.js";
import { BaseMcpProvider } from "../base.js";
import type { PlaywrightServerInfo } from "./types.js";

const SIGKILL_TIMEOUT_MS = 2_000;
const MAX_SNIPPET_CHARS = 240;

interface ScreenshotResult {
  savedPath?: string;
  mimeType?: string;
}

export class PlaywrightMcpProvider
  extends BaseMcpProvider<PlaywrightMcpProviderConfig>
  implements McpScreenshotProvider
{
  readonly type = "playwright";
  private startPromise: Promise<{ info: PlaywrightServerInfo; child: ChildProcessWithoutNullStreams }> | null = null;
  private clientPromise: Promise<Client> | null = null;
  private serverInfo: PlaywrightServerInfo | null = null;

  constructor(name: string) {
    super(name, { id: name, transport: "http", status: "stopped" });
  }

  override async init(config: PlaywrightMcpProviderConfig, context: McpProviderContext): Promise<void> {
    await super.init(config, context);
    this.setInfo({
      startupTimeoutSec: config.startup_timeout_sec,
      status: "stopped",
    });
  }

  override async start(): Promise<McpServerInfo> {
    await this.ensureServer();
    return this.getServerInfo();
  }

  override async stop(): Promise<void> {
    const client = this.clientPromise ? await this.clientPromise.catch(() => null) : null;
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    const proc = this.startPromise ? await this.startPromise.catch(() => null) : null;
    if (proc?.child && !proc.child.killed) {
      proc.child.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.child.killed) proc.child.kill("SIGKILL");
      }, SIGKILL_TIMEOUT_MS);
    }
    this.serverInfo = null;
    this.startPromise = null;
    this.clientPromise = null;
    this.setInfo({ status: "stopped", url: undefined });
  }

  async takeScreenshot(opts: { sessionId: string; callId?: string; tool?: string }): Promise<ScreenshotResult | null> {
    const server = await this.ensureServer();
    const client = await this.ensureClient(server);
    const safeTool = opts.tool ? opts.tool.replace(/[^A-Za-z0-9_-]+/g, "-") : "call";
    const nonce = crypto.randomUUID();
    const relFileName = path.join(opts.sessionId, `${safeTool || "call"}-${opts.callId ?? "auto"}-${nonce}.png`);
    const expectedPath = path.join(server.outputDir, relFileName);
    await mkdir(path.dirname(expectedPath), { recursive: true });
    try {
      const res: unknown = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {
          filename: relFileName,
        },
      });
      if (isToolError(res)) {
        const msg = toolErrorText(res);
        this.logger.debug(`[playwright-mcp] screenshot tool error: ${safeSnippet(msg)}`);
        return null;
      }

      const imageBlock = Array.isArray((res as { content?: unknown }).content)
        ? (res as { content: Array<{ type?: unknown; mimeType?: unknown; data?: unknown }> }).content.find(
            (c) => c && typeof c === "object" && c.type === "image",
          )
        : null;

      const mimeType = typeof imageBlock?.mimeType === "string" ? imageBlock.mimeType : undefined;
      const base64 = typeof imageBlock?.data === "string" ? imageBlock.data : null;
      if (base64) {
        const buf = Buffer.from(base64, "base64");
        await writeFile(expectedPath, buf);
        return { savedPath: expectedPath, mimeType };
      }

      const fromText = Array.isArray((res as { content?: unknown }).content)
        ? (res as { content: Array<{ type?: unknown; text?: unknown }> }).content.find(
            (c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string",
          )?.text
        : null;
      const linkedPath = typeof fromText === "string" ? extractFirstLinkedFilePath(fromText) : null;
      const candidates = [linkedPath, expectedPath].filter((p): p is string => typeof p === "string" && p.length > 0);
      for (const candidate of candidates) {
        try {
          await access(candidate);
          return { savedPath: candidate, mimeType };
        } catch {
          continue;
        }
      }

      return null;
    } catch (e) {
      this.logger.debug(`[playwright-mcp] screenshot failed: ${String(e)}`);
      return null;
    }
  }

  private async ensureServer(): Promise<PlaywrightServerInfo> {
    if (this.startPromise) {
      const started = await this.startPromise;
      if (!started.child.killed && started.child.exitCode === null) return started.info;
      this.startPromise = null;
      this.clientPromise = null;
      this.serverInfo = null;
    }
    this.setInfo({ status: "starting", url: undefined });
    this.startPromise = this.startServer().catch((e) => {
      this.startPromise = null;
      this.clientPromise = null;
      this.serverInfo = null;
      this.setInfo({ status: "error" });
      throw e;
    });
    const started = await this.startPromise;
    return started.info;
  }

  private async ensureClient(server: PlaywrightServerInfo): Promise<Client> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = this.createClient(server);
    return this.clientPromise;
  }

  private async createClient(server: PlaywrightServerInfo): Promise<Client> {
    const client = new Client({ name: "tintin", version: "0.1.0" }, { capabilities: {} });
    const primary = new StreamableHTTPClientTransport(new URL(server.url));
    try {
      await client.connect(primary);
      return client;
    } catch (e) {
      this.logger.warn(`[playwright-mcp] streamable HTTP connect failed (${String(e)}), falling back to SSE`);
    }
    // Legacy SSE fallback: server advertises /sse for SSE transport
    const sseUrl = new URL(server.url);
    sseUrl.pathname = sseUrl.pathname.replace(/\/mcp$/, "") + "/sse";
    const fallback = new SSEClientTransport(sseUrl);
    await client.connect(fallback);
    return client;
  }

  private async startServer(): Promise<{ info: PlaywrightServerInfo; child: ChildProcessWithoutNullStreams }> {
    const userDataDir = substituteSessionId(this.config.user_data_dir, "shared");
    const outputDir = substituteSessionId(this.config.output_dir, "shared");
    await mkdir(userDataDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const port = await findAvailablePort(this.config.host, this.config.port_start, this.config.port_end);
    const executablePath = this.config.executable_path ?? (await findChromeExecutable()) ?? undefined;
    const args = buildPlaywrightArgs({
      pkg: this.config.package,
      host: this.config.host,
      port,
      browser: this.config.browser,
      userDataDir,
      outputDir,
      snapshotMode: this.config.snapshot_mode,
      imageResponses: this.config.image_responses,
      headless: this.config.headless,
      executablePath,
      timeoutMs: this.config.timeout_ms,
      userAgent: this.config.user_agent,
      viewportSize: this.config.viewport_size,
    });

    this.logger.info(
      `[playwright-mcp] starting on ${this.config.host}:${port} browser=${this.config.browser} headless=${String(
        this.config.headless,
      )} executable_path=${executablePath ?? "(playwright default)"} output_dir=${outputDir}`,
    );
    const child = spawn("npx", args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (buf) => {
      const text = buf.toString("utf8").trim();
      if (text) this.logger.debug(`[playwright-mcp] ${text}`);
    });
    child.stderr.on("data", (buf) => {
      const text = buf.toString("utf8").trim();
      if (text) this.logger.warn(`[playwright-mcp] stderr: ${text}`);
    });
    child.on("exit", (code, signal) => {
      this.logger.warn(`[playwright-mcp] exited code=${String(code)} signal=${String(signal)}`);
      this.startPromise = null;
      this.clientPromise = null;
      this.serverInfo = null;
      this.setInfo({ status: "stopped" });
    });

    try {
      const startupTimeoutMs = Math.max(1_000, Math.floor(this.config.startup_timeout_sec * 1000));
      await waitForPortOpen(this.config.host, port, startupTimeoutMs);
    } catch (e) {
      this.logger.error(`[playwright-mcp] failed to start on ${this.config.host}:${port}: ${String(e)}`);
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, SIGKILL_TIMEOUT_MS);
      this.setInfo({ status: "error" });
      throw e;
    }
    const info: PlaywrightServerInfo = {
      port,
      url: `http://${resolveUrlHost(this.config.host)}:${port}/mcp`,
      userDataDir,
      outputDir,
    };
    this.serverInfo = info;
    this.setInfo({
      url: info.url,
      status: "running",
    });
    return { info, child };
  }
}

function substituteSessionId(p: string, sessionId: string): string {
  return p.replaceAll("{sessionId}", sessionId);
}

/**
 * Map bind address to client-accessible URL host.
 * Playwright MCP's security check only accepts Host header as "localhost",
 * so local loopback addresses need to be mapped to localhost.
 */
function resolveUrlHost(bindHost: string): string {
  const localAddresses = ["127.0.0.1", "::1", "0.0.0.0", "[::]"];
  if (localAddresses.includes(bindHost)) {
    return "localhost";
  }
  return bindHost;
}

function safeSnippet(text: string, maxChars = MAX_SNIPPET_CHARS): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}...`;
}

function extractFirstLinkedFilePath(text: string): string | null {
  const candidates: string[] = [];
  const re = /\[[^\]]*]\(([^)]+)\)/g;
  for (const match of text.matchAll(re)) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    // Playwright MCP uses absolute file system paths in markdown links.
    candidates.push(raw);
  }
  const preferred = candidates.find((p) => p.endsWith(".png") || p.endsWith(".jpeg") || p.endsWith(".jpg"));
  return preferred ?? candidates[0] ?? null;
}

async function findChromeExecutable(): Promise<string | null> {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function buildPlaywrightArgs(opts: {
  pkg: string;
  host: string;
  port: number;
  browser: string;
  userDataDir: string;
  outputDir: string;
  snapshotMode: string;
  imageResponses: string;
  headless: boolean;
  executablePath?: string;
  timeoutMs: number;
  userAgent?: string;
  viewportSize?: string;
}): string[] {
  const args = [
    "--no-install",
    "-y",
    opts.pkg,
    "--browser",
    opts.browser,
    "--host",
    opts.host,
    "--port",
    String(opts.port),
    "--user-data-dir",
    opts.userDataDir,
    "--output-dir",
    opts.outputDir,
    "--snapshot-mode",
    opts.snapshotMode,
    "--image-responses",
    opts.imageResponses,
    "--shared-browser-context",
    "--timeout-navigation",
    String(Math.max(1_000, Math.min(opts.timeoutMs, 60_000))),
  ];
  if (opts.userAgent) args.push("--user-agent", opts.userAgent);
  if (opts.viewportSize) args.push("--viewport-size", opts.viewportSize);
  if (opts.executablePath) args.push("--executable-path", opts.executablePath);
  if (opts.headless) args.push("--headless");
  return args;
}

async function findAvailablePort(host: string, start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    const ok = await tryPort(host, port);
    if (ok) return port;
  }
  throw new Error(`No open port found for Playwright MCP between ${start} and ${end}`);
}

function tryPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function waitForPortOpen(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const connectHost = resolveUrlHost(host);
  while (Date.now() < deadline) {
    const ok = await canConnect(connectHost, port);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for Playwright MCP on ${connectHost}:${port}`);
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function isToolError(res: unknown): res is { isError: true; content?: Array<{ text?: unknown }> } {
  return Boolean(res && typeof res === "object" && (res as { isError?: unknown }).isError === true);
}

function toolErrorText(res: { content?: Array<{ text?: unknown }> }): string {
  if (!Array.isArray(res.content)) return "";
  const text = res.content.find((c) => c && typeof c === "object" && typeof c.text === "string")?.text;
  return typeof text === "string" ? text : "";
}
