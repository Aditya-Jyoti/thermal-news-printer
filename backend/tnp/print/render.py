"""384px-wide, 1-bit newspaper receipt renderer.

Layout: masthead + dateline across the full width, then a narrow left margin column holding
a flipbook of "Whiskers" the cat reporter (see sprites.py) and a text column with, per item,
a plain-text `#tag` line and the TL;DR in a serif face. Titles are never printed.

Text and rules are drawn on a grayscale canvas and hard-thresholded (crisp glyphs); the
margin sprites live on a separate canvas and are Floyd-Steinberg dithered; the two are merged
into the final 1-bit image.
"""
from __future__ import annotations

import random
import shutil
import subprocess
import zlib
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

from tnp.models import DigestItem
from tnp.print import sprites

WIDTH = 384
PAPER_NAME = "THE THERMAL TIMES"
EMPTY_TEXT = "No new stories — check back later"

FONT_DIR = Path(__file__).parent / "fonts"
_PLAYFAIR = FONT_DIR / "PlayfairDisplay-VF.ttf"
_SERIF = FONT_DIR / "SourceSerif4-VF.ttf"
_SERIF_ITALIC = FONT_DIR / "SourceSerif4-Italic-VF.ttf"

# Layout constants (pixels).
PAD = 10                    # outer left/right padding
MARGIN_W = 52               # sprite column width
RULE_X = PAD + MARGIN_W + 2  # x of the vertical column rule
TEXT_X = RULE_X + 8
TEXT_R = WIDTH - PAD
TEXT_W = TEXT_R - TEXT_X
BODY_SIZE = 21
LEADING = 26
THRESHOLD = 150


# --- fonts ---------------------------------------------------------------------------

_SYSTEM_QUERIES = {
    "display": "Noto Serif:bold",
    "body": "Noto Serif",
    "italic": "Noto Serif:italic",
}


def _fc_match(query: str) -> str | None:
    exe = shutil.which("fc-match")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "-f", "%{file}", query], capture_output=True, text=True, timeout=5
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out if out and Path(out).exists() else None


def _load_bundled(path: Path, size: int, axes: list[float]) -> ImageFont.FreeTypeFont | None:
    if not path.exists():
        return None
    try:
        font = ImageFont.truetype(str(path), size)
        try:
            font.set_variation_by_axes(axes)
        except (OSError, AttributeError):
            pass
        return font
    except OSError:
        return None


@lru_cache(maxsize=64)
def _font(kind: str, size: int, weight: int = 400) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """kind: 'display' | 'body' | 'italic'. Bundled OFL fonts first, then system, then PIL."""
    if kind == "display":
        f = _load_bundled(_PLAYFAIR, size, [weight])
    elif kind == "body":
        f = _load_bundled(_SERIF, size, [weight, min(max(size, 8), 60)])
    else:
        f = _load_bundled(_SERIF_ITALIC, size, [weight, min(max(size, 8), 60)])
    if f:
        return f
    for path in (_fc_match(_SYSTEM_QUERIES[kind]), "DejaVuSerif.ttf", "LiberationSerif-Regular.ttf"):
        if path:
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default(size)


# --- text helpers --------------------------------------------------------------------

def wrap_text(text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont, max_w: int) -> list[str]:
    """Greedy pixel-width word wrap. Over-long words are split by character (no hyphens)."""
    lines: list[str] = []
    cur = ""
    for word in text.split():
        while font.getlength(word) > max_w:  # a single word wider than the column
            if cur:
                lines.append(cur)
                cur = ""
            cut = len(word)
            while cut > 1 and font.getlength(word[:cut]) > max_w:
                cut -= 1
            lines.append(word[:cut])
            word = word[cut:]
        trial = f"{cur} {word}" if cur else word
        if font.getlength(trial) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def _draw_line(
    d: ImageDraw.ImageDraw, x: int, y: int, line: str, font, width: int, justify: bool
) -> None:
    words = line.split(" ")
    if not justify or len(words) < 2:
        d.text((x, y), line, font=font, fill=0)
        return
    total = sum(font.getlength(w) for w in words)
    gap = (width - total) / (len(words) - 1)
    space = font.getlength(" ")
    if gap > space * 2.2:  # would look gappy; leave ragged
        d.text((x, y), line, font=font, fill=0)
        return
    cx = float(x)
    for w in words:
        d.text((round(cx), y), w, font=font, fill=0)
        cx += font.getlength(w) + gap


def _centered(d: ImageDraw.ImageDraw, y: int, text: str, font, x0: int = 0, x1: int = WIDTH) -> int:
    w = font.getlength(text)
    d.text((round(x0 + (x1 - x0 - w) / 2), y), text, font=font, fill=0)
    return y


def _fit_display(text: str, max_w: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    size = 44
    while size > 12:
        f = _font("display", size, 800)
        if f.getlength(text) <= max_w:
            return f
        size -= 1
    return _font("display", 12, 800)


def _diamond(d: ImageDraw.ImageDraw, cx: int, cy: int, r: int) -> None:
    d.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=0)


def _ornament(d: ImageDraw.ImageDraw, y: int, x0: int, x1: int) -> None:
    """Thin rule broken by three small diamonds."""
    cx = (x0 + x1) // 2
    d.line([(x0, y), (cx - 22, y)], fill=0)
    d.line([(cx + 22, y), (x1, y)], fill=0)
    _diamond(d, cx - 12, y, 2)
    _diamond(d, cx, y, 3)
    _diamond(d, cx + 12, y, 2)


# --- the receipt -----------------------------------------------------------------------

def _ordinal_date(dt: datetime) -> str:
    return f"{dt.strftime('%A')}, {dt.strftime('%B')} {dt.day}, {dt.year}"


def _reaction_plan(slug: str, slot_idx: int, n_slots: int, rng: random.Random) -> str:
    """Frame for the `slot_idx`-th sprite slot of an item: reaction first, then walk/read."""
    if slot_idx == 0:
        return sprites.frame_for_tag(slug)
    cycle = ["read", "walk_a", "walk_b", "walk_a"]
    return cycle[(slot_idx - 1 + rng.randrange(2)) % len(cycle)] if slot_idx < n_slots else "idle"


def render_receipt(
    items: list[DigestItem],
    *,
    edition_date: datetime,
    edition_name: str = "Morning Edition",
    seed: int | None = None,
    issue_no: int | None = None,
) -> Image.Image:
    """Render `items` as a 1-bit, 384px-wide newspaper receipt. Deterministic for equal inputs."""
    if seed is None:
        seed = zlib.crc32("|".join(f"{i.category_slug}:{i.tldr}" for i in items).encode())
    rng = random.Random(seed)

    body_font = _font("body", BODY_SIZE, 440)
    tag_font = _font("italic", 17, 500)
    small = _font("body", 13, 500)
    small_it = _font("italic", 15, 400)
    ordered = sorted(items, key=lambda i: i.position)

    # --- pass 1: layout (compute heights) so we can size the canvas ---
    mast_font = _fit_display(PAPER_NAME, WIDTH - 2 * PAD)
    lines_per_item = [wrap_text(i.tldr, body_font, TEXT_W) for i in ordered]
    item_h = [24 + len(ls) * LEADING + 12 for ls in lines_per_item]
    top_h = 0
    header_h = 138
    if ordered:
        content_h = sum(item_h) + 14 * (len(ordered) - 1)
    else:
        content_h = 90
    footer_h = 140
    height = top_h + header_h + content_h + footer_h

    text = Image.new("L", (WIDTH, height), 255)
    d = ImageDraw.Draw(text)
    art = Image.new("L", (WIDTH, height), 255)  # sprites (to be dithered)

    # --- masthead ---
    y = 8
    d.rectangle([PAD, y, WIDTH - PAD, y + 2], fill=0)
    d.line([(PAD, y + 5), (WIDTH - PAD, y + 5)], fill=0)
    y += 11
    asc, desc = mast_font.getmetrics()
    d.text((round((WIDTH - mast_font.getlength(PAPER_NAME)) / 2), y), PAPER_NAME, font=mast_font, fill=0)
    y += asc + desc + 2
    d.line([(PAD, y), (WIDTH - PAD, y)], fill=0)
    y += 6
    _centered(d, y, _ordinal_date(edition_date), small_it)
    y += 22
    d.line([(PAD, y), (WIDTH - PAD, y)], fill=0)
    y += 5
    no = issue_no if issue_no is not None else len(ordered)
    d.text((PAD, y), edition_name.upper(), font=small, fill=0)
    right = f"NO. {no}"
    d.text((WIDTH - PAD - small.getlength(right), y), right, font=small, fill=0)
    y += 20
    d.rectangle([PAD, y, WIDTH - PAD, y + 1], fill=0)
    y += 12
    content_top = y

    # --- items + margin flipbook ---
    slot_h = sprites.SIZE[1] + 4
    sprite_slots: list[tuple[int, str, int]] = []  # (y, frame, x offset)

    def place_slots(top: int, height_px: int, slug: str) -> None:
        n = max(1, height_px // slot_h)
        step = height_px / n
        for k in range(n):
            frame = _reaction_plan(slug, k, n, rng)
            xoff = {"walk_a": 0, "walk_b": 3}.get(frame, rng.randrange(0, 3))
            sprite_slots.append((round(top + k * step + (step - sprites.SIZE[1]) / 2), frame, xoff))

    if not ordered:
        _centered(d, y + 24, EMPTY_TEXT, small_it, TEXT_X, TEXT_R)
        y += content_h
        d.line([(RULE_X, content_top), (RULE_X, y - 8)], fill=0)
        place_slots(content_top, content_h - 8, "")
    else:
        item_top = y
        for n, (it, ls) in enumerate(zip(ordered, lines_per_item)):
            block_top = y
            d.text((TEXT_X, y), f"#{it.category_slug}", font=tag_font, fill=0)
            y += 24
            for j, line in enumerate(ls):
                _draw_line(d, TEXT_X, y, line, body_font, TEXT_W, justify=j < len(ls) - 1)
                y += LEADING
            y += 12
            place_slots(block_top, y - block_top, it.category_slug)
            if n < len(ordered) - 1:
                _ornament(d, y + 3, TEXT_X, TEXT_R)
                y += 14
        d.line([(RULE_X, item_top - 2), (RULE_X, y - 6)], fill=0)

    # --- footer ---
    fy = y + 6
    d.rectangle([PAD, fy, WIDTH - PAD, fy + 1], fill=0)
    d.line([(PAD, fy + 4), (WIDTH - PAD, fy + 4)], fill=0)
    wave_y = fy + 12
    fy += 16
    n_items = len(ordered)
    _centered(d, fy, f"{n_items} {'story' if n_items == 1 else 'stories'}", small_it, TEXT_X, TEXT_R)
    fy += 24
    _ornament(d, fy, TEXT_X + 10, TEXT_R - 10)
    fy += 12
    _centered(d, fy, "That's all, folks!", small_it, TEXT_X, TEXT_R)
    fy += 20
    _centered(d, fy, "Full stories in the app", small, TEXT_X, TEXT_R)
    sprite_slots.append((wave_y, "wave", 0))

    # --- compose ---
    mask = text.point(lambda v: 0 if v < THRESHOLD else 255)
    art_alpha = Image.new("L", (WIDTH, height), 0)
    for sy, frame, xoff in sprite_slots:
        sp = sprites.sprite_image(frame)
        pos = (PAD + xoff, sy)
        art.paste(sp.getchannel(0), pos, sp.getchannel(1))
        art_alpha.paste(sp.getchannel(1), pos)
    art_1 = art.convert("1", dither=Image.FLOYDSTEINBERG)
    text_1 = mask.convert("1", dither=Image.NONE)
    out = ImageChops.darker(art_1, text_1)
    return out.convert("1", dither=Image.NONE)
