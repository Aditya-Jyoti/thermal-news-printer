"""Conservative input cleanup: drop newsletter/podcast boilerplate lines and build a bounded prompt body."""
from __future__ import annotations

import re

MAX_INPUT_CHARS = 12000

_URL_ONLY = re.compile(r"^\(?<?(?:https?://|www\.)\S+>?\)?[.,]?$", re.IGNORECASE)
# Bare one-to-four word labels ("Subscribe", "Share", "Read more").
_BARE = re.compile(
    r"^(?:subscribe|share|sponsored|sponsor|advertisement|read more|continue reading|leave a comment|"
    r"sign up|click here|show notes|transcript|full transcript|listen now|watch now)\b[\w\s!.:|-]{0,20}$",
    re.IGNORECASE,
)
# Short call-to-action lines (<= 120 chars).
_SHORT_CTA = re.compile(
    r"^(?:listen (?:to|now|on)|watch (?:the|on|now)|subscribe (?:to|now|here|on|for)|share (?:this|on|via|with)|"
    r"leave a comment|like and subscribe|follow us|sign up (?:for|to|now)|click here|get the newsletter|"
    r"support (?:us|the show)|(?:the )?full (?:episode|transcript))\b",
    re.IGNORECASE,
)
# Lines of any (reasonable) length that are boilerplate by their opening.
_ALWAYS = re.compile(
    r"^(?:this (?:post|article|story|piece|episode) (?:was )?(?:originally )?(?:published|appeared)|"
    r"the post .{0,200}appeared first on|originally published (?:on|at|in)|"
    r"sponsored by\b|this (?:episode|issue|post) is (?:sponsored|brought to you) by|"
    r"(?:subscribe|share) (?:this|to|now|the)\b.{0,80}$|"
    r"if you(?:'d| would)? (?:like|enjoy).{0,60}(?:subscribe|newsletter)|"
    r"you(?:'re| are) (?:receiving|getting) this (?:email|newsletter)|"
    r"unsubscribe\b|view (?:this )?(?:email )?in (?:your )?browser)",
    re.IGNORECASE,
)
_GREETING = re.compile(r"^(?:hi|hello|hey|welcome)\b[^.\n]{0,60}?\bthis is\b", re.IGNORECASE)
_GREETING_HINT = re.compile(r"newsletter|podcast|episode|issue|subscribers?|bonus|edition", re.IGNORECASE)


def _is_boilerplate(line: str) -> bool:
    s = line.strip()
    if not s:
        return False
    if _URL_ONLY.match(s):
        return True
    if len(s.split()) <= 4 and _BARE.match(s):
        return True
    if len(s) <= 120 and _SHORT_CTA.match(s):
        return True
    if _ALWAYS.match(s):
        return True
    if len(s) <= 500 and _GREETING.match(s) and _GREETING_HINT.search(s):
        return True
    return False


def strip_boilerplate(text: str) -> str:
    """Remove obvious newsletter/podcast boilerplate lines; keep everything else untouched."""
    kept = [ln for ln in text.splitlines() if not _is_boilerplate(ln)]
    out = "\n".join(kept)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def prepare_body(text: str, limit: int = MAX_INPUT_CHARS) -> str:
    """Clean and bound article text: keep the beginning, cutting at a paragraph (else sentence/word) boundary."""
    paras = [re.sub(r"[ \t\f\v]+", " ", p).strip() for p in re.split(r"\n\s*\n|\n", strip_boilerplate(text))]
    body = "\n".join(p for p in paras if p)
    if len(body) <= limit:
        return body
    cut = body[:limit]
    nl = cut.rfind("\n")
    if nl >= limit * 0.5:
        return cut[:nl].rstrip()
    ends = list(re.finditer(r"[.!?](?=\s|$)", cut))
    if ends and ends[-1].end() >= limit * 0.5:
        return cut[: ends[-1].end()]
    return cut[: cut.rfind(" ")].rstrip() if " " in cut else cut
