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

export class CloudflareEmbeddingProvider implements EmbeddingProvider {
  private readonly apiToken: string;
  private readonly accountId?: string;
  private readonly baseUrl: string;
  private readonly retryDelayMs?: number;
  readonly model: string;
  readonly dimension: number;
  readonly isAutoEmbedding = false;

  constructor(options: {
    apiToken?: string;
    accountId?: string;
    baseUrl?: string;
    model?: string;
    dimension?: number;
    retryDelayMs?: number;
  }) {
    this.apiToken = (options.apiToken || "").trim();
    this.accountId = (options.accountId || "").trim();
    this.baseUrl = (options.baseUrl || "").trim().replace(/\/+$/, "");
    this.model = (options.model || "@cf/baai/bge-m3").trim();
    this.dimension = options.dimension || 1024;
    this.retryDelayMs = options.retryDelayMs;
  }

  resolveEndpoint(): string {
    if (this.baseUrl) {
      if (this.baseUrl.endsWith("/embeddings")) {
        return this.baseUrl;
      }
      if (this.baseUrl.includes("/ai/v1")) {
        return `${this.baseUrl}/embeddings`;
      }
      if (this.accountId) {
        return `${this.baseUrl}/accounts/${this.accountId}/ai/v1/embeddings`;
      }
      return `${this.baseUrl}/embeddings`;
    }

    if (!this.accountId) {
      throw new Error(
        "Cloudflare embedding requires CLOUDFLARE_ACCOUNT_ID (and CLOUDFLARE_API_TOKEN), or CLOUDFLARE_BASE_URL"
      );
    }

    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/embeddings`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const endpoint = this.resolveEndpoint();
    const batchSize = 32;
    const allEmbeddings: number[][] = [];
    const isRunEndpoint = endpoint.includes("/ai/run/");

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((t) => {
        const cleaned = t.replace(/\0/g, "").trim();
        return cleaned.length > 2500 ? cleaned.slice(0, 2500) : cleaned;
      });

      const vectors = await this.fetchWithRetry(endpoint, batch, isRunEndpoint);
      for (const vector of vectors) {
        allEmbeddings.push(vector);
      }
    }

    return allEmbeddings;
  }

  private async fetchWithRetry(url: string, batch: string[], isRunEndpoint: boolean): Promise<number[][]> {
    const maxAttempts = 5;
    let attempt = 0;

    const body = isRunEndpoint
      ? JSON.stringify({ text: batch })
      : JSON.stringify({ model: this.model, input: batch });

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {})
          },
          body
        });

        if (response.ok) {
          const json = (await response.json()) as {
            data?: Array<{ embedding?: number[]; index?: number }>;
            result?: { data?: number[][] } | number[][];
          };

          if (json.data && Array.isArray(json.data)) {
            const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
            return sorted.map((item) => item.embedding || new Array(this.dimension).fill(0));
          }

          if (json.result) {
            const rawList = Array.isArray(json.result)
              ? json.result
              : (json.result.data && Array.isArray(json.result.data) ? json.result.data : []);
            if (rawList.length > 0 && Array.isArray(rawList[0])) {
              return rawList as number[][];
            }
          }

          throw new Error("Invalid response from Cloudflare embedding API: missing 'data' or 'result'");
        }

        const errorText = await response.text().catch(() => "");

        if (response.status === 429 || response.status >= 500) {
          if (attempt < maxAttempts) {
            const backoffMs = this.retryDelayMs ?? Math.min(attempt * 1500 + Math.floor(Math.random() * 500), 10000);
            console.warn(`[Cloudflare] HTTP ${response.status}. Retrying in ${Math.round(backoffMs)}ms (attempt ${attempt}/${maxAttempts})...`);
            await sleep(backoffMs);
            continue;
          }
        }

        throw new Error(`Cloudflare embedding failed (${response.status}): ${errorText}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Cloudflare embedding failed") || message.includes("Invalid response")) {
          throw err;
        }

        if (attempt < maxAttempts) {
          const backoffMs = this.retryDelayMs ?? Math.min(attempt * 1500, 10000);
          console.warn(`[Cloudflare] Network error: ${message}. Retrying in ${Math.round(backoffMs)}ms (attempt ${attempt}/${maxAttempts})...`);
          await sleep(backoffMs);
          continue;
        }
        throw new Error(`Cloudflare embedding network failed after ${maxAttempts} attempts: ${message}`);
      }
    }

    throw new Error(`Cloudflare embedding failed after ${maxAttempts} attempts`);
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
      model: env.AUTO_EMBEDDING_MODEL || env.EMBEDDING_MODEL,
      dimension: env.AUTO_EMBEDDING_DIMENSION || env.EMBEDDING_DIMENSION
    });
  }

  // Cloudflare provider (default, or explicit "cloudflare" / "cf")
  return new CloudflareEmbeddingProvider({
    apiToken: env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_KEY || env.EMBEDDING_API_KEY,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    baseUrl: env.CLOUDFLARE_BASE_URL || env.EMBEDDING_BASE_URL,
    model: env.CLOUDFLARE_MODEL || env.EMBEDDING_MODEL,
    dimension: env.EMBEDDING_DIMENSION
  });
}
