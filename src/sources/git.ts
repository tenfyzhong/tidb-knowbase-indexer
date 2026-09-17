import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { GitSource } from "../config.js";
import { computeHash } from "../chunker.js";
import type { DocumentItem, DiffResult } from "../sync.js";

const execFileAsync = promisify(execFile);

function matchPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Convert glob pattern to regular expression
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*(?!\*)/g, "[^/]*")
      .replace(/\?/g, ".");
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(filePath);
  });
}

export function parseGitDiffOutput(
  diffOutput: string,
  includePatterns: string[],
  excludePatterns: string[]
): { added: string[]; modified: string[]; deleted: string[] } {
  const added = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();

  const lines = diffOutput.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  for (const line of lines) {
    const parts = line.split(/\t+/);
    if (parts.length < 2) continue;

    const statusCode = parts[0];
    const status = statusCode[0];

    if (status === "R" || status === "C") {
      const oldPath = parts[1];
      const newPath = parts[2] || parts[1];

      if (matchPattern(oldPath, includePatterns) && !matchPattern(oldPath, excludePatterns)) {
        deleted.add(oldPath);
      }
      if (matchPattern(newPath, includePatterns) && !matchPattern(newPath, excludePatterns)) {
        added.add(newPath);
      }
      continue;
    }

    const filePath = parts[1];
    const isIncluded = matchPattern(filePath, includePatterns);
    const isExcluded = matchPattern(filePath, excludePatterns);

    if (!isIncluded || isExcluded) continue;

    if (status === "A") {
      added.add(filePath);
    } else if (status === "M") {
      modified.add(filePath);
    } else if (status === "D") {
      deleted.add(filePath);
    }
  }

  return {
    added: Array.from(added),
    modified: Array.from(modified),
    deleted: Array.from(deleted)
  };
}

export interface GitLoadResult {
  currentCommit: string;
  diff?: DiffResult;
  docs: Map<string, DocumentItem>;
}

export async function loadGitDocuments(
  source: GitSource,
  lastCommit?: string
): Promise<GitLoadResult> {
  const tempDir = path.join(os.tmpdir(), `knowbase-git-${crypto.randomUUID()}`);
  const docs = new Map<string, DocumentItem>();

  try {
    let authUrl = source.url;
    if (source.token) {
      const urlObj = new URL(source.url);
      urlObj.username = "x-access-token";
      urlObj.password = source.token;
      authUrl = urlObj.toString();
    }

    await fs.mkdir(tempDir, { recursive: true });

    let isIncremental = false;
    let diffResult: DiffResult | undefined;

    if (lastCommit) {
      try {
        await execFileAsync("git", ["init"], { cwd: tempDir });
        await execFileAsync("git", ["remote", "add", "origin", authUrl], { cwd: tempDir });
        await execFileAsync("git", ["fetch", "--depth=50", "origin", source.branch], { cwd: tempDir });
        await execFileAsync("git", ["checkout", source.branch], { cwd: tempDir });

        const { stdout: headStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir });
        const currentCommit = headStdout.trim();

        if (currentCommit === lastCommit) {
          return { currentCommit, docs };
        }

        // Check if lastCommit is present in fetched history
        await execFileAsync("git", ["cat-file", "-e", `${lastCommit}^{commit}`], { cwd: tempDir });

        const { stdout: diffStdout } = await execFileAsync(
          "git",
          ["diff", "--name-status", lastCommit, "HEAD"],
          { cwd: tempDir }
        );

        const parsed = parseGitDiffOutput(diffStdout, source.include, source.exclude);
        isIncremental = true;
        diffResult = {
          added: parsed.added,
          modified: parsed.modified,
          deleted: parsed.deleted,
          unchanged: []
        };

        // Read content for added and modified files
        const filesToRead = [...parsed.added, ...parsed.modified];
        for (const relPath of filesToRead) {
          const fullPath = path.join(tempDir, relPath);
          try {
            const content = await fs.readFile(fullPath, "utf-8");
            const hash = computeHash(content);
            const title = path.basename(relPath, path.extname(relPath));
            docs.set(relPath, { path: relPath, hash, content, title });
          } catch {
            // File might have been deleted in working tree
          }
        }

        return { currentCommit, diff: diffResult, docs };
      } catch {
        // Fallback to full clone
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(tempDir, { recursive: true });
      }
    }

    // Full clone
    await execFileAsync("git", ["clone", "--depth=1", "--branch", source.branch, authUrl, tempDir]);

    const { stdout: headStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempDir });
    const currentCommit = headStdout.trim();

    async function walk(dir: string, baseDir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          if (!matchPattern(`${relPath}/`, source.exclude)) {
            await walk(fullPath, baseDir);
          }
        } else if (entry.isFile()) {
          const isIncluded = matchPattern(relPath, source.include);
          const isExcluded = matchPattern(relPath, source.exclude);

          if (isIncluded && !isExcluded) {
            try {
              const content = await fs.readFile(fullPath, "utf-8");
              const hash = computeHash(content);
              const title = path.basename(relPath, path.extname(relPath));
              docs.set(relPath, { path: relPath, hash, content, title });
            } catch {
              // Ignore unreadable binary or missing files
            }
          }
        }
      }
    }

    await walk(tempDir, tempDir);
    return { currentCommit, docs };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
