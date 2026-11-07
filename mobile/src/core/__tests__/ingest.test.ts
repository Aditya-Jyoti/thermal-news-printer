import { createHash } from 'crypto';

import { createFeed, createCategory, listFeeds, getFeedRow } from '../db/catalog';
import { getArticleDetail, insertArticle, listArticles } from '../db/articles';
import { enrichRows, isMeaningfullyLonger, needsEnrichment } from '../enrich';
import { extractArticle } from '../ingest/fulltext';
import { htmlToText } from '../ingest/html';
import { parseFeed } from '../ingest/parse';
import { isClearlyPolitical } from '../ingest/politics';
import { runIngest } from '../ingest/service';
import { sha256Hex } from '../ingest/sha256';
import { computeFingerprint, normalizeUrl } from '../ingest/url';
import { createMemoryDb } from '../testing/sqljs';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Test Feed</title>
<item><title>Launch of Widget</title><link>https://ex.test/a?utm_source=x</link><guid>g-a</guid>
 <pubDate>Tue, 03 Jun 2025 10:00:00 +0000</pubDate><dc:creator>Ann</dc:creator>
 <description>&lt;p&gt;Short &amp;amp; sweet.&lt;/p&gt;</description>
 <media:content url="https://img.test/a.jpg" medium="image"/></item>
<item><title>Thumb item</title><link>https://ex.test/b</link>
 <content:encoded><![CDATA[<p>Hello <b>world</b></p><p>Second.</p>]]></content:encoded>
 <media:thumbnail url="https://img.test/b.png"/></item>
<item><title>Enclosure item</title><link>https://ex.test/c</link><description>x</description>
 <enclosure url="https://img.test/c.jpg" type="image/jpeg" length="1"/></item>
<item><title>Inline img</title><link>https://ex.test/d</link>
 <description>&lt;p&gt;&lt;img src="https://img.test/d.jpg"&gt; text&lt;/p&gt;</description></item>
<item><title>Election results are in</title><link>https://ex.test/e</link><description>Senate vote</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Blog</title>
<entry><title>Atom post</title><id>tag:x,1</id>
 <link rel="alternate" href="https://at.test/p1"/><link rel="enclosure" type="image/png" href="https://at.test/i.png"/>
 <published>2025-06-01T12:00:00Z</published><author><name>Bob</name></author>
 <content type="html">&lt;p&gt;Body text&lt;/p&gt;</content></entry></feed>`;

describe('parseFeed', () => {
  it('parses RSS entries, dates, authors, content and images', () => {
    const f = parseFeed(RSS);
    expect(f.title).toBe('Test Feed');
    expect(f.entries).toHaveLength(5);
    const [a, b, c, d] = f.entries;
    expect(a).toMatchObject({ title: 'Launch of Widget', guid: 'g-a', author: 'Ann', imageUrl: 'https://img.test/a.jpg' });
    expect(a.publishedAt?.toISOString()).toBe('2025-06-03T10:00:00.000Z');
    expect(htmlToText(a.contentHtml)).toBe('Short & sweet.');
    expect(b.imageUrl).toBe('https://img.test/b.png');
    expect(b.contentHtml).toContain('<b>world</b>');
    expect(htmlToText(b.contentHtml)).toBe('Hello world\n\nSecond.');
    expect(c.imageUrl).toBe('https://img.test/c.jpg');
    expect(d.imageUrl).toBe('https://img.test/d.jpg');
    expect(b.guid).toBe('https://ex.test/b'); // falls back to link
  });

  it('parses Atom', () => {
    const f = parseFeed(ATOM);
    expect(f.title).toBe('Atom Blog');
    expect(f.entries[0]).toMatchObject({
      title: 'Atom post',
      url: 'https://at.test/p1',
      guid: 'tag:x,1',
      author: 'Bob',
      imageUrl: 'https://at.test/i.png',
    });
    expect(f.entries[0].publishedAt?.toISOString()).toBe('2025-06-01T12:00:00.000Z');
    expect(htmlToText(f.entries[0].contentHtml)).toBe('Body text');
  });

  it('rejects non-feed documents', () => {
    expect(() => parseFeed('<html><body>hi</body></html>')).toThrow(/unparseable/);
  });
});

describe('url + fingerprint', () => {
  it('sha256 matches node crypto, including unicode', () => {
    for (const s of ['', 'abc', 'https://ex.test/é✓😀', 'x'.repeat(200)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  it('normalizes scheme/host case, utm params, fragments and trailing slashes', () => {
    expect(normalizeUrl('HTTPS://Ex.Test/Path/?utm_source=a&id=3&UTM_x=1#frag')).toBe('https://ex.test/Path?id=3');
    expect(computeFingerprint('https://ex.test/a/', 't1')).toBe(computeFingerprint('https://EX.test/a?utm_medium=z', 't2'));
    expect(computeFingerprint('', 'Hello, World!')).toBe(computeFingerprint(null, 'hello  world'));
    expect(computeFingerprint('https://ex.test/a', 't')).not.toBe(computeFingerprint('https://ex.test/b', 't'));
  });
});

describe('politics prefilter', () => {
  it('flags clear keywords on word boundaries only', () => {
    expect(isClearlyPolitical('Senate passes bill')).toBe(true);
    expect(isClearlyPolitical('Fine title', 'The White House said')).toBe(true);
    expect(isClearlyPolitical('Gopher database released')).toBe(false);
    expect(isClearlyPolitical('Startup raises Series A', 'x'.repeat(1600) + ' election')).toBe(false);
  });
});

function xmlResponse(body: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(status === 304 ? null : body, { status, headers });
}

describe('runIngest', () => {
  it('ingests, dedupes, flags politics, stores validators and sends conditional GET', async () => {
    const db = await createMemoryDb();
    const cat = await createCategory(db, 'Products');
    const feed = await createFeed(db, 'https://ex.test/rss', cat.id);
    const calls: { url: string; headers: Record<string, string> }[] = [];
    let mode: 'ok' | '304' = 'ok';
    const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return mode === 'ok' ? xmlResponse(RSS, { etag: '"e1"', 'last-modified': 'Tue, 03 Jun 2025 10:00:00 GMT' }) : xmlResponse('', {}, 304);
    });

    const r1 = await runIngest(db, { fetch: fetchFn });
    expect(r1).toMatchObject({ feeds_checked: 1, new_articles: 5, skipped_duplicates: 0, flagged_political: 1, errors: {} });
    expect(calls[0].headers['User-Agent']).toBe('termal-news-printer/0.1');
    expect(calls[0].headers['If-None-Match']).toBeUndefined();
    const row = await getFeedRow(db, feed.id);
    expect(row.etag).toBe('"e1"');
    expect(row.title).toBe('Test Feed');
    expect((await listFeeds(db))[0].last_error).toBeNull();
    expect((await listArticles(db)).total).toBe(4); // political hidden

    const r2 = await runIngest(db, { fetch: fetchFn });
    expect(r2.new_articles).toBe(0);
    expect(r2.skipped_duplicates).toBe(5);
    expect(calls[1].headers['If-None-Match']).toBe('"e1"');
    expect(calls[1].headers['If-Modified-Since']).toBe('Tue, 03 Jun 2025 10:00:00 GMT');

    mode = '304';
    const r3 = await runIngest(db, { fetch: fetchFn });
    expect(r3).toMatchObject({ new_articles: 0, errors: {} });
    expect((await getFeedRow(db, feed.id)).etag).toBe('"e1"'); // validators kept on 304
  });

  it('isolates per-feed errors and records them', async () => {
    const db = await createMemoryDb();
    const cat = await createCategory(db, 'Products');
    const bad = await createFeed(db, 'https://bad.test/rss', cat.id);
    await createFeed(db, 'https://good.test/rss', cat.id);
    const fetchFn = async (url: string) => {
      if (url.includes('bad')) throw new Error('network down');
      return xmlResponse(ATOM);
    };
    const r = await runIngest(db, { fetch: fetchFn });
    expect(r.feeds_checked).toBe(2);
    expect(r.new_articles).toBe(1);
    expect(r.errors['https://bad.test/rss']).toMatch(/network down/);
    expect((await getFeedRow(db, bad.id)).last_error).toMatch(/network down/);

    const http500 = await runIngest(db, { feedId: bad.id, fetch: async () => xmlResponse('x', {}, 500) });
    expect(http500.errors['https://bad.test/rss']).toMatch(/HTTP 500/);
    const junk = await runIngest(db, { feedId: bad.id, fetch: async () => xmlResponse('<html/>') });
    expect(junk.errors['https://bad.test/rss']).toMatch(/unparseable/);
  });

  it('aborts slow feeds via the timeout signal', async () => {
    jest.useFakeTimers();
    try {
      const db = await createMemoryDb();
      const cat = await createCategory(db, 'P');
      await createFeed(db, 'https://slow.test/rss', cat.id);
      const fetchFn = (_u: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
      const p = runIngest(db, { fetch: fetchFn });
      await jest.advanceTimersByTimeAsync(21_000);
      const r = await p;
      expect(r.errors['https://slow.test/rss']).toMatch(/timed out/);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('enrichment', () => {
  it('decides on short items and the 1.3x / +300 chars rule', () => {
    expect(needsEnrichment('short', 'https://a.test/x')).toBe(true);
    expect(needsEnrichment('x'.repeat(1500), 'https://a.test/x')).toBe(false);
    expect(needsEnrichment('short', 'ftp://a.test')).toBe(false);
    expect(needsEnrichment('short', null)).toBe(false);
    expect(isMeaningfullyLonger('x'.repeat(1000), 'y'.repeat(100))).toBe(true);
    expect(isMeaningfullyLonger('x'.repeat(350), 'y'.repeat(100))).toBe(false); // < +300? 250 gain
    expect(isMeaningfullyLonger('x'.repeat(1400), 'y'.repeat(1200))).toBe(false); // < 1.3x
    expect(isMeaningfullyLonger(null, 'a')).toBe(false);
  });

  const page = (paras: number) =>
    `<html><head><title>T</title></head><body><nav>menu</nav><article><h1>Head</h1>${Array.from(
      { length: paras },
      (_, i) => `<p>Paragraph ${i} of the story with enough words to count as real article content here, really.</p>`,
    ).join('')}</article></body></html>`;

  it('extracts article text with readability', () => {
    const got = extractArticle(page(12), 'https://a.test/x');
    expect(got?.text).toContain('Paragraph 3 of the story');
    expect(got?.text).not.toContain('menu');
  });

  it('updates rows only when longer; failures fall back silently; concurrency <= 4', async () => {
    const db = await createMemoryDb();
    const cat = await createCategory(db, 'P');
    const feed = await createFeed(db, 'https://f.test/rss', cat.id);
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push((await insertArticle(db, { feedId: feed.id, guid: `g${i}`, url: `https://a.test/${i}`, title: `t${i}`, fingerprint: `f${i}`, contentText: 'tiny' }))!);
    }
    let inflight = 0;
    let peak = 0;
    const fetchFn = async (url: string) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      if (url.endsWith('/1')) throw new Error('boom');
      if (url.endsWith('/2')) return new Response('nope', { status: 404 });
      if (url.endsWith('/3')) return new Response(page(1), { headers: { 'content-type': 'text/html' } });
      return new Response(page(12), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    };
    const rows = ids.map((id, i) => ({ id, url: `https://a.test/${i}`, content_text: 'tiny' }));
    const updated = await enrichRows(db, rows, { fetch: fetchFn, concurrency: 99 });
    expect(peak).toBeLessThanOrEqual(4);
    expect([...updated.keys()].sort()).toEqual([ids[0], ids[4], ids[5], ids[6], ids[7]].sort());
    expect((await getArticleDetail(db, ids[0])).content_text).toContain('Paragraph 11');
    expect((await getArticleDetail(db, ids[1])).content_text).toBe('tiny');
  });
});
