import * as core from "@actions/core";
import type { Config, Env, Source } from "./config.js";
import { TiDBClient, type ChunkRecord, type SyncState } from "./db.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding.js";
import { chunkText, generateVectorId, hasConfidentialTag } from "./chunker.js";
import { loadGitDocuments } from "./sources/git.js";
import { loadWebDocuments } from "./sources/web.js";

export interface DocumentItem {
  path: string;
  hash: string;
  content: string;
  title?: string;
}

export interface DiffResult {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
}

export interface SyncResult {
  sourceName: string;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  unchangedCount: number;
  totalChunks: number;
  skippedConfidentialCount: number;
}

export interface SyncOptions {
  batchSize?: number;
  gitDiff?: DiffResult;
  commit?: string;
  lastCommit?: string;
}

export function calculateDiff(
  prevState: SyncState,
  currentDocs: Map<string, DocumentItem>
): DiffResult {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];

  const prevFiles = prevState.files || {};
  const prevFilePaths = Object.keys(prevFiles);

  for (const [filePath, doc] of currentDocs.entries()) {
    const prevItem = prevFiles[filePath];
    if (!prevItem) {
      added.push(filePath);
    } else if (prevItem.hash !== doc.hash) {
      modified.push(filePath);
    } else {
      unchanged.push(filePath);
    }
  }

  for (const prevPath of prevFilePaths) {
    if (!currentDocs.has(prevPath)) {
      deleted.push(prevPath);
    }
  }

  return { added, modified, deleted, unchanged };
}

export async function syncSource(
  source: Source,
  currentDocs: Map<string, DocumentItem>,
  db: TiDBClient,
  embedder?: EmbeddingProvider | null,
  options: SyncOptions = {}
): Promise<SyncResult> {
  core.info(`[${source.name}] Fetching previous sync state from TiDB...`);
  const prevState: SyncState = (await db.getSyncState(source.name)) || { files: {} };
  const prevFiles = prevState.files || {};

  core.info(`[${source.name}] Calculating diff...`);
  const diff = options.gitDiff ?? calculateDiff(prevState, currentDocs);

  core.info(
    `[${source.name}] Diff: +${diff.added.length}, ~${diff.modified.length}, -${diff.deleted.length}, =${diff.unchanged.length}`
  );

  const filesToProcess = [...diff.added, ...diff.modified];
  let skippedConfidentialCount = 0;
  const newChunksToUpsert: ChunkRecord[] = [];
  const nextFilesState: Record<string, { hash: string; chunkCount: number; isConfidential?: boolean }> = {
    ...prevFiles
  };

  // Remove deleted files from state and remove their chunks from TiDB
  for (const deletedPath of diff.deleted) {
    core.info(`[${source.name}] Removing deleted document chunks: ${deletedPath}`);
    await db.deleteChunksByPath(source.name, deletedPath);
    delete nextFilesState[deletedPath];
  }

  // Process added and modified files
  for (const filePath of filesToProcess) {
    const doc = currentDocs.get(filePath);
    if (!doc) continue;

    // Check for confidential notes
    if (hasConfidentialTag(doc.content)) {
      core.info(`[${source.name}] Skipping confidential note: ${filePath}`);
      skippedConfidentialCount++;

      if (diff.modified.includes(filePath)) {
        await db.deleteChunksByPath(source.name, filePath);
      }

      nextFilesState[filePath] = {
        hash: doc.hash,
        chunkCount: 0,
        isConfidential: true
      };
      continue;
    }

    // If modified, remove existing chunks before inserting new ones
    if (diff.modified.includes(filePath)) {
      await db.deleteChunksByPath(source.name, filePath);
    }

    const textChunks = chunkText(doc.content);
    const chunkTexts: string[] = [];
    const pendingRecords: Omit<ChunkRecord, "embedding">[] = [];

    for (let idx = 0; idx < textChunks.length; idx++) {
      const chunk = textChunks[idx];
      const vectorId = generateVectorId(source.name, filePath, chunk.chunkIndex);

      pendingRecords.push({
        id: vectorId,
        text: chunk.text,
        source: source.name,
        path: filePath,
        title: doc.title,
        chunkIndex: chunk.chunkIndex,
        url: source.type === "web" ? filePath : undefined
      });
      chunkTexts.push(chunk.text);
    }

    if (chunkTexts.length > 0) {
      if (embedder) {
        core.info(`[${source.name}] Generating embeddings for ${filePath} (${chunkTexts.length} chunks)...`);
        const embeddings = await embedder.embed(chunkTexts);
        for (let i = 0; i < pendingRecords.length; i++) {
          newChunksToUpsert.push({
            ...pendingRecords[i],
            embedding: embeddings[i]
          });
        }
      } else {
        for (const rec of pendingRecords) {
          newChunksToUpsert.push(rec);
        }
      }
    }

    nextFilesState[filePath] = {
      hash: doc.hash,
      chunkCount: textChunks.length,
      isConfidential: false
    };
  }

  // Write new/updated chunks into TiDB Cloud Starter
  if (newChunksToUpsert.length > 0) {
    core.info(`[${source.name}] Writing ${newChunksToUpsert.length} chunks into TiDB Cloud...`);
    await db.upsertChunks(newChunksToUpsert);
  }

  // Save updated sync state in TiDB
  const nextCommit = options.commit || options.lastCommit || prevState.lastCommit;
  const nextState: SyncState = {
    lastCommit: nextCommit,
    files: nextFilesState
  };

  core.info(`[${source.name}] Saving updated sync state to TiDB...`);
  await db.saveSyncState(source.name, nextState);

  const totalChunks = Object.values(nextFilesState).reduce((acc, f) => acc + (f.chunkCount || 0), 0);

  return {
    sourceName: source.name,
    addedCount: diff.added.length,
    modifiedCount: diff.modified.length,
    deletedCount: diff.deleted.length,
    unchangedCount: diff.unchanged.length,
    totalChunks,
    skippedConfidentialCount
  };
}

export async function runSync(config: Config, env: Env): Promise<SyncResult[]> {
  const db = new TiDBClient(env);
  const embedder = env.EMBEDDING_PROVIDER === "auto" ? null : createEmbeddingProvider(env);
  const results: SyncResult[] = [];

  try {
    core.info("Initializing TiDB schema if not exists...");
    await db.initSchema();
    for (const source of config) {
      core.info(`=== Starting synchronization for source: ${source.name} (${source.type}) ===`);

      if (source.type === "git") {
        const prevState = await db.getSyncState(source.name);
        const lastCommit = prevState?.lastCommit;

        core.info(`Loading Git documents from ${source.url} (branch: ${source.branch})...`);
        const gitResult = await loadGitDocuments(source, lastCommit);

        const result = await syncSource(source, gitResult.docs, db, embedder, {
          gitDiff: gitResult.diff,
          commit: gitResult.currentCommit
        });
        results.push(result);
      } else if (source.type === "web") {
        core.info(`Crawling web documents from ${source.url}...`);
        const webDocs = await loadWebDocuments(source);

        const result = await syncSource(source, webDocs, db, embedder);
        results.push(result);
      }
    }

    return results;
  } finally {
    await db.close();
  }
}
