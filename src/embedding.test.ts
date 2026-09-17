import { describe, it, expect } from "vitest";
import {
  MockEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider
} from "./embedding.js";
import { parseEnv } from "./config.js";

describe("embedding", () => {
  describe("MockEmbeddingProvider", () => {
    it("should generate deterministic normalized embeddings", async () => {
      const provider = new MockEmbeddingProvider(1024);
      expect(provider.dimension).toBe(1024);

      const [v1, v2] = await provider.embed(["test text 1", "test text 2"]);
      expect(v1).toHaveLength(1024);
      expect(v2).toHaveLength(1024);

      // Verify determinism
      const [v1Repeat] = await provider.embed(["test text 1"]);
      expect(v1).toEqual(v1Repeat);

      // Verify unit norm (approximately 1.0)
      const norm1 = Math.sqrt(v1.reduce((sum, x) => sum + x * x, 0));
      expect(norm1).toBeCloseTo(1.0, 2);
    });

    it("should return empty array for empty input", async () => {
      const provider = new MockEmbeddingProvider(1024);
      const result = await provider.embed([]);
      expect(result).toEqual([]);
    });
  });

  describe("createEmbeddingProvider", () => {
    it("should instantiate MockEmbeddingProvider when provider is mock", () => {
      const env = parseEnv({
        TIDB_DATABASE_URL: "mysql://localhost/test",
        EMBEDDING_PROVIDER: "mock",
        EMBEDDING_DIMENSION: "512"
      });

      const provider = createEmbeddingProvider(env);
      expect(provider).toBeInstanceOf(MockEmbeddingProvider);
      expect(provider.dimension).toBe(512);
    });

    it("should instantiate OpenAIEmbeddingProvider by default", () => {
      const env = parseEnv({
        TIDB_DATABASE_URL: "mysql://localhost/test",
        EMBEDDING_API_KEY: "sk-test",
        EMBEDDING_MODEL: "BAAI/bge-m3"
      });

      const provider = createEmbeddingProvider(env);
      expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
      expect(provider.dimension).toBe(1024);
    });
  });
});
