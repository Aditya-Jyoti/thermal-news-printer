"""OpenRouter client built on the OpenAI SDK (OpenAI-compatible API)."""
from __future__ import annotations

import os

from openai import OpenAI, OpenAIError

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
