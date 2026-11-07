"""Original pixel-art mascot for the receipt margin: "Whiskers", a cat reporter in a press hat.

Frames are ASCII grids (16 columns wide), composed from a shared head/body plus per-pose
patches, then scaled with nearest-neighbour and dithered by the renderer.

Legend: '.' transparent, '#' black, 'd' dark grey, 'g' light grey (fur), 'w' white.
"""
from __future__ import annotations

from PIL import Image

W = 16
SCALE = 3
OVERLAY_ROWS = 7  # rows reserved above the hat for "!", "?", gear
SHADES = {"#": 0, "d": 95, "g": 205, "w": 255}

_HEAD = [
    "..#..######..#..",
    "..##.#dddd#.##..",
    ".#g##########g#.",
    ".#gggggggggggg#.",
    ".#gggggggggggg#.",
    ".#gg##gggg##gg#.",  # eyes (rows 5-6)
    ".#gg##gggg##gg#.",
    "##gggww##wwggg##",  # nose + whiskers
    "..#gggwwwwggg#..",
    "...##########...",
]
_EYES = {
    "open": [".#gg##gggg##gg#.", ".#gg##gggg##gg#."],
    "blink": [".#gggggggggggg#.", ".#gg##gggg##gg#."],
    "wide": [".#g#ww#gg#ww#g#.", ".#g#w##gg#w##g#."],
    "up": [".#gg##gggg##gg#.", ".#gggggggggggg#."],
    "happy": [".#gg#gggggg#gg#.", ".#g#g#gg#g#g#g#."],
}
_MOUTH = {
    "smile": "..#ggw#ww#wgg#..",
    "o": "..#gggw##wggg#..",
    "flat": "..#gggwwwwggg#..",
}
_TORSO = [
    "....#d#ww#d#....",
    "....#dddddd#....",
    "....#dddddd#....",
    "....#dddddd#....",
    "....########....",
]
_LEGS = {
    "idle": ["....#gg##gg#....", "....#gg##gg#....", "...###.##.###..."],
    "a": ["....#gg##gg#....", "...#gg#..#gg#...", "..###......###.."],
    "b": ["....#gg##gg#....", "....#gg##g#.....", "...###.###......"],
}
_HEAD_TOP = OVERLAY_ROWS          # row where the hat starts
_TORSO_TOP = _HEAD_TOP + len(_HEAD)
_LEGS_TOP = _TORSO_TOP + len(_TORSO)
HEIGHT = _LEGS_TOP + 3

_OVERLAYS = {
    "!": [
        "....##....",
        "....##....",
        "....##....",
        "....##....",
        "..........",
        "....##....",
        "....##....",
    ],
    "?": [
        "...####...",
        "..##..##..",
        "......##..",
        ".....##...",
        "....##....",
        "..........",
        "....##....",
    ],
    "gear": [
        "...#.#....",
        ".#######..",
        "..##.##...",
        "###...###.",
        "..##.##...",
        ".#######..",
        "...#.#....",
    ],
}


def _patch(grid: list[list[str]], top: int, left: int, rows: list[str]) -> None:
    for dr, row in enumerate(rows):
        for dc, ch in enumerate(row):
            if ch not in ". " and 0 <= top + dr < len(grid) and 0 <= left + dc < W:
                grid[top + dr][left + dc] = ch


def _arms_down(g: list[list[str]]) -> None:
    t = _TORSO_TOP
    for r in (1, 2, 3):
        g[t + r][3], g[t + r][2] = "d", "#"
        g[t + r][12], g[t + r][13] = "d", "#"
    g[t + 4][2] = "g"
    g[t + 4][13] = "g"


def _clear(g: list[list[str]], cells: list[tuple[int, int]]) -> None:
    for r, c in cells:
        g[r][c] = "."


def _build(
    *, eyes: str = "open", mouth: str = "smile", legs: str = "idle", pose: str = "down",
    overlay: str | None = None,
) -> list[str]:
    g = [["."] * W for _ in range(HEIGHT)]
    head = list(_HEAD)
    head[5], head[6] = _EYES[eyes]
    head[8] = _MOUTH[mouth]
    _patch(g, _HEAD_TOP, 0, head)
    _patch(g, _TORSO_TOP, 0, _TORSO)
    _patch(g, _LEGS_TOP, 0, _LEGS[legs])
    t = _TORSO_TOP
    if pose == "down":
        _arms_down(g)
    elif pose == "read":  # holds up a little newspaper
        _patch(g, t - 1, 0, [
            "..############..",
            "..#wwwwwwwwww#..",
            "..#w######wwww#.",
            "..#wwwwwwwwww#..",
            "..#w#####w##w#..",
            "..#wwwwwwwwww#..",
            "..##g######g##..",
        ])
    elif pose == "wave":
        _arms_down(g)
        _clear(g, [(t + 1, 12), (t + 1, 13), (t + 2, 12), (t + 2, 13), (t + 3, 12), (t + 3, 13),
                   (t + 4, 13)])
        _patch(g, t - 3, 12, ["..gg", "..#g", "..##", "..#.", "..#.", ".##."])
        _patch(g, t + 1, 12, ["#d.."])
    elif pose == "up":  # hands up in surprise
        _patch(g, t - 3, 0, [
            ".gg..........gg.",
            ".##..........##.",
            "..#d........d#..",
            "..#d........d#..",
            "..#d........d#..",
        ])
    elif pose == "think":  # paw on chin
        _arms_down(g)
        _clear(g, [(t + r, c) for r in (1, 2, 3) for c in (12, 13)] + [(t + 4, 13)])
        _patch(g, t - 1, 0, ["...........gg...", "...........#g#.", "..........#d#..."])
        _patch(g, t + 2, 0, ["..........d#...."])
    elif pose == "wrench":
        _arms_down(g)
        _clear(g, [(t + 2, 12), (t + 2, 13), (t + 3, 12), (t + 3, 13), (t + 4, 13)])
        _patch(g, t - 2, 0, [
            "...........#.#..",
            "...........###..",
            "............#.g.",
            "...........d#gg.",
            "..........d.#...",
            "............#...",
        ])
    if overlay:
        _patch(g, 0, 3, _OVERLAYS[overlay])
    return ["".join(r) for r in g]


FRAMES: dict[str, list[str]] = {
    "walk_a": _build(legs="a", pose="down", mouth="flat"),
    "walk_b": _build(legs="b", pose="down", mouth="flat", eyes="blink"),
    "read": _build(legs="idle", pose="read", eyes="up", mouth="flat"),
    "idle": _build(legs="idle", pose="down"),
    "surprised": _build(legs="idle", pose="up", eyes="wide", mouth="o", overlay="!"),
    "thinking": _build(legs="idle", pose="think", eyes="up", mouth="flat", overlay="?"),
    "tinker": _build(legs="b", pose="wrench", eyes="open", mouth="smile", overlay="gear"),
    "wave": _build(legs="idle", pose="wave", eyes="happy", mouth="smile"),
}

# Tag slug -> reaction frame; anything else idles.
REACTIONS = {
    "products": "surprised",
    "psychology": "thinking",
    "learning": "thinking",
    "engineering": "tinker",
}


def frame_for_tag(slug: str) -> str:
    return REACTIONS.get(slug, "idle")


def sprite_image(name: str, scale: int = SCALE) -> Image.Image:
    """Return an 'LA' image: grey levels in L, alpha mask where the sprite is opaque."""
    rows = FRAMES[name]
    h = len(rows)
    lum = Image.new("L", (W, h), 255)
    alpha = Image.new("L", (W, h), 0)
    lp, ap = lum.load(), alpha.load()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in SHADES:
                lp[x, y] = SHADES[ch]
                ap[x, y] = 255
    size = (W * scale, h * scale)
    return Image.merge("LA", (lum.resize(size, Image.NEAREST), alpha.resize(size, Image.NEAREST)))


SIZE = (W * SCALE, HEIGHT * SCALE)
