import type { AiClient } from '../ai/client';
import type { Db } from '../db/adapter';
import { insertArticle } from '../db/articles';
import { createCategory, createFeed, listFeeds, updateCategory } from '../db/catalog';
import { archiveEdition, replaceEdition } from '../db/edition';
import { updateSettings } from '../db/settings';
import { curateEdition, fetchNewNews, getDiagnostics } from '../edition';
import { capPerCategory, selectBalanced } from '../digest/order';
import { createMemoryDb } from '../testing/sqljs';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const WORDS = 'alpha bravo cobalt delta ember fjord garnet harbor indigo jasper kestrel lumen meadow nectar onyx prism quartz raven sable tundra umber velvet willow xenon yonder zephyr'.split(' ');
const uniqueTitle = (i: number) => `${WORDS[i % 26]} ${WORDS[(i * 7 + 3) % 26]} ${WORDS[(i * 11 + 5) % 26]} story number ${i} ${WORDS[(i * 13 + 1) % 26]}${i}`;
const TLDR = 'Acme launched the Zephyr 2 chip, which runs language models on-device at 40 tokens per second.';

let db: Db;
let n = 0;

interface W { cats: Record<string, number>; feeds: Record<string, number[]>; }

/** 4 categories; products has two feeds, the others one each. */
async function world(): Promise<W> {
  const cats: Record<string, number> = {};
  for (const [name, slug] of [['Products', 'products'], ['Engineering', 'engineering'], ['Psychology', 'psychology'], ['Learning', 'learning']]) {
    cats[slug] = (await createCategory(db, name)).id;
  }
  const feeds: Record<string, number[]> = {};
  let i = 0;
  for (const slug of ['products', 'products', 'engineering', 'psychology', 'learning']) {
    (feeds[slug] ??= []).push((await createFeed(db, `https://f${i++}.test/rss`, cats[slug])).id);
  }
  return { cats, feeds };
}

async function add(feedId: number, ageDays: number) {
  n += 1;
  return (await insertArticle(db, {
    feedId,
    guid: `g${n}`,
    url: `https://ex.test/${n}`,
    title: uniqueTitle(n),
    fingerprint: `fp${n}`,
    publishedAt: new Date(Date.now() - ageDays * 86_400_000 - n * 1000),
    contentText: 'x'.repeat(300),
    isPolitical: null,
  }))!;
}

const slugOfId = async (id: number) =>
  (await db.get<{ slug: string }>('SELECT c.slug FROM articles a JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id WHERE a.id=?', [id]))!.slug;

/** AI stub: ranks candidates in the order shown and records the prompts it received. */
const ranker = (): AiClient & { prompts: string[] } => {
  const c = {
    prompts: [] as string[],
    async chat(o: { user: string; system: string }) {
      if (!o.system.includes('editor of a tiny daily newspaper')) return TLDR;
      c.prompts.push(o.user);
      const ids = [...o.user.matchAll(/^(\d+) \|/gm)].map((m) => Number(m[1]));
      return JSON.stringify({ picks: ids, political: [] });
    },
  };
  return c;
};

beforeEach(async () => {
  db = await createMemoryDb();
  n = 0;
});

describe('balanced edition', () => {
  it('has at least one story from every category with fresh items, even when one feed has 100 fresh items', async () => {
    const w = await world();
    for (let i = 0; i < 100; i++) await add(w.feeds.products[0], 0.01 * i);
    await add(w.feeds.engineering[0], 2);
    await add(w.feeds.psychology[0], 2.5);
    await add(w.feeds.learning[0], 1);
    await updateSettings(db, { max_items_total: 8 });
    const ai = ranker();
    const r = await curateEdition(db, { client: ai });
    const slugs = await Promise.all(r.items.map((i) => slugOfId(i.article_id)));
    expect(r.items).toHaveLength(8);
    for (const s of ['products', 'engineering', 'psychology', 'learning']) expect(slugs).toContain(s);
    // the AI saw every category, with the busy feed capped at 25
    const prompt = ai.prompts[0];
    for (const s of ['products', 'engineering', 'psychology', 'learning']) expect(prompt).toContain(`#${s} |`);
    expect(prompt.match(/#products \|/g)).toHaveLength(25);
  });

  it('works without an AI key the same way (newest first, all categories)', async () => {
    const w = await world();
    for (let i = 0; i < 40; i++) await add(w.feeds.products[0], 0.01 * i);
    await add(w.feeds.engineering[0], 2);
    await add(w.feeds.psychology[0], 2.5);
    await updateSettings(db, { max_items_total: 6 });
    const r = await curateEdition(db, {});
    expect(r.noKey).toBe(true);
    const slugs = await Promise.all(r.items.map((i) => slugOfId(i.article_id)));
    expect(slugs).toContain('engineering');
    expect(slugs).toContain('psychology');
    expect(r.items).toHaveLength(6);
  });

  it('honours max_age_days with no widening: the edition is smaller instead', async () => {
    const w = await world();
    await add(w.feeds.products[0], 1);
    await add(w.feeds.engineering[0], 2);
    await add(w.feeds.learning[0], 5);
    for (let i = 0; i < 20; i++) await add(w.feeds.psychology[0], 10 + i);
    await updateSettings(db, { max_items_total: 8 });
    let r = await curateEdition(db, {});
    expect(r.windowDays).toBe(3);
    expect(r.items).toHaveLength(2);
    await updateSettings(db, { max_age_days: 7 });
    r = await curateEdition(db, {});
    expect(r.items).toHaveLength(3);
    const d = await getDiagnostics(db);
    expect(d.window_days).toBe(7);
  });

  it('keeps print_limit 0 categories out', async () => {
    const w = await world();
    for (const s of ['products', 'engineering', 'learning']) for (let i = 0; i < 4; i++) await add(w.feeds[s][0], 0.1 * i);
    await updateCategory(db, w.cats.learning, { print_limit: 0 });
    await updateSettings(db, { max_items_total: 8 });
    const r = await curateEdition(db, { client: ranker() });
    const slugs = await Promise.all(r.items.map((i) => slugOfId(i.article_id)));
    expect(slugs).not.toContain('learning');
    expect(r.items).toHaveLength(8);
  });

  it('excludes archived stories and falls short only when everything fresh is used', async () => {
    const w = await world();
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(await add(w.feeds.engineering[0], 0.1 * i));
    await replaceEdition(db, ids.slice(0, 4).map((id) => ({ article_id: id, category_slug: 'engineering' })));
    await archiveEdition(db);
    await updateSettings(db, { max_items_total: 8 });
    const r = await curateEdition(db, { client: ranker() });
    expect(r.items.map((i) => i.article_id).sort()).toEqual(ids.slice(4).sort());
  });

  it('fetch new news yields a summarized edition', async () => {
    const w = await world();
    for (const s of ['products', 'engineering', 'psychology', 'learning']) for (let i = 0; i < 3; i++) await add(w.feeds[s][0], 0.1 * i);
    await updateSettings(db, { max_items_total: 8 });
    const res = await fetchNewNews(db, { client: ranker(), fetch: async () => new Response('', { status: 404 }) });
    expect(res.edition.items).toHaveLength(8);
    expect(res.edition.items.every((i) => i.tldr)).toBe(true);
    expect(res.edition.max_age_days).toBe(3);
  });

  it('diagnostics list every feed with fresh counts and the stale flag', async () => {
    const w = await world();
    await add(w.feeds.products[0], 1);
    await add(w.feeds.products[0], 10);
    await add(w.feeds.psychology[0], 400);
    const d = await getDiagnostics(db);
    const byId = new Map(d.feeds!.map((f) => [f.id, f]));
    expect(d.feeds).toHaveLength(5);
    expect(byId.get(w.feeds.products[0])).toMatchObject({ total_items: 2, fresh_items: 1, stale: false });
    expect(byId.get(w.feeds.psychology[0])).toMatchObject({ total_items: 1, fresh_items: 0, stale: true });
    expect(byId.get(w.feeds.learning[0])).toMatchObject({ total_items: 0, stale: false, newest_at: null });
    const feeds = await listFeeds(db);
    expect(feeds.find((f) => f.id === w.feeds.psychology[0])?.stale).toBe(true);
    expect(feeds.find((f) => f.id === w.feeds.products[0])?.stale).toBe(false);
  });
});

describe('selectBalanced', () => {
  const c = (id: number, slug: string, feed = 1, title = `unique title ${id} ${slug}${id}`) => ({ article_id: id, category_slug: slug, feed_id: feed, title });
  const base = { printedIds: new Set<number>(), lastPrintTitles: [] as string[], limits: { a: 2, b: 2, c: 2 } as Record<string, number> };

  it('covers every category first, then respects limits, then fills; interleaves categories', () => {
    const ranked = [c(1, 'a'), c(2, 'a'), c(3, 'a'), c(4, 'b'), c(5, 'c')];
    const out = selectBalanced(ranked, { ...base, maxTotal: 4 });
    expect(out.map((x) => x.article_id).sort()).toEqual([1, 2, 4, 5]);
    expect(out.slice(0, 3).map((x) => x.category_slug)).toEqual(['a', 'b', 'c']);
    expect(selectBalanced(ranked, { ...base, maxTotal: 5 })).toHaveLength(5); // limits are soft
  });

  it('alternates feeds within a category and caps a single feed at ceil(target/3)', () => {
    const ranked = [c(1, 'a', 1), c(2, 'a', 1), c(3, 'a', 1), c(4, 'a', 2), c(5, 'a', 2), c(6, 'b', 3), c(7, 'b', 3)];
    const out = selectBalanced(ranked, { ...base, limits: { a: 9, b: 9 }, maxTotal: 6 });
    const of = (f: number) => out.filter((x) => x.feed_id === f).length;
    expect(of(1)).toBeLessThanOrEqual(2);
    expect(of(2)).toBeGreaterThanOrEqual(2);
    expect(out).toHaveLength(6);
  });

  it('relaxes the feed cap only when short', () => {
    const ranked = [1, 2, 3, 4, 5].map((i) => c(i, 'a', 1));
    expect(selectBalanced(ranked, { ...base, limits: { a: 9 }, maxTotal: 5 })).toHaveLength(5);
  });

  it('never takes limit-0 categories, printed ids or near-duplicates', () => {
    const out = selectBalanced(
      [c(1, 'z'), c(2, 'a'), c(4, 'a'), c(5, 'a', 1, 'same headline words here'), c(6, 'b', 2, 'same headline words here')],
      { ...base, printedIds: new Set([4]), limits: { a: 5, b: 5, z: 0 }, maxTotal: 5 },
    );
    expect(out.map((x) => x.article_id).sort()).toEqual([2, 6]); // coverage takes b's story first, so 5 is the duplicate
  });
});

describe('capPerCategory', () => {
  it('caps per category and total, alternating feeds', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: i, category_slug: 'a', feed_id: 1 })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, category_slug: 'a', feed_id: 2 })),
      { id: 200, category_slug: 'b', feed_id: 3 },
    ];
    const out = capPerCategory(rows, 4, 100);
    expect(out.filter((r) => r.category_slug === 'a')).toHaveLength(4);
    expect(out.filter((r) => r.category_slug === 'a' && r.feed_id === 2)).toHaveLength(2);
    expect(out.some((r) => r.category_slug === 'b')).toBe(true);
    expect(capPerCategory(rows, 25, 5)).toHaveLength(5);
  });
});
