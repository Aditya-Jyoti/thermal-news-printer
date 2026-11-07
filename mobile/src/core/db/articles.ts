import type { ArticleDetail, ArticleSummary, FeedDiagnostics } from '../../api/types';
import { NotFound } from '../errors';
import type { Db, SqlValue } from './adapter';
import { isStale, nowIso, toIso } from './time';

export async function fingerprintExists(db: Db, fingerprint: string): Promise<boolean> {
  return (await db.get('SELECT 1 FROM articles WHERE fingerprint=?', [fingerprint])) !== null;
}

export interface NewArticle {
  feedId: number;
  guid: string;
  url: string;
  title: string;
  fingerprint: string;
  author?: string | null;
  publishedAt?: Date | string | null;
  contentHtml?: string | null;
  contentText?: string | null;
  imageUrl?: string | null;
  isPolitical?: boolean | null;
}

/** Insert an article; returns its id, or null if it was a duplicate (fingerprint or feed+guid). */
export async function insertArticle(db: Db, a: NewArticle): Promise<number | null> {
  const r = await db.run(
    'INSERT OR IGNORE INTO articles(feed_id, guid, url, title, author, published_at, fetched_at, ' +
      'content_html, content_text, image_url, fingerprint, is_political) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      a.feedId,
      a.guid,
      a.url,
      a.title,
      a.author ?? null,
      toIso(a.publishedAt),
      nowIso(),
      a.contentHtml ?? null,
      a.contentText ?? null,
      a.imageUrl ?? null,
      a.fingerprint,
      a.isPolitical === undefined || a.isPolitical === null ? null : a.isPolitical ? 1 : 0,
    ],
  );
  return r.changes > 0 ? r.lastInsertRowId : null;
}

const ART_SELECT = `
SELECT a.*, c.id AS c_id, c.name AS c_name, c.slug AS c_slug, c.color AS c_color,
       c.print_limit AS c_limit,
       (SELECT COUNT(*) FROM feeds f2 WHERE f2.category_id=c.id) AS c_feed_count,
       s.tldr AS tldr,
       (SELECT MIN(p.created_at) FROM print_items pi JOIN prints p ON p.id=pi.print_id
         WHERE pi.article_id=a.id AND p.status='printed') AS printed_at
FROM articles a
JOIN feeds f ON f.id=a.feed_id
JOIN categories c ON c.id=f.category_id
LEFT JOIN summaries s ON s.article_id=a.id
`;

interface ArtRow {
  id: number;
  feed_id: number;
  c_id: number;
  c_name: string;
  c_slug: string;
  c_color: string | null;
  c_limit: number;
  c_feed_count: number;
  title: string;
  url: string;
  author: string | null;
  published_at: string | null;
  image_url: string | null;
  tldr: string | null;
  is_political: number | null;
  printed_at: string | null;
  content_html: string | null;
  content_text: string | null;
}

const toSummary = (r: ArtRow): ArticleSummary => ({
  id: r.id,
  feed_id: r.feed_id,
  category: {
    id: r.c_id,
    name: r.c_name,
    slug: r.c_slug,
    color: r.c_color,
    print_limit: r.c_limit,
    feed_count: r.c_feed_count,
  },
  title: r.title,
  url: r.url,
  author: r.author,
  published_at: r.published_at,
  image_url: r.image_url,
  tldr: r.tldr,
  is_political: r.is_political === null ? null : r.is_political !== 0,
  printed_at: r.printed_at,
});

export interface ListArticlesOpts {
  categoryId?: number | null;
  limit?: number;
  offset?: number;
  includePolitical?: boolean;
}

export async function listArticles(
  db: Db,
  { categoryId = null, limit = 50, offset = 0, includePolitical = false }: ListArticlesOpts = {},
): Promise<{ items: ArticleSummary[]; total: number }> {
  const where: string[] = [];
  const args: SqlValue[] = [];
  if (categoryId !== null) {
    where.push('c.id=?');
    args.push(categoryId);
  }
  if (!includePolitical) where.push('(a.is_political IS NULL OR a.is_political=0)');
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const totalRow = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM articles a JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id' + w,
    args,
  );
  const rows = await db.all<ArtRow>(
    ART_SELECT + w + ' ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC LIMIT ? OFFSET ?',
    [...args, limit, offset],
  );
  return { items: rows.map(toSummary), total: totalRow?.n ?? 0 };
}

export async function getArticleDetail(db: Db, id: number): Promise<ArticleDetail> {
  const r = await db.get<ArtRow>(ART_SELECT + ' WHERE a.id=?', [id]);
  if (!r) throw new NotFound(`article ${id} not found`);
  return { ...toSummary(r), content_html: r.content_html, content_text: r.content_text };
}

export async function upsertSummary(db: Db, articleId: number, tldr: string, model: string): Promise<void> {
  await db.run(
    'INSERT INTO summaries(article_id, tldr, model, created_at) VALUES(?,?,?,?) ' +
      'ON CONFLICT(article_id) DO UPDATE SET tldr=excluded.tldr, model=excluded.model, created_at=excluded.created_at',
    [articleId, tldr, model, nowIso()],
  );
}

export async function setPolitical(db: Db, articleId: number, isPolitical: boolean): Promise<void> {
  await db.run('UPDATE articles SET is_political=? WHERE id=?', [isPolitical ? 1 : 0, articleId]);
}

/** Replace an article's body (full-text enrichment); keeps the old HTML if none is given. */
export async function updateArticleContent(
  db: Db,
  articleId: number,
  contentText: string,
  contentHtml: string | null = null,
): Promise<void> {
  await db.run('UPDATE articles SET content_text=?, content_html=COALESCE(?, content_html) WHERE id=?', [
    contentText,
    contentHtml,
    articleId,
  ]);
}

export interface CandidateRow {
  id: number;
  feed_id: number;
  title: string;
  category_slug: string;
  content_text: string | null;
  published_at: string | null;
  fetched_at: string;
}

/** Articles never printed (failed prints do not count) and never shown in an archived edition. */
const NOT_CONSUMED =
  'a.id NOT IN (SELECT pi.article_id FROM print_items pi JOIN prints p ON p.id=pi.print_id ' +
  "WHERE pi.article_id IS NOT NULL AND p.status != 'failed') " +
  'AND a.id NOT IN (SELECT ai.article_id FROM edition_archive_items ai WHERE ai.article_id IS NOT NULL)';

/**
 * Curation candidates: recent (<= maxAgeDays), never-printed, not-political articles, newest first.
 * Failed prints do not block. Categories with print_limit 0 are skipped.
 */
export async function listCurationCandidates(
  db: Db,
  { limit = 1000, maxAgeDays = 14, now = new Date() }: { limit?: number; maxAgeDays?: number | null; now?: Date } = {},
): Promise<CandidateRow[]> {
  // maxAgeDays null = no recency limit.
  const cutoff = maxAgeDays === null ? '0000-01-01T00:00:00.000Z' : toIso(new Date(now.getTime() - maxAgeDays * 86_400_000));
  return db.all<CandidateRow>(
    'SELECT a.id, a.feed_id, a.title, c.slug AS category_slug, a.content_text, a.published_at, a.fetched_at ' +
      'FROM articles a JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id ' +
      'WHERE (a.is_political IS NULL OR a.is_political=0) AND c.print_limit > 0 AND f.enabled=1 ' +
      'AND COALESCE(a.published_at, a.fetched_at) >= ? ' +
      `AND ${NOT_CONSUMED} ` +
      'ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC LIMIT ?',
    [cutoff, limit],
  );
}

/** Batch-set the political flag for many articles (one statement per chunk). */
export async function setPoliticalMany(db: Db, ids: number[], isPolitical: boolean): Promise<void> {
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await db.run(
      `UPDATE articles SET is_political=? WHERE id IN (${chunk.map(() => '?').join(',')})`,
      [isPolitical ? 1 : 0, ...chunk],
    );
  }
}

export interface DigestCandidateRow {
  article_id: number;
  title: string;
  category_slug: string;
  tldr: string;
  published_at: string | null;
}

/** Summarized, non-political, never-printed articles (newest first). Failed prints do not block. */
export async function listDigestCandidates(db: Db): Promise<DigestCandidateRow[]> {
  return db.all<DigestCandidateRow>(
    'SELECT a.id AS article_id, a.title, c.slug AS category_slug, s.tldr, a.published_at ' +
      'FROM articles a JOIN summaries s ON s.article_id=a.id ' +
      'JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id ' +
      `WHERE a.is_political=0 AND ${NOT_CONSUMED} ` +
      'ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC',
  );
}

/** Articles in a printed or in-flight (pending) print, or in an archived edition; failed prints do not count. */
export async function getPrintedArticleIds(db: Db): Promise<Set<number>> {
  const rows = await db.all<{ article_id: number }>(
    'SELECT pi.article_id AS article_id FROM print_items pi JOIN prints p ON p.id=pi.print_id ' +
      "WHERE pi.article_id IS NOT NULL AND p.status != 'failed' " +
      'UNION SELECT article_id FROM edition_archive_items WHERE article_id IS NOT NULL',
  );
  return new Set(rows.map((r) => r.article_id));
}

/** Mark an article read (read_at = now) or unread (null). Unknown ids are ignored. */
export async function setArticleRead(db: Db, articleId: number, read: boolean): Promise<void> {
  await db.run('UPDATE articles SET read_at=? WHERE id=?', [read ? nowIso() : null, articleId]);
}

export interface PipelineCounts {
  articles: number;
  candidates: number;
}

/** Totals for the Diagnostics section. */
export async function countArticles(db: Db, { maxAgeDays = 14, now = new Date() }: { maxAgeDays?: number; now?: Date } = {}): Promise<PipelineCounts> {
  const cutoff = toIso(new Date(now.getTime() - maxAgeDays * 86_400_000));
  const a = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM articles');
  const c = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM articles a JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id ' +
      'WHERE (a.is_political IS NULL OR a.is_political=0) AND c.print_limit > 0 AND f.enabled=1 ' +
      `AND COALESCE(a.published_at, a.fetched_at) >= ? AND ${NOT_CONSUMED}`,
    [cutoff],
  );
  return { articles: a?.n ?? 0, candidates: c?.n ?? 0 };
}

export interface CategoryCounts {
  slug: string;
  /** all stored articles of enabled feeds. */
  fetched: number;
  /** unseen, non-political articles inside the window. */
  eligible: number;
}

/** Per-category totals for Diagnostics (window null = no recency limit). */
export async function countByCategory(
  db: Db,
  { maxAgeDays = 14, now = new Date() }: { maxAgeDays?: number | null; now?: Date } = {},
): Promise<CategoryCounts[]> {
  const cutoff = maxAgeDays === null ? '0000-01-01T00:00:00.000Z' : toIso(new Date(now.getTime() - maxAgeDays * 86_400_000));
  return db.all<CategoryCounts>(
    'SELECT c.slug AS slug, COUNT(a.id) AS fetched, ' +
      'COALESCE(SUM(CASE WHEN (a.is_political IS NULL OR a.is_political=0) AND COALESCE(a.published_at, a.fetched_at) >= ? ' +
      `AND ${NOT_CONSUMED} THEN 1 ELSE 0 END), 0) AS eligible ` +
      'FROM categories c LEFT JOIN feeds f ON f.category_id=c.id AND f.enabled=1 LEFT JOIN articles a ON a.feed_id=f.id ' +
      'GROUP BY c.id ORDER BY c.id',
    [cutoff],
  );
}

/** Per-feed fetch state and story counts (total, and inside the age window) for Diagnostics. */
export async function feedDiagnostics(
  db: Db,
  { maxAgeDays = 3, now = new Date() }: { maxAgeDays?: number; now?: Date } = {},
): Promise<FeedDiagnostics[]> {
  const cutoff = toIso(new Date(now.getTime() - maxAgeDays * 86_400_000));
  const rows = await db.all<{
    id: number; url: string; title: string | null; slug: string; enabled: number;
    last_fetched_at: string | null; last_error: string | null; total: number; fresh: number; newest: string | null;
  }>(
    'SELECT f.id, f.url, f.title, c.slug, f.enabled, f.last_fetched_at, f.last_error, ' +
      'COUNT(a.id) AS total, ' +
      'COALESCE(SUM(CASE WHEN COALESCE(a.published_at, a.fetched_at) >= ? THEN 1 ELSE 0 END), 0) AS fresh, ' +
      'MAX(COALESCE(a.published_at, a.fetched_at)) AS newest ' +
      'FROM feeds f JOIN categories c ON c.id=f.category_id LEFT JOIN articles a ON a.feed_id=f.id ' +
      'GROUP BY f.id ORDER BY c.id, f.id',
    [cutoff],
  );
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    category_slug: r.slug,
    enabled: r.enabled !== 0,
    last_fetched_at: r.last_fetched_at,
    last_error: r.last_error,
    total_items: r.total,
    fresh_items: r.fresh,
    newest_at: r.newest,
    stale: isStale(r.newest, now),
  }));
}
