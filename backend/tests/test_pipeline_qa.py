"""QA: process_pending (summaries, politics, limits, age) and the cross-print dedup loop."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import openai
import pytest

from tnp import db
from tnp.pipeline import build_digest, process_pending

PRIMARY = "google/gemma-3-12b-it"
FALLBACK = "deepseek/deepseek-v4.1-flash"


class FakeAI:
    """Politics is decided by the headline word 'POLITICS'. Models in `fail_models` raise."""

    def __init__(self, fail_models=()):
        self.calls: list[str] = []
        self.prompts: list[str] = []
        self.fail_models = set(fail_models)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kw):
        self.calls.append(kw["model"])
        prompt = kw["messages"][0]["content"]
        self.prompts.append(prompt)
        if kw["model"] in self.fail_models:
            raise openai.APIConnectionError(request=None)
        if "Reply with ONLY a JSON" in prompt:
            pol = "POLITICS" in prompt
            text = f'{{"political": {str(pol).lower()}, "reason": "r", "tldr": "Combined tldr."}}'
        else:
            text = "Summary only."
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


def _feed(conn, slug):
    return conn.execute(
        "SELECT f.id FROM feeds f JOIN categories c ON c.id=f.category_id WHERE c.slug=? ORDER BY f.id LIMIT 1",
        (slug,),
    ).fetchone()[0]


def add(conn, n, *, slug="products", title=None, political=None, pub_days=0, fetched_days=0, content="body"):
    """Insert article n. n=1 is the newest (published n minutes before now)."""
    title = title or f"Quiet story {n} zephyr{n}"
    if pub_days is None:  # no published date: ordering and age use fetched_at
        fetched = (datetime.now(timezone.utc) - timedelta(days=fetched_days)).isoformat(timespec="seconds")
        cur = conn.execute(
            "INSERT INTO articles(feed_id, guid, url, title, fetched_at, content_text, fingerprint, is_political) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (_feed(conn, slug), f"g{n}", f"https://ex.com/{n}", title, fetched, content, f"fp{n}", political),
        )
        conn.commit()
        return cur.lastrowid
    pub = datetime.now(timezone.utc) - timedelta(days=pub_days, minutes=n)
    return db.insert_article(
        conn, feed_id=_feed(conn, slug), guid=f"g{n}", url=f"https://ex.com/{n}",
        title=title, fingerprint=f"fp{n}", published_at=pub, content_text=content,
        is_political=political,
    )


def summary_count(conn):
    return conn.execute("SELECT COUNT(*) FROM summaries").fetchone()[0]


# --- process_pending -----------------------------------------------------------

def test_political_articles_get_no_summary_and_are_not_reprocessed(conn):
    pol = add(conn, 1, title="POLITICS rally downtown")
    ai = FakeAI()
    r = process_pending(conn, client=ai)
    assert (r.summarized, r.flagged_political) == (0, 1)
    assert db.get_article_detail(conn, pol).is_political is True
    assert db.get_article_detail(conn, pol).tldr is None
    assert summary_count(conn) == 0
    calls_before = len(ai.calls)
    r2 = process_pending(conn, client=ai)
    assert r2.summarized == 0 and r2.flagged_political == 0
    assert len(ai.calls) == calls_before  # political rows are excluded from the backlog


def test_unclassified_article_uses_combined_call_and_sets_flag(conn):
    aid = add(conn, 1)
    ai = FakeAI()
    process_pending(conn, client=ai)
    assert db.get_article_detail(conn, aid).is_political is False
    assert "Reply with ONLY a JSON" in ai.prompts[0]
    assert db.get_article_detail(conn, aid).tldr == "Combined tldr."


def test_already_classified_article_uses_summary_only_call(conn):
    aid = add(conn, 1, political=False)
    ai = FakeAI()
    process_pending(conn, client=ai)
    assert "Reply with ONLY a JSON" not in ai.prompts[0]
    assert db.get_article_detail(conn, aid).tldr == "Summary only."


def test_max_age_days_excludes_old_articles_and_param_controls_window(conn):
    old = add(conn, 1, pub_days=2)
    assert process_pending(conn, client=FakeAI(), max_age_days=1).summarized == 0
    assert db.get_article_detail(conn, old).tldr is None
    assert process_pending(conn, client=FakeAI()).summarized == 1  # default window is 4 days


def test_missing_published_date_falls_back_to_fetched_at(conn):
    recent = add(conn, 1, pub_days=None, fetched_days=0)
    stale = add(conn, 2, pub_days=None, fetched_days=10)
    r = process_pending(conn, client=FakeAI())
    assert r.summarized == 1
    assert db.get_article_detail(conn, recent).tldr is not None
    assert db.get_article_detail(conn, stale).tldr is None


def test_limit_caps_batch_newest_first(conn):
    ids = [add(conn, n, pub_days=0) for n in range(1, 6)]
    r = process_pending(conn, client=FakeAI(), limit=2)
    assert r.summarized == 2
    done = [a for a in ids if db.get_article_detail(conn, a).tldr]
    assert done == ids[:2]  # ids[0] is the newest


def test_per_article_ai_failure_counts_and_continues(conn):
    add(conn, 1, title="Quiet alpha story one")
    add(conn, 2, title="Quiet beta story two")
    ai = FakeAI(fail_models={PRIMARY, FALLBACK})
    r = process_pending(conn, client=ai)
    assert r.failed == 2 and r.summarized == 0 and r.skipped_no_key is False
    assert summary_count(conn) == 0


def test_fallback_model_records_actual_model(conn):
    aid = add(conn, 1, political=False)
    ai = FakeAI(fail_models={PRIMARY})
    r = process_pending(conn, client=ai)
    assert r.summarized == 1
    assert conn.execute("SELECT model FROM summaries WHERE article_id=?", (aid,)).fetchone()[0] == FALLBACK


def test_missing_key_sets_skipped_flag_and_writes_nothing(conn, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    add(conn, 1)
    r = process_pending(conn)
    assert r.skipped_no_key is True and r.summarized == 0 and r.failed == 0
    assert summary_count(conn) == 0


def test_summaries_are_not_recomputed_for_already_summarized(conn):
    add(conn, 1)
    process_pending(conn, client=FakeAI())
    ai = FakeAI()
    assert process_pending(conn, client=ai).summarized == 0
    assert ai.calls == []


# --- digest across consecutive prints ------------------------------------------

def _summarize_all(conn):
    process_pending(conn, client=FakeAI())


def test_consecutive_digests_never_repeat_printed_items(conn):
    prod = [add(conn, n, slug="products", title=f"Distinct launch{n} marvel{n} gadget{n} wonder") for n in (1, 2, 3)]
    eng = [add(conn, n, slug="engineering", title=f"Engineering dive{n} kernel{n} scheduler{n} notes")
           for n in (4, 5)]
    _summarize_all(conn)

    first = build_digest(conn)
    assert sorted(i.article_id for i in first) == sorted(prod[:2] + eng)  # 2 per category, newest first
    pid = db.create_print(conn, "manual", first)
    db.set_print_status(conn, pid, "printed")

    second = build_digest(conn)
    assert [i.article_id for i in second] == [prod[2]]  # only the unprinted leftover remains
    assert not {i.article_id for i in first} & {i.article_id for i in second}
    pid2 = db.create_print(conn, "manual", second)
    db.set_print_status(conn, pid2, "printed")
    assert build_digest(conn) == []


def test_next_digest_picks_fresh_items_and_skips_near_duplicate_of_last_print(conn):
    add(conn, 1, slug="products", title="Apple unveils foldable phone design today")
    add(conn, 2, slug="products", title="Tesla ships updated battery pack line")
    add(conn, 3, slug="products", title="Apple unveils foldable phone design today!")  # near-dup of #1
    add(conn, 4, slug="products", title="Startup raises seed round for robots")
    _summarize_all(conn)

    first = build_digest(conn)
    first_titles = {conn.execute("SELECT title FROM articles WHERE id=?", (i.article_id,)).fetchone()[0]
                    for i in first}
    assert len(first) == 2  # cap of two; the near-duplicate pair can only contribute once
    assert sum("foldable" in t for t in first_titles) == 1
    pid = db.create_print(conn, "schedule", first)
    db.set_print_status(conn, pid, "printed")

    second = build_digest(conn)
    second_ids = {i.article_id for i in second}
    assert not second_ids & {i.article_id for i in first}
    for aid in second_ids:
        title = conn.execute("SELECT title FROM articles WHERE id=?", (aid,)).fetchone()[0]
        assert "foldable" not in title  # near-duplicate of last print filtered out


def test_pending_or_failed_prints_still_block_their_articles(conn):
    add(conn, 1, slug="products", title="Alpha launch zed one")
    _summarize_all(conn)
    items = build_digest(conn)
    pid = db.create_print(conn, "manual", items)  # left pending
    assert build_digest(conn) == []
    db.set_print_status(conn, pid, "failed", error="ble timeout")
    assert build_digest(conn) == []


def test_political_and_unsummarized_never_in_digest(conn):
    pol = add(conn, 1, slug="products", title="POLITICS fight in the capital")
    ok = add(conn, 2, slug="products", title="Quiet product unveiling story")
    backlog = add(conn, 3, slug="products", title="Quiet product unveiling story later")
    r = process_pending(conn, client=FakeAI(), limit=2)  # processes #1 (political) and #2 only
    assert (r.flagged_political, r.summarized) == (1, 1)
    digest = build_digest(conn)
    assert [d.article_id for d in digest] == [ok]
    assert pol not in [d.article_id for d in digest] and backlog not in [d.article_id for d in digest]
