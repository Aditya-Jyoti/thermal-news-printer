import type { IngestResult } from '../../api/types';
import { insertArticle, fingerprintExists } from '../db/articles';
import type { Db } from '../db/adapter';
import { getFeedRow, listFeedRows, recordFeedFetch, type FeedRow } from '../db/catalog';
import { defaultFetch, fetchWithTimeout, USER_AGENT, type FetchLike } from '../http';
import { htmlToText } from './html';
import { parseFeed } from './parse';
import { isClearlyPolitical } from './politics';
import { computeFingerprint } from './url';

const TIMEOUT_MS = 20_000;

async function ingestFeed(db: Db, fetchImpl: FetchLike, feed: FeedRow, result: IngestResult): Promise<void> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/rss+xml, application/atom+xml, */*',
  };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  const res = await fetchWithTimeout(fetchImpl, feed.url, { headers }, TIMEOUT_MS);
  if (res.status === 304) {
    await recordFeedFetch(db, feed.id, { keepValidators: true });
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching feed`);

  const parsed = parseFeed(await res.text());
  for (const e of parsed.entries) {
    const fp = computeFingerprint(e.url, e.title);
    if (await fingerprintExists(db, fp)) {
      result.skipped_duplicates += 1;
      continue;
    }
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
  }
  await recordFeedFetch(db, feed.id, {
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    title: parsed.title,
  });
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
  for (const feed of feeds) {
    result.feeds_checked += 1;
    try {
      await ingestFeed(db, fetchImpl, feed, result);
    } catch (e) {
      const msg = `${e instanceof Error ? e.name : 'Error'}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      result.errors[feed.url] = msg;
      await recordFeedFetch(db, feed.id, { error: msg });
    }
  }
  return result;
}
