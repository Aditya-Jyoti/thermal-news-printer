import type { Db } from './adapter';

/** Migration v1: schema identical to docs/ARCHITECTURE.md. */
const V1 = `
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, slug TEXT UNIQUE NOT NULL,
  color TEXT NULL, print_limit INTEGER NOT NULL DEFAULT 2, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feeds(
  id INTEGER PRIMARY KEY, url TEXT UNIQUE NOT NULL, title TEXT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1, etag TEXT NULL, last_modified TEXT NULL,
  last_fetched_at TEXT NULL, last_error TEXT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS articles(
  id INTEGER PRIMARY KEY,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, author TEXT NULL,
  published_at TEXT NULL, fetched_at TEXT NOT NULL,
  content_html TEXT NULL, content_text TEXT NULL, image_url TEXT NULL,
  fingerprint TEXT UNIQUE NOT NULL, is_political INTEGER NULL,
  UNIQUE(feed_id, guid));
CREATE TABLE IF NOT EXISTS summaries(
  article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  tldr TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prints(
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, trigger TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT NULL);
CREATE TABLE IF NOT EXISTS print_items(
  print_id INTEGER REFERENCES prints(id) ON DELETE CASCADE,
  article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  position INTEGER NOT NULL, category_slug TEXT NOT NULL, tldr TEXT NOT NULL,
  PRIMARY KEY(print_id, position));
CREATE TABLE IF NOT EXISTS schedules(
  id INTEGER PRIMARY KEY, cron TEXT NOT NULL, label TEXT NULL,
  enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles(feed_id);
CREATE INDEX IF NOT EXISTS idx_print_items_article ON print_items(article_id);
`;

/** Migration v2: persisted upcoming edition + indexes for the hot queries. */
const V2 = `
CREATE TABLE IF NOT EXISTS edition_items(
  position INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  category_slug TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
CREATE INDEX IF NOT EXISTS idx_articles_fetched ON articles(fetched_at);
CREATE INDEX IF NOT EXISTS idx_feeds_category ON feeds(category_id);
CREATE INDEX IF NOT EXISTS idx_print_items_print ON print_items(print_id);
`;

/**
 * Migration v3: read/unread + archived editions (History).
 * `editions` only holds archived editions: the live one stays in edition_items. An edition is archived either
 * by "Fetch new news" (print_id NULL = not printed) or by a successful print (print_id set). Archived articles
 * are excluded from future editions. Existing printed prints are back-filled (edition id = print id).
 */
const V3 = `
ALTER TABLE articles ADD COLUMN read_at TEXT NULL;
CREATE TABLE IF NOT EXISTS editions(
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, archived_at TEXT NULL,
  print_id INTEGER NULL REFERENCES prints(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS edition_archive_items(
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  article_id INTEGER NULL REFERENCES articles(id) ON DELETE SET NULL,
  category_slug TEXT NOT NULL, tldr TEXT NULL,
  PRIMARY KEY(edition_id, position));
CREATE INDEX IF NOT EXISTS idx_archive_items_article ON edition_archive_items(article_id);
CREATE INDEX IF NOT EXISTS idx_editions_archived ON editions(archived_at);
INSERT INTO editions(id, created_at, archived_at, print_id)
  SELECT id, created_at, created_at, id FROM prints WHERE status='printed';
INSERT INTO edition_archive_items(edition_id, position, article_id, category_slug, tldr)
  SELECT pi.print_id, pi.position, pi.article_id, pi.category_slug, pi.tldr
  FROM print_items pi JOIN prints p ON p.id=pi.print_id WHERE p.status='printed';
`;

/** Append new migrations; index + 1 is the resulting PRAGMA user_version. */
export const MIGRATIONS: string[] = [V1, V2, V3];

export async function migrate(db: Db): Promise<void> {
  await db.exec('PRAGMA foreign_keys=ON');
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    await db.exec(MIGRATIONS[v]);
    await db.exec(`PRAGMA user_version=${v + 1}`);
  }
}
