import type { DeviceServices } from '../../device/contracts';
import { AIError, type AiClient } from '../ai/client';
import { buildCurateUser, candidateLines, parseCurateJson } from '../ai/curate';
import type { Db } from '../db/adapter';
import { insertArticle, upsertSummary } from '../db/articles';
import { createCategory, createFeed, updateCategory } from '../db/catalog';
import { getEditionBuiltAt, listEditionItems, replaceEdition } from '../db/edition';
import { createPrint } from '../db/prints';
import { updateSettings } from '../db/settings';
import { selectInOrder } from '../digest/order';
import { buildEdition, curateEdition, editionIdle, getEdition } from '../edition';
import { runPrint } from '../pipeline';
import { createMemoryDb } from '../testing/sqljs';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const TLDR =
  'Acme Corp launched the Zephyr 2 chip, which runs language models on-device at 40 tokens per second while drawing 3 watts. ' +
  'It ships to phone makers in March and doubles the speed of the earlier design.';

let db: Db;
let feedId: number;
let n = 0;

async function seed(o: { title?: string; feed?: number; ageDays?: number; political?: boolean | null; summary?: boolean } = {}) {
  n += 1;
  const id = (await insertArticle(db, {
    feedId: o.feed ?? feedId,
    guid: `g${n}`,
    url: `https://ex.test/${n}`,
    title: o.title ?? `Distinct headline ${n} zebra${n * 31} quark${n * 17}`,
    fingerprint: `fp${n}`,
    publishedAt: new Date(Date.now() - (o.ageDays ?? 0) * 86_400_000 - n * 1000),
    contentText: 'x'.repeat(2000),
    isPolitical: o.political === undefined ? null : o.political,
  }))!;
  if (o.summary) await upsertSummary(db, id, `tldr ${id}`, 'm');
  return id;
}

/** AI stub: curate calls get `curate(user)`, summaries get TLDR. */
function ai(curate: (user: string) => string | Error) {
  const c = {
    curateCalls: 0,
    summaryCalls: 0,
    prompts: [] as string[],
    async chat(o: { user: string; system: string }) {
      if (o.system.includes('editor of a tiny daily newspaper')) {
        c.curateCalls++;
        c.prompts.push(o.user);
        const r = curate(o.user);
        if (r instanceof Error) throw r;
        return r;
      }
      c.summaryCalls++;
      return TLDR;
    },
  };
  return c satisfies AiClient & Record<string, unknown>;
}

const picks = (ids: number[], political: number[] = []) => JSON.stringify({ picks: ids, political });

beforeEach(async () => {
  db = await createMemoryDb();
  feedId = (await createFeed(db, 'https://f.test/rss', (await createCategory(db, 'Products')).id)).id;
  n = 0;
});

describe('parseCurateJson', () => {
  const valid = [1, 2, 3, 4];
  it('parses plain JSON, code fences and surrounding prose', () => {
    expect(parseCurateJson('{"picks":[2,1],"political":[3]}', valid)).toEqual({ picks: [2, 1], political: [3] });
    expect(parseCurateJson('```json\n{"picks":[4,2],"political":[]}\n```', valid)).toEqual({ picks: [4, 2], political: [] });
    expect(parseCurateJson('Sure! Here you go:\n{"picks": [1, 3], "political": [2]}\nHope that helps', valid)).toEqual({
      picks: [1, 3],
      political: [2],
    });
  });
  it('drops unknown ids, dupes, string ids, and picks flagged political', () => {
    expect(parseCurateJson('{"picks":["2", 9, 2, 3, "x"],"political":["3", 77]}', valid)).toEqual({ picks: [2], political: [3] });
  });
  it('returns null for unusable output and tolerates a missing key', () => {
    expect(parseCurateJson('I cannot do that', valid)).toBeNull();
    expect(parseCurateJson('{"foo": 1}', valid)).toBeNull();
    expect(parseCurateJson('{"picks": [1]}', valid)).toEqual({ picks: [1], political: [] });
  });
});

describe('prompt lines', () => {
  it('are compact: id | #category | title | ~160 chars of whitespace-collapsed text', () => {
    const lines = candidateLines([
      { id: 7, category_slug: 'products', title: 'A | B\ntitle', content_text: `${'word  \n '.repeat(100)}` },
    ]);
    expect(lines.startsWith('7 | #products | A B title | word word')).toBe(true);
    expect(lines.length).toBeLessThan(7 + 12 + 14 + 3 * 3 + 225);
    expect(buildCurateUser([{ id: 1, category_slug: 'c', title: 't', content_text: null }], 5)).toContain('MAX_PICKS = 5');
  });
});

describe('selectInOrder (code rules on the AI order)', () => {
  const c = (id: number, slug: string, title = `Unique title number ${id} alpha${id}`) => ({ article_id: id, category_slug: slug, title });
  const base = { limits: { a: 2, b: 1 }, maxTotal: 10, printedIds: new Set<number>(), lastPrintTitles: [] as string[] };
  it('keeps the AI order and enforces per-category limits and the cap', () => {
    const out = selectInOrder([c(5, 'a'), c(4, 'b'), c(3, 'a'), c(2, 'a'), c(1, 'b')], base);
    expect(out.map((x) => x.article_id)).toEqual([5, 4, 3]);
    expect(selectInOrder([c(5, 'a'), c(4, 'b'), c(3, 'a')], { ...base, maxTotal: 2 }).map((x) => x.article_id)).toEqual([5, 4]);
  });
  it('excludes printed ids and near-duplicates (vs last print and within the batch)', () => {
    const same = 'OpenAI launches new model today for everyone';
    const out = selectInOrder(
      [c(1, 'a', same), c(2, 'a', same + '!'), c(3, 'a', 'Totally different story about quantum bits'), c(4, 'b', 'Printed one'), c(5, 'b', 'Last print rerun headline here now')],
      { ...base, printedIds: new Set([4]), lastPrintTitles: ['Last print rerun headline here now'] },
    );
    expect(out.map((x) => x.article_id)).toEqual([1, 3]);
  });
});

describe('curateEdition', () => {
  it('uses the AI order, flags political, marks the rest checked, and only sends recent unprinted candidates', async () => {
    const a = await seed();
    const b = await seed();
    const pol = await seed();
    const old = await seed({ ageDays: 30 });
    const printed = await seed();
    await createPrint(db, 'manual', [{ article_id: printed, position: 1, category_slug: 'products', tldr: 't' }]);
    await updateSettings(db, { max_items_total: 2 });
    const client = ai(() => picks([b, a], [pol]));
    const r = await curateEdition(db, { client });
    expect(r).toMatchObject({ usedAi: true, noKey: false });
    expect(r.items.map((i) => i.article_id)).toEqual([b, a]);
    const sent = client.prompts[0];
    const hasId = (id: number) => new RegExp(`^${id} \\|`, 'm').test(sent);
    expect(hasId(a)).toBe(true);
    expect(hasId(old)).toBe(false);
    expect(hasId(printed)).toBe(false);
    const flags = await db.all<{ id: number; is_political: number | null }>('SELECT id, is_political FROM articles ORDER BY id');
    expect(Object.fromEntries(flags.map((f) => [f.id, f.is_political]))).toEqual({ [a]: 0, [b]: 0, [pol]: 1, [old]: null, [printed]: null });
  });

  it('prefers limits on the AI order, then tops up past them to the guaranteed size', async () => {
    const ids = [await seed(), await seed(), await seed(), await seed()];
    await updateSettings(db, { max_items_total: 8 });
    const cat = (await db.get<{ id: number }>("SELECT id FROM categories WHERE slug='products'"))!.id;
    await updateCategory(db, cat, { print_limit: 2 });
    const r = await curateEdition(db, { client: ai(() => picks([ids[3], ids[1], ids[0], ids[2]])) });
    expect(r.items.map((i) => i.article_id)).toEqual([ids[3], ids[1], ids[0], ids[2]]);
    await updateSettings(db, { max_items_total: 3 });
    const r3 = await curateEdition(db, { client: ai(() => picks([ids[3], ids[1], ids[0], ids[2]])) });
    expect(r3.items.map((i) => i.article_id)).toEqual([ids[3], ids[1], ids[0]]);
  });

  it('falls back to the deterministic newest-first selection on AI errors or unparsable replies', async () => {
    const newest = await seed();
    const older = await seed({ ageDays: 1 });
    for (const reply of [new AIError('boom'), 'no json here', picks([])]) {
      const r = await curateEdition(db, { client: ai(() => reply) });
      expect(r).toMatchObject({ usedAi: false, noKey: false });
      expect(r.items.map((i) => i.article_id)).toEqual([newest, older]);
    }
    // nothing is marked on failure
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM articles WHERE is_political IS NOT NULL'))!.n).toBe(0);
  });

  it('surfaces "no key" and still produces a fallback selection', async () => {
    const id = await seed();
    const r = await curateEdition(db, {});
    expect(r).toMatchObject({ usedAi: false, noKey: true });
    expect(r.items.map((i) => i.article_id)).toEqual([id]);
    await buildEdition(db, {}, { force: true });
    expect((await getEdition(db)).status.no_key).toBe(true);
  });
});

describe('edition persistence and rebuild rules', () => {
  it('persists the edition, summarizes only the chosen stories and exposes joined data', async () => {
    const ids = [await seed(), await seed(), await seed()];
    await updateSettings(db, { max_items_total: 2 });
    const client = ai(() => picks([ids[2], ids[0]]));
    const ed = await buildEdition(db, { client });
    expect(client.summaryCalls).toBe(2); // not 3: unchosen stories are never summarized
    expect(ed.items.map((i) => [i.position, i.article_id, i.tldr])).toEqual([
      [1, ids[2], TLDR],
      [2, ids[0], TLDR],
    ]);
    expect(ed.items[0]).toMatchObject({ category_slug: 'products', url: expect.stringContaining('https://ex.test/') });
    expect(ed.status).toMatchObject({ phase: 'idle', no_key: false });
    expect(await getEditionBuiltAt(db)).not.toBeNull();
    expect((await listEditionItems(db)).map((i) => i.article_id)).toEqual([ids[2], ids[0]]);
  });

  it('does not re-curate an existing edition unless forced, empty or new articles arrived', async () => {
    const a = await seed();
    const client = ai(() => picks([a]));
    await buildEdition(db, { client });
    await buildEdition(db, { client });
    expect(client.curateCalls).toBe(1);
    await buildEdition(db, { client }, { newArticles: 0 });
    expect(client.curateCalls).toBe(1);
    await buildEdition(db, { client }, { newArticles: 2 });
    expect(client.curateCalls).toBe(2);
    await buildEdition(db, { client }, { force: true });
    expect(client.curateCalls).toBe(3);
    await buildEdition(db, { client }, { ensureOnly: true });
    expect(client.curateCalls).toBe(3);
    await replaceEdition(db, []);
    await buildEdition(db, { client });
    expect(client.curateCalls).toBe(4);
    expect(client.summaryCalls).toBe(1); // the summary was reused every time
  });

  it('retries missing summaries without reshuffling', async () => {
    const a = await seed();
    const b = await seed();
    let fail = true;
    const client: AiClient & { curates: number } = {
      curates: 0,
      async chat(o) {
        if (o.system.includes('editor of a tiny daily newspaper')) {
          client.curates++;
          return picks([a, b]);
        }
        if (fail) throw new AIError('flaky');
        return TLDR;
      },
    };
    const first = await buildEdition(db, { client });
    expect(first.items.map((i) => i.article_id)).toEqual([a, b]);
    expect(first.items.every((i) => i.tldr === null)).toBe(true);
    fail = false;
    const second = await buildEdition(db, { client });
    expect(client.curates).toBe(1);
    expect(second.items.every((i) => i.tldr === TLDR)).toBe(true);
  });

  it('is single-flight: concurrent builds share one run and never reshuffle mid-summaries', async () => {
    const ids = [await seed(), await seed(), await seed()];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = ai(() => picks(ids));
    const slow: AiClient = {
      chat: async (o) => {
        if (!o.system.includes('editor of a tiny daily newspaper')) await gate;
        return client.chat(o);
      },
    };
    const p1 = buildEdition(db, { client: slow });
    await new Promise((r) => setTimeout(r, 20));
    expect((await getEdition(db, { client: slow })).status.phase).toBe('summarizing');
    const p2 = buildEdition(db, { client: slow }, { force: true }); // must not start a second curation
    release();
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(client.curateCalls).toBe(1);
    expect(e1.items.map((i) => i.article_id)).toEqual(e2.items.map((i) => i.article_id));
    await editionIdle(db);
  });
});

describe('runPrint uses the persisted edition', () => {
  function fakeDevice(printError?: Error) {
    const device: DeviceServices = {
      render: jest.fn(async (items) => ({ bitmap: { width: 384 as const, height: items.length, pixels: new Uint8Array(384 * items.length) }, pngBase64: 'UE5H' })),
      printer: {
        ensurePermissions: async () => true,
        scan: async () => [],
        print: jest.fn(async () => {
          if (printError) throw printError;
        }),
      },
    };
    return device;
  }

  it('prints exactly the edition (only summarized items), then clears it and builds the next one', async () => {
    const a = await seed({ summary: true });
    const b = await seed({ summary: true });
    const unsummarized = await seed();
    const later = await seed({ ageDays: 1 });
    await replaceEdition(db, [
      { article_id: b, category_slug: 'products' },
      { article_id: unsummarized, category_slug: 'products' },
      { article_id: a, category_slug: 'products' },
    ]);
    const device = fakeDevice();
    const rec = await runPrint(db, 'manual', { device, savePng: async () => null }); // no key: cannot summarize
    expect(rec?.status).toBe('printed');
    expect(rec?.items.map((i) => [i.position, i.article_id])).toEqual([
      [1, b],
      [2, a],
    ]);
    await editionIdle(db);
    // next edition was built in the background from what is left (printed ones excluded)
    expect((await listEditionItems(db)).map((i) => i.article_id)).toEqual(expect.not.arrayContaining([a, b]));
    expect((await listEditionItems(db)).map((i) => i.article_id).sort()).toEqual([unsummarized, later].sort());
  });

  it('finishes pending summaries before printing', async () => {
    const a = await seed();
    await replaceEdition(db, [{ article_id: a, category_slug: 'products' }]);
    const client = ai(() => picks([a]));
    const rec = await runPrint(db, 'schedule', { device: fakeDevice(), client, savePng: async () => null });
    expect(rec?.items[0].tldr).toBe(TLDR);
    await editionIdle(db);
  });

  it('keeps the edition when the print fails', async () => {
    const a = await seed({ summary: true });
    await replaceEdition(db, [{ article_id: a, category_slug: 'products' }]);
    const rec = await runPrint(db, 'manual', { device: fakeDevice(new Error('BLE: no printer found')), savePng: async () => null });
    expect(rec?.status).toBe('failed');
    expect((await listEditionItems(db)).map((i) => i.article_id)).toEqual([a]);
    const retry = await runPrint(db, 'manual', { device: fakeDevice(), savePng: async () => null });
    expect(retry?.status).toBe('printed');
    await editionIdle(db);
  });
});
