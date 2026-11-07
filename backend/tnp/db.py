"""SQLite schema and repository functions (stdlib sqlite3)."""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from tnp.models import (
    ArticleDetail,
    ArticleSummary,
    Category,
    DigestItem,
    Feed,
    PrintItem,
    PrintRecord,
    Schedule,
    Settings,
)

SCHEMA = """
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
"""


class NotFound(LookupError):
    pass


class Conflict(ValueError):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: str | Path) -> sqlite3.Connection:
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "category"


def _dt(v: str | None) -> datetime | None:
    return datetime.fromisoformat(v) if v else None


def _iso(v: datetime | str | None) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        return v
    if v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v.astimezone(timezone.utc).isoformat(timespec="seconds")


def _set_clause(sets: dict[str, Any]) -> str:
    return ", ".join(f"{k}=?" for k in sets)


# --- categories ---------------------------------------------------------------

_CAT_SELECT = (
    "SELECT c.*, (SELECT COUNT(*) FROM feeds f WHERE f.category_id=c.id) AS feed_count "
    "FROM categories c"
)


def _category(row: sqlite3.Row) -> Category:
    return Category(
        id=row["id"], name=row["name"], slug=row["slug"], color=row["color"],
        print_limit=row["print_limit"], feed_count=row["feed_count"],
    )


def list_categories(conn: sqlite3.Connection) -> list[Category]:
    return [_category(r) for r in conn.execute(_CAT_SELECT + " ORDER BY c.id")]


def get_category(conn: sqlite3.Connection, category_id: int) -> Category:
    row = conn.execute(_CAT_SELECT + " WHERE c.id=?", (category_id,)).fetchone()
    if row is None:
        raise NotFound(f"category {category_id} not found")
    return _category(row)


def get_category_by_slug(conn: sqlite3.Connection, slug: str) -> Category | None:
    row = conn.execute(_CAT_SELECT + " WHERE c.slug=?", (slug,)).fetchone()
    return _category(row) if row else None


def _unique_slug(conn: sqlite3.Connection, name: str, exclude_id: int | None = None) -> str:
    base = slugify(name)
    slug, n = base, 2
    while conn.execute(
        "SELECT 1 FROM categories WHERE slug=? AND id IS NOT ?", (slug, exclude_id)
    ).fetchone():
        slug = f"{base}-{n}"
        n += 1
    return slug


def create_category(
    conn: sqlite3.Connection, name: str, color: str | None = None, print_limit: int = 2
) -> Category:
    if conn.execute("SELECT 1 FROM categories WHERE name=?", (name,)).fetchone():
        raise Conflict(f"category '{name}' already exists")
    cur = conn.execute(
        "INSERT INTO categories(name, slug, color, print_limit, created_at) VALUES(?,?,?,?,?)",
        (name, _unique_slug(conn, name), color, print_limit, now_iso()),
    )
    conn.commit()
    return get_category(conn, cur.lastrowid)


def update_category(conn: sqlite3.Connection, category_id: int, **fields: Any) -> Category:
    get_category(conn, category_id)
    sets: dict[str, Any] = {}
    if fields.get("name") is not None:
        name = fields["name"]
        if conn.execute(
            "SELECT 1 FROM categories WHERE name=? AND id!=?", (name, category_id)
        ).fetchone():
            raise Conflict(f"category '{name}' already exists")
        sets["name"] = name
        sets["slug"] = _unique_slug(conn, name, category_id)
    if "color" in fields:
        sets["color"] = fields["color"]
    if fields.get("print_limit") is not None:
        sets["print_limit"] = fields["print_limit"]
    if sets:
        conn.execute(
            f"UPDATE categories SET {_set_clause(sets)} WHERE id=?", (*sets.values(), category_id)
        )
        conn.commit()
    return get_category(conn, category_id)


def delete_category(conn: sqlite3.Connection, category_id: int) -> None:
    get_category(conn, category_id)
    conn.execute("DELETE FROM categories WHERE id=?", (category_id,))
    conn.commit()


# --- feeds --------------------------------------------------------------------

def _feed(row: sqlite3.Row) -> Feed:
    return Feed(
        id=row["id"], url=row["url"], title=row["title"], category_id=row["category_id"],
        enabled=bool(row["enabled"]), last_fetched_at=_dt(row["last_fetched_at"]),
        last_error=row["last_error"],
    )


def list_feeds(conn: sqlite3.Connection, category_id: int | None = None) -> list[Feed]:
    sql, args = "SELECT * FROM feeds", ()
    if category_id is not None:
        sql, args = sql + " WHERE category_id=?", (category_id,)
    return [_feed(r) for r in conn.execute(sql + " ORDER BY id", args)]


def get_feed_row(conn: sqlite3.Connection, feed_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM feeds WHERE id=?", (feed_id,)).fetchone()
    if row is None:
        raise NotFound(f"feed {feed_id} not found")
    return row


def get_feed(conn: sqlite3.Connection, feed_id: int) -> Feed:
    return _feed(get_feed_row(conn, feed_id))


def list_feed_rows(conn: sqlite3.Connection, enabled_only: bool = True) -> list[sqlite3.Row]:
    sql = "SELECT * FROM feeds" + (" WHERE enabled=1" if enabled_only else "") + " ORDER BY id"
    return list(conn.execute(sql))


def create_feed(
    conn: sqlite3.Connection, url: str, category_id: int, title: str | None = None,
    enabled: bool = True,
) -> Feed:
    get_category(conn, category_id)
    if conn.execute("SELECT 1 FROM feeds WHERE url=?", (url,)).fetchone():
        raise Conflict(f"feed '{url}' already exists")
    cur = conn.execute(
        "INSERT INTO feeds(url, title, category_id, enabled, created_at) VALUES(?,?,?,?,?)",
        (url, title, category_id, int(enabled), now_iso()),
    )
    conn.commit()
    return get_feed(conn, cur.lastrowid)


def update_feed(conn: sqlite3.Connection, feed_id: int, **fields: Any) -> Feed:
    old = get_feed(conn, feed_id)
    sets: dict[str, Any] = {}
    if fields.get("url") is not None and fields["url"] != old.url:
        if conn.execute("SELECT 1 FROM feeds WHERE url=?", (fields["url"],)).fetchone():
            raise Conflict(f"feed '{fields['url']}' already exists")
        sets["url"] = fields["url"]
        # new URL: conditional-GET validators no longer apply
        sets["etag"] = None
        sets["last_modified"] = None
    if fields.get("category_id") is not None:
        get_category(conn, fields["category_id"])
        sets["category_id"] = fields["category_id"]
    if "title" in fields:
        sets["title"] = fields["title"]
    if fields.get("enabled") is not None:
        sets["enabled"] = int(fields["enabled"])
    if sets:
        conn.execute(
            f"UPDATE feeds SET {_set_clause(sets)} WHERE id=?", (*sets.values(), feed_id)
        )
        conn.commit()
    return get_feed(conn, feed_id)


def delete_feed(conn: sqlite3.Connection, feed_id: int) -> None:
    get_feed(conn, feed_id)
    conn.execute("DELETE FROM feeds WHERE id=?", (feed_id,))
    conn.commit()


def record_feed_fetch(
    conn: sqlite3.Connection, feed_id: int, *, etag: str | None = None,
    last_modified: str | None = None, error: str | None = None, title: str | None = None,
    keep_validators: bool = False,
) -> None:
    """Record a fetch outcome. On error or 304 (keep_validators) validators are untouched."""
    if error is not None or keep_validators:
        conn.execute(
            "UPDATE feeds SET last_fetched_at=?, last_error=? WHERE id=?",
            (now_iso(), error, feed_id),
        )
    else:
        conn.execute(
            "UPDATE feeds SET last_fetched_at=?, last_error=NULL, etag=?, last_modified=?, "
            "title=COALESCE(title, ?) WHERE id=?",
            (now_iso(), etag, last_modified, title, feed_id),
        )
    conn.commit()


# --- articles -----------------------------------------------------------------

def fingerprint_exists(conn: sqlite3.Connection, fingerprint: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM articles WHERE fingerprint=?", (fingerprint,)
    ).fetchone() is not None


def insert_article(
    conn: sqlite3.Connection, *, feed_id: int, guid: str, url: str, title: str,
    fingerprint: str, author: str | None = None, published_at: datetime | str | None = None,
    content_html: str | None = None, content_text: str | None = None,
    image_url: str | None = None, is_political: bool | None = None,
) -> int | None:
    """Insert an article; returns its id, or None if it was a duplicate."""
    cur = conn.execute(
        "INSERT OR IGNORE INTO articles(feed_id, guid, url, title, author, published_at, "
        "fetched_at, content_html, content_text, image_url, fingerprint, is_political) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (feed_id, guid, url, title, author, _iso(published_at), now_iso(), content_html,
         content_text, image_url, fingerprint,
         None if is_political is None else int(is_political)),
    )
    conn.commit()
    return cur.lastrowid if cur.rowcount else None


_ART_SELECT = """
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
"""


def _article_kwargs(r: sqlite3.Row) -> dict[str, Any]:
    return dict(
        id=r["id"], feed_id=r["feed_id"],
        category=Category(
            id=r["c_id"], name=r["c_name"], slug=r["c_slug"], color=r["c_color"],
            print_limit=r["c_limit"], feed_count=r["c_feed_count"],
        ),
        title=r["title"], url=r["url"], author=r["author"],
        published_at=_dt(r["published_at"]), image_url=r["image_url"], tldr=r["tldr"],
        is_political=None if r["is_political"] is None else bool(r["is_political"]),
        printed_at=_dt(r["printed_at"]),
    )


def list_articles(
    conn: sqlite3.Connection, category_id: int | None = None, limit: int = 50,
    offset: int = 0, include_political: bool = False,
) -> tuple[list[ArticleSummary], int]:
    where: list[str] = []
    args: list[Any] = []
    if category_id is not None:
        where.append("c.id=?")
        args.append(category_id)
    if not include_political:
        where.append("(a.is_political IS NULL OR a.is_political=0)")
    w = (" WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute(
        "SELECT COUNT(*) FROM articles a JOIN feeds f ON f.id=a.feed_id "
        "JOIN categories c ON c.id=f.category_id" + w, args
    ).fetchone()[0]
    rows = conn.execute(
        _ART_SELECT + w + " ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC "
        "LIMIT ? OFFSET ?", (*args, limit, offset),
    ).fetchall()
    return [ArticleSummary(**_article_kwargs(r)) for r in rows], total


def get_article_detail(conn: sqlite3.Connection, article_id: int) -> ArticleDetail:
    r = conn.execute(_ART_SELECT + " WHERE a.id=?", (article_id,)).fetchone()
    if r is None:
        raise NotFound(f"article {article_id} not found")
    return ArticleDetail(
        **_article_kwargs(r), content_html=r["content_html"], content_text=r["content_text"]
    )


def upsert_summary(conn: sqlite3.Connection, article_id: int, tldr: str, model: str) -> None:
    conn.execute(
        "INSERT INTO summaries(article_id, tldr, model, created_at) VALUES(?,?,?,?) "
        "ON CONFLICT(article_id) DO UPDATE SET tldr=excluded.tldr, model=excluded.model, "
        "created_at=excluded.created_at",
        (article_id, tldr, model, now_iso()),
    )
    conn.commit()


def set_political(conn: sqlite3.Connection, article_id: int, is_political: bool) -> None:
    conn.execute("UPDATE articles SET is_political=? WHERE id=?", (int(is_political), article_id))
    conn.commit()


def update_article_content(
    conn: sqlite3.Connection, article_id: int, content_text: str, content_html: str | None = None
) -> None:
    """Replace an article's body (full-text enrichment); keeps the old HTML if none is given."""
    conn.execute(
        "UPDATE articles SET content_text=?, content_html=COALESCE(?, content_html) WHERE id=?",
        (content_text, content_html, article_id),
    )
    conn.commit()


def list_articles_needing_summary(conn: sqlite3.Connection, limit: int = 50) -> list[sqlite3.Row]:
    """Non-political articles without a summary; rows are articles.* plus category_slug."""
    return list(conn.execute(
        "SELECT a.*, c.slug AS category_slug FROM articles a "
        "JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id "
        "LEFT JOIN summaries s ON s.article_id=a.id "
        "WHERE s.article_id IS NULL AND (a.is_political IS NULL OR a.is_political=0) "
        "ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC LIMIT ?", (limit,)))


def list_digest_candidates(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Summarized, non-political, never-printed articles (newest first).

    Rows: article_id, title, category_slug, tldr, published_at.
    """
    return list(conn.execute(
        "SELECT a.id AS article_id, a.title, c.slug AS category_slug, s.tldr, a.published_at "
        "FROM articles a JOIN summaries s ON s.article_id=a.id "
        "JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id "
        "WHERE a.is_political=0 AND a.id NOT IN "
        "(SELECT pi.article_id FROM print_items pi JOIN prints p ON p.id=pi.print_id "
        "WHERE pi.article_id IS NOT NULL AND p.status != 'failed') "
        "ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC"))


def get_printed_article_ids(conn: sqlite3.Connection) -> set[int]:
    """Articles in a printed or in-flight (pending) print; failed prints do not count."""
    return {r[0] for r in conn.execute(
        "SELECT DISTINCT pi.article_id FROM print_items pi JOIN prints p ON p.id=pi.print_id "
        "WHERE pi.article_id IS NOT NULL AND p.status != 'failed'")}


# --- prints -------------------------------------------------------------------

def create_print(conn: sqlite3.Connection, trigger: str, items: Iterable[DigestItem]) -> int:
    """Create a 'pending' print with its items; returns the print id."""
    cur = conn.execute(
        "INSERT INTO prints(created_at, trigger, status) VALUES(?,?,'pending')",
        (now_iso(), trigger),
    )
    pid = cur.lastrowid
    conn.executemany(
        "INSERT INTO print_items(print_id, article_id, position, category_slug, tldr) "
        "VALUES(?,?,?,?,?)",
        [(pid, i.article_id, i.position, i.category_slug, i.tldr) for i in items],
    )
    conn.commit()
    return pid


def set_print_status(
    conn: sqlite3.Connection, print_id: int, status: str, error: str | None = None
) -> None:
    cur = conn.execute("UPDATE prints SET status=?, error=? WHERE id=?", (status, error, print_id))
    if cur.rowcount == 0:
        raise NotFound(f"print {print_id} not found")
    conn.commit()


def _print_items(conn: sqlite3.Connection, print_id: int) -> list[PrintItem]:
    rows = conn.execute(
        "SELECT pi.*, a.title AS title FROM print_items pi "
        "LEFT JOIN articles a ON a.id=pi.article_id WHERE pi.print_id=? ORDER BY pi.position",
        (print_id,),
    )
    return [
        PrintItem(position=r["position"], article_id=r["article_id"],
                  category_slug=r["category_slug"], tldr=r["tldr"], title=r["title"])
        for r in rows
    ]


def _print(conn: sqlite3.Connection, r: sqlite3.Row) -> PrintRecord:
    return PrintRecord(
        id=r["id"], created_at=_dt(r["created_at"]), trigger=r["trigger"],
        status=r["status"], error=r["error"], items=_print_items(conn, r["id"]),
    )


def get_print(conn: sqlite3.Connection, print_id: int) -> PrintRecord:
    r = conn.execute("SELECT * FROM prints WHERE id=?", (print_id,)).fetchone()
    if r is None:
        raise NotFound(f"print {print_id} not found")
    return _print(conn, r)


def list_prints(
    conn: sqlite3.Connection, limit: int = 20, offset: int = 0
) -> tuple[list[PrintRecord], int]:
    total = conn.execute("SELECT COUNT(*) FROM prints").fetchone()[0]
    rows = conn.execute(
        "SELECT * FROM prints ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset)
    ).fetchall()
    return [_print(conn, r) for r in rows], total


def get_last_print_items(conn: sqlite3.Connection) -> list[PrintItem]:
    """Items of the most recent print that actually printed (empty if none)."""
    r = conn.execute(
        "SELECT id FROM prints WHERE status='printed' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return _print_items(conn, r["id"]) if r else []


# --- schedules ----------------------------------------------------------------

def _schedule(r: sqlite3.Row) -> Schedule:
    return Schedule(id=r["id"], cron=r["cron"], label=r["label"], enabled=bool(r["enabled"]))


def list_schedules(conn: sqlite3.Connection) -> list[Schedule]:
    return [_schedule(r) for r in conn.execute("SELECT * FROM schedules ORDER BY id")]


def get_schedule(conn: sqlite3.Connection, schedule_id: int) -> Schedule:
    r = conn.execute("SELECT * FROM schedules WHERE id=?", (schedule_id,)).fetchone()
    if r is None:
        raise NotFound(f"schedule {schedule_id} not found")
    return _schedule(r)


def create_schedule(
    conn: sqlite3.Connection, cron: str, label: str | None = None, enabled: bool = True
) -> Schedule:
    cur = conn.execute(
        "INSERT INTO schedules(cron, label, enabled) VALUES(?,?,?)", (cron, label, int(enabled))
    )
    conn.commit()
    return get_schedule(conn, cur.lastrowid)


def update_schedule(conn: sqlite3.Connection, schedule_id: int, **fields: Any) -> Schedule:
    get_schedule(conn, schedule_id)
    sets: dict[str, Any] = {}
    if fields.get("cron") is not None:
        sets["cron"] = fields["cron"]
    if "label" in fields:
        sets["label"] = fields["label"]
    if fields.get("enabled") is not None:
        sets["enabled"] = int(fields["enabled"])
    if sets:
        conn.execute(
            f"UPDATE schedules SET {_set_clause(sets)} WHERE id=?", (*sets.values(), schedule_id)
        )
        conn.commit()
    return get_schedule(conn, schedule_id)


def delete_schedule(conn: sqlite3.Connection, schedule_id: int) -> None:
    get_schedule(conn, schedule_id)
    conn.execute("DELETE FROM schedules WHERE id=?", (schedule_id,))
    conn.commit()


# --- settings -----------------------------------------------------------------

def get_setting(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
    r = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(r["value"]) if r else default


def set_setting(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value))
    )
    conn.commit()


def get_settings(conn: sqlite3.Connection) -> Settings:
    stored = {r["key"]: json.loads(r["value"]) for r in conn.execute("SELECT * FROM settings")}
    return Settings(**{k: v for k, v in stored.items() if k in Settings.model_fields})


def update_settings(conn: sqlite3.Connection, **fields: Any) -> Settings:
    """Partial update; None values are ignored except printer_address and fallback_model
    (clearable; a null fallback_model disables the fallback)."""
    for k, v in fields.items():
        if k not in Settings.model_fields:
            continue
        if v is None and k not in ("printer_address", "fallback_model"):
            continue
        set_setting(conn, k, v)
    return get_settings(conn)
