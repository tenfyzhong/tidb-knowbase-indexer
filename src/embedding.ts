import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Env } from "./config.js";

export interface EmbeddingProvider {
  /**
   * Generates embedding vectors for the given text strings.
   * For TiDB native auto embedding, this returns an empty array as computation happens inside TiDB.
   */
  embed(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
  readonly isAutoEmbedding: boolean;
  readonly model?: string;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly isAutoEmbedding = false;
  readonly model = "mock";

  constructor(dimension = 1024) {
    this.dimension = dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const hash = crypto.createHash("sha256").update(text).digest();
      const vector: number[] = [];
      let sumSq = 0;

      for (let i = 0; i < this.dimension; i++) {
        const byteIndex = (i * 4) % hash.length;
        const rawVal = (hash[byteIndex] - 128) / 128;
        vector.push(rawVal);
        sumSq += rawVal * rawVal;
      }

      // Unit normalize vector
      const norm = Math.sqrt(sumSq) || 1;
      return vector.map((v) => Number((v / norm).toFixed(6)));
    });
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly model: string;
  readonly dimension: number;
  readonly isAutoEmbedding = false;

  constructor(options: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    dimension?: number;
  }) {
    this.apiKey = options.apiKey || "";
    this.baseUrl = (options.baseUrl || "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
    this.model = options.model || "BAAI/bge-m3";
    this.dimension = options.dimension || (this.model.includes("text-embedding-3-small") ? 1536 : 1024);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batchSize = 32;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((t) => {
        const cleaned = t.replace(/\0/g, "").trim();
        return cleaned.length > 2500 ? cleaned.slice(0, 2500) : cleaned;
      });

      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: this.model,
          input: batch
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `Embedding API request failed (${response.status} ${response.statusText}): ${errorText}`
        );
      }

      const json = (await response.json()) as {
        data?: Array<{ embedding: number[]; index?: number }>;
      };

      if (!json.data || !Array.isArray(json.data)) {
        throw new Error("Invalid response from embedding API: missing 'data' array");
      }

      const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const item of sorted) {
        allEmbeddings.push(item.embedding);
      }
    }

    return allEmbeddings;
  }
}

export class HuggingFaceEmbeddingProvider implements EmbeddingProvider {
  private readonly token: string;
  private readonly retryDelayMs?: number;
  readonly model: string;
  readonly dimension: number;
  readonly isAutoEmbedding = false;

  constructor(options: { token?: string; model?: string; dimension?: number; retryDelayMs?: number }) {
    this.token = options.token || "";
    this.model = options.model || "BAAI/bge-m3";
    this.dimension = options.dimension || 1024;
    this.retryDelayMs = options.retryDelayMs;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batchSize = 8;
    const allEmbeddings: number[][] = [];
    const url = `https://router.huggingface.co/hf-inference/models/${this.model}/pipeline/feature-extraction`;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((t) => {
        const cleaned = t.replace(/\0/g, "").trim();
        return cleaned.length > 2000 ? cleaned.slice(0, 2000) : cleaned;
      });

      const vectors = await this.fetchWithRetry(url, batch);
      for (const vector of vectors) {
        allEmbeddings.push(vector);
      }
    }

    return allEmbeddings;
  }

  private async fetchWithRetry(url: string, batch: string[]): Promise<number[][]> {
    const maxAttempts = 5;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            "x-wait-for-model": "true"
          },
          body: JSON.stringify({
            inputs: batch,
            options: { wait_for_model: true }
          })
        });

        if (response.ok) {
          const raw = (await response.json()) as unknown;
          return this.normalizeEmbeddings(raw, batch.length);
        }

        const errorText = await response.text().catch(() => "");

        // Case 1: Model loading (503)
        if (response.status === 503) {
          let waitMs = this.retryDelayMs ?? 15000;
          if (this.retryDelayMs === undefined) {
            try {
              const parsed = JSON.parse(errorText);
              if (typeof parsed.estimated_time === "number") {
                waitMs = Math.min(Math.max(Math.ceil(parsed.estimated_time * 1000), 5000), 45000);
              }
            } catch {
              // use default waitMs
            }
          }
          console.warn(`[HuggingFace] Model ${this.model} is loading (503). Waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${maxAttempts})...`);
          await sleep(waitMs);
          continue;
        }

        // Case 2: Gateway timeout (504), Bad Gateway (502), Rate Limit (429), or Server Error (500)
        if (response.status === 504 || response.status === 502 || response.status === 429 || response.status === 500) {
          if (attempt < maxAttempts) {
            if (response.status === 504 && batch.length > 2) {
              console.warn(`[HuggingFace] 504 timeout on batch of ${batch.length}, splitting into smaller sub-batches...`);
              const mid = Math.floor(batch.length / 2);
              const part1 = await this.fetchWithRetry(url, batch.slice(0, mid));
              const part2 = await this.fetchWithRetry(url, batch.slice(mid));
              return [...part1, ...part2];
            }

            const backoffMs = this.retryDelayMs ?? Math.min(attempt * 6000 + Math.floor(Math.random() * 3000), 30000);
            console.warn(`[HuggingFace] Server returned ${response.status} (${response.statusText || "error"}). Retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt}/${maxAttempts})...`);
            await sleep(backoffMs);
            continue;
          }
        }

        throw new Error(`HuggingFace embedding failed (${response.status}): ${errorText}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("HuggingFace embedding failed")) {
          throw err;
        }

        if (attempt < maxAttempts) {
          const backoffMs = this.retryDelayMs ?? Math.min(attempt * 5000, 20000);
          console.warn(`[HuggingFace] Network error: ${message}. Retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt}/${maxAttempts})...`);
          await sleep(backoffMs);
          continue;
        }
        throw new Error(`HuggingFace embedding network failed after ${maxAttempts} attempts: ${message}`);
      }
    }

    throw new Error(`HuggingFace embedding failed after ${maxAttempts} attempts`);
  }

  private normalizeEmbeddings(raw: unknown, expectedCount: number): number[][] {
    if (!Array.isArray(raw) || raw.length === 0) {
      return Array.from({ length: expectedCount }, () => new Array(this.dimension).fill(0));
    }

    // Case 1: 1D array [0.1, 0.2, ...] -> single vector
    if (typeof raw[0] === "number") {
      return [raw as number[]];
    }

    // Case 2: 2D array [[0.1, 0.2, ...], ...] -> batch of pooled sentence vectors
    if (Array.isArray(raw[0]) && typeof raw[0][0] === "number") {
      return raw as number[][];
    }

    // Case 3: 3D array [[[token1], [token2]], ...] -> batch of token vectors; perform mean pooling
    if (Array.isArray(raw[0]) && Array.isArray(raw[0][0]) && typeof raw[0][0][0] === "number") {
      const batch3D = raw as number[][][];
      return batch3D.map((itemTokens) => {
        if (itemTokens.length === 0) return new Array(this.dimension).fill(0);
        const dim = itemTokens[0].length;
        const pooled = new Array(dim).fill(0);
        for (const tokenVec of itemTokens) {
          for (let d = 0; d < dim; d++) {
            pooled[d] += tokenVec[d];
          }
        }
        for (let d = 0; d < dim; d++) {
          pooled[d] /= itemTokens.length;
        }
        return pooled;
      });
    }

    return Array.from({ length: expectedCount }, () => new Array(this.dimension).fill(0));
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  readonly model: string;
  readonly dimension: number;
  readonly isAutoEmbedding = false;

  constructor(options: { apiKey?: string; model?: string; dimension?: number }) {
    this.apiKey = options.apiKey || "";
    this.model = options.model || "text-embedding-004";
    this.dimension = options.dimension || 768;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;
    const requests = texts.map((text) => ({
      model: `models/${this.model}`,
      content: { parts: [{ text: text.length > 2500 ? text.slice(0, 2500) : text }] }
    }));

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Gemini embedding failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      embeddings?: Array<{ values: number[] }>;
    };

    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error("Invalid response from Gemini embedding API");
    }

    return data.embeddings.map((e) => e.values);
  }
}

export class JinaEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly model: string;
  readonly dimension: number;
  readonly isAutoEmbedding = false;

  constructor(options: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    dimension?: number;
  }) {
    this.apiKey = options.apiKey || "";
    this.baseUrl = (options.baseUrl || "https://api.jina.ai/v1").replace(/\/+$/, "");
    this.model = options.model || "jina-embeddings-v3";
    this.dimension = options.dimension || 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.model,
        input: texts.map((t) => (t.length > 2500 ? t.slice(0, 2500) : t))
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Jina embedding failed (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as {
      data?: Array<{ embedding: number[]; index?: number }>;
    };

    if (!json.data || !Array.isArray(json.data)) {
      throw new Error("Invalid response from Jina embedding API");
    }

    const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((item) => item.embedding);
  }
}

export class TiDBAutoEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  readonly isAutoEmbedding = true;

  constructor(options?: { model?: string; dimension?: number }) {
    this.model = options?.model || "tidbcloud_free/amazon/titan-embed-text-v2";
    this.dimension = options?.dimension || 1024;
  }

  async embed(_texts: string[]): Promise<number[][]> {
    // Vector generation is performed automatically inside TiDB via EMBED_TEXT()
    return [];
  }
}

export function createEmbeddingProvider(env: Env): EmbeddingProvider {
  const providerType = (env.EMBEDDING_PROVIDER || "").toLowerCase();

  if (providerType === "mock") {
    return new MockEmbeddingProvider(env.EMBEDDING_DIMENSION || 1024);
  }

  if (providerType === "tidb_auto" || providerType === "auto") {
    return new TiDBAutoEmbeddingProvider({
      model: env.EMBEDDING_MODEL,
      dimension: env.EMBEDDING_DIMENSION
    });
  }

  if (providerType === "huggingface" || (!providerType && env.HF_TOKEN)) {
    return new HuggingFaceEmbeddingProvider({
      token: env.HF_TOKEN || env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
      dimension: env.EMBEDDING_DIMENSION
    });
  }

  if (providerType === "gemini" || (!providerType && env.GEMINI_API_KEY)) {
    return new GeminiEmbeddingProvider({
      apiKey: env.GEMINI_API_KEY || env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
      dimension: env.EMBEDDING_DIMENSION
    });
  }

  if (providerType === "jina" || (!providerType && env.JINA_API_KEY)) {
    return new JinaEmbeddingProvider({
      apiKey: env.JINA_API_KEY || env.EMBEDDING_API_KEY,
      baseUrl: env.EMBEDDING_BASE_URL,
      model: env.EMBEDDING_MODEL,
      dimension: env.EMBEDDING_DIMENSION
    });
  }

  // Default to OpenAI / SiliconFlow
  return new OpenAIEmbeddingProvider({
    apiKey: env.EMBEDDING_API_KEY || env.OPENAI_API_KEY,
    baseUrl: env.EMBEDDING_BASE_URL,
    model: env.EMBEDDING_MODEL,
    dimension: env.EMBEDDING_DIMENSION
  });
}
