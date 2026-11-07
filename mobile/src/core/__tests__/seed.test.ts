import { listCategories, listFeeds, deleteFeed } from '../db/catalog';
import { getSettings, listSchedules } from '../db/settings';
import { initDb } from '../db';
import { seedDefaults } from '../seed';
import { createMemoryDb } from '../testing/sqljs';

describe('seedDefaults', () => {
  it('seeds categories, feeds, schedule and settings once', async () => {
    const db = await createMemoryDb({ migrate: false });
    await initDb(db);
    const cats = await listCategories(db);
    expect(cats.map((c) => c.slug)).toEqual(['products', 'engineering', 'psychology', 'learning']);
    expect(cats[0].feed_count).toBe(2);
    const feeds = await listFeeds(db);
    expect(feeds.map((f) => f.url)).toContain('https://techcrunch.com/category/startups/feed/');
    expect(feeds).toHaveLength(5);
    expect(await listSchedules(db)).toEqual([{ id: 1, cron: '0 8 * * *', label: 'Morning edition', enabled: true }]);
    expect(await getSettings(db)).toEqual({
      max_items_total: 8,
      model: 'google/gemma-3-12b-it',
      fallback_model: 'deepseek/deepseek-v4.1-flash',
      printer_address: null,
    });
  });

  it('is idempotent and does not resurrect deleted feeds', async () => {
    const db = await createMemoryDb();
    expect(await seedDefaults(db)).toBe(true);
    const f = (await listFeeds(db))[0];
    await deleteFeed(db, f.id);
    expect(await seedDefaults(db)).toBe(false);
    expect(await listFeeds(db)).toHaveLength(4);
    expect(await listSchedules(db)).toHaveLength(1);
  });
});
