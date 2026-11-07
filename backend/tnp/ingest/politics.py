"""Conservative keyword prefilter for political content.

Only flags clear matches; everything else stays NULL for the AI classifier.
"""
from __future__ import annotations

import re

POLITICAL_KEYWORDS: tuple[str, ...] = (
    "election", "elections", "senate", "senator", "congress", "congressional",
    "parliament", "parliamentary", "trump", "biden", "obama",
    "democrat", "democrats", "democratic party", "republican", "republicans", "gop",
    "campaign trail", "presidential", "partisan", "legislation", "geopolitics",
    "geopolitical", "white house", "prime minister", "lawmakers", "impeachment",
    "ballot", "midterms", "political party", "politician", "politicians",
    "kremlin", "brexit",
)

_PATTERN = re.compile(
    r"\b(?:" + "|".join(re.escape(k) for k in POLITICAL_KEYWORDS) + r")\b", re.IGNORECASE
)


def is_clearly_political(title: str, text: str | None = None) -> bool:
    """True if the title or the start of the body contains a political keyword."""
    haystack = f"{title}\n{(text or '')[:1500]}"
    return _PATTERN.search(haystack) is not None
