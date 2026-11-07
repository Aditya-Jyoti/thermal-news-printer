import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import openai
from fastapi.testclient import TestClient

from tnp import db
from tnp.api.app import create_app
from tnp.api.cron import cron_matches
from tnp.pipeline import build_digest, process_pending
from tnp.scheduler import Scheduler


class FakeAI:
    """Headline containing 'POLITICS' is classified political. Models in fail_models raise."""

    def __init__(self, fail_models=()):
        self.calls: list[str] = []
        self.fail_models = set(fail_models)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kw):
        self.calls.append(kw["model"])
        if kw["model"] in self.fail_models:
            raise openai.APIConnectionError(request=None)
        prompt = kw["messages"][0]["content"]
        pol = "POLITICS" in prompt
        if "Reply with ONLY a JSON" in prompt:
            text = f'{{"political": {str(pol).lower()}, "reason": "r", "tldr": "Short summary."}}'
        else:
            text = "Short summary."
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


def add(conn, n, title=None, feed_id=1, political=None, age_days=0):
    pub = datetime.now(timezone.utc) - timedelta(days=age_days, minutes=n)
    return db.insert_article(
        conn, feed_id=feed_id, guid=f"g{n}", url=f"http://x/{n}",
        title=title or f"Unique story {n} alpha{n}", fingerprint=f"fp{n}",
        published_at=pub, content_text="body", is_political=political,
    )


def test_process_stores_summaries_and_political(conn):
    a = add(conn, 1)
    b = add(conn, 2, title="POLITICS rally")
    c = add(conn, 3, political=False)
    old = add(conn, 4, age_days=30)
    r = process_pending(conn, client=FakeAI())
    assert (r.summarized, r.flagged_political, r.failed) == (2, 1, 0)
    assert db.get_article_detail(conn, a).tldr == "Short summary."
    assert db.get_article_detail(conn, b).is_political is True
    assert db.get_article_detail(conn, b).tldr is None
    assert db.get_article_detail(conn, c).tldr == "Short summary."
    assert db.get_article_detail(conn, old).tldr is None  # too old


def test_process_limit_and_no_key(conn):
    for i in range(1, 5):
        add(conn, i)
    assert process_pending(conn, client=FakeAI(), limit=2).summarized == 2
    r = process_pending(conn)  # no key in env
    assert r.skipped_no_key and r.summarized == 0


def test_process_uses_fallback_and_records_model(conn):
    a = add(conn, 1)
    ai = FakeAI(fail_models={"google/gemma-3-12b-it"})
    r = process_pending(conn, client=ai)
    assert r.summarized == 1
    assert ai.calls == ["google/gemma-3-12b-it", "deepseek/deepseek-v4.1-flash"]
    model = conn.execute("SELECT model FROM summaries WHERE article_id=?", (a,)).fetchone()[0]
    assert model == "deepseek/deepseek-v4.1-flash"


def test_process_fallback_disabled_counts_failure(conn):
    add(conn, 1)
    db.update_settings(conn, fallback_model=None)
    assert db.get_settings(conn).fallback_model is None
    r = process_pending(conn, client=FakeAI(fail_models={"google/gemma-3-12b-it"}))
    assert r.failed == 1 and r.summarized == 0


def test_build_digest_limits_and_printed_exclusion(conn):
    feed_ids = {f.category_id: f.id for f in db.list_feeds(conn)}
    cats = {c.slug: c.id for c in db.list_categories(conn)}
    prod, eng = feed_ids[cats["products"]], feed_ids[cats["engineering"]]
    for i in range(1, 5):
        add(conn, i, feed_id=prod, political=False)
    add(conn, 10, feed_id=eng, political=False)
    add(conn, 11, feed_id=eng, political=False)
    conn.execute("UPDATE categories SET print_limit=1 WHERE slug='engineering'")
    conn.execute("UPDATE categories SET print_limit=2 WHERE slug='products'")
    conn.commit()
    process_pending(conn, client=FakeAI())
    digest = build_digest(conn)
    slugs = [d.category_slug for d in digest]
    assert slugs.count("engineering") == 1 and slugs.count("products") == 2
    pid = db.create_print(conn, "manual", digest)
    db.set_print_status(conn, pid, "printed")
    again = build_digest(conn)
    assert {d.article_id for d in again}.isdisjoint({d.article_id for d in digest})


def test_cron_matches():
    t = datetime(2026, 11, 9, 8, 0)  # Monday
    assert cron_matches("0 8 * * *", t)
    assert not cron_matches("1 8 * * *", t)
    assert cron_matches("*/15 8-18 * * 1-5", t)
    assert cron_matches("0,30 8 * * 1", t)
    assert not cron_matches("0 8 * * 0", t)
    sunday = datetime(2026, 11, 8, 8, 0)
    assert cron_matches("0 8 * * 0", sunday) and cron_matches("0 8 * * 7", sunday)
    assert cron_matches("0 8 * 11 *", t) and not cron_matches("0 8 * 10 *", t)
    # day-of-month and day-of-week both restricted -> OR
    assert cron_matches("0 8 9 * 3", t)  # dom matches, dow (Wed) doesn't
    assert cron_matches("0 8 1 * 1", t)  # dow matches
    assert not cron_matches("0 8 1 * 3", t)  # neither
    assert cron_matches("10-20/5 * * * *", datetime(2026, 11, 9, 1, 15))
    assert not cron_matches("10-20/5 * * * *", datetime(2026, 11, 9, 1, 16))


def test_scheduler_fires_only_enabled_matching(tmp_path):
    path = str(tmp_path / "s.sqlite3")
    c = db.connect(path)
    db.init_db(c)
    db.create_schedule(c, "5 9 * * *", None, True)
    db.create_schedule(c, "6 9 * * *", None, False)
    c.close()
    ran: list[str] = []
    s = Scheduler(path, cycle=lambda conn, trigger: ran.append(trigger))
    assert not s.tick(datetime(2026, 1, 1, 9, 4))
    assert not s.tick(datetime(2026, 1, 1, 9, 6))  # disabled
    assert s.tick(datetime(2026, 1, 1, 9, 5))
    for _ in range(100):
        if ran:
            break
        time.sleep(0.02)
    assert ran == ["schedule"]


def test_api_digest_preview_models_and_process(tmp_path):
    client = TestClient(create_app(str(tmp_path / "a.sqlite3")))
    assert client.get("/digest/preview").json() == []
    assert "google/gemma-3-12b-it" in [m["id"] for m in client.get("/models").json()]
    assert client.post("/ai/process").json()["skipped_no_key"] is True
    s = client.patch("/settings", json={"fallback_model": None}).json()
    assert s["fallback_model"] is None
