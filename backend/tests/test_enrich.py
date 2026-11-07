import httpx
import respx

from tnp import db
from tnp.ingest import enrich
from tnp.ingest.enrich import enrich_rows, is_meaningfully_longer, needs_enrichment
from tnp.ingest.fulltext import fetch_full_text
from tnp.pipeline import process_pending

from .test_ai import FakeClient

PAGE = "<html><body><article><h1>T</h1>" + "".join(
    f"<p>Paragraph {i} of the full story with enough words to be extracted as main content properly.</p>"
    for i in range(30)
) + "</article></body></html>"


def _add(conn, url="https://example.com/a", text="Teaser."):
    feed = db.list_feed_rows(conn)[0]
    return db.insert_article(conn, feed_id=feed["id"], guid=url, url=url, title="T", fingerprint=url,
                             content_text=text, content_html="<p>old</p>")


def _row(conn, aid):
    return conn.execute("SELECT a.*, 'c' AS category_slug FROM articles a WHERE id=?", (aid,)).fetchone()


def test_needs_enrichment():
    assert needs_enrichment("short", "https://x.com/a")
    assert needs_enrichment(None, "http://x.com/a")
    assert not needs_enrichment("x" * 2000, "https://x.com/a")
    assert not needs_enrichment("short", "")
    assert not needs_enrichment("short", "not-a-url")


def test_meaningfully_longer():
    assert is_meaningfully_longer("x" * 3000, "x" * 170)
    assert not is_meaningfully_longer("x" * 200, "x" * 170)
    assert not is_meaningfully_longer(None, "abc")
    assert not is_meaningfully_longer("x" * 1000, "x" * 900)


@respx.mock
def test_fetch_full_text_extracts():
    respx.get("https://example.com/a").mock(
        return_value=httpx.Response(200, text=PAGE, headers={"content-type": "text/html"}))
    with httpx.Client() as c:
        text, html = fetch_full_text("https://example.com/a", client=c)
    assert text and "Paragraph 12" in text and html


@respx.mock
def test_fetch_full_text_failures_return_none():
    respx.get("https://example.com/403").mock(return_value=httpx.Response(403))
    respx.get("https://example.com/pdf").mock(
        return_value=httpx.Response(200, content=b"%PDF", headers={"content-type": "application/pdf"}))
    respx.get("https://example.com/boom").mock(side_effect=httpx.ConnectTimeout("t"))
    with httpx.Client() as c:
        for u in ("403", "pdf", "boom"):
            assert fetch_full_text(f"https://example.com/{u}", client=c) == (None, None)


def test_enrich_updates_db(conn, monkeypatch):
    aid = _add(conn)
    monkeypatch.setattr(enrich, "fetch_full_text", lambda url, *, client: ("Full story. " * 100, "<p>full</p>"))
    out = enrich_rows(conn, [_row(conn, aid)], client=httpx.Client())
    assert out[aid].startswith("Full story")
    r = _row(conn, aid)
    assert r["content_text"].startswith("Full story") and r["content_html"] == "<p>full</p>"


def test_enrich_skips_long_and_falls_back_on_failure(conn, monkeypatch):
    long_id = _add(conn, "https://example.com/long", "x " * 1000)
    short_id = _add(conn, "https://example.com/short", "Teaser.")
    calls = []

    def fake(url, *, client):
        calls.append(url)
        return None, None

    monkeypatch.setattr(enrich, "fetch_full_text", fake)
    out = enrich_rows(conn, [_row(conn, long_id), _row(conn, short_id)], client=httpx.Client())
    assert out == {} and calls == ["https://example.com/short"]
    assert _row(conn, short_id)["content_text"] == "Teaser."


def test_enrich_ignores_barely_longer_text(conn, monkeypatch):
    aid = _add(conn, text="y" * 500)
    monkeypatch.setattr(enrich, "fetch_full_text", lambda url, *, client: ("z" * 550, None))
    assert enrich_rows(conn, [_row(conn, aid)], client=httpx.Client()) == {}
    assert _row(conn, aid)["content_text"] == "y" * 500


def test_enrich_exception_never_propagates(conn, monkeypatch):
    aid = _add(conn)

    def boom(url, *, client):
        raise RuntimeError("x")

    monkeypatch.setattr(enrich, "fetch_full_text", boom)
    assert enrich_rows(conn, [_row(conn, aid)], client=httpx.Client()) == {}


def test_process_pending_summarizes_enriched_text(conn, monkeypatch):
    aid = _add(conn)
    conn.execute("UPDATE articles SET is_political=0 WHERE id=?", (aid,))
    conn.commit()
    monkeypatch.setattr(enrich, "fetch_full_text", lambda url, *, client: ("FULLSTORYMARK " * 80, None))
    c = FakeClient("Acme ships a chip.")
    res = process_pending(conn, client=c)
    assert res.summarized == 1
    assert "FULLSTORYMARK" in c.calls[0]["messages"][0]["content"]
    assert "FULLSTORYMARK" in _row(conn, aid)["content_text"]
