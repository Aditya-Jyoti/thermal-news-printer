"""AI layer: OpenRouter client, TL;DR summarizer, politics classifier."""
from .client import AIError, AIUnavailable, DEFAULT_MODEL, chat, chat_with_fallback, default_model, make_client, try_models
from .politics import classify_politics
from .summarize import (
    MAX_TLDR_CHARS,
    clean_tldr,
    summarize,
    summarize_and_classify,
    summarize_many,
)

__all__ = [
    "AIError", "AIUnavailable", "DEFAULT_MODEL", "MAX_TLDR_CHARS", "chat", "chat_with_fallback", "try_models",
    "classify_politics", "clean_tldr", "default_model", "make_client", "summarize",
    "summarize_and_classify", "summarize_many",
]
