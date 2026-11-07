"""Shared data models — the contract between backend streams and the mobile app.

Orchestrator-owned. Do not change field names/types without updating docs/ARCHITECTURE.md
and mobile/src/api/types.ts.
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, Field, StringConstraints

T = TypeVar("T")

CategoryName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


# --- Categories ---------------------------------------------------------------

class CategoryCreate(BaseModel):
    name: CategoryName
    color: str | None = None  # "#RRGGBB"; app falls back to Material You palette
    print_limit: int = Field(default=2, ge=0, le=20)


class CategoryUpdate(BaseModel):
    name: CategoryName | None = None
    color: str | None = None
    print_limit: int | None = Field(default=None, ge=0, le=20)


class Category(BaseModel):
    id: int
    name: str
    slug: str  # lowercase, used for the printed "#tag"
    color: str | None
    print_limit: int
    feed_count: int = 0


# --- Feeds --------------------------------------------------------------------

class FeedCreate(BaseModel):
    url: str
    category_id: int
    title: str | None = None
    enabled: bool = True


class FeedUpdate(BaseModel):
    url: str | None = None
    category_id: int | None = None
    title: str | None = None
    enabled: bool | None = None


class Feed(BaseModel):
    id: int
    url: str
    title: str | None
    category_id: int
    enabled: bool
    last_fetched_at: datetime | None
    last_error: str | None


class IngestResult(BaseModel):
    feeds_checked: int
    new_articles: int
    skipped_duplicates: int
    flagged_political: int
    errors: dict[str, str] = {}  # feed url -> error message


# --- Articles -----------------------------------------------------------------

class ArticleSummary(BaseModel):
    """Card-sized view for the feed list."""
    id: int
    feed_id: int
    category: Category
    title: str
    url: str
    author: str | None
    published_at: datetime | None
    image_url: str | None
    tldr: str | None
    is_political: bool | None
    printed_at: datetime | None  # first time it appeared in a print, else None


class ArticleDetail(ArticleSummary):
    content_html: str | None
    content_text: str | None


# --- AI / digest --------------------------------------------------------------

class ArticleForAI(BaseModel):
    """Minimal input handed to Stream B (ai/, digest/). Built from DB rows by the wiring layer."""
    id: int
    title: str
    url: str
    content_text: str | None
    category_slug: str
    published_at: datetime | None


class SummaryResult(BaseModel):
    article_id: int
    tldr: str
    model: str


class PoliticsVerdict(BaseModel):
    article_id: int
    is_political: bool
    reason: str | None = None


class DigestCandidate(BaseModel):
    article_id: int
    title: str
    category_slug: str
    tldr: str
    published_at: datetime | None


class DigestItem(BaseModel):
    article_id: int
    position: int
    category_slug: str
    tldr: str


# --- Prints & history ---------------------------------------------------------

PrintStatus = Literal["pending", "printed", "failed"]
PrintTrigger = Literal["manual", "schedule"]


class PrintItem(BaseModel):
    position: int
    article_id: int | None
    category_slug: str
    tldr: str
    title: str | None = None  # app only; never printed


class PrintRecord(BaseModel):
    id: int
    created_at: datetime
    trigger: PrintTrigger
    status: PrintStatus
    error: str | None
    items: list[PrintItem] = []


# --- Schedules & settings -----------------------------------------------------

class ScheduleCreate(BaseModel):
    cron: str  # 5-field cron, e.g. "0 8 * * *"
    label: str | None = None
    enabled: bool = True


class ScheduleUpdate(BaseModel):
    cron: str | None = None
    label: str | None = None
    enabled: bool | None = None


class Schedule(BaseModel):
    id: int
    cron: str
    label: str | None
    enabled: bool


class ModelOption(BaseModel):
    id: str  # OpenRouter model id
    label: str


SUPPORTED_MODELS: list[ModelOption] = [
    ModelOption(id="google/gemma-3-12b-it", label="Gemma 3 12B (default)"),
    ModelOption(id="deepseek/deepseek-v4.1-flash", label="DeepSeek V4.1 Flash"),
]


class Settings(BaseModel):
    max_items_total: int = Field(default=8, ge=1, le=30)
    model: str = "google/gemma-3-12b-it"
    fallback_model: str | None = "deepseek/deepseek-v4.1-flash"  # tried when the primary fails
    printer_address: str | None = None  # BLE MAC, Phase 3
