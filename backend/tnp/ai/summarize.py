"""TL;DR generation for the thermal receipt (printed WITHOUT the title, so it must stand alone)."""
from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor

from tnp.models import ArticleForAI, PoliticsVerdict, SummaryResult

from .client import AIError, chat, try_models
from .clean import MAX_INPUT_CHARS, prepare_body  # noqa: F401
from .politics import POLITICS_RULES, parse_verdict_json

log = logging.getLogger(__name__)

MAX_TLDR_CHARS = 450
SUMMARY_MAX_TOKENS = 220
COMBINED_MAX_TOKENS = 340
MIN_WORDS = 25
SHORT_INPUT_CHARS = 400  # teaser-only input: do not demand a minimum length (never pad)

BANNED_PHRASES = (
    "explores", "discusses", "delves", "sheds light", "various", "a number of",
    "highlights the importance", "in today's world", "this article", "this post", "this episode",
)
_BANNED_RE = re.compile(
    r"\b(?:explor(?:es|ing)|discuss(?:es|ing)|delv(?:es|ing)|sheds? light|various|a number of|"
    r"highlights? the importance|in today'?s (?:world|fast-paced)|this (?:article|post|episode|piece|essay))\b",
    re.IGNORECASE,
)

TLDR_RULES = """The headline is NOT printed, so the TL;DR must stand alone and name the concrete subject (company, product, person, institution or study) explicitly.
Write 2 to 3 sentences, about 45 to 70 words, never more than 450 characters, in this order:
1. What happened: who did what, what was found, or what launched.
2. The key specifics from the text: numbers, names, how it works, scope, dates.
3. One short clause on why it matters or what changes, only if the text supports it.
Rules:
- Never invent facts. If the text is only a short teaser, state just what it says, concretely, without padding.
- For podcasts, essays and opinion pieces, state the actual argument or finding, not that someone talks about a topic.
- Banned filler: explores, discusses, delves, sheds light, various, a number of, highlights the importance, in today's world, rhetorical questions, and "This article/post/episode".
- Neutral newspaper tone, active voice. Plain text only: no markdown, emoji, quotation marks, hashtags or bullet points. Do not mention that you are summarizing.
Good examples:
Linear, the issue-tracking startup, launched Linear Asks, which turns Slack messages into tracked issues without leaving the chat. Teams can route requests to the right owner automatically, and the feature is included in all paid plans. It aims to cut the copy-pasting between support channels and engineering backlogs.
A Stanford study of 2,100 adults found that people who walked 7,000 steps a day had a 47 percent lower risk of early death than those who walked 2,000. Benefits flattened beyond about 10,000 steps, suggesting the popular target is higher than needed."""

STRICT_NUDGE = (
    "\n\nYour previous answer was too vague or too short. Rewrite it: 2 to 3 concrete sentences (45 to 70 words), "
    "name the exact subject, include specific numbers or names from the text, and avoid every banned filler word."
)

SUMMARY_SYSTEM_PROMPT = f"""You write the digest paragraph for a tiny newspaper printed on a narrow receipt strip.

{TLDR_RULES}

Reply with the TL;DR text only."""

COMBINED_SYSTEM_PROMPT = f"""You prepare items for a tiny newspaper printed on a narrow receipt strip. Do two things for the article below.

1. Write a TL;DR. {TLDR_RULES}

2. Decide whether the article is political. {POLITICS_RULES} When genuinely unclear, answer false.

Reply with ONLY a JSON object, no code fences:
{{"political": true or false, "reason": "max 12 words", "tldr": "the TL;DR text"}}"""


def _score(tldr: str, in_chars: int) -> tuple[int, int]:
    """Lower is better: fewer quality issues first, then more words."""
    return len(quality_issues(tldr, input_chars=in_chars)), -len(tldr.split())


def _article_block(article: ArticleForAI) -> str:
    body = prepare_body(article.content_text or "")
    if not body:
        return (
            f"Headline: {article.title}\n\n(No article text is available; write the TL;DR from the "
            "headline alone, without inventing details.)"
        )
    return f"Headline: {article.title}\n\nArticle text:\n{body}"


def quality_issues(tldr: str, *, input_chars: int = 10**6) -> list[str]:
    """Reasons a TL;DR is not good enough to print (empty list = fine)."""
    issues: list[str] = []
    if len(tldr.split()) < MIN_WORDS and input_chars >= SHORT_INPUT_CHARS:
        issues.append("too short")
    found = sorted({m.group(0).lower() for m in _BANNED_RE.finditer(tldr)})
    if found:
        issues.append("filler: " + ", ".join(found))
    if "?" in tldr:
        issues.append("question")
    return issues


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


def summarize(
    article: ArticleForAI, *, client, model: str, fallback_model: str | None = None
) -> SummaryResult:
    """TL;DR via `model`; on AIError retry once with `fallback_model`. result.model = model used."""

    user = _article_block(article)
    in_chars = len(article.content_text or "")

    def attempt(m: str) -> SummaryResult:
        tldr = clean_tldr(chat(client, model=m, system=SUMMARY_SYSTEM_PROMPT, user=user, max_tokens=SUMMARY_MAX_TOKENS))
        if not tldr:
            raise AIError("model returned no usable TL;DR")
        if quality_issues(tldr, input_chars=in_chars):
            try:  # one stricter retry on the same model
                retry = clean_tldr(chat(client, model=m, system=SUMMARY_SYSTEM_PROMPT, user=user + STRICT_NUDGE,
                                        max_tokens=SUMMARY_MAX_TOKENS))
                if retry and _score(retry, in_chars) < _score(tldr, in_chars):
                    tldr = retry
            except AIError:
                pass  # keep the first answer
        return SummaryResult(article_id=article.id, tldr=tldr, model=m)

    return try_models([model, fallback_model or ""], attempt)


def summarize_many(
    articles: list[ArticleForAI], *, client, model: str, concurrency: int = 4,
    fallback_model: str | None = None,
) -> list[SummaryResult]:
    """Summarize concurrently; per-article failures are logged and skipped. Input order is preserved."""

    def one(a: ArticleForAI) -> SummaryResult | None:
        try:
            return summarize(a, client=client, model=model, fallback_model=fallback_model)
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
    article: ArticleForAI, *, client, model: str, fallback_model: str | None = None
) -> tuple[SummaryResult, PoliticsVerdict]:
    """One call returning both the TL;DR and the politics verdict (cheaper than two calls).

    On AIError the call is retried once with `fallback_model`; result.model records the model used.
    """

    user = _article_block(article)
    in_chars = len(article.content_text or "")

    def once(m: str, u: str) -> tuple[str, str]:
        raw = chat(client, model=m, system=COMBINED_SYSTEM_PROMPT, user=u, max_tokens=COMBINED_MAX_TOKENS)
        data = _extract_json(raw)
        return (clean_tldr(str(data.get("tldr", ""))) if data else ""), raw

    def attempt(m: str) -> tuple[SummaryResult, PoliticsVerdict]:
        tldr, raw = once(m, user)
        if not tldr:
            raise AIError("combined response had no usable tldr")
        if quality_issues(tldr, input_chars=in_chars):
            try:  # one stricter retry on the same model
                tldr2, raw2 = once(m, user + STRICT_NUDGE)
                if tldr2 and _score(tldr2, in_chars) < _score(tldr, in_chars):
                    tldr, raw = tldr2, raw2
            except AIError:
                pass  # keep the first answer
        verdict = parse_verdict_json(raw, article.id)
        return SummaryResult(article_id=article.id, tldr=tldr, model=m), verdict

    return try_models([model, fallback_model or ""], attempt)
