import { describe, it, expect, vi, beforeEach } from "vitest";
import mysql from "mysql2/promise";
import { resolveSslOptions, TiDBClient } from "./db.js";
import { MockEmbeddingProvider, TiDBAutoEmbeddingProvider } from "./embedding.js";
import type { Env } from "./config.js";

vi.mock("mysql2/promise");

describe("db", () => {
  const baseEnv: Env = {
    TIDB_HOST: "localhost",
    TIDB_USER: "root",
    TIDB_DATABASE: "test",
    TIDB_PORT: 4000,
    TIDB_SSL: true,
    TIDB_SSL_REJECT_UNAUTHORIZED: true
  };

  describe("resolveSslOptions", () => {
    it("returns undefined when TIDB_SSL is false", () => {
      expect(resolveSslOptions({ ...baseEnv, TIDB_SSL: false })).toBeUndefined();
    });

    it("returns rejectUnauthorized option by default", () => {
      const ssl = resolveSslOptions(baseEnv);
      expect(ssl?.rejectUnauthorized).toBe(true);
    });

    it("accepts inline PEM text for TIDB_CA", () => {
      const caPem = "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----";
      const ssl = resolveSslOptions({ ...baseEnv, TIDB_CA: caPem });
      expect(ssl?.ca).toBe(caPem);
    });
  });

  describe("TiDBClient initSchema & upsertChunks", () => {
    let mockPool: {
      query: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockPool = {
        query: vi.fn(),
        end: vi.fn()
      };
      (mysql.createPool as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPool);
    });

    it("creates chunks table with VECTOR(dim) NOT NULL when using client-side embedding", async () => {
      const mockProvider = new MockEmbeddingProvider(1024);
      const client = new TiDBClient(baseEnv, mockProvider);

      mockPool.query.mockResolvedValueOnce([[]]); // INFORMATION_SCHEMA
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE chunks
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE sync_state

      await client.initSchema();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("embedding VECTOR(1024) NOT NULL")
      );
      expect(mockPool.query).not.toHaveBeenCalledWith(
        expect.stringContaining("GENERATED ALWAYS AS")
      );
    });

    it("creates chunks table with EMBED_TEXT generated column when using TiDB auto embedding", async () => {
      const autoProvider = new TiDBAutoEmbeddingProvider({
        model: "tidbcloud_free/amazon/titan-embed-text-v2",
        dimension: 1024
      });
      const client = new TiDBClient(baseEnv, autoProvider);

      mockPool.query.mockResolvedValueOnce([[]]); // INFORMATION_SCHEMA
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE chunks
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE sync_state

      await client.initSchema();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("embedding VECTOR(1024) GENERATED ALWAYS AS (")
      );
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", text)')
      );
    });

    it("drops legacy table when switching from auto generated column to client-side vector", async () => {
      const mockProvider = new MockEmbeddingProvider(1024);
      const client = new TiDBClient(baseEnv, mockProvider);

      // Existing table has GENERATED ALWAYS AS (EMBED_TEXT)
      mockPool.query.mockResolvedValueOnce([
        [{ EXTRA: "STORED GENERATED", GENERATION_EXPRESSION: 'EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", text)' }]
      ]);
      mockPool.query.mockResolvedValueOnce([{}]); // DROP TABLE IF EXISTS chunks
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE chunks
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE sync_state

      await client.initSchema();

      expect(mockPool.query).toHaveBeenCalledWith("DROP TABLE IF EXISTS chunks");
    });

    it("upserts chunks with VEC_FROM_TEXT(?) when using client-side embedding", async () => {
      const mockProvider = new MockEmbeddingProvider(1024);
      const client = new TiDBClient(baseEnv, mockProvider);

      mockPool.query.mockResolvedValue([{}]);

      const count = await client.upsertChunks([
        {
          id: "chunk-1",
          text: "Sample chunk text",
          source: "notes",
          path: "doc.md",
          chunkIndex: 0
        }
      ]);

      expect(count).toBe(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("VEC_FROM_TEXT(?)"),
        expect.arrayContaining(["chunk-1", "Sample chunk text"])
      );
    });

    it("upserts chunks without VEC_FROM_TEXT when using TiDB auto embedding", async () => {
      const autoProvider = new TiDBAutoEmbeddingProvider();
      const client = new TiDBClient(baseEnv, autoProvider);

      mockPool.query.mockResolvedValue([{}]);

      const count = await client.upsertChunks([
        {
          id: "chunk-1",
          text: "Sample chunk text",
          source: "notes",
          path: "doc.md",
          chunkIndex: 0
        }
      ]);

      expect(count).toBe(1);
      expect(mockPool.query).not.toHaveBeenCalledWith(
        expect.stringContaining("VEC_FROM_TEXT(?)"),
        expect.anything()
      );
    });
  });
});
