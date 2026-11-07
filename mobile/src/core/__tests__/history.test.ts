import type { EditionItem, HistoryEdition } from '../../api/types';
import type { DeviceServices } from '../../device/contracts';
import { groupHistoryByDay } from '../../lib/history';
import { previewModel } from '../../lib/previewModel';
import { AIError, type AiClient } from '../ai/client';
import type { Db } from '../db/adapter';
import { countArticles, getPrintedArticleIds, insertArticle, listCurationCandidates, setArticleRead, upsertSummary } from '../db/articles';
import { createCategory, createFeed } from '../db/catalog';
import { listEditionItems, listHistory, replaceEdition, archiveEdition } from '../db/edition';
import { MIGRATIONS, migrate } from '../db/schema';
import { updateSettings } from '../db/settings';
import { clearError, getLastErrors, recordError } from '../diagnostics';
import { MAX_AGE_DAYS, MAX_CANDIDATES, editionIdle, fetchNewNews, getDiagnostics, getEdition } from '../edition';
import { parseDate } from '../ingest/parse';
import { runPrint } from '../pipeline';
import { createMemoryDb } from '../testing/sqljs';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

let db: Db;
let feedId: number;
let n = 0;

async function seed(o: { summary?: boolean; ageDays?: number; publishedAt?: Date | null } = {}) {
  n += 1;
  const id = (await insertArticle(db, {
    feedId,
    guid: `g${n}`,
    url: `https://ex.test/${n}`,
    title: `Distinct headline number ${n} zebra${n * 31} quark${n * 17}`,
    fingerprint: `fp${n}`,
    publishedAt: o.publishedAt === undefined ? new Date(Date.now() - (o.ageDays ?? 0) * 86_400_000 - n * 1000) : o.publishedAt,
    contentText: 'x'.repeat(2000),
    isPolitical: false,
  }))!;
  if (o.summary) await upsertSummary(db, id, `tldr ${id}`, 'm');
  return id;
}
const stage = (...ids: number[]) => replaceEdition(db, ids.map((article_id) => ({ article_id, category_slug: 'products' })));

function fakeDevice(over: { renderError?: Error } = {}) {
  const device: DeviceServices = {
    render: jest.fn(async (items) => {
      if (over.renderError) throw over.renderError;
      return { bitmap: { width: 384 as const, height: items.length, pixels: new Uint8Array(384 * items.length) }, pngBase64: 'UE5H' };
    }),
    printer: { ensurePermissions: async () => true, scan: async () => [], print: jest.fn(async () => undefined) },
  };
  return device;
}

const TLDR =
  'Acme Corp launched the Zephyr 2 chip, which runs language models on-device at 40 tokens per second while drawing 3 watts. It ships to phone makers in March.';
const okClient: AiClient = { chat: async (o) => (o.user.includes('Candidates:') ? '{"picks": [], "political": []}' : TLDR) };

beforeEach(async () => {
  db = await createMemoryDb();
  feedId = (await createFeed(db, 'https://f.test/rss', (await createCategory(db, 'Products', null, 20)).id)).id;
  n = 0;
});

describe('migration v3', () => {
  it('adds read_at and archive tables, and back-fills printed prints into History', async () => {
    const old = await createMemoryDb({ migrate: false });
    await old.exec(MIGRATIONS[0] as string);
    await old.exec(MIGRATIONS[1] as string);
    await old.exec('PRAGMA user_version=2');
    await old.run("INSERT INTO categories(name, slug, created_at) VALUES('P','p','2026-01-01')");
    await old.run("INSERT INTO feeds(url, category_id, created_at) VALUES('u',1,'2026-01-01')");
    await old.run("INSERT INTO articles(feed_id, guid, url, title, fetched_at, fingerprint) VALUES(1,'g','u','T','2026-01-01','f')");
    await old.run("INSERT INTO prints(created_at, trigger, status) VALUES('2026-01-02T08:00:00+00:00','manual','printed')");
    await old.run("INSERT INTO prints(created_at, trigger, status) VALUES('2026-01-03T08:00:00+00:00','manual','failed')");
    await old.run("INSERT INTO print_items(print_id, article_id, position, category_slug, tldr) VALUES(1,1,1,'p','hello')");
    await migrate(old);
    expect((await old.get<{ user_version: number }>('PRAGMA user_version'))?.user_version).toBe(4);
    await old.run('SELECT read_at FROM articles');
    const h = await listHistory(old);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ print_id: 1, printed: true });
    expect(h[0].items[0]).toMatchObject({ tldr: 'hello', article_id: 1, read_at: null });
  });
});

describe('read / unread', () => {
  it('toggles read_at and shows it in the edition and History', async () => {
    const id = await seed({ summary: true });
    await stage(id);
    expect((await listEditionItems(db))[0].read_at).toBeNull();
    await setArticleRead(db, id, true);
    expect((await listEditionItems(db))[0].read_at).not.toBeNull();
    await setArticleRead(db, id, false);
    expect((await listEditionItems(db))[0].read_at).toBeNull();
    await setArticleRead(db, id, true);
    await archiveEdition(db);
    expect((await listHistory(db))[0].items[0].read_at).not.toBeNull();
  });
});

describe('archive', () => {
  it('Fetch new news moves the edition to History (not printed) and never brings it back', async () => {
    const a = await seed({ summary: true });
    const b = await seed({ summary: true });
    await stage(a, b);
    const fresh = await seed();
    const fetchFn = async () => new Response('', { status: 404 });
    const res = await fetchNewNews(db, { client: okClient, fetch: fetchFn });
    await editionIdle(db);
    const hist = await listHistory(db);
    expect(hist).toHaveLength(1);
    expect(hist[0].printed).toBe(false);
    expect(hist[0].items.map((i) => i.article_id)).toEqual([a, b]);
    const ids = (await listEditionItems(db)).map((i) => i.article_id);
    expect(ids).toEqual([fresh]);
    expect(res.edition.target).toBe(8);
    expect((await getPrintedArticleIds(db)).has(a)).toBe(true);
    expect((await listCurationCandidates(db)).map((c) => c.id)).toEqual([fresh]);
  });

  it('archiving an empty edition creates nothing', async () => {
    expect(await archiveEdition(db)).toBeNull();
    expect(await listHistory(db)).toEqual([]);
  });

  it('printing archives the printed items with print_id (Printed)', async () => {
    const a = await seed({ summary: true });
    const b = await seed(); // not summarized: not printed, not archived
    await stage(a, b);
    const noSummaries: AiClient = {
      chat: async () => {
        throw new AIError('down', 500);
      },
    };
    const rec = await runPrint(db, 'manual', { device: fakeDevice(), client: noSummaries, fetch: async () => new Response('', { status: 404 }) });
    expect(rec?.status).toBe('printed');
    await editionIdle(db);
    const hist = await listHistory(db);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ printed: true, print_id: rec!.id });
    expect(hist[0].items.map((i) => i.article_id)).toEqual([a]);
  });

  it('a failed print keeps the edition and archives nothing', async () => {
    const a = await seed({ summary: true });
    await stage(a);
    const rec = await runPrint(db, 'manual', { device: fakeDevice({ renderError: new Error('no renderer') }), client: okClient });
    expect(rec?.status).toBe('failed');
    expect(await listHistory(db)).toEqual([]);
    expect(await listEditionItems(db)).toHaveLength(1);
    expect((await getLastErrors(db)).render?.message).toContain('no renderer');
  });
});

describe('history grouping by local day', () => {
  const ed = (id: number, iso: string, printed: boolean): HistoryEdition => ({
    id,
    created_at: iso,
    archived_at: iso,
    print_id: printed ? id : null,
    printed,
    items: [],
  });
  it('groups by local calendar day, newest first, with labels and status counts', () => {
    const now = new Date(2026, 10, 7, 12, 0, 0); // Sat 7 Nov 2026 local
    const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).toISOString();
    const groups = groupHistoryByDay([ed(1, at(5, 9), true), ed(2, at(7, 8), true), ed(3, at(7, 20), false), ed(4, at(6, 23), false)], now);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Thu 5 Nov']);
    expect(groups[0].editions.map((e) => e.id)).toEqual([3, 2]);
    expect(groups[0]).toMatchObject({ printed: 1, notPrinted: 1 });
    expect(groups[2].key).toBe('2026-11-05');
  });
});

describe('edition window and shortfall', () => {
  it('defaults to a 3 day window and 100 candidates per AI call', async () => {
    expect(MAX_AGE_DAYS).toBe(3);
    expect(MAX_CANDIDATES).toBe(100);
    const recent = await seed({ ageDays: 2 });
    await seed({ ageDays: 4 });
    expect((await listCurationCandidates(db, { limit: MAX_CANDIDATES, maxAgeDays: MAX_AGE_DAYS })).map((c) => c.id)).toEqual([recent]);
  });

  it('articles without a usable published_at fall back to fetched_at', async () => {
    const id = await seed({ publishedAt: null });
    expect((await listCurationCandidates(db)).map((c) => c.id)).toEqual([id]);
  });

  it('fills up to max_items_total from candidates the AI did not pick, and reports the target', async () => {
    await updateSettings(db, { max_items_total: 5 });
    for (let i = 0; i < 7; i++) await seed({ ageDays: i * 0.3 });
    const client: AiClient = { chat: async (o) => (o.user.includes('Candidates:') ? '{"picks": [1], "political": []}' : TLDR) };
    const res = await fetchNewNews(db, { client, fetch: async () => new Response('', { status: 404 }) });
    expect(res.edition.items).toHaveLength(5);
    expect(res.edition.target).toBe(5);
    expect(res.edition.items[0].article_id).toBe(1);
  });

  it('counts for diagnostics', async () => {
    const a = await seed({ summary: true });
    await seed();
    await stage(a);
    expect(await countArticles(db)).toEqual({ articles: 2, candidates: 2 });
    const d = await getDiagnostics(db);
    expect(d.counts).toEqual({ articles: 2, candidates: 2, edition_size: 1, summarized: 1 });
  });
});

describe('last_errors', () => {
  it('records per stage with redaction, truncation and clears on success', async () => {
    await recordError(db, 'summarize', 'HTTP 401: bad key sk-or-v1-abcdef1234567890 Bearer abcdefgh12345');
    await recordError(db, 'ingest', 'x'.repeat(2000));
    const e = await getLastErrors(db);
    expect(e.summarize?.message).toContain('HTTP 401');
    expect(e.summarize?.message).not.toContain('abcdef1234');
    expect(e.ingest?.message.length).toBeLessThanOrEqual(300);
    await clearError(db, 'summarize');
    expect((await getLastErrors(db)).summarize).toBeUndefined();
    expect((await getLastErrors(db)).ingest).toBeDefined();
  });

  it('a failing AI shows up in the edition status and clears once summaries succeed', async () => {
    await seed();
    await replaceEdition(db, []);
    const failing: AiClient = {
      chat: async () => {
        throw new AIError('model call failed: HTTP 401: User not found', 401);
      },
    };
    const fetchFn = async () => new Response('', { status: 404 });
    await fetchNewNews(db, { client: failing, fetch: fetchFn });
    const ed = await getEdition(db, { client: failing });
    expect(ed.items.length).toBeGreaterThan(0);
    expect(ed.items.every((i) => i.tldr === null)).toBe(true);
    expect(ed.status.last_error?.message).toContain('401');
    // a working AI summarizes the missing ones and clears the error
    await fetchNewNews(db, { client: okClient, fetch: fetchFn }); // rolls to a new edition (nothing left) ...
    const errs = await getLastErrors(db);
    expect(errs.summarize).toBeUndefined();
  });
});

describe('date parser', () => {
  const ms = (s: string) => parseDate(s)?.getTime();
  const base = Date.UTC(2026, 10, 6, 14, 3, 0);
  it('handles RFC-822 variants', () => {
    expect(ms('Fri, 06 Nov 2026 14:03:00 +0000')).toBe(base);
    expect(ms('Fri, 06 Nov 2026 14:03:00 GMT')).toBe(base);
    expect(ms('Fri, 06 Nov 2026 09:03:00 -0500')).toBe(base);
    expect(ms('Fri, 6 Nov 2026 14:03 GMT')).toBe(base);
    expect(ms('06 Nov 2026 15:03:00 +0100')).toBe(base);
    expect(ms('Fri, 06 Nov 2026 10:03:00 EDT')).toBe(base);
  });
  it('handles ISO 8601 with and without ms / offset', () => {
    expect(ms('2026-11-06T14:03:00Z')).toBe(base);
    expect(ms('2026-11-06T14:03:00.000Z')).toBe(base);
    expect(ms('2026-11-06T15:03:00+01:00')).toBe(base);
    expect(ms('2026-11-06T09:03:00.250-0500')).toBe(base + 250);
    expect(ms('2026-11-06T14:03:00')).toBe(base); // no zone: UTC
    expect(ms('2026-11-06')).toBe(Date.UTC(2026, 10, 6));
  });
  it('returns null for garbage', () => {
    expect(parseDate('yesterday-ish')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('preview model with partial summaries', () => {
  const item = (id: number, tldr: string | null): EditionItem => ({
    position: id,
    article_id: id,
    category_slug: 'products',
    category: { id: 1, name: 'Products', slug: 'products', color: null, print_limit: 2, feed_count: 1 },
    title: `t${id}`,
    url: 'u',
    image_url: null,
    published_at: null,
    tldr,
    read_at: null,
  });
  it('splits summarized from placeholders and never drops stories', () => {
    const m = previewModel([item(1, 'a'), item(2, null), item(3, 'c')], false);
    expect(m.ready.map((d) => d.article_id)).toEqual([1, 3]);
    expect(m.ready.map((d) => d.position)).toEqual([1, 2]);
    expect(m.pending).toEqual([expect.objectContaining({ article_id: 2, tldr: 'Summarizing…' })]);
    expect(previewModel([item(2, null)], true).pending[0].tldr).toMatch(/unavailable/);
    const none = previewModel([item(1, null), item(2, null)], true);
    expect(none.ready).toEqual([]);
    expect(none.pending).toHaveLength(2);
  });
});
