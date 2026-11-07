"""Title normalization and token Jaccard similarity for near-duplicate detection."""
from __future__ import annotations

import re
import unicodedata

NEAR_DUPLICATE_THRESHOLD = 0.8


def normalize_title(title: str) -> str:
    t = unicodedata.normalize("NFKD", title)
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def title_tokens(title: str) -> frozenset[str]:
    return frozenset(normalize_title(title).split())


def jaccard(a: frozenset[str] | set[str], b: frozenset[str] | set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def is_near_duplicate(a: str, b: str, threshold: float = NEAR_DUPLICATE_THRESHOLD) -> bool:
    return jaccard(title_tokens(a), title_tokens(b)) >= threshold
