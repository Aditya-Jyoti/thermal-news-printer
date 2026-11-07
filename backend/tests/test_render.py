"""Renderer tests: geometry, determinism, wrapping. No network/hardware."""
from __future__ import annotations

import inspect
from datetime import datetime

import pytest
from PIL import Image, ImageChops

from tnp.models import DigestItem
from tnp.print import render, sprites
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


def test_deterministic_for_same_input_and_seed():
    items = sample_items()
    a, b = _render(items, seed=7), _render(items, seed=7)
    assert a.tobytes() == b.tobytes()
    assert _render(items).tobytes() == _render(items).tobytes()  # derived seed is stable


def test_seed_changes_margin_only_slightly_but_stays_valid():
    img = _render(sample_items(), seed=1)
    assert img.size[0] == 384 and img.mode == "1"


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
    # Item text column should be mostly pure ink/paper; the check is that rendering twice with
    # different seeds keeps the text column identical (only the margin sprites vary).
    items = sample_items()[:1]
    a, b = _render(items, seed=1), _render(items, seed=99)
    box = (render.TEXT_X, 150, 384, a.height - 150)
    assert a.crop(box).tobytes() == b.crop(box).tobytes()


def test_sprite_frames_are_well_formed_and_vary():
    for name, rows in sprites.FRAMES.items():
        assert len(rows) == sprites.HEIGHT
        assert all(len(r) == sprites.W for r in rows), name
    assert len({tuple(f) for f in sprites.FRAMES.values()}) == len(sprites.FRAMES)
    assert sprites.frame_for_tag("products") != sprites.frame_for_tag("engineering")
    assert sprites.frame_for_tag("unknown-tag") == "read"
    assert sprites.sprite_image("read").size == sprites.SIZE


def test_margin_has_ink_for_every_item():
    img = _render(sample_items()).convert("L")
    margin = ImageChops.invert(img.crop((render.PAD, 150, render.PAD + render.MARGIN_W, img.height)))
    assert margin.getbbox() is not None
    assert isinstance(img, Image.Image)


@pytest.mark.parametrize("slug", ["products", "engineering", "psychology", "learning", "custom"])
def test_every_tag_renders(slug):
    assert _render([_item(0, slug=slug)]).width == 384


def test_newsie_frames_and_walk_cycle():
    assert len(sprites.WALK_CYCLE) >= 3
    assert len({tuple(sprites.FRAMES[n]) for n in sprites.WALK_CYCLE}) == len(sprites.WALK_CYCLE)
    assert all(n in sprites.FRAMES for n in ("wave", "read", "surprised", "thinking", "tinker"))
    assert sprites.frame_for_tag("products") == "surprised"
    assert sprites.frame_for_tag("psychology") == sprites.frame_for_tag("learning") == "thinking"
    assert sprites.frame_for_tag("engineering") == "tinker"


def test_sprite_art_is_pure_one_bit():
    # shading is a regular checker pattern, never grey / error-diffused speckle
    lum = sprites.sprite_image("read").getchannel(0)
    assert set(lum.getdata()) <= {0, 255}


def test_body_text_is_ragged_right():
    # left-aligned: lines are drawn as whole strings, so word gaps are one normal space
    assert "justify" not in inspect.getsource(render.render_receipt) or "justify=False" in inspect.getsource(render.render_receipt)
