import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmbeddingProvider,
  MockEmbeddingProvider,
  OpenAIEmbeddingProvider,
  HuggingFaceEmbeddingProvider,
  GeminiEmbeddingProvider,
  JinaEmbeddingProvider,
  TiDBAutoEmbeddingProvider
} from "./embedding.js";
import type { Env } from "./config.js";

describe("Embedding Providers", () => {
  const baseEnv: Env = {
    TIDB_HOST: "localhost",
    TIDB_USER: "root",
    TIDB_DATABASE: "test",
    TIDB_PORT: 4000,
    TIDB_SSL: true,
    TIDB_SSL_REJECT_UNAUTHORIZED: true
  };

  describe("MockEmbeddingProvider", () => {
    it("generates deterministic unit-normalized embeddings of the requested dimension", async () => {
      const provider = new MockEmbeddingProvider(1024);
      expect(provider.dimension).toBe(1024);
      expect(provider.isAutoEmbedding).toBe(false);

      const results = await provider.embed(["Hello world", "Hello world", "Another text"]);
      expect(results.length).toBe(3);
      expect(results[0].length).toBe(1024);
      expect(results[1].length).toBe(1024);
      // Deterministic
      expect(results[0]).toEqual(results[1]);
      // Different for different text
      expect(results[0]).not.toEqual(results[2]);

      // Unit normalized (sum of squares ~ 1)
      const sumSq = results[0].reduce((acc, v) => acc + v * v, 0);
      expect(Math.abs(sumSq - 1)).toBeLessThan(0.01);
    });

    it("handles empty texts gracefully", async () => {
      const provider = new MockEmbeddingProvider(512);
      const results = await provider.embed([]);
      expect(results).toEqual([]);
    });
  });

  describe("OpenAIEmbeddingProvider", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("sends batch embedding requests and returns ordered vectors", async () => {
      const mockResponse = {
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] }
        ]
      };

      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-test",
        baseUrl: "https://api.siliconflow.cn/v1",
        model: "BAAI/bge-m3",
        dimension: 2
      });

      const results = await provider.embed(["First", "Second"]);
      expect(results).toEqual([
        [0.1, 0.2],
        [0.3, 0.4]
      ]);

      expect(global.fetch).toHaveBeenCalledWith("https://api.siliconflow.cn/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk-test"
        },
        body: JSON.stringify({
          model: "BAAI/bge-m3",
          input: ["First", "Second"]
        })
      });
    });

    it("throws a clear error if API returns error status", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid API key"
      });

      const provider = new OpenAIEmbeddingProvider({
        apiKey: "invalid",
        baseUrl: "https://api.siliconflow.cn/v1"
      });

      await expect(provider.embed(["test"])).rejects.toThrow("Embedding API request failed (401 Unauthorized)");
    });
  });
  describe("HuggingFaceEmbeddingProvider", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("calls HuggingFace router pipeline/feature-extraction endpoint with token and x-wait-for-model", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [
          [0.1, 0.2],
          [0.3, 0.4]
        ]
      });

      const provider = new HuggingFaceEmbeddingProvider({
        token: "hf_test",
        model: "BAAI/bge-m3",
        dimension: 2
      });

      const results = await provider.embed(["A", "B"]);
      expect(results).toEqual([
        [0.1, 0.2],
        [0.3, 0.4]
      ]);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://router.huggingface.co/hf-inference/models/BAAI/bge-m3/pipeline/feature-extraction",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer hf_test",
            "x-wait-for-model": "true"
          }),
          body: JSON.stringify({
            inputs: ["A", "B"],
            options: { wait_for_model: true }
          })
        })
      );
    });

    it("handles 1D array response when a single vector is returned", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [0.5, 0.6]
      });

      const provider = new HuggingFaceEmbeddingProvider({
        token: "hf_test",
        model: "BAAI/bge-m3",
        dimension: 2
      });

      const results = await provider.embed(["Single sentence"]);
      expect(results).toEqual([[0.5, 0.6]]);
    });

    it("handles 3D array response (token-level embeddings) and applies mean pooling", async () => {
      // Batch of 1 item with 2 tokens of 2 dimensions:
      // Token 1: [1.0, 3.0], Token 2: [3.0, 5.0] -> Mean pooled: [2.0, 4.0]
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [
          [
            [1.0, 3.0],
            [3.0, 5.0]
          ]
        ]
      });

      const provider = new HuggingFaceEmbeddingProvider({
        token: "hf_test",
        model: "BAAI/bge-m3",
        dimension: 2
      });

      const results = await provider.embed(["Sentence to pool"]);
      expect(results).toEqual([[2.0, 4.0]]);
    });

    it("splits large texts into batches of 16", async () => {
      const batch1Response = Array.from({ length: 16 }, () => [0.1, 0.1]);
      const batch2Response = Array.from({ length: 4 }, () => [0.2, 0.2]);

      (global.fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => batch1Response
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => batch2Response
        });

      const provider = new HuggingFaceEmbeddingProvider({
        token: "hf_test",
        model: "BAAI/bge-m3",
        dimension: 2
      });

      const texts = Array.from({ length: 20 }, (_, i) => `Text ${i}`);
      const results = await provider.embed(texts);

      expect(results.length).toBe(20);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });


  describe("TiDBAutoEmbeddingProvider", () => {
    it("identifies as auto embedding and delegates computation to TiDB", async () => {
      const provider = new TiDBAutoEmbeddingProvider({
        model: "tidbcloud_free/amazon/titan-embed-text-v2",
        dimension: 1024
      });

      expect(provider.isAutoEmbedding).toBe(true);
      expect(provider.dimension).toBe(1024);
      expect(provider.model).toBe("tidbcloud_free/amazon/titan-embed-text-v2");

      const res = await provider.embed(["test"]);
      expect(res).toEqual([]);
    });
  });

  describe("createEmbeddingProvider", () => {
    it("creates Mock provider when EMBEDDING_PROVIDER=mock", () => {
      const provider = createEmbeddingProvider({
        ...baseEnv,
        EMBEDDING_PROVIDER: "mock",
        EMBEDDING_DIMENSION: 768
      });
      expect(provider).toBeInstanceOf(MockEmbeddingProvider);
      expect(provider.dimension).toBe(768);
    });

    it("creates TiDBAuto provider when EMBEDDING_PROVIDER=tidb_auto or auto", () => {
      const provider = createEmbeddingProvider({
        ...baseEnv,
        EMBEDDING_PROVIDER: "tidb_auto"
      });
      expect(provider).toBeInstanceOf(TiDBAutoEmbeddingProvider);
      expect(provider.isAutoEmbedding).toBe(true);
    });

    it("defaults to OpenAI (SiliconFlow) when EMBEDDING_API_KEY is provided", () => {
      const provider = createEmbeddingProvider({
        ...baseEnv,
        EMBEDDING_API_KEY: "sk-sf-test"
      });
      expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
      expect(provider.dimension).toBe(1024);
    });
  });
});
