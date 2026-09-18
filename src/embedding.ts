import crypto from "node:crypto";
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
  readonly model: string;
  readonly dimension: number;
  readonly isAutoEmbedding = false;

  constructor(options: { token?: string; model?: string; dimension?: number }) {
    this.token = options.token || "";
    this.model = options.model || "BAAI/bge-m3";
    this.dimension = options.dimension || 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `https://router.huggingface.co/hf-inference/models/${this.model}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({
        inputs: texts.map((t) => (t.length > 2500 ? t.slice(0, 2500) : t)),
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
