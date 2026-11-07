"""FastAPI application implementing the REST contract in docs/ARCHITECTURE.md."""
from __future__ import annotations

import io
import os
import sqlite3
from contextlib import asynccontextmanager
from typing import Any, Iterator

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from tnp import db
from tnp.cron import validate_cron
from tnp.config import load_config
from tnp.ingest.service import run_ingest
from tnp.pipeline import ProcessResult, build_digest, process_pending
from tnp.scheduler import Scheduler
from tnp.models import (
    ArticleDetail,
    ArticleSummary,
    Category,
    CategoryCreate,
    CategoryUpdate,
    DigestItem,
    Feed,
    FeedCreate,
    FeedUpdate,
    IngestResult,
    Page,
    PrintRecord,
    Schedule,
    ScheduleCreate,
    ScheduleUpdate,
    SUPPORTED_MODELS,
    ModelOption,
    Settings,
)
from tnp.seed import seed_defaults


class SettingsUpdate(BaseModel):
    """Partial Settings for PATCH /settings."""
    max_items_total: int | None = Field(default=None, ge=1, le=30)
    model: str | None = None
    fallback_model: str | None = None  # explicit null disables the fallback
    printer_address: str | None = None


def _check_feed_url(url: str) -> str:
    url = url.strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(422, "feed url must start with http:// or https://")
    return url


def _check_cron(expr: str) -> str:
    try:
        return validate_cron(expr)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _process_in_background(db_path: str) -> None:
    conn = db.connect(db_path)
    try:
        process_pending(conn)
    finally:
        conn.close()


def create_app(db_path: str | None = None) -> FastAPI:
    path = db_path or load_config().db_path

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> Any:
        sched = None
        if os.environ.get("TNP_SCHEDULER", "1") != "0":
            sched = Scheduler(app.state.db_path)
            sched.start()
        try:
            yield
        finally:
            if sched:
                sched.stop()

    app = FastAPI(title="termal-news-printer", version="0.1.0", lifespan=lifespan)
    app.state.db_path = path
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    # Initialise + seed eagerly so a fresh TestClient (without lifespan) also works.
    boot = db.connect(path)
    try:
        db.init_db(boot)
        seed_defaults(boot)
    finally:
        boot.close()

    @app.exception_handler(db.NotFound)
    async def _not_found(_: Request, exc: db.NotFound) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(db.Conflict)
    async def _conflict(_: Request, exc: db.Conflict) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    def get_conn() -> Iterator[sqlite3.Connection]:
        conn = db.connect(app.state.db_path)
        try:
            yield conn
        finally:
            conn.close()

    Conn = Depends(get_conn)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    # --- categories ---
    @app.get("/categories", response_model=list[Category])
    def categories(conn: sqlite3.Connection = Conn) -> list[Category]:
        return db.list_categories(conn)

    @app.post("/categories", response_model=Category, status_code=201)
    def category_create(body: CategoryCreate, conn: sqlite3.Connection = Conn) -> Category:
        return db.create_category(conn, body.name.strip(), body.color, body.print_limit)

    @app.patch("/categories/{category_id}", response_model=Category)
    def category_update(
        category_id: int, body: CategoryUpdate, conn: sqlite3.Connection = Conn
    ) -> Category:
        fields: dict[str, Any] = body.model_dump(exclude_unset=True)
        if isinstance(fields.get("name"), str):
            fields["name"] = fields["name"].strip()
        return db.update_category(conn, category_id, **fields)

    @app.delete("/categories/{category_id}", status_code=204)
    def category_delete(category_id: int, conn: sqlite3.Connection = Conn) -> Response:
        db.delete_category(conn, category_id)
        return Response(status_code=204)

    # --- feeds ---
    @app.get("/feeds", response_model=list[Feed])
    def feeds(category_id: int | None = None, conn: sqlite3.Connection = Conn) -> list[Feed]:
        return db.list_feeds(conn, category_id)

    @app.post("/feeds", response_model=Feed, status_code=201)
    def feed_create(body: FeedCreate, conn: sqlite3.Connection = Conn) -> Feed:
        return db.create_feed(
            conn, _check_feed_url(body.url), body.category_id, body.title, body.enabled
        )

    # NOTE: must be declared before /feeds/{feed_id} routes sharing the prefix.
    @app.post("/feeds/refresh", response_model=IngestResult)
    def feeds_refresh(
        background: BackgroundTasks, feed_id: int | None = None, conn: sqlite3.Connection = Conn
    ) -> IngestResult:
        result = run_ingest(conn, feed_id)
        background.add_task(_process_in_background, app.state.db_path)
        return result

    @app.patch("/feeds/{feed_id}", response_model=Feed)
    def feed_update(feed_id: int, body: FeedUpdate, conn: sqlite3.Connection = Conn) -> Feed:
        fields: dict[str, Any] = body.model_dump(exclude_unset=True)
        if fields.get("url") is not None:
            fields["url"] = _check_feed_url(fields["url"])
        return db.update_feed(conn, feed_id, **fields)

    @app.delete("/feeds/{feed_id}", status_code=204)
    def feed_delete(feed_id: int, conn: sqlite3.Connection = Conn) -> Response:
        db.delete_feed(conn, feed_id)
        return Response(status_code=204)

    # --- articles ---
    @app.get("/articles", response_model=Page[ArticleSummary])
    def articles(
        category_id: int | None = None,
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
        include_political: bool = False,
        conn: sqlite3.Connection = Conn,
    ) -> Page[ArticleSummary]:
        items, total = db.list_articles(conn, category_id, limit, offset, include_political)
        return Page[ArticleSummary](items=items, total=total, limit=limit, offset=offset)

    @app.get("/articles/{article_id}", response_model=ArticleDetail)
    def article(article_id: int, conn: sqlite3.Connection = Conn) -> ArticleDetail:
        return db.get_article_detail(conn, article_id)

    # --- prints ---
    @app.get("/prints", response_model=Page[PrintRecord])
    def prints(
        limit: int = Query(20, ge=1, le=200),
        offset: int = Query(0, ge=0),
        conn: sqlite3.Connection = Conn,
    ) -> Page[PrintRecord]:
        items, total = db.list_prints(conn, limit, offset)
        return Page[PrintRecord](items=items, total=total, limit=limit, offset=offset)

    @app.get("/prints/{print_id}", response_model=PrintRecord)
    def print_get(print_id: int, conn: sqlite3.Connection = Conn) -> PrintRecord:
        return db.get_print(conn, print_id)

    # --- schedules ---
    @app.get("/schedules", response_model=list[Schedule])
    def schedules(conn: sqlite3.Connection = Conn) -> list[Schedule]:
        return db.list_schedules(conn)

    @app.post("/schedules", response_model=Schedule, status_code=201)
    def schedule_create(body: ScheduleCreate, conn: sqlite3.Connection = Conn) -> Schedule:
        return db.create_schedule(conn, _check_cron(body.cron), body.label, body.enabled)

    @app.patch("/schedules/{schedule_id}", response_model=Schedule)
    def schedule_update(
        schedule_id: int, body: ScheduleUpdate, conn: sqlite3.Connection = Conn
    ) -> Schedule:
        fields: dict[str, Any] = body.model_dump(exclude_unset=True)
        if fields.get("cron") is not None:
            fields["cron"] = _check_cron(fields["cron"])
        return db.update_schedule(conn, schedule_id, **fields)

    @app.delete("/schedules/{schedule_id}", status_code=204)
    def schedule_delete(schedule_id: int, conn: sqlite3.Connection = Conn) -> Response:
        db.delete_schedule(conn, schedule_id)
        return Response(status_code=204)

    # --- settings ---
    @app.get("/settings", response_model=Settings)
    def settings_get(conn: sqlite3.Connection = Conn) -> Settings:
        return db.get_settings(conn)

    @app.patch("/settings", response_model=Settings)
    def settings_patch(body: SettingsUpdate, conn: sqlite3.Connection = Conn) -> Settings:
        return db.update_settings(conn, **body.model_dump(exclude_unset=True))

    # --- digest / AI / print ---
    @app.get("/digest/preview", response_model=list[DigestItem])
    def digest_preview(conn: sqlite3.Connection = Conn) -> list[DigestItem]:
        return build_digest(conn)

    @app.get("/models", response_model=list[ModelOption])
    def models() -> list[ModelOption]:
        return SUPPORTED_MODELS

    @app.post("/ai/process", response_model=ProcessResult)
    def ai_process(
        limit: int = Query(40, ge=1, le=200), conn: sqlite3.Connection = Conn
    ) -> ProcessResult:
        return process_pending(conn, limit=limit)

    @app.get("/print/preview.png")
    def print_preview(print_id: int | None = None, conn: sqlite3.Connection = Conn) -> Response:
        from tnp import print as printing

        if print_id is not None:
            record = db.get_print(conn, print_id)  # 404 if unknown
            stored = printing.print_png_path(conn, print_id)
            if stored.exists():
                return Response(stored.read_bytes(), media_type="image/png")
            items = [
                DigestItem(article_id=i.article_id or 0, position=i.position,
                           category_slug=i.category_slug, tldr=i.tldr)
                for i in record.items
            ]
            img = printing.render_items(items, issue_no=print_id, seed=print_id)
        else:
            img = printing.render_items(build_digest(conn))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return Response(buf.getvalue(), media_type="image/png")

    @app.post("/print", response_model=PrintRecord)
    def print_now(conn: sqlite3.Connection = Conn) -> PrintRecord:
        from tnp import print as printing

        digest = build_digest(conn)
        if not digest:
            raise HTTPException(409, "Nothing new to print")
        record = printing.deliver(conn, digest, "manual")
        if record is not None and record.status == "failed":
            raise HTTPException(502, f"print {record.id} failed: {record.error}")
        assert record is not None
        return record

    return app



_app: FastAPI | None = None


def __getattr__(name: str) -> FastAPI:
    """Lazy module-level `app` so importing this module has no side effects."""
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
