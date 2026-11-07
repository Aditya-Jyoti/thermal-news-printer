import type { Db } from '../db/adapter';
import {
  createCategory,
  createFeed,
  deleteCategory,
  deleteFeed,
  getCategory,
  listCategories,
  listFeeds,
  updateCategory,
  updateFeed,
} from '../db/catalog';
import {
  getArticleDetail,
  getPrintedArticleIds,
  insertArticle,
  listArticles,
  listArticlesNeedingSummary,
  listDigestCandidates,
  setPolitical,
  upsertSummary,
} from '../db/articles';
import { createPrint, getLastPrintItems, getPrint, listPrints, setPrintStatus } from '../db/prints';
import { migrate } from '../db/schema';
import { getSettings, updateSettings } from '../db/settings';
import { Conflict, NotFound } from '../errors';
import { createMemoryDb } from '../testing/sqljs';

let db: Db;
let catId: number;
let feedId: number;

beforeEach(async () => {
  db = await createMemoryDb();
  catId = (await createCategory(db, 'Products')).id;
  feedId = (await createFeed(db, 'https://a.test/feed', catId)).id;
});

async function article(n: number, extra: Partial<Parameters<typeof insertArticle>[1]> = {}) {
  return insertArticle(db, {
    feedId,
    guid: `g${n}`,
    url: `https://a.test/${n}`,
    title: `Title ${n}`,
    fingerprint: `fp${n}`,
    publishedAt: new Date(Date.UTC(2026, 0, n)),
    ...extra,
  });
}

describe('migrations', () => {
  it('sets user_version and is idempotent', async () => {
    await migrate(db);
    const v = await db.get<{ user_version: number }>('PRAGMA user_version');
    expect(v?.user_version).toBe(1);
  });
});

describe('categories', () => {
  it('slugifies, de-duplicates slugs and rejects duplicate names', async () => {
    const a = await createCategory(db, 'Big Think!');
    const b = await createCategory(db, 'big-think');
    expect(a.slug).toBe('big-think');
    expect(b.slug).toBe('big-think-2');
    await expect(createCategory(db, 'Products')).rejects.toBeInstanceOf(Conflict);
    expect((await createCategory(db, '???')).slug).toBe('category');
  });

  it('updates fields, reports feed_count, 404s', async () => {
    const c = await updateCategory(db, catId, { name: 'Gadgets', print_limit: 5, color: '#fff' });
    expect(c).toMatchObject({ name: 'Gadgets', slug: 'gadgets', print_limit: 5, color: '#fff', feed_count: 1 });
    const cleared = await updateCategory(db, catId, { color: null });
    expect(cleared.color).toBeNull();
    await expect(updateCategory(db, 999, {})).rejects.toBeInstanceOf(NotFound);
    const other = await createCategory(db, 'Other');
    await expect(updateCategory(db, other.id, { name: 'Gadgets' })).rejects.toBeInstanceOf(Conflict);
  });

  it('cascades delete to feeds and articles', async () => {
    await article(1);
    await deleteCategory(db, catId);
    expect(await listFeeds(db)).toHaveLength(0);
    expect((await listArticles(db)).total).toBe(0);
    expect(await listCategories(db)).toHaveLength(0);
  });
});

describe('feeds', () => {
  it('enforces unique urls and valid category; url change clears validators', async () => {
    await expect(createFeed(db, 'https://a.test/feed', catId)).rejects.toBeInstanceOf(Conflict);
    await expect(createFeed(db, 'https://b.test/feed', 999)).rejects.toBeInstanceOf(NotFound);
    await db.run("UPDATE feeds SET etag='x', last_modified='y' WHERE id=?", [feedId]);
    await updateFeed(db, feedId, { url: 'https://c.test/feed', enabled: false });
    const row = await db.get<{ etag: string | null; enabled: number }>('SELECT * FROM feeds WHERE id=?', [feedId]);
    expect(row?.etag).toBeNull();
    expect(row?.enabled).toBe(0);
    await deleteFeed(db, feedId);
    await expect(deleteFeed(db, feedId)).rejects.toBeInstanceOf(NotFound);
  });
});

describe('articles', () => {
  it('dedupes by fingerprint and by feed+guid', async () => {
    expect(await article(1)).not.toBeNull();
    expect(await article(1)).toBeNull(); // same fp
    expect(await article(2, { guid: 'g1' })).toBeNull(); // same feed+guid
  });

  it('hides political from default listing, orders newest first, joins category', async () => {
    await article(1);
    await article(2);
    const p = await article(3, { isPolitical: true });
    const list = await listArticles(db);
    expect(list.items.map((a) => a.title)).toEqual(['Title 2', 'Title 1']);
    expect(list.items[0].category.slug).toBe('products');
    expect(list.total).toBe(2);
    expect((await listArticles(db, { includePolitical: true })).total).toBe(3);
    expect((await getArticleDetail(db, p!)).is_political).toBe(true);
    await expect(getArticleDetail(db, 999)).rejects.toBeInstanceOf(NotFound);
  });

  it('needing-summary excludes summarized and political', async () => {
    const a = (await article(1))!;
    await article(2);
    await article(3, { isPolitical: true });
    await upsertSummary(db, a, 'sum', 'm');
    const rows = await listArticlesNeedingSummary(db);
    expect(rows.map((r) => r.title)).toEqual(['Title 2']);
    expect(rows[0].category_slug).toBe('products');
  });
});

describe('digest candidates and print lifecycle', () => {
  async function ready(n: number) {
    const id = (await article(n, { isPolitical: false }))!;
    await upsertSummary(db, id, `tldr ${n}`, 'm');
    return id;
  }

  it('requires is_political=0 and a summary', async () => {
    const a = await ready(1);
    await article(2, { isPolitical: false }); // no summary
    const c = (await article(3))!; // unchecked politics
    await upsertSummary(db, c, 'x', 'm');
    expect((await listDigestCandidates(db)).map((r) => r.article_id)).toEqual([a]);
    await setPolitical(db, c, false);
    expect(await listDigestCandidates(db)).toHaveLength(2);
  });

  it('pending and printed prints block; failed prints release', async () => {
    const a = await ready(1);
    const item = { article_id: a, position: 1, category_slug: 'products', tldr: 'tldr 1' };
    const pid = await createPrint(db, 'manual', [item]);
    expect(await listDigestCandidates(db)).toHaveLength(0); // pending blocks
    expect((await getPrintedArticleIds(db)).has(a)).toBe(true);
    await setPrintStatus(db, pid, 'failed', 'boom');
    expect(await listDigestCandidates(db)).toHaveLength(1); // released
    expect((await getPrintedArticleIds(db)).size).toBe(0);
    expect((await getPrint(db, pid)).error).toBe('boom');
    await setPrintStatus(db, pid, 'printed');
    expect(await listDigestCandidates(db)).toHaveLength(0);
    await expect(setPrintStatus(db, 999, 'printed')).rejects.toBeInstanceOf(NotFound);
  });

  it('printed_at comes from printed prints only', async () => {
    const a = await ready(1);
    const item = { article_id: a, position: 1, category_slug: 'products', tldr: 't' };
    const p1 = await createPrint(db, 'manual', [item]);
    await setPrintStatus(db, p1, 'failed', 'x');
    expect((await getArticleDetail(db, a)).printed_at).toBeNull();
    const p2 = await createPrint(db, 'schedule', [item]);
    await setPrintStatus(db, p2, 'printed');
    expect((await getArticleDetail(db, a)).printed_at).toBe((await getPrint(db, p2)).created_at);
  });

  it('getLastPrintItems uses the latest printed print and includes titles; ON DELETE SET NULL', async () => {
    const a = await ready(1);
    const p1 = await createPrint(db, 'manual', [{ article_id: a, position: 1, category_slug: 'products', tldr: 't' }]);
    await setPrintStatus(db, p1, 'printed');
    const p2 = await createPrint(db, 'manual', []);
    await setPrintStatus(db, p2, 'failed', 'x');
    expect((await getLastPrintItems(db)).map((i) => i.title)).toEqual(['Title 1']);
    await deleteFeed(db, feedId);
    const rec = await getPrint(db, p1);
    expect(rec.items[0].article_id).toBeNull();
    expect(rec.items[0].title).toBeNull();
    expect(rec.items[0].tldr).toBe('t');
    const page = await listPrints(db, 1, 0);
    expect(page.total).toBe(2);
    expect(page.items[0].id).toBe(p2);
  });
});

describe('settings', () => {
  it('returns defaults, ignores null except clearable keys', async () => {
    expect((await getSettings(db)).max_items_total).toBe(8);
    await updateSettings(db, { max_items_total: 5, model: 'x/y', printer_address: 'AA:BB' });
    await updateSettings(db, { model: null as unknown as string });
    let s = await getSettings(db);
    expect(s).toMatchObject({ max_items_total: 5, model: 'x/y', printer_address: 'AA:BB' });
    await updateSettings(db, { printer_address: null, fallback_model: null });
    s = await getSettings(db);
    expect(s.printer_address).toBeNull();
    expect(s.fallback_model).toBeNull();
    expect((await getCategory(db, catId)).id).toBe(catId);
  });
});
