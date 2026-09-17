import crypto from "node:crypto";
import * as cheerio from "cheerio";

export interface TextChunk {
  chunkIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  maxChunkSize?: number;
  overlap?: number;
}

export function computeHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function generateVectorId(sourceName: string, filePath: string, chunkIndex: number): string {
  const pathHash = crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 32);
  const sanitizedSource = sourceName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20);
  return `${sanitizedSource}:${pathHash}:${chunkIndex}`;
}

export function hasConfidentialTag(content: string): boolean {
  if (!content) return false;

  // 1. Check YAML frontmatter for confidential tags
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const tagsMatch = frontmatter.match(/(?:tags|tag|labels):\s*([\s\S]*?)(?=\n[a-zA-Z0-9_-]+:|$)/i);
    if (tagsMatch) {
      const tagContent = tagsMatch[1].toLowerCase();
      if (
        tagContent.includes("confidential") ||
        tagContent.includes("#confidential") ||
        tagContent.includes('"confidential"') ||
        tagContent.includes("'confidential'")
      ) {
        return true;
      }
    }
  }

  // 2. Check Markdown body (strip code blocks to avoid matching examples)
  const bodyWithoutCode = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "");

  // Match #confidential or #confidential/subtag
  const tagRegex = /(?:^|\s)#(confidential(?:\/[a-zA-Z0-9_\-]+)?)(?=\s|$|[.,;:!?()[\]{}])/i;
  return tagRegex.test(bodyWithoutCode);
}

export function extractHtmlText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);

  $("script, style, nav, footer, header, noscript, svg, iframe").remove();

  const title = $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    "";

  // Replace block elements with newlines to preserve spacing
  $("p, div, h1, h2, h3, h4, h5, h6, li, tr, blockquote, pre, section, article").each((_, el) => {
    $(el).append("\n");
  });

  const rawText = $("body").length ? $("body").text() : $.text();
  const cleanText = rawText
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00A0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  return { title, text: cleanText };
}

export function chunkText(content: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChunkSize = options.maxChunkSize || 1000;
  const overlap = options.overlap !== undefined ? options.overlap : 150;

  if (!content || content.trim().length === 0) {
    return [];
  }

  // If text is short enough, return as single chunk
  if (content.length <= maxChunkSize) {
    return [
      {
        chunkIndex: 0,
        text: content.trim(),
        charStart: 0,
        charEnd: content.length
      }
    ];
  }

  // Split content by Markdown headers or section dividers
  const sectionSplitter = /(?=(?:\r?\n|^)#{1,4}\s+)/g;
  const rawSections = content.split(sectionSplitter).filter((s) => s.trim().length > 0);

  const sections: string[] = [];
  for (const sec of rawSections) {
    if (sec.length > maxChunkSize) {
      // Split large section by paragraph boundaries
      const paragraphs = sec.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
      let currentParaGroup = "";

      for (const p of paragraphs) {
        if (p.length > maxChunkSize) {
          // Hard split very long single paragraphs (e.g. log output)
          if (currentParaGroup) {
            sections.push(currentParaGroup);
            currentParaGroup = "";
          }
          for (let i = 0; i < p.length; i += maxChunkSize - overlap) {
            sections.push(p.slice(i, i + maxChunkSize));
          }
        } else if ((currentParaGroup + "\n\n" + p).length <= maxChunkSize) {
          currentParaGroup = currentParaGroup ? `${currentParaGroup}\n\n${p}` : p;
        } else {
          if (currentParaGroup) sections.push(currentParaGroup);
          currentParaGroup = p;
        }
      }
      if (currentParaGroup) sections.push(currentParaGroup);
    } else {
      sections.push(sec);
    }
  }

  const chunks: TextChunk[] = [];
  let currentText = "";
  let chunkStartIndex = 0;
  let runningCharOffset = 0;

  for (const sec of sections) {
    const candidate = currentText ? `${currentText}\n\n${sec}` : sec;

    if (candidate.length <= maxChunkSize) {
      currentText = candidate;
    } else {
      if (currentText) {
        chunks.push({
          chunkIndex: chunks.length,
          text: currentText.trim(),
          charStart: chunkStartIndex,
          charEnd: chunkStartIndex + currentText.length
        });

        // Compute overlap for sliding window
        const overlapText = currentText.slice(Math.max(0, currentText.length - overlap));
        currentText = `${overlapText}\n\n${sec}`;
        chunkStartIndex = runningCharOffset - overlapText.length;
      } else {
        chunks.push({
          chunkIndex: chunks.length,
          text: sec.trim(),
          charStart: runningCharOffset,
          charEnd: runningCharOffset + sec.length
        });
        currentText = "";
        chunkStartIndex = runningCharOffset + sec.length;
      }
    }

    runningCharOffset += sec.length + 2;
  }

  if (currentText && currentText.trim().length > 0) {
    chunks.push({
      chunkIndex: chunks.length,
      text: currentText.trim(),
      charStart: chunkStartIndex,
      charEnd: chunkStartIndex + currentText.length
    });
  }

  return chunks;
}
