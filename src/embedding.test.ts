import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmbeddingProvider,
  MockEmbeddingProvider,
  CloudflareEmbeddingProvider,
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

  describe("CloudflareEmbeddingProvider", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("resolves endpoint correctly based on accountId and baseUrl", () => {
      const p1 = new CloudflareEmbeddingProvider({
        accountId: "my-account-id",
        apiToken: "cf-token"
      });
      expect(p1.resolveEndpoint()).toBe(
        "https://api.cloudflare.com/client/v4/accounts/my-account-id/ai/v1/embeddings"
      );
      expect(p1.model).toBe("@cf/baai/bge-m3");
      expect(p1.dimension).toBe(1024);
      expect(p1.isAutoEmbedding).toBe(false);

      const p2 = new CloudflareEmbeddingProvider({
        baseUrl: "https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/workers-ai/v1",
        apiToken: "cf-token"
      });
      expect(p2.resolveEndpoint()).toBe(
        "https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/workers-ai/v1/embeddings"
      );

      const p3 = new CloudflareEmbeddingProvider({
        baseUrl: "https://custom.endpoint.com/v1/embeddings",
        apiToken: "cf-token"
      });
      expect(p3.resolveEndpoint()).toBe("https://custom.endpoint.com/v1/embeddings");

      const p4 = new CloudflareEmbeddingProvider({
        apiToken: "cf-token"
      });
      expect(() => p4.resolveEndpoint()).toThrow("Cloudflare embedding requires CLOUDFLARE_ACCOUNT_ID");
    });

    it("sends batch embedding requests and parses OpenAI-compatible response", async () => {
      const mockResponse = {
        data: [
          { embedding: [0.1, 0.2, 0.3], index: 1 },
          { embedding: [0.4, 0.5, 0.6], index: 0 }
        ]
      };

      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const provider = new CloudflareEmbeddingProvider({
        accountId: "test-acc",
        apiToken: "test-token",
        model: "@cf/baai/bge-m3",
        dimension: 3
      });

      const embeddings = await provider.embed(["first text", "second text"]);
      expect(embeddings).toEqual([
        [0.4, 0.5, 0.6], // index 0
        [0.1, 0.2, 0.3]  // index 1
      ]);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledUrl).toBe("https://api.cloudflare.com/client/v4/accounts/test-acc/ai/v1/embeddings");
      expect(calledOptions.method).toBe("POST");
      expect(calledOptions.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer test-token"
      });
      const parsedBody = JSON.parse(calledOptions.body);
      expect(parsedBody.model).toBe("@cf/baai/bge-m3");
      expect(parsedBody.input).toEqual(["first text", "second text"]);
    });

    it("parses Cloudflare direct run response format ({ result: { data: [...] } })", async () => {
      const mockRunResponse = {
        result: {
          data: [
            [0.11, 0.22, 0.33],
            [0.44, 0.55, 0.66]
          ]
        },
        success: true
      };

      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockRunResponse
      });

      const provider = new CloudflareEmbeddingProvider({
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/test-acc/ai/run/@cf/baai/bge-m3",
        apiToken: "test-token",
        dimension: 3
      });

      const embeddings = await provider.embed(["first", "second"]);
      expect(embeddings).toEqual([
        [0.11, 0.22, 0.33],
        [0.44, 0.55, 0.66]
      ]);
    });

    it("retries on 429 and 500 status codes with backoff and succeeds", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: async () => "Rate limit exceeded"
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "Temporary glitch"
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ embedding: [0.1, 0.2], index: 0 }]
          })
        });

      const provider = new CloudflareEmbeddingProvider({
        accountId: "test-acc",
        apiToken: "test-token",
        dimension: 2,
        retryDelayMs: 1
      });

      const result = await provider.embed(["retry text"]);
      expect(result).toEqual([[0.1, 0.2]]);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it("throws clear error after exhausting retries on persistent 500", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "Permanent error"
      });

      const provider = new CloudflareEmbeddingProvider({
        accountId: "test-acc",
        apiToken: "test-token",
        dimension: 2,
        retryDelayMs: 1
      });

      await expect(provider.embed(["failing text"])).rejects.toThrow(
        "Cloudflare embedding failed (500)"
      );
    });

    it("throws error when response is missing both data and result", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unexpected: true })
      });

      const provider = new CloudflareEmbeddingProvider({
        accountId: "test-acc",
        apiToken: "test-token",
        dimension: 2
      });

      await expect(provider.embed(["bad payload"])).rejects.toThrow(
        "Invalid response from Cloudflare embedding API"
      );
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

    it("defaults to Cloudflare when CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is provided", () => {
      const provider = createEmbeddingProvider({
        ...baseEnv,
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_ACCOUNT_ID: "acc-123"
      });
      expect(provider).toBeInstanceOf(CloudflareEmbeddingProvider);
      expect(provider.dimension).toBe(1024);
      expect(provider.model).toBe("@cf/baai/bge-m3");
    });

    it("creates Cloudflare provider when EMBEDDING_PROVIDER=cloudflare or cf", () => {
      const provider = createEmbeddingProvider({
        ...baseEnv,
        EMBEDDING_PROVIDER: "cloudflare",
        CLOUDFLARE_ACCOUNT_ID: "acc-123"
      });
      expect(provider).toBeInstanceOf(CloudflareEmbeddingProvider);
    });
  });
});
