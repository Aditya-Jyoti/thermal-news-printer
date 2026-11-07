import type { ArticleDetail, ArticleSummary } from '../../api/types';
import { NotFound } from '../errors';
import type { Db, SqlValue } from './adapter';
import { nowIso, toIso } from './time';

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

export interface PendingRow {
  id: number;
  title: string;
  url: string;
  content_text: string | null;
  category_slug: string;
  published_at: string | null;
  fetched_at: string;
  is_political: number | null;
}

/** Non-political articles without a summary, newest first. */
export async function listArticlesNeedingSummary(db: Db, limit = 50): Promise<PendingRow[]> {
  return db.all<PendingRow>(
    'SELECT a.*, c.slug AS category_slug FROM articles a ' +
      'JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id ' +
      'LEFT JOIN summaries s ON s.article_id=a.id ' +
      'WHERE s.article_id IS NULL AND (a.is_political IS NULL OR a.is_political=0) ' +
      'ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC LIMIT ?',
    [limit],
  );
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
      'WHERE a.is_political=0 AND a.id NOT IN ' +
      '(SELECT pi.article_id FROM print_items pi JOIN prints p ON p.id=pi.print_id ' +
      "WHERE pi.article_id IS NOT NULL AND p.status != 'failed') " +
      'ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC',
  );
}

/** Articles in a printed or in-flight (pending) print; failed prints do not count. */
export async function getPrintedArticleIds(db: Db): Promise<Set<number>> {
  const rows = await db.all<{ article_id: number }>(
    'SELECT DISTINCT pi.article_id AS article_id FROM print_items pi JOIN prints p ON p.id=pi.print_id ' +
      "WHERE pi.article_id IS NOT NULL AND p.status != 'failed'",
  );
  return new Set(rows.map((r) => r.article_id));
}
