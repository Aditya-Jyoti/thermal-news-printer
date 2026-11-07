"""Idempotent seeding of default categories, feeds, schedule and settings."""
from __future__ import annotations

import sqlite3

from tnp import db

DEFAULT_CATEGORIES: dict[str, list[str]] = {
    "Products": [
        "https://hnrss.org/launches",
        "https://techcrunch.com/startups/feed/",
    ],
    "Engineering": ["https://blog.pragmaticengineer.com/rss/"],
    "Psychology": ["http://freakonomics.blogs.nytimes.com/feed/"],
    "Learning": ["https://feeds.feedburner.com/bigthink/main"],
}
DEFAULT_SCHEDULE = ("0 8 * * *", "Morning edition")
DEFAULT_SETTINGS = {"max_items_total": 8, "model": "google/gemma-2-9b-it"}
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
    for k, v in DEFAULT_SETTINGS.items():
        if db.get_setting(conn, k) is None:
            db.set_setting(conn, k, v)
    db.set_setting(conn, _SEEDED_KEY, True)
    return True
