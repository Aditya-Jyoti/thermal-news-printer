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

/** Append new migrations; index + 1 is the resulting PRAGMA user_version. */
export const MIGRATIONS: string[] = [V1, V2];

export async function migrate(db: Db): Promise<void> {
  await db.exec('PRAGMA foreign_keys=ON');
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    await db.exec(MIGRATIONS[v]);
    await db.exec(`PRAGMA user_version=${v + 1}`);
  }
}
