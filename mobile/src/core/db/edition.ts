import type { Category, EditionItem, HistoryEdition, HistoryItem } from '../../api/types';
import type { Db } from './adapter';
import { getSetting, setSetting } from './settings';
import { nowIso } from './time';

/** Run `fn` in a transaction, or plain when one is already open elsewhere. */
async function inTx<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  let tx = false;
  try {
    await db.exec('BEGIN');
    tx = true;
  } catch {
    // already inside a transaction elsewhere: proceed without one
  }
  try {
    const r = await fn();
    if (tx) await db.exec('COMMIT');
    return r;
  } catch (e) {
    if (tx) await db.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

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
  read_at: string | null;
  c_id: number;
  c_name: string;
  c_color: string | null;
  c_limit: number;
  c_feed_count: number;
}

/** The persisted edition joined with article/category data and summaries (tldr null while pending). */
export async function listEditionItems(db: Db): Promise<EditionItem[]> {
  const rows = await db.all<Row>(
    'SELECT e.position, e.article_id, e.category_slug, a.title, a.url, a.image_url, a.published_at, a.read_at, s.tldr, ' +
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
    read_at: r.read_at,
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

export interface ArchiveOptions {
  /** Set when the edition was printed: the History entry shows "Printed". */
  printId?: number | null;
  /** Archive only these articles (the printed ones); the rest of the edition is dropped, not archived. */
  onlyArticleIds?: ReadonlySet<number>;
}

/**
 * Move the live edition into History (editions + edition_archive_items) and empty it. Returns the new
 * edition id, or null when there was nothing to archive. Archived articles never come back in a future edition.
 */
export async function archiveEdition(db: Db, o: ArchiveOptions = {}): Promise<number | null> {
  return inTx(db, async () => {
    const rows = await db.all<{ article_id: number; category_slug: string; tldr: string | null }>(
      'SELECT e.article_id, e.category_slug, s.tldr FROM edition_items e LEFT JOIN summaries s ON s.article_id=e.article_id ORDER BY e.position',
    );
    const keep = o.onlyArticleIds ? rows.filter((r) => o.onlyArticleIds!.has(r.article_id)) : rows;
    let id: number | null = null;
    if (keep.length > 0) {
      const now = nowIso();
      const builtAt = await getEditionBuiltAt(db);
      id = (await db.run('INSERT INTO editions(created_at, archived_at, print_id) VALUES(?,?,?)', [builtAt ?? now, now, o.printId ?? null]))
        .lastInsertRowId;
      for (let i = 0; i < keep.length; i++) {
        await db.run(
          'INSERT INTO edition_archive_items(edition_id, position, article_id, category_slug, tldr) VALUES(?,?,?,?,?)',
          [id, i + 1, keep[i].article_id, keep[i].category_slug, keep[i].tldr],
        );
      }
    }
    await clearEdition(db);
    return id;
  });
}

interface HistoryRow {
  edition_id: number;
  created_at: string;
  archived_at: string;
  print_id: number | null;
  position: number;
  article_id: number | null;
  category_slug: string;
  tldr: string | null;
  title: string | null;
  url: string | null;
  image_url: string | null;
  read_at: string | null;
  c_id: number | null;
  c_name: string | null;
  c_color: string | null;
  c_limit: number | null;
  c_feed_count: number | null;
}

/** The newest `limit` archived editions with all their stories, in ONE query (no N+1). */
export async function listHistory(db: Db, limit = 60): Promise<HistoryEdition[]> {
  const rows = await db.all<HistoryRow>(
    'SELECT e.id AS edition_id, e.created_at, e.archived_at, e.print_id, i.position, i.article_id, i.category_slug, i.tldr, ' +
      'a.title, a.url, a.image_url, a.read_at, c.id AS c_id, c.name AS c_name, c.color AS c_color, c.print_limit AS c_limit, ' +
      '(SELECT COUNT(*) FROM feeds f2 WHERE f2.category_id=c.id) AS c_feed_count ' +
      'FROM (SELECT * FROM editions ORDER BY archived_at DESC, id DESC LIMIT ?) e ' +
      'JOIN edition_archive_items i ON i.edition_id=e.id ' +
      'LEFT JOIN articles a ON a.id=i.article_id ' +
      'LEFT JOIN categories c ON c.slug=i.category_slug ' +
      'ORDER BY e.archived_at DESC, e.id DESC, i.position',
    [limit],
  );
  const out: HistoryEdition[] = [];
  const byId = new Map<number, HistoryEdition>();
  for (const r of rows) {
    let ed = byId.get(r.edition_id);
    if (!ed) {
      ed = { id: r.edition_id, created_at: r.created_at, archived_at: r.archived_at, print_id: r.print_id, printed: r.print_id !== null, items: [] };
      byId.set(r.edition_id, ed);
      out.push(ed);
    }
    const category: Category | null =
      r.c_id === null
        ? null
        : { id: r.c_id, name: r.c_name ?? r.category_slug, slug: r.category_slug, color: r.c_color, print_limit: r.c_limit ?? 0, feed_count: r.c_feed_count ?? 0 };
    const item: HistoryItem = {
      position: r.position,
      article_id: r.article_id,
      category_slug: r.category_slug,
      category,
      title: r.title,
      url: r.url,
      image_url: r.image_url,
      tldr: r.tldr,
      read_at: r.read_at,
    };
    ed.items.push(item);
  }
  return out;
}

export async function countEditionSummarized(db: Db): Promise<{ size: number; summarized: number }> {
  const r = await db.get<{ size: number; summarized: number }>(
    'SELECT COUNT(*) AS size, COUNT(s.article_id) AS summarized FROM edition_items e LEFT JOIN summaries s ON s.article_id=e.article_id',
  );
  return { size: r?.size ?? 0, summarized: r?.summarized ?? 0 };
}
