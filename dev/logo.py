#!/usr/bin/env python3
# Builds docs/assets/logo.svg and logo-dark.svg: "adt+" as glyph outlines from
# JetBrains Mono Bold (SIL OFL 1.1), with the font's own underscore in the
# next character cell as a blinking cursor. Outlines rather than live text, so
# the mark looks the same on every reader's system. Development only, never
# shipped.
#
#   python3 -m pip install fonttools
#   dev/logo.py JetBrainsMono-Bold.ttf [docs/assets]
#
# The font comes from https://github.com/JetBrains/JetBrainsMono/releases
# (fonts/ttf/JetBrainsMono-Bold.ttf in the zip). A static .ttf only: a
# variable font draws its default weight here.
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

if len(sys.argv) not in (2, 3):
    sys.exit('usage: dev/logo.py <font.ttf> [out_dir]')
font_path = sys.argv[1]
out_dir = sys.argv[2] if len(sys.argv) == 3 else 'docs/assets'
f = TTFont(font_path)
gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f['head'].unitsPerEm
size, baseline, padx = 38, 44, 4
s = size / upm
adv = f['hmtx'][cmap[ord('a')]][0] * s
fmt = lambda v: f'{v:.2f}'.rstrip('0').rstrip('.')

# ink bounds of a glyph, to trim the side padding exactly
def bounds(ch, x):
    bp = BoundsPen(gs)
    gs[cmap[ord(ch)]].draw(TransformPen(bp, (s, 0, 0, -s, x, baseline)))
    return bp.bounds

x0 = padx - bounds('a', 0)[0]
paths = []
for i, ch in enumerate('adt+'):
    pen = SVGPathPen(gs, fmt)
    gs[cmap[ord(ch)]].draw(TransformPen(pen, (s, 0, 0, -s, x0 + i * adv, baseline)))
    paths.append(pen.getCommands())
# cursor: the font's own underscore, in the next character cell
ux0, uy0, ux1, uy1 = bounds('_', x0 + 4 * adv)
width = ux1 + padx
for name, text, cur in (('logo.svg', '#1d1d1f', '#0969da'), ('logo-dark.svg', '#f5f5f7', '#58a6ff')):
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(width)} 64" width="{fmt(width)}" height="64" role="img" aria-label="adt+">
  <title>adt+</title>
  <style>
    .c{{animation:blink 1.06s steps(1,end) infinite}}
    @keyframes blink{{50%{{opacity:0}}}}
    @media (prefers-reduced-motion: reduce){{.c{{animation:none}}}}
  </style>
  <path fill="{text}" d="{' '.join(paths)}"/>
  <rect class="c" fill="{cur}" x="{fmt(ux0)}" y="{fmt(uy0)}" width="{fmt(ux1-ux0)}" height="{fmt(uy1-uy0)}" rx="1"/>
</svg>
'''
    with open(f'{out_dir}/{name}', 'w') as out:
        out.write(svg)
print('width', fmt(width), 'adv', fmt(adv), 'cursor', fmt(ux0), fmt(uy0), fmt(ux1 - ux0), fmt(uy1 - uy0))
