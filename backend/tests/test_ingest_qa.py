"""QA: URL normalization, cross-feed dedup, conditional GET, error isolation, image extraction."""
import httpx
import pytest
import respx

from tnp import db
from tnp.ingest.parse import compute_fingerprint, entry_published, html_to_text, normalize_url
from tnp.ingest.politics import is_clearly_political
from tnp.ingest.service import run_ingest
from tnp.models import IngestResult

NS = 'xmlns:media="http://search.yahoo.com/mrss/"'


def rss(*items: str, title="Test Feed") -> str:
    return (
        f'<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" {NS}>'
        f"<channel><title>{title}</title>{''.join(items)}</channel></rss>"
    )


def item(title, link, guid=None, extra="", description="Plain body text."):
    return (
        f"<item><title>{title}</title><link>{link}</link><guid>{guid or link}</guid>"
        f"<pubDate>Mon, 02 Nov 2026 08:00:00 GMT</pubDate>"
        f"<description><![CDATA[{description}]]></description>{extra}</item>"
    )


@pytest.fixture
def bare(tmp_path):
    """Initialised DB with NO seeded feeds, so run_ingest(conn) never touches real URLs."""
    c = db.connect(tmp_path / "bare.sqlite3")
    db.init_db(c)
    yield c
    c.close()


def _feed(conn, url, slug_name="Products"):
    cat = db.get_category_by_slug(conn, slug_name.lower()) or db.create_category(conn, slug_name)
    return db.create_feed(conn, url, cat.id)


def _articles(conn):
    return db.list_articles(conn, limit=200, include_political=True)[0]


# --- URL normalization & fingerprints -----------------------------------------

@pytest.mark.parametrize(
    "a,b",
    [
        ("https://ex.com/post?utm_source=rss&utm_medium=x", "https://ex.com/post"),
        ("https://ex.com/post?UTM_Campaign=c", "https://ex.com/post"),
        ("https://ex.com/post/", "https://ex.com/post"),
        ("https://EX.com/post", "https://ex.com/post"),
        ("HTTPS://ex.com/post#comments", "https://ex.com/post"),
        ("https://ex.com/post?id=7&utm_source=x", "https://ex.com/post?id=7"),
    ],
)
def test_same_article_different_url_noise_has_same_fingerprint(a, b):
    assert compute_fingerprint(a, "t1") == compute_fingerprint(b, "other title")


def test_different_paths_and_meaningful_params_differ():
    assert compute_fingerprint("https://ex.com/a", "t") != compute_fingerprint("https://ex.com/b", "t")
    assert compute_fingerprint("https://ex.com/p?id=1", "t") != compute_fingerprint("https://ex.com/p?id=2", "t")
    assert compute_fingerprint("https://ex.com/Post", "t") != compute_fingerprint("https://ex.com/post", "t")


def test_fingerprint_falls_back_to_normalized_title():
    assert compute_fingerprint("", "Hello, World!") == compute_fingerprint("  ", "hello world")
    assert compute_fingerprint(None, "Hello World") == compute_fingerprint("", "hello world")


def test_normalize_url_keeps_root_and_drops_fragment():
    assert normalize_url("https://ex.com/") == "https://ex.com"
    assert normalize_url("https://ex.com/a/b/?x=1#frag") == "https://ex.com/a/b?x=1"


def test_political_keywords_hit_and_miss():
    assert is_clearly_political("Senate votes on budget")
    assert is_clearly_political("Startup news", "a text that mentions the Kremlin")
    assert is_clearly_political("Lawmakers debate a bill")
    assert not is_clearly_political("New battery startup launches")
    assert is_clearly_political("Congressional hearing scheduled")
    # keyword past the 1500-char prefilter window is not flagged (AI classifier handles it)
    assert not is_clearly_political("Science news", "x " * 1000 + " election")
    # substring must be a whole word
    assert not is_clearly_political("Electionary of plants")


def test_html_to_text_strips_scripts_and_keeps_paragraphs():
    text = html_to_text("<p>One</p><script>evil()</script><p>Two<br>three</p>")
    assert "evil" not in text
    assert "One" in text and "Two" in text and "three" in text
    assert html_to_text(None) is None and html_to_text("   ") is None


def test_entry_published_missing_is_none():
    assert entry_published({}) is None


# --- ingest behaviour ---------------------------------------------------------

@respx.mock
def test_cross_feed_dedup_by_normalized_url(bare):
    fa = _feed(bare, "https://a.example/rss")
    fb = _feed(bare, "https://b.example/rss", "Engineering")
    respx.get("https://a.example/rss").mock(return_value=httpx.Response(
        200, text=rss(item("Launch X", "https://ex.com/post/?utm_source=rss"))))
    respx.get("https://b.example/rss").mock(return_value=httpx.Response(
        200, text=rss(item("Launch X again", "https://EX.com/post#frag"))))
    r1 = run_ingest(bare, fa.id)
    r2 = run_ingest(bare, fb.id)
    assert r1.new_articles == 1 and r2.new_articles == 0 and r2.skipped_duplicates == 1
    assert len(_articles(bare)) == 1


@respx.mock
def test_same_guid_within_feed_is_not_duplicated(bare):
    f = _feed(bare, "https://a.example/rss")
    respx.get(f.url).mock(return_value=httpx.Response(200, text=rss(
        item("One", "https://ex.com/1", guid="same"),
        item("Two", "https://ex.com/2", guid="same"),
    )))
    r = run_ingest(bare, f.id)
    assert r.new_articles == 1 and r.skipped_duplicates == 1


@respx.mock
def test_conditional_get_sends_validators_and_304_keeps_state(bare):
    f = _feed(bare, "https://a.example/rss")
    route = respx.get(f.url).mock(side_effect=[
        httpx.Response(200, text=rss(item("One", "https://ex.com/1")),
                       headers={"etag": '"v1"', "last-modified": "Mon, 02 Nov 2026 08:00:00 GMT"}),
        httpx.Response(304),
    ])
    run_ingest(bare, f.id)
    r2 = run_ingest(bare, f.id)
    second = route.calls[1].request
    assert second.headers["If-None-Match"] == '"v1"'
    assert second.headers["If-Modified-Since"] == "Mon, 02 Nov 2026 08:00:00 GMT"
    assert r2.new_articles == 0 and r2.errors == {}
    row = db.get_feed_row(bare, f.id)
    assert row["etag"] == '"v1"' and row["last_error"] is None and row["last_fetched_at"] is not None
    assert len(_articles(bare)) == 1


@respx.mock
def test_error_in_one_feed_does_not_stop_others(bare):
    bad = _feed(bare, "https://bad.example/rss")
    good = _feed(bare, "https://good.example/rss", "Engineering")
    respx.get(bad.url).mock(return_value=httpx.Response(500))
    respx.get(good.url).mock(return_value=httpx.Response(
        200, text=rss(item("Deep dive", "https://ex.com/deep"))))
    result = run_ingest(bare)
    assert result.feeds_checked == 2 and result.new_articles == 1
    assert set(result.errors) == {bad.url}
    assert db.get_feed(bare, bad.id).last_error and db.get_feed(bare, good.id).last_error is None


@respx.mock
def test_malformed_feed_records_error_and_inserts_nothing(bare):
    f = _feed(bare, "https://a.example/rss")
    respx.get(f.url).mock(return_value=httpx.Response(200, text="<<< definitely not a feed >>>"))
    r = run_ingest(bare, f.id)
    assert r.new_articles == 0 and f.url in r.errors
    assert "unparseable" in r.errors[f.url]
    assert db.get_feed(bare, f.id).last_error is not None


@respx.mock
def test_run_ingest_all_skips_disabled_but_explicit_id_fetches_it(bare):
    on = _feed(bare, "https://on.example/rss")
    off = _feed(bare, "https://off.example/rss", "Engineering")
    db.update_feed(bare, off.id, enabled=False)
    respx.get(on.url).mock(return_value=httpx.Response(200, text=rss()))
    off_route = respx.get(off.url).mock(return_value=httpx.Response(200, text=rss()))
    assert run_ingest(bare).feeds_checked == 1 and not off_route.called
    assert run_ingest(bare, off.id).feeds_checked == 1 and off_route.called


@respx.mock
def test_run_ingest_unknown_feed_raises_not_found(bare):
    with pytest.raises(db.NotFound):
        run_ingest(bare, 12345)


@respx.mock
def test_feed_title_is_recorded_once(bare):
    f = _feed(bare, "https://a.example/rss")
    respx.get(f.url).mock(return_value=httpx.Response(200, text=rss(item("A", "https://ex.com/a"), title="Nice Feed")))
    run_ingest(bare, f.id)
    assert db.get_feed(bare, f.id).title == "Nice Feed"


@respx.mock
def test_politics_flag_set_at_ingest_and_clean_stays_null(bare):
    f = _feed(bare, "https://a.example/rss")
    respx.get(f.url).mock(return_value=httpx.Response(200, text=rss(
        item("Senate passes budget", "https://ex.com/p"),
        item("Battery startup launches", "https://ex.com/b"),
    )))
    r = run_ingest(bare, f.id)
    assert r.flagged_political == 1 and r.new_articles == 2
    by_title = {a.title: a for a in _articles(bare)}
    assert by_title["Senate passes budget"].is_political is True
    assert by_title["Battery startup launches"].is_political is None
    assert [a.title for a in db.list_articles(bare)[0]] == ["Battery startup launches"]


@respx.mock
def test_missing_title_falls_back_to_link_and_empty_entries_skipped(bare):
    f = _feed(bare, "https://a.example/rss")
    respx.get(f.url).mock(return_value=httpx.Response(200, text=rss(
        "<item><link>https://ex.com/no-title</link></item>",
        "<item><description>nothing</description></item>",
    )))
    r = run_ingest(bare, f.id)
    assert r.new_articles == 1
    assert _articles(bare)[0].title == "https://ex.com/no-title"


@pytest.mark.parametrize(
    "extra,expected",
    [
        ('<media:content url="https://img.example/mc.jpg" type="image/jpeg"/>', "https://img.example/mc.jpg"),
        ('<media:thumbnail url="https://img.example/th.jpg"/>', "https://img.example/th.jpg"),
        ('<enclosure url="https://img.example/enc.png" type="image/png" length="1"/>', "https://img.example/enc.png"),
        ('<enclosure url="https://x.example/a.mp3" type="audio/mpeg" length="1"/>'
         '<enclosure url="https://img.example/after.webp" type="image/webp" length="1"/>', "https://img.example/after.webp"),
        ("", None),
    ],
)
@respx.mock
def test_image_extraction_variants(bare, extra, expected):
    f = _feed(bare, "https://a.example/rss")
    respx.get(f.url).mock(return_value=httpx.Response(200, text=rss(
        item("Pic", "https://ex.com/pic", extra=extra, description="No inline image here."))))
    run_ingest(bare, f.id)
    assert _articles(bare)[0].image_url == expected


@respx.mock
def test_image_falls_back_to_first_img_in_content(bare):
    f = _feed(bare, "https://a.example/rss")
    body = '<p>Text</p><img src="https://img.example/inline.jpg"/>'
    respx.get(f.url).mock(return_value=httpx.Response(200, text=rss(
        item("Inline", "https://ex.com/inline", description=body))))
    run_ingest(bare, f.id)
    assert _articles(bare)[0].image_url == "https://img.example/inline.jpg"


@respx.mock
def test_enclosure_non_image_is_not_used_as_image(bare):
    f = _feed(bare, "https://a.example/rss")
    respx.get(f.url).mock(return_value=httpx.Response(200, text=rss(
        item("Podcast", "https://ex.com/pod", extra='<enclosure url="https://x.example/a.mp3" type="audio/mpeg" length="1"/>'))))
    run_ingest(bare, f.id)
    assert _articles(bare)[0].image_url is None


@respx.mock
def test_ingest_result_shape(bare):
    f = _feed(bare, "https://a.example/rss")
    respx.get(f.url).mock(return_value=httpx.Response(200, text=rss(item("A", "https://ex.com/a"))))
    r = run_ingest(bare, f.id)
    assert isinstance(r, IngestResult)
    assert r.model_dump().keys() == {"feeds_checked", "new_articles", "skipped_duplicates", "flagged_political", "errors"}
