import * as core from "@actions/core";
import { parseConfig, parseEnv, sanitizeLogs } from "./config.js";
import { runSync } from "./sync.js";

async function main(): Promise<void> {
  try {
    const rawConfigJson = process.env.CONFIG_JSON;
    if (!rawConfigJson) {
      throw new Error("Missing required environment variable or secret: CONFIG_JSON");
    }

    const config = parseConfig(rawConfigJson);
    const env = parseEnv(process.env);

    sanitizeLogs(config, env);

    core.info(`Starting Knowledge Base Indexer with ${config.length} configured source(s)`);
    const results = await runSync(config, env);

    core.info("Synchronization completed successfully!");
    for (const r of results) {
      core.info(
        `[${r.sourceName}] Added: ${r.addedCount}, Modified: ${r.modifiedCount}, Deleted: ${r.deletedCount}, Unchanged: ${r.unchangedCount}, Total Chunks: ${r.totalChunks}, Skipped Confidential: ${r.skippedConfidentialCount}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Knowledge Base Indexer failed: ${message}`);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  main();
}
