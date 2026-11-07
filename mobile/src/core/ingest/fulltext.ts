import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import { defaultFetch, fetchWithTimeout, USER_AGENT, type FetchLike } from '../http';
import { htmlToText } from './html';

const TIMEOUT_MS = 15_000;
const MAX_CHARS = 3_000_000;

/** Extract (text, html) of the main article from a page's HTML; null when nothing is extractable. */
export function extractArticle(pageHtml: string, url?: string): { text: string; html: string } | null {
  const { document } = parseHTML(pageHtml);
  if (url) {
    try {
      // Readability resolves relative links against documentURI/baseURI.
      Object.defineProperty(document, 'documentURI', { value: url, configurable: true });
    } catch {
      // best effort
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const article = new Readability(document as any, { charThreshold: 200 }).parse();
  if (!article?.content) return null;
  const text = htmlToText(article.content);
  return text ? { text, html: article.content } : null;
}

/** Download `url` and extract the main article. Returns null on any failure. */
export async function fetchFullText(
  url: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<{ text: string; html: string } | null> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.5' } },
      TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ctype && !ctype.includes('html') && !ctype.includes('xml')) return null;
    const page = (await res.text()).slice(0, MAX_CHARS);
    return extractArticle(page, url);
  } catch {
    return null; // enrichment is best-effort
  }
}
