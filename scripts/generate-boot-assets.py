"""初回に使う素材を可逆圧縮・横書き用に生成する。ビルド時には実行しない。

python -m pip install 'fonttools[woff]==4.61.1' 'Pillow==13.0.0'
python scripts/generate-boot-assets.py
pnpm exec node scripts/generate-favicon.ts
"""
from pathlib import Path
from io import BytesIO
from hashlib import sha256
import json
import fontTools

from fontTools import subset
from fontTools.ttLib import TTFont
from PIL import Image

root = Path(__file__).resolve().parent.parent
fonts = root / 'node_modules/@fontsource-variable/noto-sans-jp'
target = root / 'design/fonts'
target.mkdir(exist_ok=True)
(target / 'LICENSE').write_bytes((fonts / 'LICENSE').read_bytes())
# Fontsource の共通の日本語の範囲と Latin。字の範囲・太さ・横書きの機能は保つ。
# 縦書き専用の字形と位置調整を外し、到達できなくなった字形だけを落とす。
records = []
for name in [*(str(i) for i in range(109, 120)), 'latin']:
    source = fonts / f'files/noto-sans-jp-{name}-wght-normal.woff2'
    font = TTFont(source)
    before = set(font.getBestCmap())
    before_variations = {selector: dict(entries) for table in font['cmap'].tables if table.format == 14
                         for selector, entries in table.uvsDict.items()}
    selectors = {selector for table in font['cmap'].tables if table.format == 14
                 for selector in table.uvsDict}
    features = set()
    for table in ['GSUB', 'GPOS']:
        if table in font:
            features.update(record.FeatureTag for record in font[table].table.FeatureList.FeatureRecord)
    options = subset.Options()
    options.layout_features = sorted(features - {'vert', 'vrt2', 'vhal', 'vpal', 'vkrn'})
    options.recalc_timestamp = False
    options.notdef_outline = True
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_languages = ['*']
    options.name_legacy = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=before | selectors)
    subsetter.subset(font)
    assert set(font.getBestCmap()) == before
    assert {selector: dict(entries) for table in font['cmap'].tables if table.format == 14
            for selector, entries in table.uvsDict.items()} == before_variations
    assert [(axis.axisTag, axis.minValue, axis.maxValue) for axis in font['fvar'].axes] == [('wght', 100, 900)]
    encoded_font = BytesIO()
    font.save(encoded_font)
    original = source.read_bytes()
    optimized = encoded_font.getvalue()
    (target / source.name).write_bytes(optimized if len(optimized) < len(original) else original)
    records.append({'file': source.name, 'sourceSha256': sha256(source.read_bytes()).hexdigest(),
                    'sha256': sha256((target / source.name).read_bytes()).hexdigest()})
(target / 'manifest.json').write_text(json.dumps({
    'fontsourceVersion': json.loads((fonts / 'package.json').read_text())['version'],
    'fonttoolsVersion': fontTools.__version__, 'fonts': records
}, indent=2) + '\n')

source = root / 'design/brand/master/symbol.png'
image = Image.open(source).convert('RGBA')
encoded = BytesIO()
image.save(encoded, format='WEBP', lossless=True, exact=True, method=6)
assert Image.open(BytesIO(encoded.getvalue())).convert('RGBA').tobytes() == image.tobytes()
source.with_suffix('.webp').write_bytes(encoded.getvalue())
