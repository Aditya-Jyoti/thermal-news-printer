import httpx
import respx

from tnp import db
from tnp.ingest import run_ingest
from tnp.ingest.parse import compute_fingerprint, normalize_url
from tnp.ingest.politics import is_clearly_political

RSS = """<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Test Feed</title>
<item><title>Cool launch</title><link>https://Example.com/a/?utm_source=x#frag</link>
<guid>1</guid><description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description>
<media:thumbnail url="https://img.test/a.png"/></item>
<item><title>Senate votes on bill</title><link>https://example.com/b</link><guid>2</guid>
<description>Politics</description></item>
<item><title>Inline image</title><link>https://example.com/c</link><guid>3</guid>
<content:encoded>&lt;img src="https://img.test/c.jpg"&gt;text</content:encoded></item>
</channel></rss>"""


def test_normalize_and_fingerprint():
    assert normalize_url("https://Example.com/a/?utm_source=x&k=1#f") == "https://example.com/a?k=1"
    assert compute_fingerprint("https://example.com/a/", "x") == compute_fingerprint(
        "https://EXAMPLE.com/a?utm_medium=y", "z")
    assert compute_fingerprint("", "Hello, World") == compute_fingerprint(None, "hello world")


def test_politics_filter():
    assert is_clearly_political("Senate passes bill")
    assert not is_clearly_political("New database launches")


@respx.mock
def test_run_ingest(conn):
    feed = db.list_feeds(conn)[0]
    for f in db.list_feeds(conn)[1:]:
        db.update_feed(conn, f.id, enabled=False)
    route = respx.get(feed.url).mock(return_value=httpx.Response(
        200, text=RSS, headers={"etag": '"abc"', "last-modified": "Mon, 01 Jan 2026 00:00:00 GMT"}))
    r = run_ingest(conn)
    assert (r.feeds_checked, r.new_articles, r.skipped_duplicates, r.flagged_political) == (1, 3, 0, 1)
    arts, _ = db.list_articles(conn, include_political=True)
    by = {a.title: a for a in arts}
    assert by["Cool launch"].image_url == "https://img.test/a.png"
    assert by["Inline image"].image_url == "https://img.test/c.jpg"
    assert by["Senate votes on bill"].is_political is True
    assert db.get_article_detail(conn, by["Cool launch"].id).content_text == "Hello world"
    assert route.calls[0].request.headers["user-agent"] == "termal-news-printer/0.1"

    # second run: conditional headers sent, 304 handled
    route.mock(return_value=httpx.Response(304))
    r2 = run_ingest(conn)
    assert r2.new_articles == 0 and not r2.errors
    h = route.calls[-1].request.headers
    assert h["if-none-match"] == '"abc"' and "if-modified-since" in h

    # full re-fetch: everything is a duplicate
    route.mock(return_value=httpx.Response(200, text=RSS))
    assert run_ingest(conn).skipped_duplicates == 3


@respx.mock
def test_error_isolated_per_feed(conn):
    feeds = db.list_feeds(conn)
    for f in feeds[2:]:
        db.update_feed(conn, f.id, enabled=False)
    respx.get(feeds[0].url).mock(return_value=httpx.Response(500))
    respx.get(feeds[1].url).mock(return_value=httpx.Response(200, text=RSS))
    r = run_ingest(conn)
    assert feeds[0].url in r.errors and r.new_articles == 3
    assert db.list_feeds(conn)[0].last_error
    assert db.list_feeds(conn)[1].last_error is None
