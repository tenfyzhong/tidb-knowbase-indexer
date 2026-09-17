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
    if (pattern.startsWith("**/")) {
      const ext = pattern.slice(3);
      if (ext.startsWith("*.")) {
        return filePath.endsWith(ext.slice(1));
      }
    }
    return filePath.includes(pattern.replace(/\*/g, ""));
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

    const status = parts[0];
    const statusCode = status[0].toUpperCase();

    if (statusCode === "R") {
      const oldPath = parts[1];
      const newPath = parts[2] || parts[1];

      if (
        matchPattern(oldPath, includePatterns) &&
        !excludePatterns.some((ex) => oldPath.includes(ex))
      ) {
        deleted.add(oldPath);
      }

      if (
        matchPattern(newPath, includePatterns) &&
        !excludePatterns.some((ex) => newPath.includes(ex))
      ) {
        added.add(newPath);
      }
    } else if (statusCode === "D") {
      const filePath = parts[1];
      if (
        matchPattern(filePath, includePatterns) &&
        !excludePatterns.some((ex) => filePath.includes(ex))
      ) {
        deleted.add(filePath);
      }
    } else if (statusCode === "A" || statusCode === "C") {
      const filePath = parts[1];
      if (
        matchPattern(filePath, includePatterns) &&
        !excludePatterns.some((ex) => filePath.includes(ex))
      ) {
        added.add(filePath);
      }
    } else if (statusCode === "M") {
      const filePath = parts[1];
      if (
        matchPattern(filePath, includePatterns) &&
        !excludePatterns.some((ex) => filePath.includes(ex))
      ) {
        modified.add(filePath);
      }
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
    const cloneArgs = ["clone"];
    if (source.branch) {
      cloneArgs.push("-b", source.branch);
    }

    let cloneUrl = source.url;
    const token =
      source.token ||
      process.env.GH_PAT ||
      process.env.GH_TOKEN ||
      process.env.GITHUB_TOKEN;

    if (token) {
      if (cloneUrl.startsWith("git@github.com:")) {
        const repoPath = cloneUrl.slice("git@github.com:".length);
        cloneUrl = `https://x-access-token:${token}@github.com/${repoPath}`;
      } else if (cloneUrl.startsWith("https://github.com/")) {
        const repoPath = cloneUrl.slice("https://github.com/".length);
        cloneUrl = `https://x-access-token:${token}@github.com/${repoPath}`;
      } else if (cloneUrl.startsWith("https://")) {
        try {
          const urlObj = new URL(cloneUrl);
          urlObj.username = "x-access-token";
          urlObj.password = token;
          cloneUrl = urlObj.toString();
        } catch {
          // ignore
        }
      }
    }

    cloneArgs.push(cloneUrl, tempDir);

    try {
      await execFileAsync("git", cloneArgs, { timeout: 120000 });
    } catch (err) {
      if (source.branch) {
        const fallbackArgs = ["clone", cloneUrl, tempDir];
        await execFileAsync("git", fallbackArgs, { timeout: 120000 });
      } else {
        throw err;
      }
    }

    const { stdout: headShaOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: tempDir
    });
    const currentCommit = headShaOut.trim();

    const includePatterns =
      source.include && source.include.length > 0
        ? source.include
        : ["**/*.md", "**/*.txt", "**/*.markdown"];
    const excludePatterns =
      source.exclude && source.exclude.length > 0
        ? source.exclude
        : [".git", "node_modules", ".DS_Store"];

    // Try git diff if lastCommit is provided and valid
    if (lastCommit && lastCommit.trim().length > 0) {
      try {
        const { stdout: commitCheck } = await execFileAsync(
          "git",
          ["cat-file", "-t", lastCommit],
          { cwd: tempDir }
        );

        if (commitCheck.trim() === "commit") {
          const { stdout: diffOutput } = await execFileAsync(
            "git",
            ["diff", "--name-status", lastCommit, "HEAD"],
            { cwd: tempDir }
          );

          const parsed = parseGitDiffOutput(diffOutput, includePatterns, excludePatterns);

          const filesToRead = [...parsed.added, ...parsed.modified];
          for (const relPath of filesToRead) {
            const fullPath = path.join(tempDir, relPath);
            try {
              const content = await fs.readFile(fullPath, "utf-8");
              const hash = computeHash(content);
              docs.set(relPath, {
                path: relPath,
                hash,
                content,
                title: path.basename(relPath).replace(/\.[^/.]+$/, "")
              });
            } catch {
              // File might have been removed
            }
          }

          return {
            currentCommit,
            diff: {
              added: parsed.added,
              modified: parsed.modified,
              deleted: parsed.deleted,
              unchanged: []
            },
            docs
          };
        }
      } catch {
        // Fall back to full scan
      }
    }

    // Full repository scan fallback
    async function walk(dir: string, relDir: string = ""): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

        if (excludePatterns.some((ex) => relPath.includes(ex))) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, relPath);
        } else if (entry.isFile()) {
          const isIncluded = matchPattern(relPath, includePatterns);
          if (isIncluded) {
            const content = await fs.readFile(fullPath, "utf-8");
            const hash = computeHash(content);
            docs.set(relPath, {
              path: relPath,
              hash,
              content,
              title: entry.name.replace(/\.[^/.]+$/, "")
            });
          }
        }
      }
    }

    await walk(tempDir);

    return {
      currentCommit,
      docs
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
