"""生成後に実行: python scripts/boot-font-assets.test.py（fonttools[woff] が必要）。"""
from pathlib import Path
import unittest
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen

ROOT = Path(__file__).resolve().parent.parent


def variations(font):
    return {selector: dict(entries) for table in font['cmap'].tables if table.format == 14
            for selector, entries in table.uvsDict.items()}


def referenced_names(font):
    ids = {a.axisNameID for a in font['fvar'].axes}
    for instance in font['fvar'].instances:
        ids.add(instance.subfamilyNameID)
        if instance.postscriptNameID != 0xFFFF:
            ids.add(instance.postscriptNameID)
    stat = font['STAT'].table
    ids.update(a.AxisNameID for a in stat.DesignAxisRecord.Axis)
    ids.update(v.ValueNameID for v in stat.AxisValueArray.AxisValue)
    ids.add(stat.ElidedFallbackNameID)
    return ids


def outline(font, name, weight):
    glyphs = font.getGlyphSet(location={'wght': weight})
    pen = DecomposingRecordingPen(glyphs)
    glyphs[name].draw(pen)
    return glyphs[name].width, pen.value


class FontCoverage(unittest.TestCase):
    def test_unicode_variations_notdef_and_license(self):
        files = sorted((ROOT / 'design/fonts').glob('*.woff2'))
        self.assertEqual(len(files), 12)
        for file in files:
            with self.subTest(file=file.name):
                source = TTFont(ROOT / 'node_modules/@fontsource-variable/noto-sans-jp/files' / file.name)
                target = TTFont(file)
                a, b = variations(source), variations(target)
                self.assertEqual({s: set(codes) for s, codes in a.items()},
                                 {s: set(codes) for s, codes in b.items()})
                for weight in [400, 500, 600, 700, 900]:
                    self.assertEqual(outline(source, '.notdef', weight), outline(target, '.notdef', weight))
                    for selector, entries in a.items():
                        for codepoint, glyph in entries.items():
                            old = glyph or source.getBestCmap()[codepoint]
                            new = b[selector][codepoint] or target.getBestCmap()[codepoint]
                            self.assertEqual(outline(source, old, weight), outline(target, new, weight))
                self.assertEqual(referenced_names(source), referenced_names(target))
                for name_id in referenced_names(target):
                    self.assertTrue(any(n.nameID == name_id for n in target['name'].names))
                for name_id in {0, 13, 14} | referenced_names(target):
                    original = {(n.platformID, n.platEncID, n.langID, n.toUnicode())
                                for n in source['name'].names if n.nameID == name_id}
                    optimized = {(n.platformID, n.platEncID, n.langID, n.toUnicode())
                                 for n in target['name'].names if n.nameID == name_id}
                    self.assertEqual(original, optimized)


if __name__ == '__main__':
    unittest.main()
