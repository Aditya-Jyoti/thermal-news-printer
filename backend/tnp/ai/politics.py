"""AI politics classifier. CLAUDE.md: content must be STRICTLY non-political."""
from __future__ import annotations

import json
import logging
import re

from tnp.models import ArticleForAI, PoliticsVerdict

from .client import chat

log = logging.getLogger(__name__)

POLITICS_RULES = (
    "Political = elections, political parties, politicians or government officials as the focus, "
    "legislation or regulatory fights, partisan policy debates, protests, geopolitical conflict or war commentary, "
    "culture-war topics. "
    "NOT political (allowed) = new initiatives, education, scientific breakthroughs, product launches, "
    "startup news, engineering deep dives, psychology and learning, and major breaking news such as disasters "
    "or accidents. A company or product merely mentioning a government or law in passing is not political."
)

POLITICS_SYSTEM_PROMPT = f"""You are a strict content filter for a non-political daily news print.
{POLITICS_RULES}
When it is genuinely unclear, answer false.

Reply with ONLY a JSON object, no code fences:
{{"political": true or false, "reason": "max 12 words"}}"""

_FALSE_WORDS = {"false", "no", "0", "n"}
_TRUE_WORDS = {"true", "yes", "1", "y"}


def _as_bool(v) -> bool | None:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in _TRUE_WORDS:
            return True
        if s in _FALSE_WORDS:
            return False
    return None


def parse_verdict_json(raw: str, article_id: int) -> PoliticsVerdict:
    """Robustly parse a verdict; unparseable output yields political=False, reason='unparsed'."""
    flag: bool | None = None
    reason: str | None = None
    span = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    first = re.search(r"\{.*?\}", raw, flags=re.DOTALL)
    for cand in (span.group(0) if span else None, first.group(0) if first else None):
        if not cand:
            continue
        try:
            obj = json.loads(cand)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            flag = _as_bool(obj.get("political", obj.get("is_political")))
            r = obj.get("reason")
            reason = str(r).strip()[:200] if r else None
            break
    if flag is None:  # loose fallback: `"political": true`, `Political: yes`, or a bare true/false
        lm = re.search(r"political\W{0,5}(true|false|yes|no)\b", raw, flags=re.IGNORECASE)
        if lm:
            flag = _as_bool(lm.group(1))
        else:
            bm = re.fullmatch(r"\W*(true|false|yes|no)\W*", raw.strip(), flags=re.IGNORECASE)
            if bm:
                flag = _as_bool(bm.group(1))
    if flag is None:
        log.warning("unparsed politics verdict for article %s: %r", article_id, raw[:120])
        return PoliticsVerdict(article_id=article_id, is_political=False, reason="unparsed")
    return PoliticsVerdict(article_id=article_id, is_political=flag, reason=reason)


def classify_politics(article: ArticleForAI, *, client, model: str) -> PoliticsVerdict:
    body = re.sub(r"\s+", " ", (article.content_text or "").strip())[:1500]
    user = f"Headline: {article.title}\n\nExcerpt: {body}" if body else f"Headline: {article.title}"
    raw = chat(client, model=model, system=POLITICS_SYSTEM_PROMPT, user=user, max_tokens=60, temperature=0.0)
    return parse_verdict_json(raw, article.id)
