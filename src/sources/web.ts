import * as cheerio from "cheerio";
import type { WebSource } from "../config.js";
import { computeHash, extractHtmlText } from "../chunker.js";
import type { DocumentItem } from "../sync.js";

export async function loadWebDocuments(source: WebSource): Promise<Map<string, DocumentItem>> {
  const docs = new Map<string, DocumentItem>();
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: source.url, depth: 1 }];

  const baseOrigin = new URL(source.url).origin;
  const patternRegex = source.urlPattern ? new RegExp(source.urlPattern) : null;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const { url, depth } = current;
    const normalizedUrl = url.split("#")[0].replace(/\/$/, "");

    if (visited.has(normalizedUrl)) continue;
    visited.add(normalizedUrl);

    try {
      const res = await fetch(normalizedUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Knowbase-Indexer/1.0)",
          ...(source.headers || {})
        }
      });

      const contentType = res.headers.get("content-type") || "";
      if (!res.ok || !contentType.includes("text/html")) {
        continue;
      }

      const html = await res.text();
      const { title, text } = extractHtmlText(html);

      if (text.length > 20) {
        const hash = computeHash(text);
        docs.set(normalizedUrl, {
          path: normalizedUrl,
          hash,
          content: text,
          title: title || normalizedUrl
        });
      }

      if (depth < source.maxDepth) {
        const $ = cheerio.load(html);
        $("a[href]").each((_, el) => {
          const href = $(el).attr("href");
          if (!href) return;

          try {
            const nextUrl = new URL(href, normalizedUrl);
            const nextNormalized = nextUrl.toString().split("#")[0].replace(/\/$/, "");

            if (nextUrl.origin === baseOrigin && !visited.has(nextNormalized)) {
              if (!patternRegex || patternRegex.test(nextNormalized)) {
                queue.push({ url: nextNormalized, depth: depth + 1 });
              }
            }
          } catch {
            // ignore invalid URL
          }
        });
      }
    } catch (err) {
      console.warn(`Failed to crawl web URL ${normalizedUrl}:`, err);
    }
  }

  return docs;
}
