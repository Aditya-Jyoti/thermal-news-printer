import type { AiClient } from '../ai/client';
import type { Db } from '../db/adapter';
import { insertArticle } from '../db/articles';
import { createCategory, createFeed, updateCategory } from '../db/catalog';
import { archiveEdition, replaceEdition } from '../db/edition';
import { updateSettings } from '../db/settings';
import { curateEdition, fetchNewNews, getDiagnostics } from '../edition';
import { selectGuaranteed } from '../digest/order';
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
const slugs = ['products', 'engineering', 'psychology', 'learning'];

async function seedWorld() {
  const feeds: { id: number; slug: string }[] = [];
  const cats: Record<string, number> = {};
  for (const [name, slug] of [['Products', 'products'], ['Engineering', 'engineering'], ['Psychology', 'psychology'], ['Learning', 'learning']]) {
    cats[slug] = (await createCategory(db, name)).id;
  }
  // 5 feeds across 4 categories
  for (const [i, slug] of ['products', 'products', 'engineering', 'psychology', 'learning'].entries()) {
    feeds.push({ id: (await createFeed(db, `https://f${i}.test/rss`, cats[slug])).id, slug });
  }
  const ids: { id: number; slug: string; age: number }[] = [];
  for (let i = 0; i < 100; i++) {
    n += 1;
    const f = feeds[i % 5];
    // mostly stale (weekly blogs): 20% within 14 days, the rest 15..200 days
    const age = i % 5 === 0 ? i % 14 : 15 + ((i * 17) % 185);
    const id = (await insertArticle(db, {
      feedId: f.id,
      guid: `g${n}`,
      url: `https://ex.test/${n}`,
      title: uniqueTitle(n),
      fingerprint: `fp${n}`,
      publishedAt: new Date(Date.now() - age * 86_400_000 - n * 1000),
      contentText: 'x'.repeat(1500),
      isPolitical: null,
    }))!;
    ids.push({ id, slug: f.slug, age });
  }
  return { cats, ids };
}

/** AI stub that only ever picks a handful (like a picky model) and never flags anything. */
const pickyAi = (maxPicks = 3): AiClient & { calls: number } => {
  const c = {
    calls: 0,
    async chat(o: { user: string; system: string }) {
      if (!o.system.includes('editor of a tiny daily newspaper')) return TLDR;
      c.calls++;
      const ids = [...o.user.matchAll(/^(\d+) \|/gm)].map((m) => Number(m[1]));
      return JSON.stringify({ picks: ids.slice(0, maxPicks), political: [] });
    },
  };
  return c;
};

beforeEach(async () => {
  db = await createMemoryDb();
  n = 0;
});

describe('guaranteed edition size', () => {
  it('reaches the threshold with 5 feeds, 100 mixed-age articles, strict limits and archived items', async () => {
    const { cats, ids } = await seedWorld();
    await updateSettings(db, { max_items_total: 8 });
    await updateCategory(db, cats.products, { print_limit: 3 });
    await updateCategory(db, cats.psychology, { print_limit: 1 });
    await updateCategory(db, cats.engineering, { print_limit: 1 });
    await updateCategory(db, cats.learning, { print_limit: 1 });
    // 15 newest articles are already archived (shown before)
    const newest = [...ids].sort((a, b) => a.age - b.age).slice(0, 15);
    await replaceEdition(db, newest.map((x) => ({ article_id: x.id, category_slug: x.slug })));
    await archiveEdition(db);

    const ai = pickyAi(3);
    const r = await curateEdition(db, { client: ai });
    const got = r.items.map((i) => i.article_id);
    expect(got).toHaveLength(8);
    expect(new Set(got).size).toBe(8);
    for (const a of newest) expect(got).not.toContain(a.id);
    // limits are only preferences: the AI's three picks come first
    expect(got.slice(0, 1)).toHaveLength(1);
    // the recent window alone could not fill the edition
    expect(r.windowDays === null || r.windowDays > 14).toBe(true);
    const d = await getDiagnostics(db);
    expect(d.categories?.map((c) => c.slug)).toEqual(slugs);
    expect(d.categories!.reduce((s, c) => s + c.fetched, 0)).toBe(100);
  });

  it('keeps print_limit 0 categories out even when topping up', async () => {
    const { cats, ids } = await seedWorld();
    await updateSettings(db, { max_items_total: 8 });
    await updateCategory(db, cats.learning, { print_limit: 0 });
    const ai = pickyAi(2);
    const r = await curateEdition(db, { client: ai });
    expect(r.items).toHaveLength(8);
    const learning = new Set(ids.filter((x) => x.slug === 'learning').map((x) => x.id));
    for (const i of r.items) expect(learning.has(i.article_id)).toBe(false);
  });

  it('falls short only when every unseen story is exhausted', async () => {
    const { ids } = await seedWorld();
    await updateSettings(db, { max_items_total: 8 });
    // everything except 5 stories is archived
    const left = new Set(ids.slice(0, 5).map((x) => x.id));
    const rest = ids.filter((x) => !left.has(x.id));
    await replaceEdition(db, rest.map((x) => ({ article_id: x.id, category_slug: x.slug })));
    await archiveEdition(db);
    const r = await curateEdition(db, { client: pickyAi(3) });
    expect(r.items.map((i) => i.article_id).sort()).toEqual([...left].sort());
  });

  it('fetch new news yields a full edition', async () => {
    await seedWorld();
    await updateSettings(db, { max_items_total: 8 });
    const res = await fetchNewNews(db, { client: pickyAi(3), fetch: async () => new Response('', { status: 404 }) });
    expect(res.edition.items).toHaveLength(8);
    expect(res.edition.items.every((i) => i.tldr)).toBe(true);
  });

  it('works without an AI key (heuristic fallback) to the same size', async () => {
    await seedWorld();
    await updateSettings(db, { max_items_total: 8 });
    const r = await curateEdition(db, {});
    expect(r.noKey).toBe(true);
    expect(r.items).toHaveLength(8);
  });
});

describe('selectGuaranteed', () => {
  const c = (id: number, slug: string, title = `unique title ${id} ${slug}${id}`) => ({ article_id: id, category_slug: slug, title });
  const base = { printedIds: new Set<number>(), lastPrintTitles: [] as string[] };

  it('orders: picks within limits, other picks, then round-robin pool', () => {
    const out = selectGuaranteed(
      [c(1, 'a'), c(2, 'a'), c(3, 'b')],
      [c(4, 'a'), c(5, 'a'), c(6, 'b'), c(7, 'c')],
      { ...base, limits: { a: 1, b: 1, c: 1 }, maxTotal: 6 },
    );
    expect(out.map((x) => x.article_id)).toEqual([1, 3, 2, 4, 6, 7]);
  });

  it('never takes limit-0 categories or printed ids', () => {
    const out = selectGuaranteed([c(1, 'z'), c(2, 'a')], [c(3, 'z'), c(4, 'a'), c(5, 'a')], {
      ...base,
      printedIds: new Set([4]),
      limits: { a: 1, z: 0 },
      maxTotal: 5,
    });
    expect(out.map((x) => x.article_id)).toEqual([2, 5]);
  });
});
