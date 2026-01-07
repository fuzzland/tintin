import type { PineconeSection } from "./config.js";
import type { Logger } from "./log.js";
import { fetch } from "undici";

type PineconeIndex = {
  upsert: (records: any[]) => Promise<void>;
  deleteMany: (ids: string[]) => Promise<void>;
  query: (payload: any) => Promise<any>;
  describeIndexStats?: () => Promise<{ dimension?: number }>;
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
  private indexDimension: number | null = null;
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

  private async getTargetDimension(): Promise<number | null> {
    if (this.indexDimension !== null) return this.indexDimension;
    const configuredDim =
      this.config && typeof this.config.dimension === "number" && Number.isFinite(this.config.dimension)
        ? Math.floor(this.config.dimension)
        : null;
    if (configuredDim && configuredDim > 0) {
      this.indexDimension = configuredDim;
    }
    const idx = await this.getIndex();
    if (!idx) return this.indexDimension;
    if (typeof idx.describeIndexStats === "function") {
      try {
        const stats = await idx.describeIndexStats();
        const dim = Number((stats as any)?.dimension);
        if (Number.isFinite(dim) && dim > 0) {
          if (this.indexDimension && this.indexDimension !== dim) {
            this.logger.warn(`[pinecone] index dimension mismatch config=${this.indexDimension} actual=${dim}`);
          }
          this.indexDimension = Math.floor(dim);
          this.logger.info(`[pinecone] index dimension=${this.indexDimension}`);
        }
      } catch (e) {
        this.logger.warn(`[pinecone] describeIndexStats failed: ${String(e)}`);
      }
    }
    return this.indexDimension;
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
      const targetDimension = await this.getTargetDimension();
      if (!targetDimension) {
        throw new Error("index dimension unknown");
      }
      const vectorText = (opts.embedText ?? `${opts.title}\n${opts.note}`).trim();
      const vector =
        Array.isArray(opts.vector) && opts.vector.length > 0 ? opts.vector : await this.embed(vectorText, targetDimension);
      const sanitized = sanitizeVector(vector);
      if (!sanitized) {
        throw new Error("missing or invalid embedding");
      }
      const values = Array.from(sanitized);
      if (!Array.isArray(values) || values.length === 0 || values.length !== targetDimension) {
        throw new Error(`invalid embedding vector length=${values.length} expected=${targetDimension}`);
      }
      await idx.upsert([
        {
          id: opts.snapshotId,
          values,
          metadata: {
            title: opts.title,
            note: opts.note,
            run_id: opts.runId,
            identity_id: opts.identityId,
            created_at: opts.createdAt,
          },
        },
      ]);
      this.logger.info(`[pinecone] upsert ok snapshot=${opts.snapshotId} len=${values.length}`);
    } catch (e) {
      const shape =
        Array.isArray(opts.vector) || ArrayBuffer.isView(opts.vector)
          ? `vector_len=${(opts.vector as any)?.length ?? "?"} type=${opts.vector?.constructor?.name ?? typeof opts.vector}`
          : `vector_type=${typeof opts.vector}`;
      this.logger.error(`[pinecone] upsert failed snapshot=${opts.snapshotId} ${shape}: ${String(e)}`);
    }
  }

  async deleteSnapshotDoc(snapshotId: string): Promise<void> {
    const idx = await this.getIndex();
    if (!idx) return;
    try {
      await idx.deleteMany([snapshotId]);
    } catch (e) {
      this.logger.warn(`[pinecone] delete failed snapshot=${snapshotId}: ${String(e)}`);
    }
  }

  async searchSnapshots(identityId: string, query: string, topK = 10): Promise<SnapshotSearchResult[]> {
    const idx = await this.getIndex();
    if (!idx) return [];
    try {
      const targetDimension = await this.getTargetDimension();
      if (!targetDimension) {
        throw new Error("index dimension unknown");
      }
      const vector = await this.embed(query, targetDimension);
      const sanitized = sanitizeVector(vector);
      if (!sanitized) {
        throw new Error("missing or invalid embedding");
      }
      if (sanitized.length !== targetDimension) {
        throw new Error(`invalid embedding vector length=${sanitized.length} expected=${targetDimension}`);
      }
      const result = await idx.query({
        topK,
        vector: sanitized,
        filter: { identity_id: { $eq: identityId } },
        includeMetadata: true,
      });
      const matches = Array.isArray(result.matches) ? result.matches : [];
      return matches.map((m: any) => ({
        id: String(m.id),
        attributes: m.metadata ?? {},
      }));
    } catch (e) {
      this.logger.error(`[pinecone] search failed: ${String(e)}`);
      return [];
    }
  }

  private async embed(text: string, dimension?: number): Promise<number[] | null> {
    const config = this.embeddingConfig;
    if (!config) {
      this.logger.error("[pinecone] embed config missing");
      return null;
    }
    const base = config.baseUrl.replace(/\/+$/, "");
    const url = `${base}/embeddings`;
    try {
      const body: Record<string, unknown> = { model: config.model, input: text };
      if (typeof dimension === "number" && Number.isFinite(dimension) && dimension > 0) {
        body.dimensions = Math.floor(dimension);
      }
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
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
      if (dimension && embedding.length !== dimension) {
        this.logger.error(`[pinecone] embed dimension mismatch expected=${dimension} actual=${embedding.length}`);
        return null;
      }
      return embedding;
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

function sanitizeVector(input: unknown): number[] | null {
  const arr: ArrayLike<any> | null =
    Array.isArray(input) || ArrayBuffer.isView(input) ? (input as ArrayLike<any>) : null;
  if (!arr) return null;
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push(v);
    } else if (typeof v === "string" && v.trim().length > 0 && Number.isFinite(Number(v))) {
      out.push(Number(v));
    } else {
      return null;
    }
  }
  return out.length > 0 ? out : null;
}
