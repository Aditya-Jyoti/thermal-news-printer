# termal-news-printer — Architecture & Shared Contract

This file is the contract that parallel workstreams code against. Change it only via the Orchestrator.

## Repository layout

```
backend/                     Python 3.12+, managed by uv (pyproject.toml)
  tnp/
    models.py                Shared pydantic models (Orchestrator-owned; do not change shapes)
    config.py                Settings from env                       [Stream A]
    db.py                    SQLite schema + repository functions    [Stream A]
    seed.py                  Default categories/feeds seeding         [Stream A]
    ingest/                  RSS fetching, parsing, dedup, keyword politics prefilter [Stream A]
    api/                     FastAPI app + CRUD routers               [Stream A]
    ai/                      OpenRouter client, summarizer, AI politics classifier [Stream B]
    digest/                  Print-batch selection (limits, dedup vs. printed)     [Stream B]
    print/                   Pillow 384px renderer + BLE (Phase 3, later)
  tests/
mobile/                      Expo (React Native, TypeScript) app      [Stream C]
docs/
```

Streams B's code must be pure / dependency-injected: it receives models from `tnp.models`
and must NOT import `tnp.db`. The Orchestrator wires B into A's DB and API after merge.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | — | required for AI; code must degrade gracefully when missing |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible |
| `TNP_MODEL` | `google/gemma-3-12b-it` | summarization model |
| `TNP_FALLBACK_MODEL` | `deepseek/deepseek-v4.1-flash` | used when the primary model errors |
| `TNP_DB_PATH` | `./data/tnp.sqlite3` | |
| `TNP_API_HOST` / `TNP_API_PORT` | `0.0.0.0` / `8000` | |
| `TNP_PRINTER` | `ble` | `ble` = real BLE printer; `dry` = render + mark printed without hardware; `off` = render + save, mark failed ("printer disabled") |

## SQLite schema (Stream A implements in `tnp/db.py`)

```sql
categories(id INTEGER PK, name TEXT UNIQUE NOT NULL, slug TEXT UNIQUE NOT NULL,
           color TEXT NULL, print_limit INTEGER NOT NULL DEFAULT 2, created_at TEXT NOT NULL)
feeds(id INTEGER PK, url TEXT UNIQUE NOT NULL, title TEXT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1, etag TEXT NULL, last_modified TEXT NULL,
      last_fetched_at TEXT NULL, last_error TEXT NULL, created_at TEXT NOT NULL)
articles(id INTEGER PK, feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
         guid TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, author TEXT NULL,
         published_at TEXT NULL, fetched_at TEXT NOT NULL,
         content_html TEXT NULL, content_text TEXT NULL, image_url TEXT NULL,
         fingerprint TEXT UNIQUE NOT NULL,      -- sha256 of normalized url (fallback: normalized title)
         is_political INTEGER NULL,             -- NULL = unchecked, 0/1
         UNIQUE(feed_id, guid))
summaries(article_id INTEGER PK REFERENCES articles(id) ON DELETE CASCADE,
          tldr TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL)
prints(id INTEGER PK, created_at TEXT NOT NULL, trigger TEXT NOT NULL,   -- 'manual' | 'schedule'
       status TEXT NOT NULL,                    -- 'pending' | 'printed' | 'failed'
       error TEXT NULL)
print_items(print_id INTEGER REFERENCES prints(id) ON DELETE CASCADE,
            article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
            position INTEGER NOT NULL, category_slug TEXT NOT NULL, tldr TEXT NOT NULL,
            PRIMARY KEY(print_id, position))
schedules(id INTEGER PK, cron TEXT NOT NULL, label TEXT NULL, enabled INTEGER NOT NULL DEFAULT 1)
settings(key TEXT PK, value TEXT NOT NULL)      -- JSON-encoded values
```

All timestamps are ISO-8601 UTC strings.

## Default seed data

| Category (slug) | Feeds |
|---|---|
| Products (`products`) | https://hnrss.org/launches, https://techcrunch.com/category/startups/feed/ |
| Engineering (`engineering`) | https://www.infoq.com/feed/, https://blog.cloudflare.com/rss/, https://github.blog/engineering/feed/, https://newsletter.pragmaticengineer.com/feed |
| Psychology (`psychology`) | https://www.psypost.org/feed/, https://www.psychologytoday.com/us/front/feed |
| Learning (`learning`) | https://bigthink.com/feed/, https://www.sciencedaily.com/rss/top/science.xml, https://www.quantamagazine.org/feed/ |

The retired defaults (Freakonomics NYT blog, Big Think feedburner, Pragmatic Engineer blog) are replaced on existing installs by mobile DB migration v4. Mobile also has the setting `max_age_days` (default 3, 1-14).

Default schedule: `0 8 * * *` ("Morning edition"). Default settings: `{"max_items_total": 8, "model": "google/gemma-3-12b-it", "fallback_model": "deepseek/deepseek-v4.1-flash"}`.

## Deduplication rules
1. Ingest: an article whose `fingerprint` already exists is skipped (cross-feed dedup).
2. Print selection: never select an article that appears in a `print_items` row of a `printed` or `pending` print.
   Items of `failed` prints become eligible again (they never reached paper).
3. Print selection: never select an article whose normalized title is near-identical (token Jaccard ≥ 0.8)
   to an item in the most recent print, or to another item in the same batch.
4. Political articles (`is_political = 1`) are never printed and are hidden from the default feed.

## REST API (Stream A implements; Stream C consumes)

Base URL configurable in the app (default `http://<lan-ip>:8000`). JSON everywhere, shapes = `tnp/models.py`.

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /health` | | `{"status":"ok"}` |
| `GET /categories` | | `Category[]` |
| `POST /categories` | `CategoryCreate` | `Category` (201) |
| `PATCH /categories/{id}` | `CategoryUpdate` | `Category` |
| `DELETE /categories/{id}` | | 204 (cascades feeds) |
| `GET /feeds` | `?category_id=` | `Feed[]` |
| `POST /feeds` | `FeedCreate` | `Feed` (201) |
| `PATCH /feeds/{id}` | `FeedUpdate` | `Feed` |
| `DELETE /feeds/{id}` | | 204 |
| `POST /feeds/refresh` | `?feed_id=` optional | `IngestResult` |
| `GET /articles` | `?category_id=&limit=50&offset=0&include_political=false` | `Page[ArticleSummary]` |
| `GET /articles/{id}` | | `ArticleDetail` |
| `GET /prints` | `?limit=20&offset=0` | `Page[PrintRecord]` |
| `GET /prints/{id}` | | `PrintRecord` (with items) |
| `GET /schedules` | | `Schedule[]` |
| `POST /schedules` | `ScheduleCreate` | `Schedule` (201) |
| `PATCH /schedules/{id}` | `ScheduleUpdate` | `Schedule` |
| `DELETE /schedules/{id}` | | 204 |
| `GET /settings` | | `Settings` |
| `GET /models` | | `ModelOption[]` — curated OpenRouter models for the picker (free text still allowed) |
| `PATCH /settings` | partial `Settings` | `Settings` |
| `GET /digest/preview` | | `DigestItem[]` — next print batch (limits, dedup vs. printed) |
| `POST /ai/process` | `?limit=40` | `{summarized, flagged_political, failed, skipped_no_key}` — summarize pending articles now |
| `GET /print/preview.png` | `?print_id=` optional | `image/png`, 1-bit, 384px wide: the next digest (empty digest renders a "No new stories" receipt), or the stored/re-rendered image of a past print |
| `POST /print` | | `PrintRecord` (builds the digest, renders, prints over BLE). 409 `Nothing new to print` when the digest is empty; 502 (`print <id> failed: ...`) when printing fails (the failed print is still recorded) |

Errors: `{"detail": "<message>"}` with 4xx/5xx. CORS: allow all origins.

## TL;DR quality pipeline
- **Full-text enrichment** (`tnp/ingest/enrich.py`, `fulltext.py`): in `process_pending`, only for the articles
  about to be summarized, a `content_text` shorter than 1500 chars triggers a fetch of the article URL
  (httpx, 15s timeout, 3 MB cap, trafilatura extraction, max 4 concurrent). If the extracted text is >= 1.3x
  and >= 300 chars longer, it is stored with `db.update_article_content(conn, id, content_text, content_html)`
  (so the app's article view gets the full story too). Any failure silently keeps the RSS text.
- **Input cleanup** (`tnp/ai/clean.py`): newsletter/podcast boilerplate lines are stripped and the body is
  bounded to 12000 chars, cut at a paragraph boundary.
- **Prompt** (`tnp/ai/summarize.py`): 2-3 sentences, ~45-70 words, <= 450 chars, subject named explicitly,
  banned filler list, two few-shot examples. `quality_issues()` flags TL;DRs under 25 words (unless the
  input is a short teaser), filler phrases or questions; one stricter retry on the same model is made and
  the better answer kept (the fallback model is still used only on `AIError`).
- **Eval CLI**: `uv run python -m tnp.ai.eval [--n 8] [--per-category 2] [--model M]` prints feed, title,
  input chars before/after enrichment, the TL;DR, word count and flags (needs `OPENROUTER_API_KEY`;
  `--enrich-only` needs none). Run `python -m tnp.pipeline ingest` first. Enrichment results are saved to
  the DB; summaries are not.
