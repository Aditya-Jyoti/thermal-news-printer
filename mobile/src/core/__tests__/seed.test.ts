import { listCategories, listFeeds, deleteFeed } from '../db/catalog';
import { getSettings, listSchedules } from '../db/settings';
import { initDb } from '../db';
import { MIGRATIONS, migrate, migrateDefaultFeeds } from '../db/schema';
import { DEFAULT_CATEGORIES, seedDefaults } from '../seed';
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
    expect(feeds).toHaveLength(11);
    expect(await listSchedules(db)).toEqual([{ id: 1, cron: '0 8 * * *', label: 'Morning edition', enabled: true }]);
    expect(await getSettings(db)).toEqual({
      max_items_total: 8,
      max_age_days: 3,
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
    expect(await listFeeds(db)).toHaveLength(10);
    expect(await listSchedules(db)).toHaveLength(1);
  });
});

describe('migration v4 (default feed replacement)', () => {
  const OLD = {
    engineering: 'https://blog.pragmaticengineer.com/rss/',
    psychology: 'http://freakonomics.blogs.nytimes.com/feed/',
    learning: 'https://feeds.feedburner.com/bigthink/main',
  };

  /** A DB seeded with the previous default list at user_version 3. */
  async function oldInstall() {
    const db = await createMemoryDb({ migrate: false });
    for (let v = 0; v < 3; v++) await db.exec(MIGRATIONS[v] as string);
    await db.exec('PRAGMA user_version=3');
    let cat = 0;
    for (const [name, urls] of Object.entries({
      Products: ['https://hnrss.org/launches', 'https://techcrunch.com/category/startups/feed/'],
      Engineering: [OLD.engineering],
      Psychology: [OLD.psychology],
      Learning: [OLD.learning],
    })) {
      cat += 1;
      await db.run('INSERT INTO categories(name, slug, created_at) VALUES(?,?,?)', [name, name.toLowerCase(), '2026-01-01']);
      for (const u of urls) await db.run('INSERT INTO feeds(url, category_id, created_at) VALUES(?,?,?)', [u, cat, '2026-01-01']);
    }
    return db;
  }

  it('replaces the old defaults in place and adds the other new ones', async () => {
    const db = await oldInstall();
    await db.run('UPDATE feeds SET enabled=0 WHERE url=?', [OLD.psychology]);
    await migrate(db);
    const feeds = await listFeeds(db);
    const urls = feeds.map((f) => f.url);
    for (const o of Object.values(OLD)) expect(urls).not.toContain(o);
    expect(urls).toHaveLength(11);
    for (const list of Object.values(DEFAULT_CATEGORIES)) for (const u of list) expect(urls).toContain(u);
    const psy = feeds.find((f) => f.url === 'https://www.psypost.org/feed/')!;
    expect(psy).toMatchObject({ id: 4, enabled: false, category_id: 3 }); // same row, flag kept
    expect((await db.get<{ user_version: number }>('PRAGMA user_version'))?.user_version).toBe(4);
  });

  it('is idempotent and leaves user feeds and deleted feeds alone', async () => {
    const db = await oldInstall();
    await db.run("INSERT INTO feeds(url, category_id, created_at) VALUES('https://mine.test/rss',2,'2026-01-01')");
    await db.run('DELETE FROM feeds WHERE url=?', [OLD.learning]); // user deleted the dead Big Think feed
    await migrate(db);
    const first = (await listFeeds(db)).map((f) => f.url).sort();
    await migrateDefaultFeeds(db);
    await migrateDefaultFeeds(db);
    expect((await listFeeds(db)).map((f) => f.url).sort()).toEqual(first);
    expect(first).toContain('https://mine.test/rss');
    expect(first).not.toContain('https://bigthink.com/feed/'); // not re-added
    expect(first).toContain('https://www.infoq.com/feed/');
  });

  it('fresh installs end up with exactly the defaults', async () => {
    const db = await createMemoryDb({ migrate: false });
    await initDb(db);
    expect(await listFeeds(db)).toHaveLength(11);
  });
});
