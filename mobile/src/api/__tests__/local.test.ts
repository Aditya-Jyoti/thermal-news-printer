import { ApiError } from '../errors';
import { createLocalApi } from '../local';
import type { Api } from '../types';
import { insertArticle, upsertSummary } from '@/core/db/articles';
import { seedDefaults } from '@/core/seed';
import { createMemoryDb } from '@/core/testing/sqljs';
import type { DeviceServices } from '@/device/contracts';
import type { Db } from '@/core/db/adapter';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const TLDR = 'A concrete summary of the story with enough words to read like a real TLDR for the printed edition today.';

function device(over: { printError?: Error; renderError?: Error } = {}): DeviceServices {
  return {
    render: async (items) => {
      if (over.renderError) throw over.renderError;
      return { bitmap: { width: 384, height: 10, pixels: new Uint8Array(3840) }, pngBase64: 'QUJD' + String(items.length) };
    },
    printer: {
      ensurePermissions: async () => true,
      scan: async () => [],
      print: async () => {
        if (over.printError) throw over.printError;
      },
    },
  };
}

let db: Db;
let api: Api;
const rejects = async (p: Promise<unknown>, status: number, msg?: RegExp) => {
  const e = await p.then(
    () => null,
    (x) => x,
  );
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).status).toBe(status);
  if (msg) expect((e as ApiError).message).toMatch(msg);
};

beforeEach(async () => {
  db = await createMemoryDb();
  await seedDefaults(db);
  api = createLocalApi({ db, device: device(), fetch: async () => new Response('', { status: 404 }) });
});

async function summarizedArticle(title = 'Zephyr chip lands') {
  const feedId = (await api.listFeeds())[0].id;
  const id = (await insertArticle(db, { feedId, guid: title, url: `https://x.test/${title}`, title, fingerprint: title, publishedAt: new Date(), contentText: 'body', isPolitical: false }))!;
  await upsertSummary(db, id, TLDR, 'm');
  return id;
}

describe('local Api shapes', () => {
  it('health, models and seeded data', async () => {
    expect(await api.health()).toEqual({ status: 'ok' });
    expect((await api.getModels()).map((m) => m.id)).toContain('google/gemma-3-12b-it');
    const cats = await api.listCategories();
    expect(cats[0]).toEqual({ id: 1, name: 'Products', slug: 'products', color: null, print_limit: 2, feed_count: 2 });
    expect(await api.listFeeds(cats[1].id)).toHaveLength(1);
    expect(await api.listSchedules()).toEqual([{ id: 1, cron: '0 8 * * *', label: 'Morning edition', enabled: true }]);
    expect(await api.getSettings()).toEqual({ max_items_total: 8, model: 'google/gemma-3-12b-it', fallback_model: 'deepseek/deepseek-v4.1-flash', printer_address: null });
  });

  it('CRUD with REST-like errors', async () => {
    const c = await api.createCategory({ name: 'Space', print_limit: 1, color: '#fff' });
    expect(c).toMatchObject({ slug: 'space', print_limit: 1, feed_count: 0 });
    await rejects(api.createCategory({ name: 'Space' }), 409);
    await rejects(api.updateCategory(999, { name: 'x' }), 404);
    const f = await api.createFeed({ url: 'https://s.test/rss', category_id: c.id, title: 'S' });
    expect(f).toMatchObject({ enabled: true, last_fetched_at: null, last_error: null, category_id: c.id });
    await rejects(api.createFeed({ url: 'ftp://nope', category_id: c.id }), 422);
    await rejects(api.createFeed({ url: 'https://s.test/rss', category_id: c.id }), 409);
    expect(await api.updateFeed(f.id, { enabled: false, title: null })).toMatchObject({ enabled: false, title: null });
    await api.deleteFeed(f.id);
    await rejects(api.deleteFeed(f.id), 404);
    await api.deleteCategory(c.id);

    const s = await api.createSchedule({ cron: '30 7 * * *' });
    expect(s).toMatchObject({ cron: '30 7 * * *', label: null, enabled: true });
    await rejects(api.createSchedule({ cron: 'nonsense' }), 422);
    expect((await api.updateSchedule(s.id, { enabled: false })).enabled).toBe(false);
    await api.deleteSchedule(s.id);
    await rejects(api.updateSchedule(s.id, {}), 404);

    expect((await api.patchSettings({ max_items_total: 5, printer_address: 'AA' })).max_items_total).toBe(5);
    await rejects(api.patchSettings({ max_items_total: 99 }), 422);
  });

  it('articles pages and details', async () => {
    const id = await summarizedArticle();
    const page = await api.listArticles({ limit: 10 });
    expect(page).toMatchObject({ total: 1, limit: 10, offset: 0 });
    expect(page.items[0]).toMatchObject({ id, tldr: TLDR, printed_at: null, is_political: false });
    expect(await api.getArticle(id)).toMatchObject({ content_text: 'body', content_html: null });
    await rejects(api.getArticle(999), 404);
  });

  it('refreshFeeds returns an IngestResult', async () => {
    const r = await api.refreshFeeds();
    expect(r.feeds_checked).toBe(5);
    expect(Object.keys(r.errors)).toHaveLength(5);
    await rejects(api.refreshFeeds(999), 404);
  });

  it('processAi reports skipped_no_key without a key', async () => {
    expect(await api.processAi()).toEqual({ summarized: 0, flagged_political: 0, failed: 0, skipped_no_key: true });
  });

  it('digestPreview, previewImage and printNow', async () => {
    await rejects(api.printNow(), 409, /Nothing new to print/);
    expect(await api.digestPreview()).toEqual([]);
    const id = await summarizedArticle();
    expect(await api.digestPreview()).toEqual([{ article_id: id, position: 1, category_slug: 'products', tldr: TLDR }]);
    expect(await api.previewImage()).toEqual({ uri: 'data:image/png;base64,QUJD1' });

    const rec = await api.printNow();
    expect(rec).toMatchObject({ status: 'printed', trigger: 'manual', error: null });
    expect(rec.items[0]).toMatchObject({ article_id: id, title: 'Zephyr chip lands' });
    const prints = await api.listPrints();
    expect(prints).toMatchObject({ total: 1, limit: 20, offset: 0 });
    expect((await api.getPrint(rec.id)).id).toBe(rec.id);
    expect((await api.getArticle(id)).printed_at).not.toBeNull();
    await rejects(api.printNow(), 409);
  });

  it('printNow surfaces printer failures as 502 and records the failed print', async () => {
    const failing = createLocalApi({ db, device: device({ printError: new Error('BLE: no printer found') }) });
    await summarizedArticle();
    await rejects(failing.printNow(), 502, /failed: BLE: no printer found/);
    expect((await failing.listPrints()).items[0]).toMatchObject({ status: 'failed', error: 'BLE: no printer found' });
    expect(await failing.digestPreview()).toHaveLength(1); // released
  });

  it('previewImage is null when the renderer is unavailable', async () => {
    const noRender = createLocalApi({ db, device: device({ renderError: new Error('Renderer not available yet') }) });
    expect(await noRender.previewImage()).toBeNull();
  });
});
