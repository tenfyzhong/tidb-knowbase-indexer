import { describe, it, expect } from "vitest";
import {
  computeHash,
  generateVectorId,
  hasConfidentialTag,
  extractHtmlText,
  chunkText
} from "./chunker.js";

describe("chunker", () => {
  describe("computeHash", () => {
    it("should compute deterministic SHA-256 hash", () => {
      const hash1 = computeHash("hello world");
      const hash2 = computeHash("hello world");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });
  });

  describe("generateVectorId", () => {
    it("should generate deterministic vector IDs", () => {
      const id1 = generateVectorId("notes", "docs/intro.md", 0);
      const id2 = generateVectorId("notes", "docs/intro.md", 0);
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^notes:[a-f0-9]{32}:0$/);
    });
  });

  describe("hasConfidentialTag", () => {
    it("should detect tag in YAML frontmatter", () => {
      const doc = `---
title: Private Note
tags: [work, confidential]
---
Some secret text.`;
      expect(hasConfidentialTag(doc)).toBe(true);
    });

    it("should detect inline tag in markdown body", () => {
      const doc = `# Project Secret\nThis document contains #confidential information.`;
      expect(hasConfidentialTag(doc)).toBe(true);
    });

    it("should detect subtag in markdown body", () => {
      const doc = `Meeting notes with #confidential/salary details.`;
      expect(hasConfidentialTag(doc)).toBe(true);
    });

    it("should ignore # Confidential heading", () => {
      const doc = `# Confidential\nThis is just a heading, not a hashtag.`;
      expect(hasConfidentialTag(doc)).toBe(false);
    });

    it("should ignore tag inside code blocks", () => {
      const doc = "Here is sample code:\n```bash\necho '#confidential'\n```\nNormal text.";
      expect(hasConfidentialTag(doc)).toBe(false);
    });

    it("should return false for clean document", () => {
      const doc = `# Public Architecture\nClean document without tags.`;
      expect(hasConfidentialTag(doc)).toBe(false);
    });
  });

  describe("extractHtmlText", () => {
    it("should extract title and clean body text from HTML", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>My Article</title>
            <script>console.log("ignore");</script>
            <style>body { color: red; }</style>
          </head>
          <body>
            <nav><a href="/">Home</a></nav>
            <main>
              <h1>Article Heading</h1>
              <p>First paragraph of content.</p>
              <p>Second paragraph of content.</p>
            </main>
            <footer>Copyright 2026</footer>
          </body>
        </html>
      `;

      const { title, text } = extractHtmlText(html);
      expect(title).toBe("My Article");
      expect(text).toContain("First paragraph of content.");
      expect(text).toContain("Second paragraph of content.");
      expect(text).not.toContain("console.log");
      expect(text).not.toContain("Copyright 2026");
    });
  });

  describe("chunkText", () => {
    it("should return single chunk for short text", () => {
      const text = "Short paragraph text.";
      const chunks = chunkText(text, { maxChunkSize: 500 });
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe(text);
      expect(chunks[0].chunkIndex).toBe(0);
    });

    it("should chunk long text with headers and overlap", () => {
      const section1 = "# Section 1\n" + "A".repeat(400);
      const section2 = "# Section 2\n" + "B".repeat(400);
      const content = `${section1}\n\n${section2}`;

      const chunks = chunkText(content, { maxChunkSize: 450, overlap: 50 });
      expect(chunks.length).toBeGreaterThan(1);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].chunkIndex).toBe(i);
      }
    });

    it("should handle empty content", () => {
      expect(chunkText("")).toEqual([]);
      expect(chunkText("   ")).toEqual([]);
    });
  });
});
