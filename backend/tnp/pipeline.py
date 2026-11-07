"""Wiring layer: ingest -> AI summarize/classify -> digest -> print.

Run `python -m tnp.pipeline [ingest|process|digest|cycle]` for a JSON result.
"""
from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel

from tnp import db
from tnp.ai import AIError, AIUnavailable, make_client, summarize, summarize_and_classify
from tnp.config import load_config
from tnp.digest import select_digest
from tnp.ingest.enrich import enrich_rows
from tnp.ingest.service import run_ingest
from tnp.models import (
    ArticleForAI,
    DigestCandidate,
    DigestItem,
    IngestResult,
    PrintRecord,
    PrintTrigger,
    Settings,
)

log = logging.getLogger(__name__)


class ProcessResult(BaseModel):
    summarized: int = 0
    flagged_political: int = 0
    failed: int = 0
    skipped_no_key: bool = False


class CycleResult(BaseModel):
    ingest: IngestResult
    process: ProcessResult
    digest: list[DigestItem]
    print_record: PrintRecord | None = None


def _parse_dt(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def article_for_ai(row: sqlite3.Row) -> ArticleForAI:
    """Build the AI input from an `articles.* + category_slug` row."""
    return ArticleForAI(
        id=row["id"], title=row["title"], url=row["url"], content_text=row["content_text"],
        category_slug=row["category_slug"], published_at=_parse_dt(row["published_at"]),
    )


def _is_recent(row: sqlite3.Row, cutoff: datetime) -> bool:
    when = _parse_dt(row["published_at"]) or _parse_dt(row["fetched_at"])
    return when is None or when >= cutoff


def process_pending(
    conn: sqlite3.Connection, *, client: Any = None, settings: Settings | None = None,
    limit: int = 40, max_age_days: int = 4,
) -> ProcessResult:
    """Summarize (and politics-classify) recent articles that lack a TL;DR, newest first.

    Never raises for a missing API key or a per-article AI failure.
    """
    result = ProcessResult()
    settings = settings or db.get_settings(conn)
    if client is None:
        try:
            client = make_client(load_config().openrouter_api_key)
        except AIUnavailable:
            result.skipped_no_key = True
            return result

    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    # Over-fetch so old rows filtered out by age don't starve the batch.
    rows = [r for r in db.list_articles_needing_summary(conn, limit * 5 + 50) if _is_recent(r, cutoff)]
    batch = rows[:limit]
    enriched = enrich_rows(conn, batch)
    for row in batch:
        art = article_for_ai(row)
        if row["id"] in enriched:
            art = art.model_copy(update={"content_text": enriched[row["id"]]})
        try:
            if row["is_political"] is None:
                summary, verdict = summarize_and_classify(
                    art, client=client, model=settings.model, fallback_model=settings.fallback_model
                )
                db.set_political(conn, art.id, verdict.is_political)
                if verdict.is_political:
                    result.flagged_political += 1
                    continue
            else:
                summary = summarize(
                    art, client=client, model=settings.model, fallback_model=settings.fallback_model
                )
            db.upsert_summary(conn, art.id, summary.tldr, summary.model)
            result.summarized += 1
        except AIUnavailable:
            result.skipped_no_key = True
            break
        except AIError as exc:
            log.warning("AI failed for article %s: %s", art.id, exc)
            result.failed += 1
    return result


def build_digest(conn: sqlite3.Connection) -> list[DigestItem]:
    """The next print batch given limits, settings and print history."""
    candidates = [
        DigestCandidate(
            article_id=r["article_id"], title=r["title"], category_slug=r["category_slug"],
            tldr=r["tldr"], published_at=_parse_dt(r["published_at"]),
        )
        for r in db.list_digest_candidates(conn)
    ]
    limits = {c.slug: c.print_limit for c in db.list_categories(conn)}
    last_titles = [i.title for i in db.get_last_print_items(conn) if i.title]
    return select_digest(
        candidates, limits=limits, max_total=db.get_settings(conn).max_items_total,
        printed_ids=db.get_printed_article_ids(conn), last_print_titles=last_titles,
    )


def run_cycle(conn: sqlite3.Connection, *, trigger: PrintTrigger = "schedule") -> CycleResult:
    from tnp import print as printing  # late import: Phase 3 swaps the implementation

    ingest = run_ingest(conn)
    process = process_pending(conn)
    digest = build_digest(conn)
    record = printing.deliver(conn, digest, trigger) if digest else None
    return CycleResult(ingest=ingest, process=process, digest=digest, print_record=record)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="tnp.pipeline")
    parser.add_argument("command", choices=["ingest", "process", "digest", "cycle"])
    parser.add_argument("--limit", type=int, default=40, help="max articles to process")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO)

    conn = db.connect(load_config().db_path)
    try:
        db.init_db(conn)
        from tnp.seed import seed_defaults
        seed_defaults(conn)
        out: Any
        if args.command == "ingest":
            out = run_ingest(conn)
        elif args.command == "process":
            out = process_pending(conn, limit=args.limit)
        elif args.command == "digest":
            out = build_digest(conn)
        else:
            out = run_cycle(conn, trigger="manual")
    finally:
        conn.close()
    json.dump(
        [i.model_dump(mode="json") for i in out] if isinstance(out, list) else out.model_dump(mode="json"),
        sys.stdout, indent=2,
    )
    print()


if __name__ == "__main__":
    main()
