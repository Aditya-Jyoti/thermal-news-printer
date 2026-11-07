"""384px-wide, 1-bit newspaper receipt renderer.

Text only (no sprites/art, to save paper): masthead + dateline, then per item a plain-text
`#tag` line and the TL;DR in a serif face, full width. Titles are never printed.

Text and rules are drawn on a grayscale canvas and hard-thresholded to 1-bit (crisp glyphs).
"""
from __future__ import annotations

import shutil
import subprocess
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from tnp.models import DigestItem

WIDTH = 384
PAPER_NAME = "THE THERMAL TIMES"
EMPTY_TEXT = "No new stories — check back later"

FONT_DIR = Path(__file__).parent / "fonts"
_PLAYFAIR = FONT_DIR / "PlayfairDisplay-VF.ttf"
_SERIF = FONT_DIR / "SourceSerif4-VF.ttf"
_SERIF_ITALIC = FONT_DIR / "SourceSerif4-Italic-VF.ttf"

# Layout constants (pixels).
PAD = 6                     # outer left/right padding
TEXT_X = PAD
TEXT_R = WIDTH - PAD
TEXT_W = TEXT_R - TEXT_X
TRAIL = 44                  # blank paper after the footer, for the tear-off
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


def render_receipt(
    items: list[DigestItem],
    *,
    edition_date: datetime,
    edition_name: str = "Morning Edition",
    issue_no: int | None = None,
) -> Image.Image:
    """Render `items` as a 1-bit, 384px-wide, text-only newspaper receipt. Deterministic."""
    body_font = _font("body", BODY_SIZE, 440)
    tag_font = _font("italic", 17, 500)
    small = _font("body", 13, 500)
    small_it = _font("italic", 15, 400)
    ordered = sorted(items, key=lambda i: i.position)

    # --- layout: compute heights so we can size the canvas ---
    mast_font = _fit_display(PAPER_NAME, WIDTH - 2 * PAD)
    lines_per_item = [wrap_text(i.tldr, body_font, TEXT_W) for i in ordered]
    item_h = [24 + len(ls) * LEADING + 6 for ls in lines_per_item]
    header_h = 124
    if ordered:
        content_h = sum(item_h) + 14 * (len(ordered) - 1)
    else:
        content_h = 60
    footer_h = 100 + TRAIL
    height = header_h + content_h + footer_h

    text = Image.new("L", (WIDTH, height), 255)
    d = ImageDraw.Draw(text)

    # --- masthead ---
    y = 6
    d.rectangle([PAD, y, WIDTH - PAD, y + 2], fill=0)
    d.line([(PAD, y + 5), (WIDTH - PAD, y + 5)], fill=0)
    y += 9
    asc, desc = mast_font.getmetrics()
    d.text((round((WIDTH - mast_font.getlength(PAPER_NAME)) / 2), y), PAPER_NAME, font=mast_font, fill=0)
    y += asc + desc + 2
    d.line([(PAD, y), (WIDTH - PAD, y)], fill=0)
    y += 5
    _centered(d, y, _ordinal_date(edition_date), small_it)
    y += 22
    d.line([(PAD, y), (WIDTH - PAD, y)], fill=0)
    y += 4
    no = issue_no if issue_no is not None else len(ordered)
    d.text((PAD, y), edition_name.upper(), font=small, fill=0)
    right = f"NO. {no}"
    d.text((WIDTH - PAD - small.getlength(right), y), right, font=small, fill=0)
    y += 20
    d.rectangle([PAD, y, WIDTH - PAD, y + 1], fill=0)
    y += 10

    # --- items ---
    if not ordered:
        _centered(d, y + 16, EMPTY_TEXT, small_it, TEXT_X, TEXT_R)
        y += content_h
    else:
        for n, (it, ls) in enumerate(zip(ordered, lines_per_item)):
            d.text((TEXT_X, y), f"#{it.category_slug}", font=tag_font, fill=0)
            y += 24
            for line in ls:
                _draw_line(d, TEXT_X, y, line, body_font, TEXT_W, justify=False)
                y += LEADING
            y += 6
            if n < len(ordered) - 1:
                _ornament(d, y + 3, TEXT_X, TEXT_R)
                y += 14

    # --- footer ---
    fy = y + 4
    d.rectangle([PAD, fy, WIDTH - PAD, fy + 1], fill=0)
    d.line([(PAD, fy + 4), (WIDTH - PAD, fy + 4)], fill=0)
    fy += 12
    n_items = len(ordered)
    _centered(d, fy, f"{n_items} {'story' if n_items == 1 else 'stories'}", small_it)
    fy += 22
    _ornament(d, fy, PAD + 60, WIDTH - PAD - 60)
    fy += 10
    _centered(d, fy, "That's all for today!", small_it)
    fy += 20
    _centered(d, fy, "Full stories in the app", small)

    mask = text.point(lambda v: 0 if v < THRESHOLD else 255)
    return mask.convert("1", dither=Image.NONE)
