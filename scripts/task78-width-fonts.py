"""Reproducible horizontal-only OFL derivative, for native browser line layout.

The export uses the original static font plus an X-only CTM. These variable
fonts implement that same transform in native contenteditable/Canvas, without
transforming the editor, replacing text nodes, or interfering with native Undo.
Requires fontTools. Original and derived binaries remain OFL-1.1.
"""
from pathlib import Path
from copy import deepcopy
from fontTools.ttLib import TTFont
from fontTools.designspaceLib import DesignSpaceDocument, AxisDescriptor, SourceDescriptor
from fontTools.varLib import build
import shutil

root = Path(__file__).resolve().parents[1]
source = root / 'tmp/task78-assets/liberation-fonts-ttf-2.1.5'
target = root / 'public/fonts/liberation'
target.mkdir(parents=True, exist_ok=True)
shutil.copyfile(source / 'LICENSE', target / 'OFL.txt')
for path in source.glob('*.ttf'):
    shutil.copyfile(path, target / path.name)

derived = root / 'public/fonts/r1width'
derived.mkdir(parents=True, exist_ok=True)
licence = (source / 'LICENSE').read_text()
(derived / 'OFL.txt').write_text(
    'R1 Width Sans/Serif/Mono: horizontal-width derivatives of Liberation 2.1.5.\n'
    '2026 R1 contributors. Original reserved names are not used as derivative family names.\n'
    'Glyphs are uniformly scaled along X; heights are unchanged; hinting is removed.\n'
    'The derivatives are distributed under SIL OFL 1.1, reproduced below.\n\n' + licence)
work = root / 'tmp/task78-assets/width-masters'
work.mkdir(parents=True, exist_ok=True)
for path in sorted(target.glob('*.ttf')):
    base = TTFont(path)
    family, style = path.stem.split('-')
    family = family.replace('Liberation', 'R1Width')
    # Decompose first: composite offsets and component transforms must not
    # accidentally apply the horizontal transform twice.
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.pens.transformPen import TransformPen
    glyphset = base.getGlyphSet()
    plain = {}
    for name in base.getGlyphOrder():
        pen = TTGlyphPen(None)
        from fontTools.pens.recordingPen import DecomposingRecordingPen
        rec = DecomposingRecordingPen(glyphset)
        glyphset[name].draw(rec)
        rec.replay(pen)
        plain[name] = pen.glyph()
    ds = DesignSpaceDocument()
    axis = AxisDescriptor(); axis.name = 'Width'; axis.tag = 'wdth'
    axis.minimum = 50; axis.default = 100; axis.maximum = 200
    ds.addAxis(axis)
    for width in (50, 100, 200):
        font = deepcopy(base)
        factor = width / 100
        for tag in ('fpgm', 'prep', 'cvt ', 'kern', 'GPOS', 'GSUB', 'DSIG'):
            if tag in font: del font[tag]
        for name, glyph in plain.items():
            g = deepcopy(glyph)
            if g.numberOfContours > 0:
                g.coordinates = type(g.coordinates)((round(x * factor), y) for x, y in g.coordinates)
            font['glyf'][name] = g
            advance, lsb = base['hmtx'][name]
            font['hmtx'][name] = (round(advance * factor), round(lsb * factor))
        font['name'].names = [entry for entry in font['name'].names if entry.nameID not in (1,2,3,4,6,16,17)]
        for platform, encoding, language in ((3,1,0x409), (1,0,0)):
            for id, value in ((1,family),(2,style),(3,f'{family}-{style}-1.0'),(4,f'{family} {style}'),(6,f'{family}-{style}'),(16,family),(17,style)):
                font['name'].setName(value, id, platform, encoding, language)
        master = work / f'{family}-{style}-{width}.ttf'; font.save(master)
        desc = SourceDescriptor(); desc.path = str(master); desc.name = str(width)
        desc.familyName = family; desc.styleName = style; desc.location = {'Width': width}
        if width == 100: desc.copyInfo = desc.copyLib = desc.copyFeatures = True
        ds.addSource(desc)
    variable, _, _ = build(ds)
    variable.save(derived / f'{family}-{style}.ttf')
    print(f'{family}-{style}: { (derived / (family + "-" + style + ".ttf")).stat().st_size } bytes')
