import crypto from "node:crypto";
import type { Env } from "./config.js";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  readonly dimension: number;

  constructor(options: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    dimension?: number;
  }) {
    this.apiKey = options.apiKey || "";
    this.baseUrl = (options.baseUrl || "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
    this.model = options.model || "BAAI/bge-m3";
    this.dimension = options.dimension || 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batchSize = 32;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((t) => {
        const cleaned = t.replace(/\0/g, "").trim();
        return cleaned.length > 2000 ? cleaned.slice(0, 2000) : cleaned;
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

      // Sort by index if provided to guarantee original order
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
  private readonly model: string;
  readonly dimension: number;

  constructor(options: { token?: string; model?: string; dimension?: number }) {
    this.token = options.token || "";
    this.model = options.model || "BAAI/bge-m3";
    this.dimension = options.dimension || 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `https://api-inference.huggingface.co/pipeline/feature-extraction/${this.model}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({
        inputs: texts.map((t) => (t.length > 2000 ? t.slice(0, 2000) : t)),
        options: { wait_for_model: true }
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`HuggingFace embedding failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as number[][] | number[];
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "number") {
      return [data as number[]];
    }
    return data as number[][];
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  readonly dimension: number;

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
      content: { parts: [{ text: text.length > 2000 ? text.slice(0, 2000) : text }] }
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

/**
 * Deterministic pseudo-random mock embedding provider for tests and offline usage.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;

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

export function createEmbeddingProvider(env: Env): EmbeddingProvider {
  switch (env.EMBEDDING_PROVIDER) {
    case "openai": {
      const apiKey = env.EMBEDDING_API_KEY || env.OPENAI_API_KEY;
      return new OpenAIEmbeddingProvider({
        apiKey,
        baseUrl: env.EMBEDDING_BASE_URL,
        model: env.EMBEDDING_MODEL,
        dimension: env.EMBEDDING_DIMENSION
      });
    }
    case "huggingface": {
      const token = env.HF_TOKEN || env.EMBEDDING_API_KEY;
      return new HuggingFaceEmbeddingProvider({
        token,
        model: env.EMBEDDING_MODEL,
        dimension: env.EMBEDDING_DIMENSION
      });
    }
    case "gemini": {
      const apiKey = env.GEMINI_API_KEY || env.EMBEDDING_API_KEY;
      return new GeminiEmbeddingProvider({
        apiKey,
        model: env.EMBEDDING_MODEL,
        dimension: env.EMBEDDING_DIMENSION
      });
    }
    case "mock":
    default:
      return new MockEmbeddingProvider(env.EMBEDDING_DIMENSION);
  }
}
