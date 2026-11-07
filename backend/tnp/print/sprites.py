"""Original pixel-art mascot for the receipt margin: a little newsie (paperboy).

A kid in a flat cap and dark jacket, a white strap across the chest leading to a satchel of
rolled-up papers on the hip. Frames are ASCII grids (16 columns wide) composed from shared
parts plus per-pose patches, then scaled with nearest-neighbour. The art is bold on purpose:
solid black/white with a single small area of light shading (the satchel flap), rendered as a
regular checker pattern rather than error diffusion so it never turns into speckle.

Legend: '.' transparent, '#' black, 'w' white, 'g' light shading (checker dither).
"""
from __future__ import annotations

from PIL import Image

W = 16
SCALE = 3
OVERLAY_ROWS = 7   # rows above the cap reserved for the floating "!", "?" and cog
SHADES = {"#": 0, "w": 255, "g": 128}

_CAP = [
    "....########....",
    "..############..",
    "..############..",
    "..#############.",   # brim pokes out to the right
]
_FACE = [
    "...#wwwwwwww#...",
    "...#wwwwwwww#...",
    "...#wwwwwwww#...",
    "....#wwwwww#....",
    ".....######.....",
]
_EYES = {
    "open": ("...#w#wwww#w#...", "...#w#wwww#w#..."),
    "blink": ("...#wwwwwwww#...", "...#w#wwww#w#..."),
    "up": ("...#w#wwww#w#...", "...#wwwwwwww#..."),
    "wide": ("...#w#wwww#w#...", "...#w#wwww#w#..."),
    "happy": ("...#wwwwwwww#...", "...#w#wwww#w#..."),
}
_MOUTH = {
    "flat": "....#wwwwww#....",
    "smile": "....#w#ww#w#....",
    "o": "....#ww##ww#....",
}
_TORSO = [
    "...##w#wwww##...",
    "...##ww#www##...",
    "...##www#ww##...",
    "...##wwwwww##...",
    "...##########...",
]
_SATCHEL = [
    "..##.##",
    ".#ww#ww",
    "#######",
    "#ggggg#",
    "#######",
]
_SATCHEL_COL = 9
_LEGS = {
    "stand": ["....###..###....", "....###..###....", "....###..###....", "...####..####..."],
    "wideA": ["....###..###....", "...###....###...", "..###......###..", ".####......####."],
    "wideB": ["....###..###....", "...###....###...", "...###...###....", "..####..####...."],
    "pass": ["....###..###....", ".....######.....", ".....##..##.....", "....###..###...."],
    "jump": ["....###..###....", "...###....###...", "...###....###...", "..###......###.."],
}
_HEAD_TOP = OVERLAY_ROWS
_TORSO_TOP = _HEAD_TOP + len(_CAP) + len(_FACE)
_LEGS_TOP = _TORSO_TOP + len(_TORSO)
HEIGHT = _LEGS_TOP + 4 + 1  # +1 spare row so a bob / jump can lift the figure

_OVERLAYS = {  # (left column, rows)
    "!": (4, ["...##...", "...##...", "...##...", "...##...", "........", "...##..."]),
    "?": (4, ["..####..", ".##..##.", "....##..", "...##...", "........", "...##..."]),
    "cog": (4, ["...##...", ".######.", "###..###", "##....##", "###..###", ".######.", "...##..."]),
}


def _put(grid, top: int, left: int, rows: list[str], *, opaque: bool = False) -> None:
    for dr, row in enumerate(rows):
        for dc, ch in enumerate(row):
            if (ch != "." or opaque) and 0 <= top + dr < len(grid) and 0 <= left + dc < W:
                grid[top + dr][left + dc] = ch


def _arm(g, t: int, side: str, kind: str) -> None:
    """2-wide black sleeves at the figure's edges, a 1px gap away from the jacket."""
    x = 0 if side == "L" else 14
    if kind == "down":
        _put(g, t, x, ["##"] * 4)
    elif kind == "fwd":      # swung out and up
        _put(g, t - 1, x, ["##"] * 4)
    elif kind == "back":     # swung back, a touch lower
        _put(g, t + 1, x, ["##"] * 4)
    elif kind == "up":       # raised overhead (cheer / wave / hold up a tool)
        _put(g, t - 3, x, ["##"] * 6)
    elif kind == "chin":     # forearm up to the chin (thinking)
        _put(g, t + 1, 14, ["##", "##", "##"])
        _put(g, t - 2, 12, ["##", "##", "##"])
        _put(g, t + 1, 13, ["#"])


def _build(*, eyes="open", mouth="flat", legs="stand", larm="down", rarm="down", prop=None,
           overlay=None, lift=0) -> list[str]:
    g = [["."] * W for _ in range(HEIGHT)]
    base = 1 - lift  # one spare row above the figure; lift raises it (bob / jump)
    head = list(_FACE)
    head[1], head[2] = _EYES[eyes]
    head[3] = _MOUTH[mouth]
    _put(g, _HEAD_TOP + base, 0, _CAP)
    _put(g, _HEAD_TOP + base + len(_CAP), 0, head)
    t = _TORSO_TOP + base
    _put(g, t, 0, _TORSO)
    _arm(g, t, "L", larm)
    _arm(g, t, "R", rarm)
    _put(g, _LEGS_TOP + base, 0, _LEGS[legs])
    if prop == "paper":      # newspaper held open in front of the torso
        _put(g, t - 1, 2, [
            "############",
            "#wwwwwwwwww#",
            "#w#####wwww#",
            "#wwwwwwwwww#",
            "#w##w###ww##",
            "#wwwwwwwwww#",
            "############",
        ], opaque=True)
    else:
        _put(g, t + 2, _SATCHEL_COL, _SATCHEL, opaque=True)
    if overlay:
        left, rows = _OVERLAYS[overlay]
        _put(g, 0, left, rows)
    return ["".join(r) for r in g]


FRAMES: dict[str, list[str]] = {
    # 4-frame walk cycle: contact, passing (bobbed up), contact, passing
    "walk_a": _build(legs="wideA", larm="fwd", rarm="back"),
    "walk_b": _build(legs="pass", lift=1),
    "walk_c": _build(legs="wideB", larm="back", rarm="fwd"),
    "walk_d": _build(legs="pass", lift=1, eyes="blink"),
    "read": _build(prop="paper", eyes="up"),
    "idle": _build(),
    "surprised": _build(legs="jump", larm="up", rarm="up", eyes="wide", mouth="o", lift=1,
                        overlay="!"),
    "thinking": _build(rarm="chin", eyes="up", overlay="?"),
    "tinker": _build(rarm="up", mouth="smile", overlay="cog"),
    "wave": _build(rarm="up", eyes="happy", mouth="smile"),
}
WALK_CYCLE = ["walk_a", "walk_b", "walk_c", "walk_d"]

# Tag slug -> reaction frame; anything else reads the paper.
REACTIONS = {
    "products": "surprised",
    "psychology": "thinking",
    "learning": "thinking",
    "engineering": "tinker",
}


def frame_for_tag(slug: str) -> str:
    return REACTIONS.get(slug, "read")


def sprite_image(name: str, scale: int = SCALE) -> Image.Image:
    """Return an 'LA' image. L is already 0/255 (checker pattern for 'g'); A masks the sprite."""
    rows = FRAMES[name]
    h = len(rows)
    size = (W * scale, h * scale)
    lum = Image.new("L", size, 255)
    alpha = Image.new("L", size, 0)
    lp, ap = lum.load(), alpha.load()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch not in SHADES:
                continue
            for dy in range(scale):
                for dx in range(scale):
                    px, py = x * scale + dx, y * scale + dy
                    ap[px, py] = 255
                    if ch == "#":
                        lp[px, py] = 0
                    elif ch == "g":
                        lp[px, py] = 0 if (px + py) % 2 == 0 else 255
    return Image.merge("LA", (lum, alpha))


SIZE = (W * SCALE, HEIGHT * SCALE)
