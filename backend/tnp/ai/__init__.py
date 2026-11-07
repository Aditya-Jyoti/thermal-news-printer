"""AI layer: OpenRouter client, TL;DR summarizer, politics classifier."""
from .client import AIError, AIUnavailable, DEFAULT_MODEL, chat, default_model, make_client
from .politics import classify_politics
from .summarize import (
    MAX_TLDR_CHARS,
    clean_tldr,
    summarize,
    summarize_and_classify,
    summarize_many,
)

__all__ = [
    "AIError", "AIUnavailable", "DEFAULT_MODEL", "MAX_TLDR_CHARS", "chat",
    "classify_politics", "clean_tldr", "default_model", "make_client", "summarize",
    "summarize_and_classify", "summarize_many",
]
