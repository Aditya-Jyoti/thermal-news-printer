"""Regenerates the static font instances from the backend's variable fonts (needs fonttools).
Skia (CanvasKit/RN) cannot set variation axes, so we bake the exact instances render.py uses.
Usage: python make_static.py
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

SRC = Path(__file__).resolve().parents[3] / "backend/tnp/print/fonts"
OUT = Path(__file__).parent
JOBS = [
    ("PlayfairDisplay-VF.ttf", {"wght": 800}, "PlayfairDisplay-Mast.ttf"),
    ("SourceSerif4-VF.ttf", {"wght": 440, "opsz": 21}, "SourceSerif4-Body.ttf"),
    ("SourceSerif4-VF.ttf", {"wght": 500, "opsz": 13}, "SourceSerif4-Small.ttf"),
    ("SourceSerif4-Italic-VF.ttf", {"wght": 500, "opsz": 17}, "SourceSerif4-Tag.ttf"),
    ("SourceSerif4-Italic-VF.ttf", {"wght": 400, "opsz": 15}, "SourceSerif4-DateItalic.ttf"),
    # Heavier instances for the "darkest" print level (thin serifs survive the 1-bit threshold).
    ("SourceSerif4-VF.ttf", {"wght": 600, "opsz": 21}, "SourceSerif4-BodyHeavy.ttf"),
    ("SourceSerif4-VF.ttf", {"wght": 680, "opsz": 13}, "SourceSerif4-SmallHeavy.ttf"),
    ("SourceSerif4-Italic-VF.ttf", {"wght": 680, "opsz": 17}, "SourceSerif4-TagHeavy.ttf"),
    ("SourceSerif4-Italic-VF.ttf", {"wght": 560, "opsz": 15}, "SourceSerif4-DateItalicHeavy.ttf"),
]
for src, axes, name in JOBS:
    f = instantiateVariableFont(TTFont(SRC / src), axes)
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    s = subset.Subsetter(opts)
    s.populate(unicodes=list(range(0x20, 0x250)) + list(range(0x2000, 0x2070)) + [0x20AC, 0x2122, 0x2190, 0x2192])
    s.subset(f)
    f.save(OUT / name)
