"""Pure, deterministic selection of the next print batch."""
from __future__ import annotations

from datetime import datetime, timezone

from tnp.models import DigestCandidate, DigestItem

from .similarity import NEAR_DUPLICATE_THRESHOLD, jaccard, title_tokens

DEFAULT_CATEGORY_LIMIT = 2


def _sort_key(c: DigestCandidate) -> tuple:
    # Newest first; undated last; article_id desc as a stable tiebreak.
    p = c.published_at
    if p is None:
        return (1, 0.0, -c.article_id)
    if p.tzinfo is None:
        p = p.replace(tzinfo=timezone.utc)
    return (0, -p.timestamp(), -c.article_id)


def select_digest(
    candidates: list[DigestCandidate],
    *,
    limits: dict[str, int],
    max_total: int,
    printed_ids: set[int],
    last_print_titles: list[str],
) -> list[DigestItem]:
    prev_tokens = [title_tokens(t) for t in last_print_titles]

    # Per-category queues of eligible candidates, newest first.
    queues: dict[str, list[DigestCandidate]] = {}
    seen_ids: set[int] = set()
    for c in sorted(candidates, key=_sort_key):
        if c.article_id in printed_ids or c.article_id in seen_ids:
            continue
        if limits.get(c.category_slug, DEFAULT_CATEGORY_LIMIT) <= 0:
            continue
        seen_ids.add(c.article_id)
        queues.setdefault(c.category_slug, []).append(c)

    in_limits = [s for s in limits if s in queues]
    rest = sorted(s for s in queues if s not in limits)
    order = in_limits + rest

    taken: dict[str, int] = {s: 0 for s in order}
    chosen_tokens: list[frozenset[str]] = []
    result: list[DigestItem] = []
    cursors = {s: 0 for s in order}

    progressed = True
    while progressed and len(result) < max_total:
        progressed = False
        for slug in order:
            if len(result) >= max_total:
                break
            cap = limits.get(slug, DEFAULT_CATEGORY_LIMIT)
            q = queues[slug]
            # Take the next acceptable candidate from this category (skipping near-duplicates).
            while taken[slug] < cap and cursors[slug] < len(q):
                c = q[cursors[slug]]
                cursors[slug] += 1
                toks = title_tokens(c.title)
                if any(jaccard(toks, o) >= NEAR_DUPLICATE_THRESHOLD for o in prev_tokens):
                    continue
                if any(jaccard(toks, o) >= NEAR_DUPLICATE_THRESHOLD for o in chosen_tokens):
                    continue
                chosen_tokens.append(toks)
                taken[slug] += 1
                result.append(
                    DigestItem(
                        article_id=c.article_id,
                        position=len(result) + 1,
                        category_slug=slug,
                        tldr=c.tldr,
                    )
                )
                progressed = True
                break
    return result
