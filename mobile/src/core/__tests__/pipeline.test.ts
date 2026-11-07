import type { DeviceServices } from '../../device/contracts';
import type { Db } from '../db/adapter';
import type { AiClient } from '../ai/client';
import { insertArticle, upsertSummary } from '../db/articles';
import { listEditionItems, replaceEdition } from '../db/edition';
import { editionIdle } from '../edition';
import { createCategory, createFeed } from '../db/catalog';
import { getPrint, listPrints } from '../db/prints';
import { updateSettings } from '../db/settings';
import { buildDigest, runCycle, runPrint } from '../pipeline';
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

/** Persist an edition of already-seeded articles (category slug products). */
const stage = (...ids: number[]) => replaceEdition(db, ids.map((article_id) => ({ article_id, category_slug: 'products' })));

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

describe('runPrint', () => {
  it('returns null and records nothing for an empty digest', async () => {
    const { device } = fakeDevice();
    expect(await runPrint(db, 'manual', { device })).toBeNull();
    expect((await listPrints(db)).total).toBe(0);
    expect(device.render).not.toHaveBeenCalled();
  });

  it('renders, saves the PNG, prints to the saved printer and marks printed', async () => {
    await stage(await seedArticle({ summary: true }));
    await updateSettings(db, { printer_address: 'AA:BB:CC' });
    const { device, printed } = fakeDevice();
    const savePng = jest.fn(async () => 'file://x.png');
    const rec = await runPrint(db, 'schedule', { device, savePng });
    expect(rec).toMatchObject({ status: 'printed', error: null, trigger: 'schedule' });
    expect(rec?.items).toHaveLength(1);
    expect(savePng).toHaveBeenCalledWith(rec!.id, 'UE5H');
    expect((printed[0] as { opts: { deviceId: string } }).opts.deviceId).toBe('AA:BB:CC');
    await editionIdle(db);
    expect(await listEditionItems(db)).toEqual([]); // printed stories never come back
    expect(await runPrint(db, 'manual', { device, savePng })).toBeNull();
  });

  it('marks the print failed on printer error and releases its articles', async () => {
    const id = await seedArticle({ summary: true });
    await stage(id);
    const { device } = fakeDevice({ printError: new Error('BLE: no printer found') });
    const rec = await runPrint(db, 'manual', { device, savePng: async () => null });
    expect(rec).toMatchObject({ status: 'failed', error: 'BLE: no printer found' });
    expect((await getPrint(db, rec!.id)).status).toBe('failed');
    expect((await listEditionItems(db)).map((i) => i.article_id)).toEqual([id]); // kept for a retry
    expect((await buildDigest(db)).map((i) => i.article_id)).toEqual([id]);
  });

  it('marks failed on render errors; a PNG save failure does not block printing', async () => {
    await stage(await seedArticle({ summary: true }));
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
  it('ingests, curates, summarizes and prints in one go', async () => {
    const rss = `<rss version="2.0"><channel><title>T</title><item><title>Fresh chip news</title><link>https://ex.test/fresh</link>
      <description>${'word '.repeat(400)}</description></item></channel></rss>`;
    const fetchFn = async (url: string) => {
      if (url.endsWith('/rss')) return new Response(rss, { status: 200 });
      return new Response('', { status: 404 });
    };
    const client: AiClient = {
      chat: async (o) => (o.user.includes('Candidates:') ? '{"picks": [1], "political": []}' : TLDR),
    };
    const { device } = fakeDevice();
    const res = await runCycle(db, 'schedule', { fetch: fetchFn, client, device, savePng: async () => null });
    expect(res.ingest.new_articles).toBe(1);
    expect(res.edition.items).toHaveLength(1);
    expect(res.print?.status).toBe('printed');
    expect(res.print?.items[0].tldr).toBe(TLDR);
    await editionIdle(db);
  });
});
