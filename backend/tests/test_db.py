from tnp import db
from tnp.models import DigestItem
from tnp.seed import seed_defaults


def test_seed_idempotent_and_defaults(conn):
    assert [c.slug for c in db.list_categories(conn)] == [
        "products", "engineering", "psychology", "learning"]
    assert len(db.list_feeds(conn)) == 5
    assert db.list_schedules(conn)[0].cron == "0 8 * * *"
    assert db.get_settings(conn).max_items_total == 8
    assert seed_defaults(conn) is False
    assert len(db.list_feeds(conn)) == 5


def test_category_slug_and_cascade(conn):
    c = db.create_category(conn, "Science & Space!")
    assert c.slug == "science-space"
    f = db.create_feed(conn, "https://x.test/rss", c.id)
    db.delete_category(conn, c.id)
    assert not [x for x in db.list_feeds(conn) if x.id == f.id]


def _article(conn, n, political=None):
    feed = db.list_feeds(conn)[0]
    return db.insert_article(conn, feed_id=feed.id, guid=f"g{n}", url=f"https://a.test/{n}",
                             title=f"T{n}", fingerprint=f"fp{n}", is_political=political)


def test_dedup_insert_and_digest_flow(conn):
    a1, a2 = _article(conn, 1, False), _article(conn, 2, False)
    assert _article(conn, 1) is None
    _article(conn, 3, True)
    assert [r["id"] for r in db.list_articles_needing_summary(conn)] == [a2, a1]
    db.upsert_summary(conn, a1, "tldr1", "m")
    db.upsert_summary(conn, a1, "tldr1b", "m")
    db.upsert_summary(conn, a2, "tldr2", "m")
    assert len(db.list_digest_candidates(conn)) == 2
    pid = db.create_print(conn, "manual", [DigestItem(
        article_id=a1, position=0, category_slug="products", tldr="tldr1b")])
    assert a1 in db.get_printed_article_ids(conn)
    assert [r["article_id"] for r in db.list_digest_candidates(conn)] == [a2]
    assert db.get_article_detail(conn, a1).printed_at is None  # still pending
    db.set_print_status(conn, pid, "printed")
    assert db.get_article_detail(conn, a1).printed_at is not None
    assert db.get_last_print_items(conn)[0].article_id == a1
    items, total = db.list_articles(conn)
    assert total == 2 and len(items) == 2  # political hidden
    assert db.list_articles(conn, include_political=True)[1] == 3
