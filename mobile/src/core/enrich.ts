import type { Db } from './db/adapter';
import { updateArticleContent } from './db/articles';
import type { FetchLike } from './http';
import { fetchFullText } from './ingest/fulltext';

export const SHORT_THRESHOLD = 1500; // RSS bodies shorter than this get a full-text fetch
export const MIN_GAIN = 1.3; // extracted text must be this much longer than the RSS text...
export const MIN_GAIN_CHARS = 300; // ...and at least this many chars longer
export const MAX_CONCURRENCY = 3;

export function needsEnrichment(contentText: string | null | undefined, url: string | null | undefined): boolean {
  return !!url && /^https?:\/\//.test(url) && (contentText ?? '').trim().length < SHORT_THRESHOLD;
}

export function isMeaningfullyLonger(next: string | null | undefined, old: string | null | undefined): boolean {
  if (!next) return false;
  const n = next.trim().length;
  const o = (old ?? '').trim().length;
  return n >= o * MIN_GAIN && n - o >= MIN_GAIN_CHARS;
}

export interface EnrichRow {
  id: number;
  url: string;
  content_text: string | null;
}

/**
 * Fetch full text for short rows and store improvements. Returns {article_id: new_text} for updated
 * rows. Never throws; DB writes happen sequentially after the (concurrent, <=3) fetches.
 */
export async function enrichRows(
  db: Db,
  rows: EnrichRow[],
  opts: { fetch?: FetchLike; concurrency?: number } = {},
): Promise<Map<number, string>> {
  const updated = new Map<number, string>();
  const todo = rows.filter((r) => needsEnrichment(r.content_text, r.url));
  if (todo.length === 0) return updated;
  const workers = Math.max(1, Math.min(opts.concurrency ?? MAX_CONCURRENCY, MAX_CONCURRENCY));
  const fetched: ({ text: string; html: string } | null)[] = new Array(todo.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, todo.length) }, async () => {
      while (next < todo.length) {
        const i = next++;
        fetched[i] = await fetchFullText(todo[i].url, opts.fetch).catch(() => null);
      }
    }),
  );
  for (let i = 0; i < todo.length; i++) {
    const got = fetched[i];
    if (got && isMeaningfullyLonger(got.text, todo[i].content_text)) {
      try {
        await updateArticleContent(db, todo[i].id, got.text, got.html);
        updated.set(todo[i].id, got.text);
      } catch {
        // keep the RSS text
      }
    }
  }
  return updated;
}
