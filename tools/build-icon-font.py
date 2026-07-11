"""Build images/otak-usage-icons.woff - the 2-glyph brand icon font.

Glyphs: OpenAI logo at U+E900 ($(otak-openai)), Claude logo at U+E901
($(otak-claude)), registered via contributes.icons in package.json.

Sources: the "openai" and "claude" SVGs from simple-icons
(https://simpleicons.org/, CC0; brand marks remain property of their owners).

Usage:
  pip install fonttools
  python tools/build-icon-font.py <dir-with-openai.svg-and-claude.svg> images/otak-usage-icons.woff
"""
import re, sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.svgLib.path import parse_path

SCRATCH = sys.argv[1]
OUT = sys.argv[2]

UPM = 1000
ASCENT = 850
DESCENT = -150

def svg_d(path):
    src = open(path, encoding='utf-8').read()
    return re.search(r'<path d="([^"]+)"', src).group(1)

glyphs = {
    'openai': (0xE900, svg_d(f'{SCRATCH}/openai.svg')),
    'claude': (0xE901, svg_d(f'{SCRATCH}/claude.svg')),
}

order = ['.notdef'] + list(glyphs)
fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder(order)
fb.setupCharacterMap({cp: name for name, (cp, _) in glyphs.items()})

# simple-icons viewBox is 24x24, y-down. Map to font units (y-up):
# x' = x * s, y' = (24 - y) * s + DESCENT  -> glyph spans DESCENT..DESCENT+1000
s = UPM / 24.0
glyf = {}
metrics = {}
pen = TTGlyphPen(None)
pen.closePath = pen.closePath  # no-op clarity
empty = TTGlyphPen(None)
glyf['.notdef'] = empty.glyph()
metrics['.notdef'] = (UPM, 0)
for name, (cp, d) in glyphs.items():
    gpen = TTGlyphPen(None)
    qpen = Cu2QuPen(gpen, max_err=1.0)
    tpen = TransformPen(qpen, (s, 0, 0, -s, 0, 24 * s + DESCENT))
    parse_path(d, tpen)
    glyf[name] = gpen.glyph()
    metrics[name] = (UPM, 0)

fb.setupGlyf(glyf)
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT)
fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=DESCENT, usWinAscent=ASCENT, usWinDescent=-DESCENT)
fb.setupNameTable({'familyName': 'otak-usage-icons', 'styleName': 'Regular',
                   'fullName': 'otak-usage-icons', 'psName': 'otak-usage-icons'})
fb.setupPost()
font = fb.font
font.flavor = 'woff'
font.save(OUT)
print('saved', OUT)
