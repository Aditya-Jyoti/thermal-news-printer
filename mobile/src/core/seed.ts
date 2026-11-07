import type { Db } from './db/adapter';
import { createCategory, createFeed } from './db/catalog';
import { createSchedule, getSetting, listSchedules, setSetting } from './db/settings';

export const DEFAULT_CATEGORIES: Record<string, string[]> = {
  Products: ['https://hnrss.org/launches', 'https://techcrunch.com/category/startups/feed/'],
  Engineering: ['https://blog.pragmaticengineer.com/rss/'],
  Psychology: ['http://freakonomics.blogs.nytimes.com/feed/'],
  Learning: ['https://feeds.feedburner.com/bigthink/main'],
};
export const DEFAULT_SCHEDULE = { cron: '0 8 * * *', label: 'Morning edition' };
export const SEED_SETTINGS = {
  max_items_total: 8,
  model: 'google/gemma-3-12b-it',
  fallback_model: 'deepseek/deepseek-v4.1-flash',
};
const SEEDED_KEY = '_seeded';

/**
 * Seed defaults once. Returns true if seeding happened (first init only). A marker setting
 * prevents re-seeding, so categories/feeds the user deleted stay deleted.
 */
export async function seedDefaults(db: Db): Promise<boolean> {
  if (await getSetting<boolean>(db, SEEDED_KEY, false)) return false;
  for (const [name, urls] of Object.entries(DEFAULT_CATEGORIES)) {
    const row = await db.get<{ id: number }>('SELECT id FROM categories WHERE name=?', [name]);
    const catId = row ? row.id : (await createCategory(db, name)).id;
    for (const url of urls) {
      if (!(await db.get('SELECT 1 FROM feeds WHERE url=?', [url]))) await createFeed(db, url, catId);
    }
  }
  if ((await listSchedules(db)).length === 0) await createSchedule(db, DEFAULT_SCHEDULE.cron, DEFAULT_SCHEDULE.label);
  for (const [k, v] of Object.entries(SEED_SETTINGS)) {
    if ((await getSetting(db, k)) === null) await setSetting(db, k, v);
  }
  await setSetting(db, SEEDED_KEY, true);
  return true;
}
