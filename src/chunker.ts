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

  // 1. Check YAML frontmatter
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];

    // Check tags: [..., confidential, ...] or tag: [..., confidential, ...]
    const arrayMatch = frontmatter.match(/tags?\s*:\s*\[([\s\S]*?)\]/i);
    if (arrayMatch) {
      const items = arrayMatch[1].split(",").map((s) => s.trim().replace(/^['"#]+|['"]+$/g, ""));
      if (
        items.some(
          (item) =>
            item.toLowerCase() === "confidential" ||
            item.toLowerCase().startsWith("confidential/")
        )
      ) {
        return true;
      }
    }

    // Check list format: tags:\n  - confidential
    const listMatches = frontmatter.matchAll(/^\s*-\s*['"#]?([a-zA-Z0-9_\-/]+)['"]?/gim);
    for (const match of listMatches) {
      const tag = match[1].toLowerCase();
      if (tag === "confidential" || tag.startsWith("confidential/")) {
        return true;
      }
    }

    // Check single line: tags: confidential or tag: confidential
    const singleMatch = frontmatter.match(/^tags?\s*:\s*['"#]?([a-zA-Z0-9_\-/]+)['"]?\s*$/im);
    if (singleMatch) {
      const tag = singleMatch[1].toLowerCase();
      if (tag === "confidential" || tag.startsWith("confidential/")) {
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

  // Remove elements that do not contain core article content
  $("script, style, noscript, nav, footer, header, svg, iframe, form").remove();

  const title = $("title").text().trim() || $("h1").first().text().trim() || "";

  // Target main content container if available, otherwise body
  const root = $("article, main, .content, .post, #content").first();
  const target = root.length > 0 ? root : $("body");

  // Collect text paragraphs
  const lines: string[] = [];
  target.find("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, code").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 0) {
      lines.push(text);
    }
  });

  const fullText = lines.length > 0 ? lines.join("\n\n") : target.text().replace(/\s+/g, " ").trim();

  return {
    title,
    text: fullText
  };
}

export function chunkText(
  content: string,
  options: ChunkOptions = {}
): TextChunk[] {
  const maxChunkSize = options.maxChunkSize ?? 1000;
  const overlap = options.overlap ?? 150;

  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  if (normalized.length <= maxChunkSize) {
    return [
      {
        chunkIndex: 0,
        text: normalized,
        charStart: 0,
        charEnd: normalized.length
      }
    ];
  }

  // Split into structural segments (paragraphs and headings)
  const rawSegments = normalized.split(/\n\s*\n/);
  const segments: string[] = [];

  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxChunkSize) {
      const sentenceRegex = /[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g;
      const sentences = trimmed.match(sentenceRegex) || [trimmed];
      for (const s of sentences) {
        const sTrim = s.trim();
        if (!sTrim) continue;
        if (sTrim.length > maxChunkSize) {
          let start = 0;
          const step = maxChunkSize - (overlap > 0 && maxChunkSize > overlap ? overlap : 0);
          while (start < sTrim.length) {
            const slice = sTrim.slice(start, start + maxChunkSize).trim();
            if (slice) segments.push(slice);
            start += Math.max(1, step);
          }
        } else {
          segments.push(sTrim);
        }
      }
    } else {
      segments.push(trimmed);
    }
  }

  const chunks: TextChunk[] = [];
  let currentChunk = "";
  let chunkStartIndex = 0;
  let chunkIndex = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prospectiveChunk = currentChunk ? `${currentChunk}\n\n${seg}` : seg;

    if (prospectiveChunk.length <= maxChunkSize) {
      currentChunk = prospectiveChunk;
    } else {
      if (currentChunk) {
        chunks.push({
          chunkIndex,
          text: currentChunk,
          charStart: chunkStartIndex,
          charEnd: chunkStartIndex + currentChunk.length
        });
        chunkIndex++;

        if (overlap > 0 && currentChunk.length > overlap) {
          const overlapSlice = currentChunk.slice(-overlap).trim();
          currentChunk = overlapSlice ? `${overlapSlice}\n\n${seg}` : seg;
          chunkStartIndex = Math.max(0, chunkStartIndex + currentChunk.length - overlap);
        } else {
          currentChunk = seg;
          chunkStartIndex = chunkStartIndex + currentChunk.length;
        }
      } else {
        let start = 0;
        const step = maxChunkSize - (overlap > 0 && maxChunkSize > overlap ? overlap : 0);
        while (start < seg.length) {
          const slice = seg.slice(start, start + maxChunkSize).trim();
          if (slice) {
            chunks.push({
              chunkIndex,
              text: slice,
              charStart: chunkStartIndex + start,
              charEnd: chunkStartIndex + start + slice.length
            });
            chunkIndex++;
          }
          start += Math.max(1, step);
        }
        currentChunk = "";
        chunkStartIndex += seg.length;
      }
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push({
      chunkIndex,
      text: currentChunk.trim(),
      charStart: chunkStartIndex,
      charEnd: chunkStartIndex + currentChunk.trim().length
    });
  }

  return chunks;
}
