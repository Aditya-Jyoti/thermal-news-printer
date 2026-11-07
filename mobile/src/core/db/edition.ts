import type { EditionItem } from '../../api/types';
import type { Db } from './adapter';
import { getSetting, setSetting } from './settings';
import { nowIso } from './time';

export const EDITION_BUILT_AT = 'edition_built_at';

interface Row {
  position: number;
  article_id: number;
  category_slug: string;
  title: string;
  url: string;
  image_url: string | null;
  published_at: string | null;
  tldr: string | null;
  c_id: number;
  c_name: string;
  c_color: string | null;
  c_limit: number;
  c_feed_count: number;
}

/** The persisted edition joined with article/category data and summaries (tldr null while pending). */
export async function listEditionItems(db: Db): Promise<EditionItem[]> {
  const rows = await db.all<Row>(
    'SELECT e.position, e.article_id, e.category_slug, a.title, a.url, a.image_url, a.published_at, s.tldr, ' +
      'c.id AS c_id, c.name AS c_name, c.color AS c_color, c.print_limit AS c_limit, ' +
      '(SELECT COUNT(*) FROM feeds f2 WHERE f2.category_id=c.id) AS c_feed_count ' +
      'FROM edition_items e JOIN articles a ON a.id=e.article_id ' +
      'JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id ' +
      'LEFT JOIN summaries s ON s.article_id=a.id ORDER BY e.position',
  );
  return rows.map((r, i) => ({
    position: i + 1,
    article_id: r.article_id,
    category_slug: r.category_slug,
    category: { id: r.c_id, name: r.c_name, slug: r.category_slug, color: r.c_color, print_limit: r.c_limit, feed_count: r.c_feed_count },
    title: r.title,
    url: r.url,
    image_url: r.image_url,
    published_at: r.published_at,
    tldr: r.tldr,
  }));
}

/** Atomically replace the edition (positions 1..n) and stamp edition_built_at. */
export async function replaceEdition(db: Db, items: { article_id: number; category_slug: string }[]): Promise<void> {
  let tx = false;
  try {
    await db.exec('BEGIN');
    tx = true;
  } catch {
    // already inside a transaction elsewhere: proceed without one
  }
  try {
    await db.run('DELETE FROM edition_items');
    for (let i = 0; i < items.length; i++) {
      await db.run('INSERT INTO edition_items(position, article_id, category_slug) VALUES(?,?,?)', [
        i + 1,
        items[i].article_id,
        items[i].category_slug,
      ]);
    }
    await setSetting(db, EDITION_BUILT_AT, nowIso());
    if (tx) await db.exec('COMMIT');
  } catch (e) {
    if (tx) await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

export async function clearEdition(db: Db): Promise<void> {
  await db.run('DELETE FROM edition_items');
  await setSetting(db, EDITION_BUILT_AT, null);
}

export async function getEditionBuiltAt(db: Db): Promise<string | null> {
  return getSetting<string | null>(db, EDITION_BUILT_AT, null);
}

/** True when any article was fetched after the edition was built. */
export async function hasArticlesSince(db: Db, iso: string): Promise<boolean> {
  return (await db.get('SELECT 1 FROM articles WHERE fetched_at > ? LIMIT 1', [iso])) !== null;
}
