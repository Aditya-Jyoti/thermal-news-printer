"""QA: SQLite schema and repository behaviour against docs/ARCHITECTURE.md."""
from datetime import datetime, timedelta, timezone

import pytest

from tnp import db
from tnp.models import DigestItem


def _art(conn, feed_id, n, *, title=None, political=None, age_days=0, fp=None):
    pub = datetime.now(timezone.utc) - timedelta(days=age_days, minutes=n)
    return db.insert_article(
        conn, feed_id=feed_id, guid=f"guid-{feed_id}-{n}", url=f"https://ex.com/{feed_id}/{n}",
        title=title or f"Story number {n}", fingerprint=fp or f"fp-{feed_id}-{n}",
        published_at=pub, content_text=f"body {n}", is_political=political,
    )


def _feed_id(conn, category_slug):
    return conn.execute(
        "SELECT f.id FROM feeds f JOIN categories c ON c.id=f.category_id WHERE c.slug=? ORDER BY f.id",
        (category_slug,),
    ).fetchone()[0]


# --- categories ---------------------------------------------------------------

def test_category_duplicate_name_conflicts(conn):
    with pytest.raises(db.Conflict):
        db.create_category(conn, "Products")


def test_category_slug_collision_gets_numeric_suffix(conn):
    a = db.create_category(conn, "Deep Tech")
    b = db.create_category(conn, "deep-tech!")
    assert a.slug == "deep-tech"
    assert b.slug == "deep-tech-2"


def test_category_rename_updates_slug_and_keeps_own_name(conn):
    cat = db.get_category_by_slug(conn, "products")
    same = db.update_category(conn, cat.id, name="Products", print_limit=3)
    assert same.slug == "products" and same.print_limit == 3
    renamed = db.update_category(conn, cat.id, name="Launches")
    assert renamed.slug == "launches"
    assert db.get_category_by_slug(conn, "products") is None


def test_category_rename_to_existing_conflicts(conn):
    cat = db.get_category_by_slug(conn, "products")
    with pytest.raises(db.Conflict):
        db.update_category(conn, cat.id, name="Engineering")


def test_category_update_unknown_is_not_found(conn):
    with pytest.raises(db.NotFound):
        db.update_category(conn, 9999, name="x")


def test_category_color_can_be_cleared(conn):
    cat = db.create_category(conn, "Colored", color="#FF0000")
    assert db.update_category(conn, cat.id, color="#00FF00").color == "#00FF00"
    assert db.update_category(conn, cat.id, color=None).color is None


def test_category_delete_cascades_feeds_articles_and_summaries(conn):
    fid = _feed_id(conn, "products")
    aid = _art(conn, fid, 1)
    db.upsert_summary(conn, aid, "tldr", "m")
    cat = db.get_category_by_slug(conn, "products")
    db.delete_category(conn, cat.id)
    assert conn.execute("SELECT COUNT(*) FROM feeds WHERE category_id=?", (cat.id,)).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM articles WHERE id=?", (aid,)).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM summaries WHERE article_id=?", (aid,)).fetchone()[0] == 0
    with pytest.raises(db.NotFound):
        db.delete_category(conn, cat.id)


# --- feeds --------------------------------------------------------------------

def test_feed_duplicate_url_conflicts_and_unknown_category_not_found(conn):
    cat = db.get_category_by_slug(conn, "learning")
    with pytest.raises(db.Conflict):
        db.create_feed(conn, "https://hnrss.org/launches", cat.id)
    with pytest.raises(db.NotFound):
        db.create_feed(conn, "https://new.example/feed", 9999)


def test_feed_url_change_clears_validators_but_same_url_keeps_them(conn):
    fid = _feed_id(conn, "products")
    db.record_feed_fetch(conn, fid, etag='"abc"', last_modified="Mon, 02 Nov 2026 08:00:00 GMT")
    db.update_feed(conn, fid, url=db.get_feed(conn, fid).url)  # same URL
    row = db.get_feed_row(conn, fid)
    assert row["etag"] == '"abc"'
    db.update_feed(conn, fid, url="https://changed.example/rss")
    row = db.get_feed_row(conn, fid)
    assert row["etag"] is None and row["last_modified"] is None


def test_feed_url_change_to_existing_conflicts(conn):
    fid = _feed_id(conn, "products")
    with pytest.raises(db.Conflict):
        db.update_feed(conn, fid, url="https://blog.pragmaticengineer.com/rss/")


def test_feed_enable_toggle_and_title_null_clears(conn):
    fid = _feed_id(conn, "products")
    f = db.update_feed(conn, fid, enabled=False, title="Named")
    assert f.enabled is False and f.title == "Named"
    f = db.update_feed(conn, fid, title=None)
    assert f.title is None and f.enabled is False
    assert fid not in [r["id"] for r in db.list_feed_rows(conn, enabled_only=True)]


def test_record_feed_fetch_error_and_304_keep_validators(conn):
    fid = _feed_id(conn, "products")
    db.record_feed_fetch(conn, fid, etag='"v1"', last_modified="LM1", title="T")
    db.record_feed_fetch(conn, fid, error="boom")
    row = db.get_feed_row(conn, fid)
    assert row["last_error"] == "boom" and row["etag"] == '"v1"' and row["last_modified"] == "LM1"
    db.record_feed_fetch(conn, fid, keep_validators=True)
    row = db.get_feed_row(conn, fid)
    assert row["last_error"] is None and row["etag"] == '"v1"'


def test_record_feed_fetch_title_only_set_when_missing(conn):
    fid = _feed_id(conn, "products")
    db.record_feed_fetch(conn, fid, title="First")
    db.record_feed_fetch(conn, fid, title="Second")
    assert db.get_feed(conn, fid).title == "First"


def test_list_feed_rows_enabled_only(conn):
    fid = _feed_id(conn, "products")
    db.update_feed(conn, fid, enabled=False)
    assert fid in [r["id"] for r in db.list_feed_rows(conn, enabled_only=False)]
    assert fid not in [r["id"] for r in db.list_feed_rows(conn)]


# --- articles -----------------------------------------------------------------

def test_insert_article_duplicate_fingerprint_or_feed_guid_returns_none(conn):
    fid = _feed_id(conn, "products")
    assert _art(conn, fid, 1, fp="same") is not None
    assert _art(conn, fid, 2, fp="same") is None  # fingerprint is globally unique
    first = db.insert_article(conn, feed_id=fid, guid="g", url="u1", title="a", fingerprint="x1")
    dup = db.insert_article(conn, feed_id=fid, guid="g", url="u2", title="b", fingerprint="x2")
    assert first is not None and dup is None


def test_list_articles_hides_political_by_default_and_filters_category(conn):
    p = _feed_id(conn, "products")
    e = _feed_id(conn, "engineering")
    _art(conn, p, 1, political=True)
    _art(conn, p, 2, political=False)
    _art(conn, e, 3)
    items, total = db.list_articles(conn)
    assert total == 2 and all(a.is_political is not True for a in items)
    items, total = db.list_articles(conn, include_political=True)
    assert total == 3
    items, total = db.list_articles(conn, category_id=db.get_category_by_slug(conn, "engineering").id)
    assert total == 1 and items[0].category.slug == "engineering"


def test_list_articles_pagination_and_newest_first(conn):
    fid = _feed_id(conn, "products")
    for n in range(1, 6):
        _art(conn, fid, n, age_days=n)  # n=1 is newest
    items, total = db.list_articles(conn, limit=2, offset=0)
    assert total == 5 and [a.title for a in items] == ["Story number 1", "Story number 2"]
    items, _ = db.list_articles(conn, limit=2, offset=4)
    assert [a.title for a in items] == ["Story number 5"]


def test_article_detail_carries_tldr_and_printed_at(conn):
    fid = _feed_id(conn, "products")
    aid = _art(conn, fid, 1)
    db.upsert_summary(conn, aid, "First tldr.", "m1")
    db.upsert_summary(conn, aid, "Second tldr.", "m2")  # upsert overwrites
    d = db.get_article_detail(conn, aid)
    assert d.tldr == "Second tldr." and d.printed_at is None
    db.create_print(conn, "manual", [DigestItem(article_id=aid, position=1, category_slug="products", tldr="x")])
    pid = conn.execute("SELECT MAX(id) FROM prints").fetchone()[0]
    db.set_print_status(conn, pid, "printed")
    assert db.get_article_detail(conn, aid).printed_at is not None


def test_set_political_and_missing_article(conn):
    fid = _feed_id(conn, "products")
    aid = _art(conn, fid, 1)
    db.set_political(conn, aid, True)
    assert db.get_article_detail(conn, aid).is_political is True
    with pytest.raises(db.NotFound):
        db.get_article_detail(conn, 99999)


def test_deleting_feed_cascades_articles_and_nulls_print_items(conn):
    fid = _feed_id(conn, "products")
    aid = _art(conn, fid, 1)
    db.create_print(conn, "manual", [DigestItem(article_id=aid, position=1, category_slug="products", tldr="kept")])
    db.delete_feed(conn, fid)
    assert conn.execute("SELECT COUNT(*) FROM articles WHERE id=?", (aid,)).fetchone()[0] == 0
    row = conn.execute("SELECT article_id, tldr FROM print_items").fetchone()
    assert row["article_id"] is None and row["tldr"] == "kept"  # history survives


# --- prints -------------------------------------------------------------------

def test_last_print_items_only_considers_printed_status(conn):
    fid = _feed_id(conn, "products")
    a1, a2, a3 = (_art(conn, fid, n) for n in (1, 2, 3))
    ok = db.create_print(conn, "manual", [DigestItem(article_id=a1, position=1, category_slug="products", tldr="a")])
    db.set_print_status(conn, ok, "printed")
    db.create_print(conn, "schedule", [DigestItem(article_id=a2, position=1, category_slug="products", tldr="b")])
    failed = db.create_print(conn, "schedule", [DigestItem(article_id=a3, position=1, category_slug="products", tldr="c")])
    db.set_print_status(conn, failed, "failed", error="ble down")
    last = db.get_last_print_items(conn)
    assert [i.article_id for i in last] == [a1]
    assert db.get_printed_article_ids(conn) == {a1, a2}  # printed + pending count; failed does not


def test_print_status_unknown_id_not_found(conn):
    with pytest.raises(db.NotFound):
        db.set_print_status(conn, 4242, "printed")


def test_list_prints_newest_first_with_total_and_items(conn):
    fid = _feed_id(conn, "products")
    ids = []
    for n in range(1, 4):
        aid = _art(conn, fid, n)
        ids.append(db.create_print(conn, "manual", [DigestItem(article_id=aid, position=1, category_slug="products", tldr=f"t{n}")]))
    records, total = db.list_prints(conn, limit=2)
    assert total == 3 and [r.id for r in records] == [ids[2], ids[1]]
    assert records[0].items[0].tldr == "t3" and records[0].trigger == "manual"
    assert db.get_print(conn, ids[0]).status == "pending"


def test_print_items_keep_positions_ordered(conn):
    fid = _feed_id(conn, "products")
    aids = [_art(conn, fid, n) for n in (1, 2, 3)]
    items = [DigestItem(article_id=a, position=i + 1, category_slug="products", tldr=f"t{i}")
             for i, a in enumerate(aids)]
    pid = db.create_print(conn, "manual", items)
    assert [i.position for i in db.get_print(conn, pid).items] == [1, 2, 3]


# --- schedules & settings -----------------------------------------------------

def test_schedule_crud_roundtrip(conn):
    s = db.create_schedule(conn, "30 6 * * 1-5", label="Weekdays", enabled=False)
    assert s.enabled is False and s.label == "Weekdays"
    s = db.update_schedule(conn, s.id, enabled=True, label=None)
    assert s.enabled is True and s.label is None and s.cron == "30 6 * * 1-5"
    db.delete_schedule(conn, s.id)
    with pytest.raises(db.NotFound):
        db.get_schedule(conn, s.id)
    with pytest.raises(db.NotFound):
        db.update_schedule(conn, s.id, enabled=True)


def test_settings_defaults_and_partial_update(conn):
    s = db.get_settings(conn)
    assert (s.max_items_total, s.model, s.fallback_model) == (8, "google/gemma-3-12b-it", "deepseek/deepseek-v4.1-flash")
    s = db.update_settings(conn, max_items_total=5)
    assert s.max_items_total == 5 and s.model == "google/gemma-3-12b-it"


def test_update_settings_none_ignored_except_clearable_fields(conn):
    db.update_settings(conn, max_items_total=None, model=None)
    assert db.get_settings(conn).max_items_total == 8
    assert db.get_settings(conn).model == "google/gemma-3-12b-it"
    db.update_settings(conn, printer_address="AA:BB")
    assert db.get_settings(conn).printer_address == "AA:BB"
    db.update_settings(conn, printer_address=None)
    assert db.get_settings(conn).printer_address is None
    db.update_settings(conn, fallback_model=None)
    assert db.get_settings(conn).fallback_model is None


def test_update_settings_ignores_unknown_keys(conn):
    s = db.update_settings(conn, bogus="x", max_items_total=3)
    assert s.max_items_total == 3 and not hasattr(s, "bogus")
    assert db.get_setting(conn, "bogus") is None
