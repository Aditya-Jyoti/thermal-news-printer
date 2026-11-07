"""Offline TL;DR quality check on recent articles.

    uv run python -m tnp.ai.eval [--n 8] [--per-category 2] [--model M] [--enrich-only]

Pulls recent articles from the DB (run `python -m tnp.pipeline ingest` first), enriches short ones with
their full text (stored in the DB), then summarizes them and prints each result with quality flags.
Summaries are NOT saved. `--enrich-only` needs no API key and just reports input lengths per feed.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import defaultdict

from tnp import db
from tnp.config import load_config
from tnp.ingest.enrich import enrich_rows

from .client import AIError, AIUnavailable, default_model, make_client
from .summarize import MAX_TLDR_CHARS, quality_issues, summarize
from tnp.models import ArticleForAI


def pick_articles(conn: sqlite3.Connection, n: int, per_category: int) -> list[sqlite3.Row]:
    """Newest non-political articles, at most `per_category` per category, round-robin across categories."""
    rows = list(conn.execute(
        "SELECT a.*, c.slug AS category_slug, f.title AS feed_title, f.url AS feed_url "
        "FROM articles a JOIN feeds f ON f.id=a.feed_id JOIN categories c ON c.id=f.category_id "
        "WHERE a.is_political IS NULL OR a.is_political=0 "
        "ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC LIMIT 2000"))
    by_cat: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        if len(by_cat[r["category_slug"]]) < per_category:
            by_cat[r["category_slug"]].append(r)
    picked: list[sqlite3.Row] = []
    for i in range(per_category):
        for lst in by_cat.values():
            if i < len(lst) and len(picked) < n:
                picked.append(lst[i])
    return picked


def _feed_name(r: sqlite3.Row) -> str:
    return r["feed_title"] or r["feed_url"]


def _print_enrichment_table(rows: list[sqlite3.Row], before: dict[int, int], after: dict[int, int]) -> None:
    per_feed: dict[str, list[int]] = defaultdict(list)
    for r in rows:
        per_feed[_feed_name(r)].append(r["id"])
    print(f"{'feed':44} {'n':>3} {'avg before':>11} {'avg after':>10}")
    for name, ids in sorted(per_feed.items()):
        b = sum(before[i] for i in ids) / len(ids)
        a = sum(after[i] for i in ids) / len(ids)
        print(f"{name[:44]:44} {len(ids):>3} {b:>11.0f} {a:>10.0f}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tnp.ai.eval", description=__doc__.split("\n\n")[0])
    ap.add_argument("--n", type=int, default=8, help="max articles to evaluate")
    ap.add_argument("--per-category", type=int, default=2, help="max articles per category")
    ap.add_argument("--model", default=None, help="override the model (default: TNP_MODEL / settings)")
    ap.add_argument("--enrich-only", action="store_true", help="only run full-text enrichment (no API key needed)")
    args = ap.parse_args(argv)

    client = None
    if not args.enrich_only:
        try:
            client = make_client(load_config().openrouter_api_key)
        except AIUnavailable as e:
            print(f"{e}\nSet OPENROUTER_API_KEY (e.g. in backend/.env) and retry, or use --enrich-only.")
            return 0

    conn = db.connect(load_config().db_path)
    try:
        db.init_db(conn)
        rows = pick_articles(conn, args.n, args.per_category)
        if not rows:
            print("No articles in the database. Run: uv run python -m tnp.pipeline ingest")
            return 0
        before = {r["id"]: len((r["content_text"] or "").strip()) for r in rows}
        enriched = enrich_rows(conn, rows)
        after = {i: len(enriched[i]) if i in enriched else before[i] for i in before}

        if args.enrich_only:
            _print_enrichment_table(rows, before, after)
            print(f"\nenriched {len(enriched)} of {len(rows)} articles")
            return 0

        model = args.model or db.get_settings(conn).model or default_model()
        flagged = 0
        for r in rows:
            art = ArticleForAI(
                id=r["id"], title=r["title"], url=r["url"],
                content_text=enriched.get(r["id"], r["content_text"]),
                category_slug=r["category_slug"], published_at=None,
            )
            print("=" * 78)
            print(f"feed:   {_feed_name(r)}   [#{r['category_slug']}]")
            print(f"title:  {r['title']}")
            print(f"input:  {before[r['id']]} chars -> {after[r['id']]} chars after enrichment")
            try:
                tldr = summarize(art, client=client, model=model).tldr
            except AIError as e:
                print(f"ERROR:  {e}")
                flagged += 1
                continue
            issues = quality_issues(tldr, input_chars=after[r["id"]])
            if len(tldr) > MAX_TLDR_CHARS:
                issues.append("over cap")
            flagged += bool(issues)
            print(f"tldr:   {tldr}")
            print(f"words:  {len(tldr.split())}  chars: {len(tldr)}  flags: {', '.join(issues) or 'none'}")
        print("=" * 78)
        print(f"model {model}: {len(rows)} articles, {flagged} flagged")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
