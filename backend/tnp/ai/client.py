"""OpenRouter client built on the OpenAI SDK (OpenAI-compatible API)."""
from __future__ import annotations

import logging
import os
from typing import Callable, TypeVar

from openai import OpenAI, OpenAIError

log = logging.getLogger(__name__)
R = TypeVar("R")

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "google/gemma-3-12b-it"
TIMEOUT_SECONDS = 30.0
MAX_RETRIES = 3  # SDK retries 408/409/429/5xx and connection errors with exponential backoff


class AIError(RuntimeError):
    """A model call failed (after retries)."""


class AIUnavailable(AIError):
    """AI features are not configured (no API key)."""


def default_model() -> str:
    return os.environ.get("TNP_MODEL") or DEFAULT_MODEL


def make_client(api_key: str | None = None, base_url: str | None = None) -> OpenAI:
    key = api_key or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise AIUnavailable(
            "OPENROUTER_API_KEY is not set; AI summarization and politics classification are unavailable."
        )
    return OpenAI(
        api_key=key,
        base_url=base_url or os.environ.get("OPENROUTER_BASE_URL") or DEFAULT_BASE_URL,
        timeout=TIMEOUT_SECONDS,
        max_retries=MAX_RETRIES,
        default_headers={
            "HTTP-Referer": "termal-news-printer",
            "X-Title": "termal-news-printer",
        },
    )


def chat(
    client,
    *,
    model: str,
    system: str,
    user: str,
    max_tokens: int = 200,
    temperature: float = 0.3,
) -> str:
    """Single chat completion returning the assistant text. Raises AIError on failure."""
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                # Some models (e.g. Gemma) reject a system role; a single user message is universally safe.
                {"role": "user", "content": f"{system}\n\n---\n\n{user}"},
            ],
            max_tokens=max_tokens,
            temperature=temperature,
        )
        text = resp.choices[0].message.content
    except OpenAIError as e:
        raise AIError(f"model call failed: {e}") from e
    except (AttributeError, IndexError, TypeError) as e:
        raise AIError(f"unexpected response shape: {e}") from e
    if not text or not text.strip():
        raise AIError("empty model response")
    return text


def try_models(models: list[str], attempt: Callable[[str], R]) -> R:
    """Run `attempt(model)` for each distinct model in order; return the first success.

    Only AIError triggers the next model (the SDK has already retried transient errors).
    Re-raises the last AIError if every model fails. `attempt` should embed the model it used
    in its result so callers can record which model actually produced the text.
    """
    ordered = list(dict.fromkeys(m for m in models if m))
    if not ordered:
        raise AIError("no model configured")
    last: AIError | None = None
    for i, model in enumerate(ordered):
        try:
            return attempt(model)
        except AIUnavailable:
            raise
        except AIError as e:
            last = e
            if i + 1 < len(ordered):
                log.warning("model %s failed (%s); falling back to %s", model, e, ordered[i + 1])
    assert last is not None
    raise last


def chat_with_fallback(client, *, models: list[str], **kwargs) -> tuple[str, str]:
    """`chat()` over `models` in order. Returns (text, model_that_answered)."""
    return try_models(models, lambda m: (chat(client, model=m, **kwargs), m))
