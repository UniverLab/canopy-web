# SPDX-License-Identifier: Apache-2.0
# The outlines below are original to this repository (drawn here in code,
# not traced from any existing face) and are licensed under the repository's
# Apache-2.0 licence. They are geometric primitives — triangles, bars, a
# square, circles, a corner, branches, overlapping squares, half-filled
# circles, stars and braille dots — for code points JetBrains Mono lacks.
"""Build CanopySymbols-Regular.woff2: one-cell terminal symbols.

Run: uv run --no-project --with fonttools --with brotli python scripts/build-terminal-symbols.py

Reads unitsPerEm, the advance width, the ascender and the descender from the
self-hosted JetBrainsMono-Regular.woff2 at generation time so every glyph
here is exactly one terminal cell wide with matching vertical metrics.
Writes apps/remote/web/public/fonts/CanopySymbols-Regular.woff2 (< 40 KB).
"""

from __future__ import annotations

import math
import os
import sys

SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "apps",
    "remote",
    "web",
    "public",
    "fonts",
    "JetBrainsMono-Regular.woff2",
)
OUT = os.path.join(os.path.dirname(SRC), "CanopySymbols-Regular.woff2")
MAX_BYTES = 40 * 1024

# Code points this face covers.
TRIANGLES = (0x23F4, 0x23F5, 0x23F6, 0x23F7)
BARS = 0x23F8
SQUARE = 0x23F9
CIRCLE = 0x23FA
CORNER = 0x23BF
BRANCHES = 0x2387
OVERLAP = 0x29C9
HALF = 0x25D0
STARS = (0x2722, 0x273B, 0x273D)
STAR_SPOKES = {0x2722: 4, 0x273B: 6, 0x273D: 8}
BRAILLE_BASE = 0x2800
BRAILLE_END = 0x28FF

COVERED = (
    list(TRIANGLES)
    + [BARS, SQUARE, CIRCLE, CORNER, BRANCHES, OVERLAP, HALF]
    + list(STARS)
    + list(range(BRAILLE_BASE, BRAILLE_END + 1))
)

def _circle(pen, cx, cy, r, sides=24, clockwise=False):
    # Straight segments only: a TrueType glyf holds quadratics, and a
    # 24-gon reads round at terminal sizes. A clockwise contour winds
    # opposite to the default, so nested inside one it cuts a hole (how
    # every counter in every TrueType face works).
    pts = [
        (cx + r * math.cos(2 * math.pi * i / sides), cy + r * math.sin(2 * math.pi * i / sides))
        for i in range(sides)
    ]
    if clockwise:
        pts.reverse()
    _poly(pen, pts)


def _rect(pen, x0, y0, x1, y1):
    pen.moveTo((x0, y0))
    pen.lineTo((x1, y0))
    pen.lineTo((x1, y1))
    pen.lineTo((x0, y1))
    pen.closePath()


def _poly(pen, pts):
    pen.moveTo(pts[0])
    for pt in pts[1:]:
        pen.lineTo(pt)
    pen.closePath()


def _rotated_bar(pen, cx, cy, angle, length, width):
    dx = math.cos(angle) * length / 2
    dy = math.sin(angle) * length / 2
    px = -math.sin(angle) * width / 2
    py = math.cos(angle) * width / 2
    _poly(
        pen,
        [
            (cx - dx + px, cy - dy + py),
            (cx + dx + px, cy + dy + py),
            (cx + dx - px, cy + dy - py),
            (cx - dx - px, cy - dy - py),
        ],
    )


def _triangle(pen, cx, cy, half, direction):
    if direction == "right":
        _poly(pen, [(cx - half, cy - half), (cx - half, cy + half), (cx + half, cy)])
    elif direction == "left":
        _poly(pen, [(cx + half, cy - half), (cx + half, cy + half), (cx - half, cy)])
    elif direction == "up":
        _poly(pen, [(cx - half, cy - half), (cx + half, cy - half), (cx, cy + half)])
    else:
        _poly(pen, [(cx - half, cy + half), (cx + half, cy + half), (cx, cy - half)])


def _draw(pen, cp, adv, mid, size):
    half = size / 2
    cx = adv / 2
    cy = mid
    if cp in TRIANGLES:
        direction = {0x23F4: "left", 0x23F5: "right", 0x23F6: "up", 0x23F7: "down"}[cp]
        _triangle(pen, cx, cy, half * 0.9, direction)
    elif cp == BARS:
        w = size * 0.22
        gap = size * 0.12
        _rect(pen, cx - gap - w, cy - half, cx - gap, cy + half)
        _rect(pen, cx + gap, cy - half, cx + gap + w, cy + half)
    elif cp == SQUARE:
        _rect(pen, cx - half, cy - half, cx + half, cy + half)
    elif cp == CIRCLE:
        _circle(pen, cx, cy, half)
    elif cp == CORNER:
        # Drawn in main(): it spans the cell's full height, so it needs
        # the ascender and descender, not the centred 60% box.
        raise AssertionError("corner is drawn by draw_corner")
    elif cp == BRANCHES:
        stem_w = size * 0.14
        _rect(pen, cx - stem_w / 2, cy - half, cx + stem_w / 2, cy + half)
        _rotated_bar(pen, cx + size * 0.16, cy + size * 0.22, math.pi / 4, size * 0.62, stem_w)
        _rotated_bar(pen, cx + size * 0.16, cy - size * 0.02, math.pi / 4, size * 0.62, stem_w)
    elif cp == OVERLAP:
        side = size * 0.62
        off = size * 0.18
        for sx, sy in ((-off, off), (off, -off)):
            x0, y0 = cx - side / 2 + sx, cy - side / 2 + sy
            x1, y1 = x0 + side, y0 + side
            t = size * 0.12
            _rect(pen, x0, y0, x1, y0 + t)
            _rect(pen, x0, y1 - t, x1, y1)
            _rect(pen, x0, y0, x0 + t, y1)
            _rect(pen, x1 - t, y0, x1, y1)
    elif cp == HALF:
        # A ring plus a filled left half: the clockwise inner contour
        # hollows the disc, so the right interior stays empty. (A plain
        # full disc here would render exactly U+23FA's glyph, not this one.)
        t = size * 0.1
        _circle(pen, cx, cy, half)
        _circle(pen, cx, cy, half - t, clockwise=True)
        inner = half - t
        arc = [
            (cx + inner * math.cos(a), cy + inner * math.sin(a))
            for a in [math.pi / 2 + math.pi * i / 12 for i in range(13)]
        ]
        _poly(pen, [(cx, cy - inner)] + arc + [(cx, cy + inner)])
    elif cp in STARS:
        # Each bar through the centre shows two opposite spokes, so n
        # visible spokes need n/2 bars; both ends are rounded.
        n = STAR_SPOKES[cp]
        spoke_w = size * 0.16
        for i in range(n // 2):
            angle = math.pi / 2 + i * math.pi / (n // 2)
            _rotated_bar(pen, cx, cy, angle, size, spoke_w)
            for sign in (1, -1):
                ex = cx + sign * math.cos(angle) * size / 2
                ey = cy + sign * math.sin(angle) * size / 2
                _circle(pen, ex, ey, spoke_w / 2)
        _circle(pen, cx, cy, spoke_w * 0.9)
    elif BRAILLE_BASE <= cp <= BRAILLE_END:
        bits = cp - BRAILLE_BASE
        # Dots 1,2,3,7 down the left column; 4,5,6,8 down the right.
        xs = (adv * 0.32, adv * 0.68)
        rows = (cy + size * 0.375, cy + size * 0.125, cy - size * 0.125, cy - size * 0.375)
        cols = (
            (0, 1, 2, 6),  # left column bit indexes
            (3, 4, 5, 7),  # right column bit indexes
        )
        r = adv * 0.11
        for col, col_bits in enumerate(cols):
            for row, bit in enumerate(col_bits):
                if bits & (1 << bit):
                    _circle(pen, xs[col], rows[row], r)


def main() -> int:
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.ttLib import TTFont

    src = TTFont(SRC)
    units = src["head"].unitsPerEm
    advances = {v[0] for v in src["hmtx"].metrics.values()}
    advances.discard(0)
    adv = max(advances)
    asc = src["hhea"].ascent
    desc = src["hhea"].descent

    cell = asc - desc
    size = cell * 0.6
    mid = (asc + desc) / 2

    # The corner spans the cell's full height, so it needs the metrics.
    def draw_corner(pen):
        t = adv * 0.14
        _rect(pen, adv - t, desc, adv, asc)
        _rect(pen, 0, desc, adv, desc + t)

    glyphs = {}
    names = []
    cmap = {}
    for cp in COVERED:
        name = f"u{cp:04X}"
        names.append(name)
        cmap[cp] = name
        pen = TTGlyphPen(None)
        if cp == CORNER:
            draw_corner(pen)
        else:
            _draw(pen, cp, adv, mid, size)
        glyphs[name] = pen.glyph()

    order = [".notdef"] + names
    glyphs[".notdef"] = TTGlyphPen(None).glyph()

    fb = FontBuilder(units, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (adv, 0) for name in order})
    fb.setupHorizontalHeader(ascent=asc, descent=desc)
    fb.setupHead(unitsPerEm=units)
    fb.setupNameTable(
        {
            "familyName": "Canopy Symbols",
            "styleName": "Regular",
            "uniqueFontIdentifier": "CanopySymbols-Regular-1.0",
            "fullName": "Canopy Symbols Regular",
            "psName": "CanopySymbols-Regular",
            "version": "Version 1.0",
        }
    )
    fb.setupOS2(
        sTypoAscender=asc,
        sTypoDescender=desc,
        usWinAscent=max(asc, 0),
        usWinDescent=max(-desc, 0),
    )
    fb.setupPost()
    fb.setupMaxp()
    fb.font.flavor = "woff2"
    fb.save(OUT)

    n = os.path.getsize(OUT)
    print(f"wrote {OUT} ({n} bytes, {len(COVERED)} glyphs)")
    if n >= MAX_BYTES:
        print(f"too big: {n} >= {MAX_BYTES} byte budget", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
