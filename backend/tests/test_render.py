"""Renderer tests: geometry, determinism, wrapping. No network/hardware."""
from __future__ import annotations

import inspect
from datetime import datetime

import pytest
from PIL import Image, ImageChops

from tnp.models import DigestItem
from tnp.print import render
from tnp.print.render import WIDTH, render_receipt, wrap_text
from tnp.print.samples import sample_items

WHEN = datetime(2026, 11, 7, 8, 0)


def _item(i: int, tldr: str = "A short summary of a story.", slug: str = "products") -> DigestItem:
    return DigestItem(article_id=i, position=i, category_slug=slug, tldr=tldr)


def _render(items, **kw):
    return render_receipt(items, edition_date=WHEN, **kw)


def test_width_and_mode():
    for n in (0, 1, 6):
        img = _render(sample_items()[:n])
        assert img.width == WIDTH == 384
        assert img.mode == "1"


def test_height_grows_with_items():
    heights = [_render(sample_items()[:n]).height for n in (1, 2, 4, 6)]
    assert heights == sorted(heights) and len(set(heights)) == 4


def test_renderer_api_accepts_no_titles():
    params = inspect.signature(render_receipt).parameters
    assert not any("title" in name for name in params)
    assert "title" not in DigestItem.model_fields  # titles never reach the renderer


def test_deterministic_for_same_input():
    items = sample_items()
    assert _render(items).tobytes() == _render(items).tobytes()


def test_empty_digest_renders_message_receipt():
    img = _render([])
    assert img.width == 384 and img.mode == "1" and img.height > 150
    assert ImageChops.invert(img.convert("L")).getbbox() is not None  # not blank


def test_very_long_tldr_wraps_without_overflow():
    long_text = " ".join(["extraordinarily"] * 80) + " " + "x" * 200  # incl. unbreakable word
    img = _render([_item(0, long_text)])
    assert img.width == 384
    # right padding stays clean: nothing is inked in the last PAD-2 columns
    dark = ImageChops.invert(img.convert("L"))
    right = dark.crop((384 - (render.PAD - 2), 0, 384, img.height))
    assert right.getbbox() is None


def test_wrap_text_respects_width_and_preserves_words():
    font = render._font("body", render.BODY_SIZE, 440)
    text = "The quick brown fox jumps over the lazy dog " * 6
    lines = wrap_text(text, font, render.TEXT_W)
    assert all(font.getlength(line) <= render.TEXT_W for line in lines)
    assert " ".join(lines).split() == text.split()
    assert not any(line.endswith("-") for line in lines)
    # an unbreakable word wider than the column is split by characters, never overflows
    huge = wrap_text("W" * 100, font, render.TEXT_W)
    assert len(huge) > 1 and all(font.getlength(line) <= render.TEXT_W for line in huge)
    assert "".join(huge) == "W" * 100


def test_text_is_crisp_not_dithered():
    # 1-bit with no error-diffusion speckle: the body column contains only full black/white
    img = _render(sample_items()[:1]).convert("L")
    assert set(img.tobytes()) <= {0, 255}


def test_no_decorative_column_text_uses_full_width():
    img = _render(sample_items())
    ink = ImageChops.invert(img.convert("L"))
    body = ink.crop((0, 150, 384, img.height - 100))
    left, _, right, _ = body.getbbox()
    assert left <= render.PAD + 4  # text starts within the left padding
    assert right >= 384 - render.PAD - 40  # and runs close to the right edge
    # no vertical column rule: no full-height ink column in the body
    for x in range(384):
        col = ink.crop((x, 150, x + 1, img.height - 100))
        assert col.histogram()[255] < (img.height - 250) * 0.9


def test_trailing_paper_is_modest():
    img = _render(sample_items())
    bbox = ImageChops.invert(img.convert("L")).getbbox()
    assert 20 <= img.height - bbox[3] <= 70


@pytest.mark.parametrize("slug", ["products", "engineering", "psychology", "learning", "custom"])
def test_every_tag_renders(slug):
    assert _render([_item(0, slug=slug)]).width == 384


def test_body_text_is_ragged_right():
    # left-aligned: lines are drawn as whole strings, so word gaps are one normal space
    assert "justify" not in inspect.getsource(render.render_receipt) or "justify=False" in inspect.getsource(render.render_receipt)
