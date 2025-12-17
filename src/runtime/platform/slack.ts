import { createHmac } from "node:crypto";
import { RateLimiter, chunkText, nowMs, timingSafeEqualString } from "../util.js";
import type { Logger } from "../log.js";
import type { SlackSection } from "../config.js";
import { redactText } from "../redact.js";
import { FormData } from "undici";
import { Blob } from "node:buffer";
import { fetchWithProxy } from "../httpClient.js";

export function verifySlackSignature(opts: {
  signingSecret: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  body: string;
}): boolean {
  const ts = opts.timestampHeader ? Number(opts.timestampHeader) : NaN;
  if (!Number.isFinite(ts)) return false;
  const ageSeconds = Math.abs(Math.floor(nowMs() / 1000) - ts);
  if (ageSeconds > 60 * 5) return false;

  if (!opts.signatureHeader) return false;
  const base = `v0:${opts.timestampHeader}:${opts.body}`;
  const digest = createHmac("sha256", opts.signingSecret).update(base).digest("hex");
  const expected = `v0=${digest}`;
  return timingSafeEqualString(expected, opts.signatureHeader);
}

export class SlackClient {
  private readonly limiter: RateLimiter;
  private readonly maxChars: number;

  constructor(
    private readonly config: SlackSection,
    private readonly logger: Logger,
  ) {
    this.limiter = new RateLimiter(config.rate_limit_msgs_per_sec);
    this.maxChars = config.max_chars;
  }

  async postMessage(opts: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }) {
    const res = await this.postMessageDetailed({ ...opts, blocksOnLastChunk: false });
    return res.firstTs;
  }

  async postMessageDetailed(opts: {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: unknown[];
    blocksOnLastChunk?: boolean;
  }): Promise<{ firstTs: string | null; lastTs: string | null; lastText: string | null }> {
    const redacted = redactText(opts.text);
    const chunks = chunkText(redacted, this.maxChars);
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    let lastText: string | null = null;
    const blocksOnLastChunk = opts.blocksOnLastChunk === true;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      await this.limiter.waitTurn();
      const res = await this.api<{ ok: boolean; ts?: string }>("chat.postMessage", {
        channel: opts.channel,
        text: chunk,
        thread_ts: opts.thread_ts,
        blocks: opts.blocks ? (blocksOnLastChunk ? (i === chunks.length - 1 ? opts.blocks : undefined) : i === 0 ? opts.blocks : undefined) : undefined,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (i === 0 && res.ts) firstTs = res.ts;
      if (res.ts) lastTs = res.ts;
      lastText = chunk;
    }
    return { firstTs, lastTs, lastText };
  }

  async updateMessage(opts: { channel: string; ts: string; text: string; blocks?: unknown[] }) {
    await this.limiter.waitTurn();
    await this.api("chat.update", {
      channel: opts.channel,
      ts: opts.ts,
      text: redactText(opts.text),
      blocks: opts.blocks,
    });
  }

  async postEphemeral(opts: { channel: string; user: string; text: string; thread_ts?: string; blocks?: unknown[] }) {
    const redacted = redactText(opts.text);
    const chunks = chunkText(redacted, this.maxChars);
    for (let i = 0; i < chunks.length; i++) {
      await this.limiter.waitTurn();
      await this.api("chat.postEphemeral", {
        channel: opts.channel,
        user: opts.user,
        text: chunks[i],
        thread_ts: opts.thread_ts,
        blocks: i === 0 ? opts.blocks : undefined,
      });
    }
  }

  async openModal(trigger_id: string, view: unknown) {
    await this.limiter.waitTurn();
    await this.api("views.open", { trigger_id, view });
  }

  async uploadFile(opts: { channel: string; thread_ts?: string; filename: string; file: Buffer; mimeType?: string; initial_comment?: string }) {
    await this.limiter.waitTurn();
    const form = new FormData();
    form.set("channels", opts.channel);
    if (opts.thread_ts) form.set("thread_ts", opts.thread_ts);
    if (opts.initial_comment) form.set("initial_comment", redactText(opts.initial_comment));
    const blob = new Blob([opts.file], { type: opts.mimeType ?? "application/octet-stream" });
    form.set("file", blob, opts.filename);
    const res = await fetchWithProxy("https://slack.com/api/files.upload", {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.bot_token}` },
      body: form,
    });
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) {
      const error = json.error ?? "unknown_error";
      this.logger.error(`Slack API files.upload error: ${error}`);
      throw new Error(`Slack API files.upload error: ${error}`);
    }
  }

  private async api<T>(method: string, body: unknown): Promise<T> {
    const res = await fetchWithProxy(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.bot_token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) {
      const error = json.error ?? "unknown_error";
      this.logger.error(`Slack API ${method} error: ${error}`);
      throw new Error(`Slack API ${method} error: ${error}`);
    }
    return json as T;
  }
}
