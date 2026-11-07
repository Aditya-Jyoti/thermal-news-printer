"""Manual demo: uv run python -m tnp.ai "<title>" "<text>" """
from __future__ import annotations

import sys

from tnp.models import ArticleForAI

from .client import AIError, AIUnavailable, default_model, make_client
from .politics import classify_politics
from .summarize import summarize


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print('usage: python -m tnp.ai "<title>" "<text>"', file=sys.stderr)
        return 2
    title, text = argv[1], (argv[2] if len(argv) > 2 else "")
    try:
        client = make_client()
    except AIUnavailable as e:
        print(f"error: {e}\nSet OPENROUTER_API_KEY and retry.", file=sys.stderr)
        return 1
    model = default_model()
    art = ArticleForAI(id=0, title=title, url="https://example.invalid", content_text=text or None,
                       category_slug="demo", published_at=None)
    try:
        s = summarize(art, client=client, model=model)
        v = classify_politics(art, client=client, model=model)
    except AIError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"model:     {model}")
    print(f"tldr ({len(s.tldr)} chars): {s.tldr}")
    print(f"political: {v.is_political} ({v.reason})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
