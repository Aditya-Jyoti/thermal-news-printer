import type { DeviceServices } from '../../device/contracts';
import type { Db } from '../db/adapter';
import { AIError, type AiClient } from '../ai/client';
import { insertArticle, upsertSummary, getArticleDetail, listDigestCandidates } from '../db/articles';
import { createCategory, createFeed, updateCategory } from '../db/catalog';
import { getPrint, listPrints } from '../db/prints';
import { updateSettings } from '../db/settings';
import { buildDigest, processPending, runCycle, runPrint } from '../pipeline';
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

async function seedArticle(o: { summary?: boolean; political?: boolean | null; ageDays?: number; title?: string; contentText?: string } = {}) {
  n += 1;
  const id = (await insertArticle(db, {
    feedId,
    guid: `g${n}`,
    url: `https://ex.test/${n}`,
    title: o.title ?? `Distinct headline number ${n} zebra${n * 31}`,
    fingerprint: `fp${n}`,
    publishedAt: new Date(Date.now() - (o.ageDays ?? 0) * 86_400_000 - n * 1000),
    contentText: o.contentText ?? 'x'.repeat(2000), // long enough to skip enrichment
    isPolitical: o.political === undefined ? false : o.political,
  }))!;
  if (o.summary) await upsertSummary(db, id, `tldr ${id}`, 'm');
  return id;
}

beforeEach(async () => {
  db = await createMemoryDb();
  feedId = (await createFeed(db, 'https://f.test/rss', (await createCategory(db, 'Products')).id)).id;
  n = 0;
});

function fakeDevice(over: { renderError?: Error; printError?: Error } = {}) {
  const printed: unknown[] = [];
  const device: DeviceServices = {
    render: jest.fn(async (items) => {
      if (over.renderError) throw over.renderError;
      return { bitmap: { width: 384 as const, height: items.length, pixels: new Uint8Array(384 * items.length) }, pngBase64: 'UE5H' };
    }),
    printer: {
      ensurePermissions: async () => true,
      scan: async () => [],
      print: jest.fn(async (bmp, opts) => {
        if (over.printError) throw over.printError;
        printed.push({ bmp, opts });
      }),
    },
  };
  return { device, printed };
}

describe('processPending', () => {
  const combined = (tldr: string, political = false) => JSON.stringify({ political, reason: 'r', tldr });
  const client = (fn: (user: string) => string | Error): AiClient & { calls: number } => {
    const c = {
      calls: 0,
      async chat(o: { user: string }) {
        c.calls++;
        const r = fn(o.user);
        if (r instanceof Error) throw r;
        return r;
      },
    };
    return c;
  };

  it('skips with skipped_no_key and never throws when no key is stored', async () => {
    await seedArticle({ political: null });
    expect(await processPending(db)).toEqual({ summarized: 0, flagged_political: 0, failed: 0, skipped_no_key: true });
  });

  it('uses the stored key to build a client (posts to OpenRouter)', async () => {
    const SecureStore = jest.requireMock('expo-secure-store') as { getItemAsync: jest.Mock };
    SecureStore.getItemAsync.mockResolvedValueOnce('sk-test');
    await seedArticle({ political: null });
    const fetchFn = jest.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: combined(TLDR) } }] })));
    const r = await processPending(db, { fetch: fetchFn });
    expect(r.summarized).toBe(1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((fetchFn.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('summarizes unchecked articles, flags political ones, counts failures', async () => {
    const ok = await seedArticle({ political: null, title: 'Chip launch' });
    const pol = await seedArticle({ political: null, title: 'Vote count' });
    const bad = await seedArticle({ political: null, title: 'Broken one' });
    const checked = await seedArticle({ political: false, title: 'Already checked' });
    const c = client((user) => {
      if (user.includes('Vote count')) return combined(TLDR, true);
      if (user.includes('Broken one')) return new AIError('boom');
      if (user.includes('Already checked')) return TLDR; // plain summary path (politics already known)
      return combined(TLDR);
    });
    const r = await processPending(db, { client: c, settings: { max_items_total: 8, model: 'p', fallback_model: null, printer_address: null } });
    expect(r).toEqual({ summarized: 2, flagged_political: 1, failed: 1, skipped_no_key: false });
    expect((await getArticleDetail(db, ok)).tldr).toBe(TLDR);
    expect((await getArticleDetail(db, checked)).tldr).toBe(TLDR);
    expect((await getArticleDetail(db, pol)).is_political).toBe(true);
    expect((await getArticleDetail(db, pol)).tldr).toBeNull();
    expect((await getArticleDetail(db, bad)).tldr).toBeNull();
  });

  it('respects max_age_days and limit, skips already summarized', async () => {
    await seedArticle({ ageDays: 10, political: null });
    await seedArticle({ summary: true, political: false });
    for (let i = 0; i < 5; i++) await seedArticle({ political: null });
    const c = client(() => combined(TLDR));
    const r = await processPending(db, { client: c, limit: 3 });
    expect(r.summarized).toBe(3);
    expect(c.calls).toBe(3);
  });
});

describe('buildDigest', () => {
  it('applies category limits, max_total and the previous-print title rule', async () => {
    const other = await createCategory(db, 'Psychology');
    const f2 = await createFeed(db, 'https://g.test/rss', other.id);
    for (let i = 0; i < 4; i++) await seedArticle({ summary: true });
    n += 1;
    const pid = (await insertArticle(db, { feedId: f2.id, guid: 'p', url: 'https://p.test/1', title: 'Psych piece alpha beta', fingerprint: 'pp', publishedAt: new Date(), isPolitical: false }))!;
    await upsertSummary(db, pid, 'psych tldr', 'm');
    let d = await buildDigest(db);
    expect(d.map((i) => i.category_slug)).toEqual(['products', 'psychology', 'products']); // limits 2 / 2 round robin
    await updateCategory(db, other.id, { print_limit: 0 });
    await updateSettings(db, { max_items_total: 1 });
    d = await buildDigest(db);
    expect(d).toHaveLength(1);
    expect(d[0].position).toBe(1);
  });
});

describe('runPrint', () => {
  it('returns null and records nothing for an empty digest', async () => {
    const { device } = fakeDevice();
    expect(await runPrint(db, 'manual', { device })).toBeNull();
    expect((await listPrints(db)).total).toBe(0);
    expect(device.render).not.toHaveBeenCalled();
  });

  it('renders, saves the PNG, prints to the saved printer and marks printed', async () => {
    await seedArticle({ summary: true });
    await updateSettings(db, { printer_address: 'AA:BB:CC' });
    const { device, printed } = fakeDevice();
    const savePng = jest.fn(async () => 'file://x.png');
    const rec = await runPrint(db, 'schedule', { device, savePng });
    expect(rec).toMatchObject({ status: 'printed', error: null, trigger: 'schedule' });
    expect(rec?.items).toHaveLength(1);
    expect(savePng).toHaveBeenCalledWith(rec!.id, 'UE5H');
    expect((printed[0] as { opts: { deviceId: string } }).opts.deviceId).toBe('AA:BB:CC');
    expect(await buildDigest(db)).toEqual([]); // printed articles never come back
    expect(await runPrint(db, 'manual', { device, savePng })).toBeNull();
  });

  it('marks the print failed on printer error and releases its articles', async () => {
    const id = await seedArticle({ summary: true });
    const { device } = fakeDevice({ printError: new Error('BLE: no printer found') });
    const rec = await runPrint(db, 'manual', { device, savePng: async () => null });
    expect(rec).toMatchObject({ status: 'failed', error: 'BLE: no printer found' });
    expect((await getPrint(db, rec!.id)).status).toBe('failed');
    expect((await listDigestCandidates(db)).map((r) => r.article_id)).toEqual([id]);
    expect((await buildDigest(db)).map((i) => i.article_id)).toEqual([id]);
  });

  it('marks failed on render errors; a PNG save failure does not block printing', async () => {
    await seedArticle({ summary: true });
    const r1 = await runPrint(db, 'manual', { device: fakeDevice({ renderError: new Error('Renderer not available yet') }).device });
    expect(r1).toMatchObject({ status: 'failed', error: 'Renderer not available yet' });
    const r2 = await runPrint(db, 'manual', {
      device: fakeDevice().device,
      savePng: async () => {
        throw new Error('disk full');
      },
    });
    expect(r2?.status).toBe('printed');
  });
});

describe('runCycle', () => {
  it('ingests, summarizes and prints in one go', async () => {
    const rss = `<rss version="2.0"><channel><title>T</title><item><title>Fresh chip news</title><link>https://ex.test/fresh</link>
      <description>${'word '.repeat(400)}</description></item></channel></rss>`;
    const fetchFn = async (url: string) => {
      if (url.endsWith('/rss')) return new Response(rss, { status: 200 });
      return new Response('', { status: 404 });
    };
    const client: AiClient = { chat: async () => JSON.stringify({ political: false, reason: 'ok', tldr: TLDR }) };
    const { device } = fakeDevice();
    const res = await runCycle(db, 'schedule', { fetch: fetchFn, client, device, savePng: async () => null });
    expect(res.ingest.new_articles).toBe(1);
    expect(res.process.summarized).toBe(1);
    expect(res.print?.status).toBe('printed');
    expect(res.print?.items[0].tldr).toBe(TLDR);
  });
});
