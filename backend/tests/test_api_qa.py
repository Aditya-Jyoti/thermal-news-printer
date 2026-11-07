"""QA: every endpoint in docs/ARCHITECTURE.md's REST table except /print/*, on a tmp DB."""
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from tnp import db
from tnp.api.app import create_app
from tnp.models import DigestItem

RSS = (
    '<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>'
    "<item><title>Fresh launch</title><link>https://ex.com/fresh?utm_source=x</link>"
    "<guid>g1</guid><description>body</description></item></channel></rss>"
)


@pytest.fixture
def api(tmp_path):
    path = str(tmp_path / "api.sqlite3")
    client = TestClient(create_app(path))
    return client, path


def _conn(path):
    return db.connect(path)


def _seeded_feed(path, slug="products"):
    c = _conn(path)
    try:
        return c.execute(
            "SELECT f.id FROM feeds f JOIN categories c ON c.id=f.category_id WHERE c.slug=? ORDER BY f.id",
            (slug,),
        ).fetchone()[0]
    finally:
        c.close()


def _category_id(path, slug):
    c = _conn(path)
    try:
        return db.get_category_by_slug(c, slug).id
    finally:
        c.close()


def _insert(path, feed_id, n, *, political=None, days=0, summary=None):
    c = _conn(path)
    try:
        pub = datetime.now(timezone.utc) - timedelta(days=days, minutes=n)
        aid = db.insert_article(
            c, feed_id=feed_id, guid=f"g{feed_id}-{n}", url=f"https://ex.com/{feed_id}/{n}",
            title=f"Headline {feed_id}-{n} unique{n}", fingerprint=f"fp-{feed_id}-{n}",
            published_at=pub, content_text=f"Full text {n}", is_political=political,
        )
        if summary:
            db.upsert_summary(c, aid, summary, "test/model")
        return aid
    finally:
        c.close()


# --- health & errors -----------------------------------------------------------

def test_health(api):
    client, _ = api
    r = client.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_cors_allows_any_origin(api):
    client, _ = api
    r = client.get("/health", headers={"Origin": "http://192.168.1.20:8081"})
    assert r.headers.get("access-control-allow-origin") == "*"


def test_error_shape_is_detail_object(api):
    client, _ = api
    r = client.patch("/categories/9999", json={"name": "x"})
    assert r.status_code == 404 and set(r.json()) == {"detail"}


# --- categories ----------------------------------------------------------------

def test_categories_list_seeded_with_feed_counts(api):
    client, _ = api
    cats = client.get("/categories").json()
    assert [c["slug"] for c in cats] == ["products", "engineering", "psychology", "learning"]
    assert {"id", "name", "slug", "color", "print_limit", "feed_count"} <= set(cats[0])
    assert cats[0]["feed_count"] == 2 and cats[0]["print_limit"] == 2


def test_category_create_201_then_409_duplicate(api):
    client, _ = api
    r = client.post("/categories", json={"name": "Space", "color": "#112233", "print_limit": 3})
    assert r.status_code == 201
    body = r.json()
    assert body["slug"] == "space" and body["print_limit"] == 3 and body["feed_count"] == 0
    dup = client.post("/categories", json={"name": "Space"})
    assert dup.status_code == 409 and "detail" in dup.json()


@pytest.mark.parametrize(
    "payload",
    [{}, {"name": ""}, {"name": "x" * 41}, {"name": "ok", "print_limit": 21}, {"name": "ok", "print_limit": -1}],
)
def test_category_create_validation_422(api, payload):
    client, _ = api
    assert client.post("/categories", json=payload).status_code == 422


def test_category_create_strips_name(api):
    client, _ = api
    assert client.post("/categories", json={"name": "  Padded  "}).json()["name"] == "Padded"


def test_category_create_whitespace_only_name_rejected(api):
    client, _ = api
    r = client.post("/categories", json={"name": "   "})
    assert r.status_code == 422


def test_category_patch_whitespace_only_name_rejected(api):
    client, path = api
    cid = _category_id(path, "learning")
    r = client.patch(f"/categories/{cid}", json={"name": "   "})
    assert r.status_code == 422


def test_category_patch_partial_and_rename_slug(api):
    client, path = api
    cid = _category_id(path, "learning")
    r = client.patch(f"/categories/{cid}", json={"print_limit": 5})
    assert r.status_code == 200 and r.json()["print_limit"] == 5 and r.json()["name"] == "Learning"
    r = client.patch(f"/categories/{cid}", json={"name": "Lifelong Learning"})
    assert r.json()["slug"] == "lifelong-learning"


def test_category_patch_errors(api):
    client, path = api
    cid = _category_id(path, "learning")
    assert client.patch(f"/categories/{cid}", json={"name": "Products"}).status_code == 409
    assert client.patch(f"/categories/{cid}", json={"print_limit": 99}).status_code == 422
    assert client.patch("/categories/9999", json={"print_limit": 1}).status_code == 404


def test_deleted_defaults_stay_deleted_after_app_restart(api, tmp_path):
    client, path = api
    cid = _category_id(path, "psychology")
    assert client.delete(f"/categories/{cid}").status_code == 204
    restarted = TestClient(create_app(path))  # boots and re-runs seed_defaults on the same DB
    slugs = [c["slug"] for c in restarted.get("/categories").json()]
    assert "psychology" not in slugs and len(slugs) == 3


def test_category_delete_204_cascades_feeds(api):
    client, path = api
    cid = _category_id(path, "products")
    before = len(client.get("/feeds").json())
    assert client.delete(f"/categories/{cid}").status_code == 204
    assert client.get(f"/feeds?category_id={cid}").json() == []
    assert len(client.get("/feeds").json()) == before - 2
    assert client.delete(f"/categories/{cid}").status_code == 404


# --- feeds ---------------------------------------------------------------------

def test_feeds_filter_by_category(api):
    client, path = api
    cid = _category_id(path, "engineering")
    feeds = client.get(f"/feeds?category_id={cid}").json()
    assert len(feeds) == 1 and feeds[0]["category_id"] == cid
    assert {"id", "url", "title", "category_id", "enabled", "last_fetched_at", "last_error"} <= set(feeds[0])


def test_feed_create_201_and_validation(api):
    client, path = api
    cid = _category_id(path, "learning")
    r = client.post("/feeds", json={"url": "https://new.example/rss", "category_id": cid, "title": "New"})
    assert r.status_code == 201 and r.json()["enabled"] is True and r.json()["title"] == "New"
    assert client.post("/feeds", json={"url": "https://new.example/rss", "category_id": cid}).status_code == 409
    assert client.post("/feeds", json={"url": "ftp://x.example/rss", "category_id": cid}).status_code == 422
    assert client.post("/feeds", json={"url": "https://y.example", "category_id": 9999}).status_code == 404


def test_feed_patch_enable_move_and_url_rules(api):
    client, path = api
    fid = _seeded_feed(path, "products")
    r = client.patch(f"/feeds/{fid}", json={"enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False
    eng = _category_id(path, "engineering")
    assert client.patch(f"/feeds/{fid}", json={"category_id": eng}).json()["category_id"] == eng
    dup = "https://blog.pragmaticengineer.com/rss/"
    assert client.patch(f"/feeds/{fid}", json={"url": dup}).status_code == 409
    assert client.patch(f"/feeds/{fid}", json={"url": "notaurl"}).status_code == 422
    assert client.patch("/feeds/9999", json={"enabled": True}).status_code == 404


def test_feed_delete_204_then_404(api):
    client, path = api
    fid = _seeded_feed(path, "psychology")
    assert client.delete(f"/feeds/{fid}").status_code == 204
    assert client.delete(f"/feeds/{fid}").status_code == 404


@respx.mock
def test_feeds_refresh_single_feed_returns_ingest_result(api):
    client, path = api
    fid = _seeded_feed(path, "products")
    respx.get("https://hnrss.org/launches").mock(return_value=httpx.Response(200, text=RSS))
    r = client.post(f"/feeds/refresh?feed_id={fid}")
    assert r.status_code == 200
    body = r.json()
    assert body == {**body, "feeds_checked": 1, "new_articles": 1, "skipped_duplicates": 0,
                    "flagged_political": 0, "errors": {}}
    items, total = db.list_articles(_conn(path), limit=10)
    assert total == 1 and items[0].title == "Fresh launch"


@respx.mock
def test_feeds_refresh_all_enabled_and_error_reported(api):
    client, path = api
    respx.route().mock(return_value=httpx.Response(503))
    r = client.post("/feeds/refresh")
    assert r.status_code == 200
    body = r.json()
    assert body["feeds_checked"] == 5 and body["new_articles"] == 0
    assert len(body["errors"]) == 5


@respx.mock
def test_feeds_refresh_unknown_feed_404(api):
    client, _ = api
    assert client.post("/feeds/refresh?feed_id=9999").status_code == 404


# --- articles ------------------------------------------------------------------

def test_articles_hide_political_by_default_and_show_with_flag(api):
    client, path = api
    fid = _seeded_feed(path)
    _insert(path, fid, 1, political=True)
    normal = _insert(path, fid, 2, summary="Short tldr.")
    default = client.get("/articles").json()
    assert default["total"] == 1 and [a["id"] for a in default["items"]] == [normal]
    shown = client.get("/articles?include_political=true").json()
    assert shown["total"] == 2
    flagged = [a for a in shown["items"] if a["is_political"] is True]
    assert len(flagged) == 1 and flagged[0]["tldr"] is None


def test_articles_shape_and_tldr(api):
    client, path = api
    fid = _seeded_feed(path)
    aid = _insert(path, fid, 1, summary="Punchy tldr.")
    item = client.get("/articles").json()["items"][0]
    assert item["id"] == aid and item["tldr"] == "Punchy tldr." and item["printed_at"] is None
    assert item["category"]["slug"] == "products" and item["url"].startswith("https://ex.com/")
    assert set(item) >= {"id", "feed_id", "category", "title", "url", "author", "published_at",
                         "image_url", "tldr", "is_political", "printed_at"}


def test_articles_category_filter_pagination_and_validation(api):
    client, path = api
    eng = _seeded_feed(path, "engineering")
    prod = _seeded_feed(path, "products")
    for n in range(1, 4):
        _insert(path, prod, n)
    _insert(path, eng, 9)
    cid = _category_id(path, "products")
    page = client.get(f"/articles?category_id={cid}&limit=2&offset=2").json()
    assert page["total"] == 3 and page["limit"] == 2 and page["offset"] == 2 and len(page["items"]) == 1
    assert client.get("/articles?limit=0").status_code == 422
    assert client.get("/articles?limit=201").status_code == 422
    assert client.get("/articles?offset=-1").status_code == 422


def test_article_detail_and_404(api):
    client, path = api
    aid = _insert(path, _seeded_feed(path), 1, summary="Detail tldr.")
    r = client.get(f"/articles/{aid}")
    assert r.status_code == 200
    body = r.json()
    assert body["content_text"] == "Full text 1" and body["tldr"] == "Detail tldr."
    assert "content_html" in body
    assert client.get("/articles/999999").status_code == 404


# --- prints --------------------------------------------------------------------

def test_prints_empty_then_list_and_detail(api):
    client, path = api
    assert client.get("/prints").json() == {"items": [], "total": 0, "limit": 20, "offset": 0}
    aid = _insert(path, _seeded_feed(path), 1, summary="Printed tldr.")
    c = _conn(path)
    pid = db.create_print(c, "schedule", [DigestItem(article_id=aid, position=1, category_slug="products", tldr="Printed tldr.")])
    db.set_print_status(c, pid, "printed")
    c.close()
    page = client.get("/prints").json()
    assert page["total"] == 1 and page["items"][0]["status"] == "printed"
    assert page["items"][0]["items"][0]["title"].startswith("Headline")
    detail = client.get(f"/prints/{pid}").json()
    assert detail["trigger"] == "schedule" and detail["items"][0]["tldr"] == "Printed tldr."
    assert client.get("/prints/9999").status_code == 404
    assert client.get("/prints?limit=0").status_code == 422


# --- schedules -----------------------------------------------------------------

def test_schedules_default_and_crud(api):
    client, _ = api
    default = client.get("/schedules").json()
    assert [s["cron"] for s in default] == ["0 8 * * *"]
    r = client.post("/schedules", json={"cron": "30 12 * * 1-5", "label": "Lunch"})
    assert r.status_code == 201 and r.json()["enabled"] is True
    sid = r.json()["id"]
    r = client.patch(f"/schedules/{sid}", json={"enabled": False, "label": None})
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["label"] is None
    assert r.json()["cron"] == "30 12 * * 1-5"
    assert client.delete(f"/schedules/{sid}").status_code == 204
    assert client.delete(f"/schedules/{sid}").status_code == 404


def test_schedule_invalid_cron_is_422_everywhere(api):
    client, _ = api
    assert client.post("/schedules", json={"cron": "99 * * * *"}).status_code == 422
    assert client.post("/schedules", json={"cron": "* * *"}).status_code == 422
    sid = client.get("/schedules").json()[0]["id"]
    assert client.patch(f"/schedules/{sid}", json={"cron": "0 25 * * *"}).status_code == 422
    assert client.patch("/schedules/9999", json={"enabled": True}).status_code == 404


# --- settings & models ---------------------------------------------------------

def test_settings_defaults(api):
    client, _ = api
    s = client.get("/settings").json()
    assert s["max_items_total"] == 8 and s["model"] == "google/gemma-3-12b-it"
    assert s["fallback_model"] == "deepseek/deepseek-v4.1-flash" and s["printer_address"] is None


def test_settings_patch_is_partial_and_roundtrips_null_fallback(api):
    client, _ = api
    r = client.patch("/settings", json={"max_items_total": 5})
    assert r.json()["max_items_total"] == 5 and r.json()["model"] == "google/gemma-3-12b-it"
    r = client.patch("/settings", json={"fallback_model": None})
    assert r.status_code == 200 and r.json()["fallback_model"] is None
    assert client.get("/settings").json()["fallback_model"] is None
    client.patch("/settings", json={"fallback_model": "x/fallback"})
    assert client.get("/settings").json()["fallback_model"] == "x/fallback"
    client.patch("/settings", json={"model": "x/primary"})
    assert client.get("/settings").json()["model"] == "x/primary"


def test_settings_null_for_non_clearable_fields_is_ignored(api):
    client, _ = api
    client.patch("/settings", json={"max_items_total": None, "model": None})
    s = client.get("/settings").json()
    assert s["max_items_total"] == 8 and s["model"] == "google/gemma-3-12b-it"
    client.patch("/settings", json={"printer_address": "AA:BB:CC:DD:EE:FF"})
    assert client.get("/settings").json()["printer_address"] == "AA:BB:CC:DD:EE:FF"


def test_settings_patch_validation(api):
    client, _ = api
    assert client.patch("/settings", json={"max_items_total": 0}).status_code == 422
    assert client.patch("/settings", json={"max_items_total": 31}).status_code == 422


def test_models_endpoint_lists_curated_options(api):
    client, _ = api
    models = client.get("/models").json()
    ids = [m["id"] for m in models]
    assert "google/gemma-3-12b-it" in ids and all({"id", "label"} <= set(m) for m in models)


# --- digest & AI --------------------------------------------------------------

def test_digest_preview_respects_summaries_limits_and_printed(api):
    client, path = api
    prod = _seeded_feed(path, "products")
    # The pipeline always classifies (is_political=0) before summarizing, so mirror that here.
    a1 = _insert(path, prod, 1, political=False, summary="One.")
    a2 = _insert(path, prod, 2, political=False, summary="Two.")
    _insert(path, prod, 3)  # no summary -> not eligible
    _insert(path, prod, 4, political=True, summary="Political.")
    preview = client.get("/digest/preview").json()
    assert [p["article_id"] for p in preview] == [a1, a2]  # products cap is 2, newest first
    assert [p["position"] for p in preview] == [1, 2]
    assert all(p["category_slug"] == "products" for p in preview)
    c = _conn(path)
    pid = db.create_print(c, "manual", [DigestItem(**p) for p in preview])
    db.set_print_status(c, pid, "printed")
    c.close()
    assert client.get("/digest/preview").json() == []


def test_digest_preview_category_limit_zero(api):
    client, path = api
    cid = _category_id(path, "products")
    client.patch(f"/categories/{cid}", json={"print_limit": 0})
    _insert(path, _seeded_feed(path, "products"), 1, political=False, summary="Hidden.")
    assert client.get("/digest/preview").json() == []


def test_ai_process_without_key_reports_skipped(api, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    client, path = api
    _insert(path, _seeded_feed(path), 1)
    r = client.post("/ai/process")
    assert r.status_code == 200
    assert r.json() == {"summarized": 0, "flagged_political": 0, "failed": 0, "skipped_no_key": True}


def test_ai_process_limit_validation(api):
    client, _ = api
    assert client.post("/ai/process?limit=0").status_code == 422
    assert client.post("/ai/process?limit=201").status_code == 422
