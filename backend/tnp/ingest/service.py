"""Feed fetching and article ingestion."""
from __future__ import annotations

import sqlite3

import feedparser
import httpx

from tnp import db
from tnp.ingest.parse import (
    compute_fingerprint,
    entry_content_html,
    entry_published,
    extract_image,
    html_to_text,
)
from tnp.ingest.politics import is_clearly_political
from tnp.models import IngestResult

USER_AGENT = "termal-news-printer/0.1"
TIMEOUT = 20.0


def _ingest_feed(
    conn: sqlite3.Connection, client: httpx.Client, feed: sqlite3.Row, result: IngestResult
) -> None:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, */*"}
    if feed["etag"]:
        headers["If-None-Match"] = feed["etag"]
    if feed["last_modified"]:
        headers["If-Modified-Since"] = feed["last_modified"]

    resp = client.get(feed["url"], headers=headers, follow_redirects=True)
    if resp.status_code == 304:
        db.record_feed_fetch(conn, feed["id"], keep_validators=True)
        return
    resp.raise_for_status()

    parsed = feedparser.parse(resp.content)
    if parsed.bozo and not parsed.entries:
        raise ValueError(f"unparseable feed: {parsed.bozo_exception}")

    for entry in parsed.entries:
        title = (entry.get("title") or "").strip()
        url = (entry.get("link") or "").strip()
        if not title and not url:
            continue
        title = title or url
        guid = entry.get("id") or url or title
        fp = compute_fingerprint(url, title)
        if db.fingerprint_exists(conn, fp):
            result.skipped_duplicates += 1
            continue
        html = entry_content_html(entry)
        text = html_to_text(html)
        political = True if is_clearly_political(title, text) else None
        article_id = db.insert_article(
            conn, feed_id=feed["id"], guid=guid, url=url or guid, title=title,
            fingerprint=fp, author=entry.get("author") or None,
            published_at=entry_published(entry), content_html=html, content_text=text,
            image_url=extract_image(entry, html), is_political=political,
        )
        if article_id is None:  # same (feed_id, guid) or fingerprint raced in
            result.skipped_duplicates += 1
            continue
        result.new_articles += 1
        if political:
            result.flagged_political += 1

    db.record_feed_fetch(
        conn, feed["id"], etag=resp.headers.get("etag"),
        last_modified=resp.headers.get("last-modified"),
        title=(parsed.feed.get("title") or None),
    )


def run_ingest(
    conn: sqlite3.Connection, feed_id: int | None = None, client: httpx.Client | None = None
) -> IngestResult:
    """Fetch one feed (any, even disabled) or all enabled feeds. Errors are per-feed."""
    feeds = [db.get_feed_row(conn, feed_id)] if feed_id is not None else db.list_feed_rows(conn)
    result = IngestResult(feeds_checked=0, new_articles=0, skipped_duplicates=0,
                          flagged_political=0, errors={})
    own_client = client is None
    client = client or httpx.Client(timeout=TIMEOUT)
    try:
        for feed in feeds:
            result.feeds_checked += 1
            try:
                _ingest_feed(conn, client, feed, result)
            except Exception as exc:  # noqa: BLE001 - one bad feed must not abort the run
                msg = f"{type(exc).__name__}: {exc}"[:500]
                result.errors[feed["url"]] = msg
                db.record_feed_fetch(conn, feed["id"], error=msg)
    finally:
        if own_client:
            client.close()
    return result
