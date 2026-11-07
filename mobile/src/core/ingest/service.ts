import type { IngestResult } from '../../api/types';
import { insertArticle } from '../db/articles';
import type { Db } from '../db/adapter';
import { getFeedRow, listFeedRows, recordFeedFetch, type FeedRow } from '../db/catalog';
import { defaultFetch, fetchWithTimeout, USER_AGENT, type FetchLike } from '../http';
import { clearError, recordError } from '../diagnostics';
import { emit } from '../events';
import { mapLimit, timed, yieldToUi } from '../perf';
import { htmlToText } from './html';
import { parseFeed } from './parse';
import { isClearlyPolitical } from './politics';
import { computeFingerprint } from './url';

const TIMEOUT_MS = 20_000;

interface Fetched {
  status: number;
  etag: string | null;
  lastModified: string | null;
  body: string | null;
}

/** Network phase only (no DB, no parsing): safe to run for several feeds concurrently. */
async function fetchFeed(fetchImpl: FetchLike, feed: FeedRow): Promise<Fetched> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/rss+xml, application/atom+xml, */*',
  };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  const res = await fetchWithTimeout(fetchImpl, feed.url, { headers }, TIMEOUT_MS);
  if (res.status === 304) return { status: 304, etag: null, lastModified: null, body: null };
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching feed`);
  return {
    status: res.status,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    body: await res.text(),
  };
}

async function existingFingerprints(db: Db, fps: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < fps.length; i += 200) {
    const chunk = fps.slice(i, i + 200);
    const rows = await db.all<{ fingerprint: string }>(
      `SELECT fingerprint FROM articles WHERE fingerprint IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
    for (const r of rows) found.add(r.fingerprint);
  }
  return found;
}

async function applyFeed(db: Db, feed: FeedRow, got: Fetched, result: IngestResult): Promise<void> {
  if (got.status === 304 || got.body === null) {
    await recordFeedFetch(db, feed.id, { keepValidators: true });
    return;
  }
  await yieldToUi();
  const parsed = parseFeed(got.body);
  await yieldToUi();
  const prints = parsed.entries.map((e) => computeFingerprint(e.url, e.title));
  const known = await existingFingerprints(db, prints);

  let tx = false;
  try {
    await db.exec('BEGIN');
    tx = true;
  } catch {
    // another transaction is open: insert without one
  }
  try {
    for (let i = 0; i < parsed.entries.length; i++) {
      const e = parsed.entries[i];
      const fp = prints[i];
      if (known.has(fp)) {
        result.skipped_duplicates += 1;
        continue;
      }
      known.add(fp);
      const text = htmlToText(e.contentHtml);
      const political = isClearlyPolitical(e.title, text) ? true : null;
      const id = await insertArticle(db, {
        feedId: feed.id,
        guid: e.guid,
        url: e.url || e.guid,
        title: e.title,
        fingerprint: fp,
        author: e.author,
        publishedAt: e.publishedAt,
        contentHtml: e.contentHtml,
        contentText: text,
        imageUrl: e.imageUrl,
        isPolitical: political,
      });
      if (id === null) {
        result.skipped_duplicates += 1;
        continue;
      }
      result.new_articles += 1;
      if (political) result.flagged_political += 1;
      if (i % 10 === 9) await yieldToUi();
    }
    if (tx) await db.exec('COMMIT');
  } catch (err) {
    if (tx) await db.exec('ROLLBACK').catch(() => undefined);
    throw err;
  }
  await recordFeedFetch(db, feed.id, { etag: got.etag, lastModified: got.lastModified, title: parsed.title });
}

/** Fetch one feed (any, even disabled) or all enabled feeds. Errors are isolated per feed. */
export async function runIngest(
  db: Db,
  opts: { feedId?: number | null; fetch?: FetchLike } = {},
): Promise<IngestResult> {
  const fetchImpl = opts.fetch ?? defaultFetch;
  const feeds =
    opts.feedId !== undefined && opts.feedId !== null ? [await getFeedRow(db, opts.feedId)] : await listFeedRows(db);
  const result: IngestResult = {
    feeds_checked: 0,
    new_articles: 0,
    skipped_duplicates: 0,
    flagged_political: 0,
    errors: {},
  };
  // Network in parallel (<= 3 feeds), parse + insert one feed at a time with UI yields in between.
  const fetched = await mapLimit(feeds, 3, async (feed) => {
    try {
      return { ok: true as const, got: await fetchFeed(fetchImpl, feed) };
    } catch (e) {
      return { ok: false as const, e };
    }
  });
  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    const f = fetched[i];
    result.feeds_checked += 1;
    try {
      if (!f.ok) throw f.e;
      await timed(`ingest ${feed.url}`, () => applyFeed(db, feed, f.got, result));
    } catch (e) {
      const msg = `${e instanceof Error ? e.name : 'Error'}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      result.errors[feed.url] = msg;
      await recordFeedFetch(db, feed.id, { error: msg });
    }
    await yieldToUi();
  }
  const failed = Object.entries(result.errors);
  if (failed.length > 0) {
    const [url, msg] = failed[0];
    console.warn(`[ingest] ${failed.length} of ${result.feeds_checked} feeds failed; first: ${url} ${msg.slice(0, 200)}`);
    await recordError(db, 'ingest', `${failed.length} of ${result.feeds_checked} feeds failed. ${url}: ${msg}`);
  } else {
    await clearError(db, 'ingest');
  }
  if (result.new_articles > 0) emit('feeds');
  return result;
}
