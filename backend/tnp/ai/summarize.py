"""TL;DR generation for the thermal receipt (printed WITHOUT the title, so it must stand alone)."""
from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor

from tnp.models import ArticleForAI, PoliticsVerdict, SummaryResult

from .client import AIError, chat
from .politics import POLITICS_RULES, parse_verdict_json

log = logging.getLogger(__name__)

MAX_INPUT_CHARS = 6000
MAX_TLDR_CHARS = 280

SUMMARY_SYSTEM_PROMPT = """You write the one-paragraph digest for a tiny newspaper printed on a narrow receipt strip. The headline is NOT printed, so your text must stand on its own.

Write a TL;DR of the article below:
- 1 to 2 punchy sentences, about 25 to 40 words, never more than 280 characters.
- Lead with the concrete news: who did what, or what was found or launched. Include the key number or fact if there is one.
- Newspaper tone: neutral, specific, active voice, present or simple past tense.
- Plain text only. No markdown, no bullet points, no emoji, no hashtags, no quotation marks around the whole text.
- Never start with "This article", "The article", "The author", "In this post", "TL;DR" or similar. Never mention that you are summarizing.
- Do not repeat the headline word for word; do not editorialize or add facts that are not in the text.

Reply with the TL;DR text only."""

COMBINED_SYSTEM_PROMPT = f"""You prepare items for a tiny newspaper printed on a narrow receipt strip. Do two things for the article below.

1. Write a TL;DR (the headline is NOT printed, so it must stand alone): 1 to 2 punchy sentences, about 25 to 40 words, never more than 280 characters. Lead with the concrete news (who did what, or what was found or launched). Neutral newspaper tone, plain text, no markdown, emoji, hashtags or quotation marks. Never start with "This article" or "TL;DR".

2. Decide whether the article is political. {POLITICS_RULES} When genuinely unclear, answer false.

Reply with ONLY a JSON object, no code fences:
{{"political": true or false, "reason": "max 12 words", "tldr": "the TL;DR text"}}"""


def _article_block(article: ArticleForAI) -> str:
    body = (article.content_text or "").strip()
    if not body:
        return (
            f"Headline: {article.title}\n\n(No article text is available; write the TL;DR from the "
            "headline alone, without inventing details.)"
        )
    body = re.sub(r"\s+", " ", body)[:MAX_INPUT_CHARS]
    return f"Headline: {article.title}\n\nArticle text:\n{body}"


_PREFIX_RE = re.compile(
    r"^\s*(?:here(?:'s| is) (?:a |the )?(?:tl;?dr|summary)[^:\n]*:|tl;?\s?dr\s*[:\-–—]?|summary\s*:|digest\s*:)\s*",
    re.IGNORECASE,
)
_WRAPPERS = "\"'“”‘’`«»"


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    ends = list(re.finditer(r"[.!?](?=\s|$)", cut))
    if ends and ends[-1].end() >= limit * 0.4:
        return cut[: ends[-1].end()].strip()
    cut = text[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-–—") + "…"


def clean_tldr(raw: str, max_chars: int = MAX_TLDR_CHARS) -> str:
    """Normalize model output into printable plain text of at most `max_chars`."""
    t = raw.strip()
    t = t.replace("```", "")
    t = _PREFIX_RE.sub("", t)
    t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)  # markdown links/images -> their text
    t = re.sub(r"^\s{0,3}(?:#{1,6}\s+|[-*•>]\s+|\d+[.)]\s+)", "", t, flags=re.MULTILINE)
    t = re.sub(r"\*\*|__|~~|`", "", t)
    t = re.sub(r"(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])", "", t)  # lone emphasis asterisks
    t = re.sub(r"[\U0001F000-\U0001FAFF☀-➿️‍]", "", t)  # emoji
    t = re.sub(r"\s+", " ", t).strip()
    t = t.strip(_WRAPPERS).strip()
    t = _PREFIX_RE.sub("", t)
    return _truncate(t, max_chars)


def summarize(article: ArticleForAI, *, client, model: str) -> SummaryResult:
    raw = chat(client, model=model, system=SUMMARY_SYSTEM_PROMPT, user=_article_block(article), max_tokens=120)
    tldr = clean_tldr(raw)
    if not tldr:
        raise AIError("model returned no usable TL;DR")
    return SummaryResult(article_id=article.id, tldr=tldr, model=model)


def summarize_many(
    articles: list[ArticleForAI], *, client, model: str, concurrency: int = 4
) -> list[SummaryResult]:
    """Summarize concurrently; per-article failures are logged and skipped. Input order is preserved."""

    def one(a: ArticleForAI) -> SummaryResult | None:
        try:
            return summarize(a, client=client, model=model)
        except Exception as e:  # noqa: BLE001 - one bad article must not sink the batch
            log.warning("summarize failed for article %s: %s", a.id, e)
            return None

    if not articles:
        return []
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        results = list(pool.map(one, articles))
    return [r for r in results if r is not None]


def _extract_json(raw: str) -> dict | None:
    m = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def summarize_and_classify(
    article: ArticleForAI, *, client, model: str
) -> tuple[SummaryResult, PoliticsVerdict]:
    """One call returning both the TL;DR and the politics verdict (cheaper than two calls)."""
    raw = chat(client, model=model, system=COMBINED_SYSTEM_PROMPT, user=_article_block(article), max_tokens=300)
    data = _extract_json(raw)
    tldr = clean_tldr(str(data.get("tldr", ""))) if data else ""
    if not tldr:
        raise AIError("combined response had no usable tldr")
    verdict = parse_verdict_json(raw, article.id)
    return SummaryResult(article_id=article.id, tldr=tldr, model=model), verdict
