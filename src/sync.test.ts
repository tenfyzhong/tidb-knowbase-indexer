import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateDiff, syncSource, type DocumentItem } from "./sync.js";
import type { GitSource } from "./config.js";
import type { TiDBClient, SyncState, ChunkRecord } from "./db.js";
import { MockEmbeddingProvider } from "./embedding.js";

describe("sync", () => {
  describe("calculateDiff", () => {
    it("should accurately compute added, modified, deleted, unchanged files", () => {
      const prevState: SyncState = {
        files: {
          "doc1.md": { hash: "hash1", chunkCount: 2 },
          "doc2.md": { hash: "hash2_old", chunkCount: 1 },
          "doc3.md": { hash: "hash3", chunkCount: 3 }
        }
      };

      const currentDocs = new Map<string, DocumentItem>([
        ["doc2.md", { path: "doc2.md", hash: "hash2_new", content: "new content" }],
        ["doc3.md", { path: "doc3.md", hash: "hash3", content: "unchanged content" }],
        ["doc4.md", { path: "doc4.md", hash: "hash4", content: "brand new doc" }]
      ]);

      const diff = calculateDiff(prevState, currentDocs);
      expect(diff.added).toEqual(["doc4.md"]);
      expect(diff.modified).toEqual(["doc2.md"]);
      expect(diff.deleted).toEqual(["doc1.md"]);
      expect(diff.unchanged).toEqual(["doc3.md"]);
    });
  });

  describe("syncSource", () => {
    const embedder = new MockEmbeddingProvider(128);

    const sampleSource: GitSource = {
      name: "test-notes",
      type: "git",
      url: "https://github.com/example/notes.git",
      branch: "main",
      include: ["**/*.md"],
      exclude: []
    };

    let mockGetSyncState: ReturnType<typeof vi.fn>;
    let mockSaveSyncState: ReturnType<typeof vi.fn>;
    let mockUpsertChunks: ReturnType<typeof vi.fn>;
    let mockDeleteChunksByPath: ReturnType<typeof vi.fn>;
    let mockDeleteChunksByIds: ReturnType<typeof vi.fn>;
    let mockDb: TiDBClient;

    beforeEach(() => {
      mockGetSyncState = vi.fn();
      mockSaveSyncState = vi.fn().mockResolvedValue(undefined);
      mockUpsertChunks = vi.fn().mockResolvedValue(0);
      mockDeleteChunksByPath = vi.fn().mockResolvedValue(0);
      mockDeleteChunksByIds = vi.fn().mockResolvedValue(0);

      mockDb = {
        getSyncState: mockGetSyncState,
        saveSyncState: mockSaveSyncState,
        upsertChunks: mockUpsertChunks,
        deleteChunksByPath: mockDeleteChunksByPath,
        deleteChunksByIds: mockDeleteChunksByIds
      } as unknown as TiDBClient;
    });

    it("should process added files and upsert chunks", async () => {
      mockGetSyncState.mockResolvedValue(null);

      const docs = new Map<string, DocumentItem>([
        [
          "guide.md",
          {
            path: "guide.md",
            hash: "h_guide",
            content: "# Guide\nThis is an introduction.",
            title: "guide"
          }
        ]
      ]);

      const result = await syncSource(sampleSource, docs, mockDb, embedder);

      expect(result.addedCount).toBe(1);
      expect(result.modifiedCount).toBe(0);
      expect(result.deletedCount).toBe(0);
      expect(result.totalChunks).toBe(1);
      expect(mockUpsertChunks).toHaveBeenCalledTimes(1);

      const upsertedChunks = mockUpsertChunks.mock.calls[0][0] as ChunkRecord[];
      expect(upsertedChunks).toHaveLength(1);
      expect(upsertedChunks[0].source).toBe("test-notes");
      expect(upsertedChunks[0].path).toBe("guide.md");
      expect(upsertedChunks[0].embedding).toHaveLength(128);

      expect(mockSaveSyncState).toHaveBeenCalledTimes(1);
      const savedState = mockSaveSyncState.mock.calls[0][1] as SyncState;
      expect(savedState.files["guide.md"].hash).toBe("h_guide");
      expect(savedState.files["guide.md"].chunkCount).toBe(1);
    });

    it("should process added files with TiDB Auto Embedding when no embedder is provided", async () => {
      mockGetSyncState.mockResolvedValue(null);

      const docs = new Map<string, DocumentItem>([
        [
          "guide.md",
          {
            path: "guide.md",
            hash: "h_guide",
            content: "# Guide\nThis is an introduction.",
            title: "guide"
          }
        ]
      ]);

      const result = await syncSource(sampleSource, docs, mockDb, null);

      expect(result.addedCount).toBe(1);
      expect(result.totalChunks).toBe(1);
      expect(mockUpsertChunks).toHaveBeenCalledTimes(1);

      const upsertedChunks = mockUpsertChunks.mock.calls[0][0] as ChunkRecord[];
      expect(upsertedChunks).toHaveLength(1);
      expect(upsertedChunks[0].source).toBe("test-notes");
      expect(upsertedChunks[0].path).toBe("guide.md");
      expect(upsertedChunks[0].embedding).toBeUndefined();
    });

    it("should delete chunks for removed files", async () => {
      mockGetSyncState.mockResolvedValue({
        files: {
          "old.md": { hash: "h_old", chunkCount: 2 }
        }
      });

      const docs = new Map<string, DocumentItem>();
      const result = await syncSource(sampleSource, docs, mockDb, embedder);

      expect(result.deletedCount).toBe(1);
      expect(mockDeleteChunksByPath).toHaveBeenCalledWith("test-notes", "old.md");
    });

    it("should skip confidential notes and remove prior chunks if previously indexed", async () => {
      mockGetSyncState.mockResolvedValue({
        files: {
          "private.md": { hash: "h_old_public", chunkCount: 1 }
        }
      });

      const docs = new Map<string, DocumentItem>([
        [
          "private.md",
          {
            path: "private.md",
            hash: "h_new_private",
            content: "# Secret\nThis has #confidential tag now.",
            title: "private"
          }
        ]
      ]);

      const result = await syncSource(sampleSource, docs, mockDb, embedder);

      expect(result.skippedConfidentialCount).toBe(1);
      expect(mockDeleteChunksByPath).toHaveBeenCalledWith("test-notes", "private.md");
      expect(mockUpsertChunks).not.toHaveBeenCalled();

      const savedState = mockSaveSyncState.mock.calls[0][1] as SyncState;
      expect(savedState.files["private.md"].isConfidential).toBe(true);
      expect(savedState.files["private.md"].chunkCount).toBe(0);
    });
  });
});
