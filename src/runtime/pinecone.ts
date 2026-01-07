import type { PineconeSection } from "./config.js";
import type { Logger } from "./log.js";
import { fetch } from "undici";

type PineconeIndex = {
  upsert: (payload: any) => Promise<void>;
  deleteMany: (payload: any) => Promise<void>;
  query: (payload: any) => Promise<any>;
};

export interface SnapshotSearchResult {
  id: string;
  attributes?: Record<string, unknown>;
}

export type EmbeddingConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export class PineconeClient {
  private index: PineconeIndex | null = null;
  constructor(
    private readonly config: PineconeSection | null,
    private readonly logger: Logger,
    private readonly embeddingConfig: EmbeddingConfig | null = null,
  ) {}

  private async getIndex(): Promise<PineconeIndex | null> {
    if (!this.config) return null;
    if (this.index) return this.index;
    try {
      const { Pinecone } = await import("@pinecone-database/pinecone");
      const pc = new Pinecone({ apiKey: this.config.api_key });
      this.index = pc.index(this.config.index);
      return this.index;
    } catch (e) {
      this.logger.warn(`[pinecone] init failed: ${String(e)}`);
      return null;
    }
  }

  async upsertSnapshotDoc(opts: {
    snapshotId: string;
    identityId: string;
    runId: string;
    title: string;
    note: string;
    embedText?: string;
    createdAt: number;
    vector?: number[];
  }): Promise<void> {
    const idx = await this.getIndex();
    if (!idx) return;
    try {
      const vectorText = (opts.embedText ?? `${opts.title}\n${opts.note}`).trim();
      const vector =
        Array.isArray(opts.vector) && opts.vector.length > 0
          ? opts.vector
          : await this.embed(vectorText);
      if (!vector) {
        this.logger.warn(`[pinecone] upsert skipped snapshot=${opts.snapshotId} (missing embedding)`);
        return;
      }
      await idx.upsert({
        vectors: [
          {
            id: opts.snapshotId,
            values: vector,
            metadata: {
              title: opts.title,
              note: opts.note,
              run_id: opts.runId,
              identity_id: opts.identityId,
              created_at: opts.createdAt,
            },
          },
        ],
      });
    } catch (e) {
      this.logger.warn(`[pinecone] upsert failed snapshot=${opts.snapshotId}: ${String(e)}`);
    }
  }

  async deleteSnapshotDoc(snapshotId: string): Promise<void> {
    const idx = await this.getIndex();
    if (!idx) return;
    try {
      await idx.deleteMany({ ids: [snapshotId] });
    } catch (e) {
      this.logger.warn(`[pinecone] delete failed snapshot=${snapshotId}: ${String(e)}`);
    }
  }

  async searchSnapshots(identityId: string, query: string, topK = 10): Promise<SnapshotSearchResult[]> {
    const idx = await this.getIndex();
    if (!idx) return [];
    try {
      const vector = await this.embed(query);
      if (!vector) {
        this.logger.warn("[pinecone] search skipped (missing embedding config)");
        return [];
      }
      const result = await idx.query({
        topK,
        id: undefined,
        vector,
        filter: { identity_id: identityId },
        includeMetadata: true,
      });
      const matches = Array.isArray(result.matches) ? result.matches : [];
      return matches.map((m: any) => ({
        id: String(m.id),
        attributes: m.metadata ?? {},
      }));
    } catch (e) {
      this.logger.warn(`[pinecone] search failed: ${String(e)}`);
      return [];
    }
  }

  private async embed(text: string): Promise<number[] | null> {
    const config = this.embeddingConfig;
    if (!config) return null;
    const base = config.baseUrl.replace(/\/+$/, "");
    const url = `${base}/embeddings`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, input: text }),
      });
      if (!res.ok) {
        this.logger.warn(`[pinecone] embed failed status=${res.status}`);
        return null;
      }
      const data = (await res.json()) as any;
      const embedding = Array.isArray(data?.data) && data.data[0] && Array.isArray(data.data[0].embedding) ? data.data[0].embedding : null;
      if (!embedding) {
        this.logger.warn("[pinecone] embed response missing embedding");
        return null;
      }
      return embedding.map((n: unknown) => (typeof n === "number" ? n : 0));
    } catch (e) {
      this.logger.warn(`[pinecone] embed error: ${String(e)}`);
      return null;
    }
  }
}

function hashToVector(text: string): number[] {
  const clean = text || "";
  let h1 = 0;
  let h2 = 0;
  let h3 = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    h1 = (h1 * 31 + c) % 100000;
    h2 = (h2 * 131 + c) % 100000;
    h3 = (h3 * 17 + c) % 100000;
  }
  return [h1 / 100000, h2 / 100000, h3 / 100000];
}
