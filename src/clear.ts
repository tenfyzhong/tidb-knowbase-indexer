import * as core from "@actions/core";
import { parseEnv } from "./config.js";
import { TiDBClient } from "./db.js";

async function main(): Promise<void> {
  try {
    const env = parseEnv(process.env);
    const db = new TiDBClient(env);

    const sourceName = process.argv[2]?.trim();

    try {
      if (sourceName) {
        core.info(`Clearing knowledge base data for source: ${sourceName}`);
        const result = await db.clearSourceData(sourceName);
        core.info(
          `Successfully cleared source '${sourceName}': deleted ${result.deletedChunks} chunks, sync state reset: ${result.deletedState}`
        );
      } else {
        core.info("Clearing ALL knowledge base data from TiDB Cloud...");
        const result = await db.clearAllData();
        core.info(
          `Successfully cleared all data: deleted ${result.deletedChunks} chunks, reset sync states: ${result.deletedState}`
        );
      }
    } finally {
      await db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Clear failed: ${message}`);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  main();
}
