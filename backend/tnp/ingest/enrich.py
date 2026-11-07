"""Best-effort full-text enrichment of short articles, just before they are summarized."""
from __future__ import annotations

import logging
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import httpx

from tnp import db
from tnp.ingest.fulltext import fetch_full_text

log = logging.getLogger(__name__)

SHORT_THRESHOLD = 1500   # RSS bodies shorter than this get a full-text fetch
MIN_GAIN = 1.3           # extracted text must be this much longer than the RSS text...
MIN_GAIN_CHARS = 300     # ...and at least this many chars longer
MAX_CONCURRENCY = 4


def needs_enrichment(content_text: str | None, url: str | None) -> bool:
    return bool(url and url.startswith(("http://", "https://"))) and len((content_text or "").strip()) < SHORT_THRESHOLD


def is_meaningfully_longer(new: str | None, old: str | None) -> bool:
    if not new:
        return False
    n, o = len(new.strip()), len((old or "").strip())
    return n >= o * MIN_GAIN and n - o >= MIN_GAIN_CHARS


def enrich_rows(
    conn: sqlite3.Connection, rows: list[sqlite3.Row], *, client: httpx.Client | None = None,
    concurrency: int = MAX_CONCURRENCY,
) -> dict[int, str]:
    """Fetch full text for short rows; store improvements. Returns {article_id: new_text} for updated rows.

    Never raises; DB writes happen on the calling thread.
    """
    todo = [r for r in rows if needs_enrichment(r["content_text"], r["url"])]
    if not todo:
        return {}
    own = client is None
    client = client or httpx.Client()
    updated: dict[int, str] = {}
    try:
        with ThreadPoolExecutor(max_workers=max(1, min(concurrency, MAX_CONCURRENCY))) as pool:
            fetched = list(pool.map(lambda r: fetch_full_text(r["url"], client=client), todo))
        for row, (text, html) in zip(todo, fetched):
            if is_meaningfully_longer(text, row["content_text"]):
                db.update_article_content(conn, row["id"], text, html)
                updated[row["id"]] = text
    except Exception as exc:  # noqa: BLE001
        log.warning("enrichment aborted: %s", exc)
    finally:
        if own:
            client.close()
    return updated
