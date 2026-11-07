"""Idempotent seeding of default categories, feeds, schedule and settings."""
from __future__ import annotations

import sqlite3

from tnp import db
from tnp.config import load_config

DEFAULT_CATEGORIES: dict[str, list[str]] = {
    "Products": [
        "https://hnrss.org/launches",
        "https://techcrunch.com/category/startups/feed/",
    ],
    "Engineering": [
        "https://www.infoq.com/feed/",
        "https://blog.cloudflare.com/rss/",
        "https://github.blog/engineering/feed/",
        "https://newsletter.pragmaticengineer.com/feed",
    ],
    "Psychology": [
        "https://www.psypost.org/feed/",
        "https://www.psychologytoday.com/us/front/feed",
    ],
    "Learning": [
        "https://bigthink.com/feed/",
        "https://www.sciencedaily.com/rss/top/science.xml",
        "https://www.quantamagazine.org/feed/",
    ],
}
DEFAULT_SCHEDULE = ("0 8 * * *", "Morning edition")
DEFAULT_SETTINGS = {
    "max_items_total": 8,
    "model": "google/gemma-3-12b-it",
    "fallback_model": "deepseek/deepseek-v4.1-flash",
}
_SEEDED_KEY = "_seeded"


def seed_defaults(conn: sqlite3.Connection) -> bool:
    """Seed defaults once. Returns True if seeding happened (first init only).

    A marker setting prevents re-seeding, so categories/feeds the user deleted stay deleted.
    """
    if db.get_setting(conn, _SEEDED_KEY, False):
        return False
    for name, urls in DEFAULT_CATEGORIES.items():
        row = conn.execute("SELECT id FROM categories WHERE name=?", (name,)).fetchone()
        cat_id = row["id"] if row else db.create_category(conn, name).id
        for url in urls:
            if not conn.execute("SELECT 1 FROM feeds WHERE url=?", (url,)).fetchone():
                db.create_feed(conn, url, cat_id)
    if not db.list_schedules(conn):
        db.create_schedule(conn, *DEFAULT_SCHEDULE)
    # Env (TNP_MODEL / TNP_FALLBACK_MODEL) only provides the initial values; the DB wins after.
    cfg = load_config()
    initial = {**DEFAULT_SETTINGS, "model": cfg.model, "fallback_model": cfg.fallback_model}
    for k, v in initial.items():
        if db.get_setting(conn, k) is None:
            db.set_setting(conn, k, v)
    db.set_setting(conn, _SEEDED_KEY, True)
    return True
