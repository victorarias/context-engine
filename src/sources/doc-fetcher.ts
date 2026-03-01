export interface FetchedDocument {
  url: string;
  title: string;
  content: string;
}

export async function fetchDocument(url: string, selector?: string): Promise<FetchedDocument> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const htmlOrText = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  let title = extractTitle(htmlOrText) || url;
  let content = htmlOrText;

  if (contentType.includes("html") || looksLikeHtml(htmlOrText)) {
    content = htmlToText(htmlOrText);
    if (!title) {
      title = url;
    }
  }

  if (selector?.trim()) {
    // Selector support is intentionally best-effort in baseline mode.
    // We preserve full extracted content for robustness.
    title = `${title} [selector=${selector.trim()}]`;
  }

  return {
    url,
    title,
    content: normalizeWhitespace(content),
  };
}

export function chunkDocument(content: string, options?: { maxChars?: number; overlapChars?: number }): string[] {
  const maxChars = Math.max(200, options?.maxChars ?? 1400);
  const overlapChars = Math.max(0, Math.min(maxChars - 1, options?.overlapChars ?? 200));

  const normalized = normalizeWhitespace(content);
  if (!normalized) return [];

  const chunks: string[] = [];
  let offset = 0;

  while (offset < normalized.length) {
    const end = Math.min(normalized.length, offset + maxChars);
    let slice = normalized.slice(offset, end);

    if (end < normalized.length) {
      const lastBoundary = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
      if (lastBoundary > Math.floor(maxChars * 0.5)) {
        slice = slice.slice(0, lastBoundary + 1);
      }
    }

    slice = slice.trim();
    if (slice) {
      chunks.push(slice);
    }

    if (end >= normalized.length) break;

    const step = Math.max(1, slice.length - overlapChars);
    offset += step;
  }

  return chunks;
}

function looksLikeHtml(content: string): boolean {
  const start = content.slice(0, 500).toLowerCase();
  return start.includes("<html") || start.includes("<!doctype html") || /<body[\s>]/i.test(start);
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeHtmlEntities(match[1]).trim();
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
