"""Entry parsing helpers: URL normalization, fingerprints, text and image extraction."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup


def normalize_url(url: str) -> str:
    """Lowercase scheme+host, drop utm_* params and fragment, strip trailing slash."""
    parts = urlsplit(url.strip())
    query = urlencode(
        [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
         if not k.lower().startswith("utm_")]
    )
    path = parts.path.rstrip("/")
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, query, ""))


def normalize_title(title: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", title.lower())).strip()


def compute_fingerprint(url: str | None, title: str) -> str:
    """sha256 of the normalized URL (fallback: normalized title)."""
    basis = normalize_url(url) if url and url.strip() else normalize_title(title)
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


_BLOCK_TAGS = ["p", "div", "li", "br", "blockquote", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre"]


def html_to_text(html: str | None) -> str | None:
    if not html:
        return None
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    for tag in soup.find_all(_BLOCK_TAGS):
        tag.append("\n\n" if tag.name != "br" else "\n")
    text = re.sub(r"[ \t\r\f\v]+", " ", soup.get_text(""))
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text or None


def entry_content_html(entry: Any) -> str | None:
    contents = entry.get("content") or []
    if contents:
        # prefer the longest content block
        best = max(contents, key=lambda c: len(c.get("value", "")))
        if best.get("value"):
            return best["value"]
    return entry.get("summary") or entry.get("description") or None


def _first_url(items: Any, *, image_only: bool = False) -> str | None:
    for it in items or []:
        url = it.get("url") or it.get("href")
        if not url:
            continue
        typ = (it.get("type") or "").lower()
        medium = (it.get("medium") or "").lower()
        if image_only and not (typ.startswith("image") or medium == "image" or not (typ or medium)):
            continue
        return url
    return None


def extract_image(entry: Any, content_html: str | None) -> str | None:
    """media:content, media:thumbnail, image enclosure, then first <img> in the content."""
    url = _first_url(entry.get("media_content"), image_only=True)
    if url:
        return url
    url = _first_url(entry.get("media_thumbnail"))
    if url:
        return url
    for link in entry.get("links") or []:
        if link.get("rel") == "enclosure" and (link.get("type") or "").startswith("image"):
            if link.get("href"):
                return link["href"]
    for enc in entry.get("enclosures") or []:
        if (enc.get("type") or "").startswith("image") and enc.get("href"):
            return enc["href"]
    if content_html:
        img = BeautifulSoup(content_html, "html.parser").find("img")
        if img and img.get("src"):
            return img["src"]
    return None


def entry_published(entry: Any) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        t = entry.get(key)
        if t:
            return datetime(*t[:6], tzinfo=timezone.utc)
    return None
