import type { Category, Feed } from '../../api/types';
import { Conflict, NotFound } from '../errors';
import { exists, type Db, type SqlValue } from './adapter';
import { isStale, nowIso } from './time';

// --- categories ---------------------------------------------------------------

interface CatRow {
  id: number;
  name: string;
  slug: string;
  color: string | null;
  print_limit: number;
  feed_count: number;
}

const CAT_SELECT =
  'SELECT c.*, (SELECT COUNT(*) FROM feeds f WHERE f.category_id=c.id) AS feed_count FROM categories c';

const toCategory = (r: CatRow): Category => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  color: r.color,
  print_limit: r.print_limit,
  feed_count: r.feed_count,
});

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'category';
}

export async function listCategories(db: Db): Promise<Category[]> {
  return (await db.all<CatRow>(CAT_SELECT + ' ORDER BY c.id')).map(toCategory);
}

export async function getCategory(db: Db, id: number): Promise<Category> {
  const row = await db.get<CatRow>(CAT_SELECT + ' WHERE c.id=?', [id]);
  if (!row) throw new NotFound(`category ${id} not found`);
  return toCategory(row);
}

async function uniqueSlug(db: Db, name: string, excludeId: number | null = null): Promise<string> {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  // `id IS NOT NULL` (no exclusion) is true for every row, so only the slug decides.
  while (await exists(db, 'SELECT 1 FROM categories WHERE slug=? AND id IS NOT ?', [slug, excludeId])) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

export async function createCategory(
  db: Db,
  name: string,
  color: string | null = null,
  printLimit = 2,
): Promise<Category> {
  if (await exists(db, 'SELECT 1 FROM categories WHERE name=?', [name])) {
    throw new Conflict(`category '${name}' already exists`);
  }
  const r = await db.run(
    'INSERT INTO categories(name, slug, color, print_limit, created_at) VALUES(?,?,?,?,?)',
    [name, await uniqueSlug(db, name), color, printLimit, nowIso()],
  );
  return getCategory(db, r.lastInsertRowId);
}

export interface CategoryFields {
  name?: string | null;
  color?: string | null;
  print_limit?: number | null;
}

export async function updateCategory(db: Db, id: number, f: CategoryFields): Promise<Category> {
  await getCategory(db, id);
  const sets: Record<string, SqlValue> = {};
  if (f.name !== undefined && f.name !== null) {
    if (await exists(db, 'SELECT 1 FROM categories WHERE name=? AND id!=?', [f.name, id])) {
      throw new Conflict(`category '${f.name}' already exists`);
    }
    sets.name = f.name;
    sets.slug = await uniqueSlug(db, f.name, id);
  }
  if ('color' in f) sets.color = f.color ?? null;
  if (f.print_limit !== undefined && f.print_limit !== null) sets.print_limit = f.print_limit;
  await applyUpdate(db, 'categories', id, sets);
  return getCategory(db, id);
}

export async function deleteCategory(db: Db, id: number): Promise<void> {
  await getCategory(db, id);
  await db.run('DELETE FROM categories WHERE id=?', [id]); // cascades feeds -> articles
}

export async function applyUpdate(db: Db, table: string, id: number, sets: Record<string, SqlValue>): Promise<void> {
  const keys = Object.keys(sets);
  if (keys.length === 0) return;
  await db.run(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, [
    ...keys.map((k) => sets[k]),
    id,
  ]);
}

// --- feeds --------------------------------------------------------------------

export interface FeedRow {
  id: number;
  url: string;
  title: string | null;
  category_id: number;
  enabled: number;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: string | null;
  last_error: string | null;
  created_at: string;
}

const toFeed = (r: FeedRow & { newest_at?: string | null }): Feed => ({
  id: r.id,
  url: r.url,
  title: r.title,
  category_id: r.category_id,
  enabled: r.enabled !== 0,
  last_fetched_at: r.last_fetched_at,
  last_error: r.last_error,
  newest_at: r.newest_at ?? null,
  stale: isStale(r.newest_at ?? null),
});

const NEWEST = '(SELECT MAX(COALESCE(a.published_at, a.fetched_at)) FROM articles a WHERE a.feed_id=feeds.id) AS newest_at';

export async function listFeeds(db: Db, categoryId?: number | null): Promise<Feed[]> {
  const rows =
    categoryId !== undefined && categoryId !== null
      ? await db.all<FeedRow>(`SELECT feeds.*, ${NEWEST} FROM feeds WHERE category_id=? ORDER BY id`, [categoryId])
      : await db.all<FeedRow>(`SELECT feeds.*, ${NEWEST} FROM feeds ORDER BY id`);
  return rows.map(toFeed);
}

export async function getFeedRow(db: Db, id: number): Promise<FeedRow> {
  const row = await db.get<FeedRow>('SELECT * FROM feeds WHERE id=?', [id]);
  if (!row) throw new NotFound(`feed ${id} not found`);
  return row;
}

export async function getFeed(db: Db, id: number): Promise<Feed> {
  const row = await db.get<FeedRow & { newest_at: string | null }>(`SELECT feeds.*, ${NEWEST} FROM feeds WHERE id=?`, [id]);
  if (!row) throw new NotFound(`feed ${id} not found`);
  return toFeed(row);
}

export async function listFeedRows(db: Db, enabledOnly = true): Promise<FeedRow[]> {
  return db.all<FeedRow>(`SELECT * FROM feeds${enabledOnly ? ' WHERE enabled=1' : ''} ORDER BY id`);
}

export async function createFeed(
  db: Db,
  url: string,
  categoryId: number,
  title: string | null = null,
  enabled = true,
): Promise<Feed> {
  await getCategory(db, categoryId);
  if (await exists(db, 'SELECT 1 FROM feeds WHERE url=?', [url])) {
    throw new Conflict(`feed '${url}' already exists`);
  }
  const r = await db.run('INSERT INTO feeds(url, title, category_id, enabled, created_at) VALUES(?,?,?,?,?)', [
    url,
    title,
    categoryId,
    enabled ? 1 : 0,
    nowIso(),
  ]);
  return getFeed(db, r.lastInsertRowId);
}

export interface FeedFields {
  url?: string | null;
  category_id?: number | null;
  title?: string | null;
  enabled?: boolean | null;
}

export async function updateFeed(db: Db, id: number, f: FeedFields): Promise<Feed> {
  const old = await getFeed(db, id);
  const sets: Record<string, SqlValue> = {};
  if (f.url !== undefined && f.url !== null && f.url !== old.url) {
    if (await exists(db, 'SELECT 1 FROM feeds WHERE url=?', [f.url])) {
      throw new Conflict(`feed '${f.url}' already exists`);
    }
    sets.url = f.url;
    // new URL: conditional-GET validators no longer apply
    sets.etag = null;
    sets.last_modified = null;
  }
  if (f.category_id !== undefined && f.category_id !== null) {
    await getCategory(db, f.category_id);
    sets.category_id = f.category_id;
  }
  if ('title' in f) sets.title = f.title ?? null;
  if (f.enabled !== undefined && f.enabled !== null) sets.enabled = f.enabled ? 1 : 0;
  await applyUpdate(db, 'feeds', id, sets);
  return getFeed(db, id);
}

export async function deleteFeed(db: Db, id: number): Promise<void> {
  await getFeed(db, id);
  await db.run('DELETE FROM feeds WHERE id=?', [id]);
}

/** Record a fetch outcome. On error or 304 (keepValidators) validators are untouched. */
export async function recordFeedFetch(
  db: Db,
  feedId: number,
  o: { etag?: string | null; lastModified?: string | null; error?: string | null; title?: string | null; keepValidators?: boolean } = {},
): Promise<void> {
  if ((o.error ?? null) !== null || o.keepValidators) {
    await db.run('UPDATE feeds SET last_fetched_at=?, last_error=? WHERE id=?', [nowIso(), o.error ?? null, feedId]);
  } else {
    await db.run(
      'UPDATE feeds SET last_fetched_at=?, last_error=NULL, etag=?, last_modified=?, title=COALESCE(title, ?) WHERE id=?',
      [nowIso(), o.etag ?? null, o.lastModified ?? null, o.title ?? null, feedId],
    );
  }
}
