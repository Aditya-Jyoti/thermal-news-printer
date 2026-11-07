"""Full-article extraction for items whose RSS body is only a teaser."""
from __future__ import annotations

import logging

import httpx
import trafilatura

log = logging.getLogger(__name__)

USER_AGENT = "termal-news-printer/0.1"
TIMEOUT = 15.0
MAX_BYTES = 3_000_000


def fetch_full_text(url: str, *, client: httpx.Client) -> tuple[str | None, str | None]:
    """Download `url` and extract (plain_text, html) of the main article.

    Returns (None, None) on any failure (HTTP error, timeout, non-HTML, nothing extractable).
    """
    try:
        with client.stream(
            "GET", url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.5"},
            timeout=TIMEOUT, follow_redirects=True,
        ) as resp:
            if resp.status_code >= 400:
                log.info("fulltext %s -> HTTP %s", url, resp.status_code)
                return None, None
            ctype = resp.headers.get("content-type", "").lower()
            if ctype and "html" not in ctype and "xml" not in ctype:
                return None, None
            buf = bytearray()
            for chunk in resp.iter_bytes():
                buf.extend(chunk)
                if len(buf) >= MAX_BYTES:
                    break
            encoding = resp.encoding or "utf-8"
        page = bytes(buf[:MAX_BYTES]).decode(encoding, errors="replace")
        text = trafilatura.extract(page, include_comments=False, include_tables=False, favor_recall=True)
        if not text or not text.strip():
            return None, None
        html = trafilatura.extract(
            page, output_format="html", include_comments=False, include_tables=False, favor_recall=True
        )
        return text.strip(), (html or None)
    except Exception as exc:  # noqa: BLE001 - enrichment is best-effort
        log.info("fulltext %s failed: %s: %s", url, type(exc).__name__, exc)
        return None, None
