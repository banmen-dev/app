// 見本（design/）と本番（src/）の二重持ちを突き合わせる。アイコンと言葉の辞書は見本が先に決まるので、
// 見本だけ、または本番だけを直すとここで落ちる。照合するのは見本にあるキーだけで、本番の辞書は画面の文言を足して大きくなってよい。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { artViewBox, arts } from '../src/lib/art.ts';
import { iconViewBox, icons } from '../src/lib/icons.ts';
import { fitTabCount } from '../src/lib/tab-fit.ts';
import { themeLabelKeys, themeNoteKeys, themes } from '../src/shared/theme.ts';
import { dictionary } from '../src/shared/vocabulary.ts';

const read = (file: string) => readFileSync(new URL(`../design/${file}`, import.meta.url), 'utf8');

// design/art.js も同じ作りで、symbol の id は a-<名前>
function evaluateArts(): { names: string[]; symbols: Map<string, { viewBox: string; body: string }> } {
  let sprite = '';
  const window: { SQ_ARTS?: string[] } = {};
  const document = {
    createElement: () => ({
      set innerHTML(html: string) {
        sprite = html;
      },
      firstChild: {},
    }),
    body: { prepend: () => {} },
  };
  vm.runInNewContext(read('art.js'), { window, document });
  const symbols = new Map<string, { viewBox: string; body: string }>();
  for (const [, id, viewBox, body] of sprite.matchAll(/<symbol id="a-([^"]+)" viewBox="([^"]+)">(.*?)<\/symbol>/g)) {
    symbols.set(id, { viewBox, body });
  }
  return { names: [...(window.SQ_ARTS ?? [])], symbols };
}

// design/icons.js は IIFE で window と document を触り、SVG のスプライトを body に差し込む。
// 偽の document に渡された文字列を受け取り、symbol を読み出す
function evaluateIcons(): { names: string[]; symbols: Map<string, { viewBox: string; body: string }> } {
  let sprite = '';
  const window: { SQ_ICONS?: string[] } = {};
  const document = {
    createElement: () => ({
      set innerHTML(html: string) {
        sprite = html;
      },
      firstChild: {},
    }),
    body: { prepend: () => {} },
  };
  vm.runInNewContext(read('icons.js'), { window, document });
  const symbols = new Map<string, { viewBox: string; body: string }>();
  for (const [, id, viewBox, body] of sprite.matchAll(/<symbol id="i-([^"]+)" viewBox="([^"]+)">(.*?)<\/symbol>/g)) {
    symbols.set(id, { viewBox, body });
  }
  // vm の中の配列は Array の実体が別なので、deepEqual の前に外の配列へ写す
  return { names: [...(window.SQ_ICONS ?? [])], symbols };
}

// design/kit.js の DICT は、全体が IIFE の中で window.SQ_DATA などを前提にするので、DICT のリテラルだけを取り出して評価する
function readKitDictionary(): Record<string, string> {
  const literal = /\n {2}const DICT = (\{[\s\S]*?\n {2}\});/.exec(read('kit.js'))?.[1];
  assert.ok(literal, 'design/kit.js に DICT が見つからない（書き方を変えたら、このテストの取り出し方も直す）');
  return vm.runInNewContext(`(${literal})`);
}

// SVG の要素の属性を、属性の並びによらずに比べられる形で取り出す
function readElements(source: string, tag: 'svg' | 'path' | 'img'): Record<string, string>[] {
  return [...source.matchAll(new RegExp(`<${tag}\\b([^>]*?)\\/?>`, 'g'))].map(([, attrs]) =>
    Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]).sort()),
  );
}

const readPaths = (source: string) => readElements(source, 'path');
const readSvg = (source: string) => readElements(source, 'svg')[0];
// 要素のタグ名の並び。path の外に足した title（読み上げの二重読み）や g、circle を拾う
const readTags = (source: string) => [...source.matchAll(/<([a-zA-Z][\w-]*)\b/g)].map(([, tag]) => tag);

describe('見本との照合', () => {
  // 横組みのロゴ（枠の外の画面）と、上の帯の左端のマーク単体
  for (const { name, file, count, wrapper } of [
    { name: 'brandMark', file: 'BrandMark.svelte', count: 1, wrapper: /<span class="brand-art" aria-hidden="true">/ },
    {
      name: 'brandSymbol',
      file: 'BrandSymbol.svelte',
      count: 1,
      wrapper: /<span class="brand-art is-symbol" aria-hidden="true">/,
    },
  ]) {
    test(`ロゴ（${name}）は見本と本番で同じ画像、寸法、読み上げの扱い`, () => {
      const kit = new RegExp(`const ${name} = \`([^\`]*)\``).exec(read('kit.js'))?.[1];
      assert.ok(kit, `design/kit.js に ${name} が見つからない`);
      const component = readFileSync(new URL(`../src/lib/components/${file}`, import.meta.url), 'utf8');
      // Svelte の asset() を見本と同じ相対パスにそろえる
      const normalized = component
        .replaceAll(/\$\{asset\('([^']+)'\)\}/g, '$1')
        .replaceAll(/\{asset\('([^']+)'\)\}/g, '"$1"')
        .replaceAll(/\{`([^`]+)`\}/g, '"$1"');
      const images = readElements(kit, 'img');
      assert.equal(images.length, count);
      assert.deepEqual(readElements(normalized, 'img'), images);
      if (name === 'brandMark') {
        // 画像だけの一致では、片方の名前が画像や別の文言に戻っても検出できない。
        const textName = /<span class="brand-name">\$?\{t\('([^']+)'\)\}<\/span>/;
        for (const source of [kit, component]) {
          assert.equal(textName.exec(source)?.[1], 'brandName');
          const brand = source.slice(source.indexOf('<span class="brand-art"'));
          assert.deepEqual(readTags(brand), ['span', 'img', 'span'], 'マークの後に名前を並べる');
        }
      }
      for (const source of [kit, normalized]) {
        assert.match(source, wrapper);
        for (const image of readElements(source, 'img')) {
          assert.equal(image.alt, '');
          const data = readFileSync(new URL(`../design/${image.src}`, import.meta.url));
          if (image.src.endsWith('.webp')) {
            // 可逆 WebP（VP8L）の寸法。幅・高さは14ビットずつ、値は寸法-1。
            assert.equal(data.toString('ascii', 12, 16), 'VP8L');
            const dimensions = data.readUInt32LE(21);
            assert.equal(Number(image.width), (dimensions & 0x3fff) + 1);
            assert.equal(Number(image.height), ((dimensions >>> 14) & 0x3fff) + 1);
          } else {
            assert.equal(Number(image.width), data.readUInt32BE(16));
            assert.equal(Number(image.height), data.readUInt32BE(20));
          }
        }
      }
    });
  }

  test('Google の G のロゴは見本と本番で同じ形と色。公式の4色の path を変えない', () => {
    const googleMark = /const googleMark = `([^`]*)`/.exec(read('kit.js'))?.[1];
    assert.ok(
      googleMark,
      'design/kit.js に googleMark が見つからない（書き方を変えたら、このテストの取り出し方も直す）',
    );
    const component = readFileSync(new URL('../src/lib/components/GoogleMark.svelte', import.meta.url), 'utf8');
    const official = [
      {
        d: 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z',
        fill: '#EA4335',
      },
      {
        d: 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z',
        fill: '#4285F4',
      },
      {
        d: 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z',
        fill: '#FBBC05',
      },
      {
        d: 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z',
        fill: '#34A853',
      },
      { d: 'M0 0h48v48H0z', fill: 'none' },
    ];
    for (const [label, source] of [
      ['見本の googleMark', googleMark],
      ['本番の GoogleMark.svelte', component],
    ]) {
      // svg と path ×5 だけ。title や g、circle を足して公式の形を崩さない
      assert.deepEqual(readTags(source), ['svg', 'path', 'path', 'path', 'path', 'path'], `${label} の要素`);
      assert.deepEqual(readPaths(source), official, `${label} の path`);
      assert.deepEqual(
        readSvg(source),
        { 'aria-hidden': 'true', class: 'google-mark', viewBox: '0 0 48 48' },
        `${label} の svg`,
      );
    }
  });

  test('GitHub のマークは見本と本番で同じ形。Octicons の path を写し、色は文字の色にする', () => {
    const githubMark = /const githubMark = `([^`]*)`/.exec(read('kit.js'))?.[1];
    assert.ok(
      githubMark,
      'design/kit.js に githubMark が見つからない（書き方を変えたら、このテストの取り出し方も直す）',
    );
    const component = readFileSync(new URL('../src/lib/components/GithubMark.svelte', import.meta.url), 'utf8');
    // Primer Octicons v19.24.0 の icons/mark-github-16.svg の path
    const octicon = {
      d: 'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656',
      fill: 'currentColor',
    };
    for (const [label, source] of [
      ['見本の githubMark', githubMark],
      ['本番の GithubMark.svelte', component],
    ]) {
      assert.deepEqual(readTags(source), ['svg', 'path'], `${label} の要素`);
      assert.deepEqual(readPaths(source), [octicon], `${label} の path`);
      assert.deepEqual(
        readSvg(source),
        { 'aria-hidden': 'true', class: 'github-mark', viewBox: '0 0 16 16' },
        `${label} の svg`,
      );
    }
  });

  test('アイコンは見本と同じ名前と中身を持つ', () => {
    const design = evaluateIcons();
    assert.ok(design.symbols.size > 0, '見本のアイコンを読めなかった');
    assert.deepEqual([...design.symbols.keys()].sort(), design.names.slice().sort());
    assert.deepEqual(Object.keys(icons).sort(), [...design.symbols.keys()].sort());
    for (const [name, symbol] of design.symbols) {
      assert.equal(symbol.viewBox, iconViewBox, `${name} の viewBox`);
      assert.equal(icons[name as keyof typeof icons], symbol.body, `${name} の中身`);
    }
  });

  test('線画は見本と同じ名前と中身を持つ', () => {
    const design = evaluateArts();
    assert.ok(design.symbols.size > 0, '見本の線画を読めなかった');
    assert.deepEqual([...design.symbols.keys()].sort(), design.names.slice().sort());
    assert.deepEqual(Object.keys(arts).sort(), [...design.symbols.keys()].sort());
    for (const [name, symbol] of design.symbols) {
      assert.equal(symbol.viewBox, artViewBox, `${name} の viewBox`);
      assert.equal(arts[name as keyof typeof arts], symbol.body, `${name} の中身`);
    }
  });

  test('画面が指定する線画の名前は、定義にある', () => {
    // 綴りを誤ると <use> が空の絵を描くので、本番の art="…" と見本の emptyState の最後の引数、art(…) の名前を引く
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.svelte')) {
          for (const m of readFileSync(path, 'utf8').matchAll(/\bart="(\w+)"/g)) names.add(m[1]);
        }
      }
    };
    walk(fileURLToPath(new URL('../src', import.meta.url)));
    for (const file of readdirSync(fileURLToPath(new URL('../design', import.meta.url)))) {
      if (!file.endsWith('.html')) continue;
      for (const m of read(file).matchAll(/(?:undefined|tone|""|"xp"), "(\w+)"\)|SQ\.art\("(\w+)"/g))
        names.add(m[1] ?? m[2]);
    }
    assert.ok(names.size > 0, '画面の線画の指定を読めなかった');
    for (const name of names) assert.ok(name in arts, `${name} は線画の定義に無い`);
  });

  test('見本の HTML の t・label・title が直接参照する billing の辞書キーは、見本と本番の両方に存在する', () => {
    const design = readKitDictionary();
    const production: Record<string, string | undefined> = dictionary;
    const references = readdirSync(new URL('../design/', import.meta.url))
      .filter((file) => file.endsWith('.html'))
      .flatMap((file) =>
        [...read(file).matchAll(/\b(?:t|label|title)\(\s*(['"])(billing[A-Z][A-Za-z0-9]*)\1/g)].map(([, , key]) => ({
          file,
          key,
        })),
      );
    assert.ok(references.length > 0, '見本の HTML に請求の辞書キーが見つからない');
    for (const { file, key } of references) {
      assert.ok(Object.hasOwn(design, key), `${file}: ${key} が見本の DICT に無い`);
      assert.ok(Object.hasOwn(production, key), `${file}: ${key} が本番の辞書に無い`);
      assert.equal(design[key], production[key], `${file}: ${key} の文言`);
    }
  });

  test('言葉の辞書は、見本の DICT の全キーについて、言葉が同じ', () => {
    const design = readKitDictionary();
    const keys = Object.keys(design);
    assert.ok(keys.length > 0, '見本の DICT を読めなかった');
    const production: Record<string, string | undefined> = dictionary;
    for (const key of keys) {
      const text = production[key];
      assert.ok(text, `本番の辞書に ${key} が無い`);
      assert.equal(text, design[key], `${key} の中身`);
    }
  });

  test('テーマの名前と説明は、見本の THEME_LABEL と THEME_NOTE と同じ', () => {
    const readObject = (name: string): Record<string, string> => {
      const literal = new RegExp(`\\n {2}const ${name} = (\\{[\\s\\S]*?\\});`).exec(read('kit.js'))?.[1];
      assert.ok(literal, `design/kit.js に ${name} が見つからない（書き方を変えたら、このテストの取り出し方も直す）`);
      return vm.runInNewContext(`(${literal})`);
    };
    const labels = readObject('THEME_LABEL');
    const notes = readObject('THEME_NOTE');
    for (const theme of themes) {
      assert.equal(dictionary[themeLabelKeys[theme]], labels[theme], `${theme} の名前`);
      assert.equal(dictionary[themeNoteKeys[theme]], notes[theme], `${theme} の説明`);
    }
  });

  test('本番の辞書は、どのキーも空でない', () => {
    for (const [key, text] of Object.entries(dictionary)) {
      assert.notEqual(text, '', key);
    }
  });
});

test('組織作成のslug入力を、プラン変更の送信クリックとして扱わない', () => {
  const source = read('kit.js');
  const createDialog = source.slice(
    source.indexOf('    createPersonalOrganization:'),
    source.indexOf('    organizationCreated:'),
  );
  const slugId = /<label[^>]*for="([^"]+)"[^>]*>URL の名前（slug）/.exec(createDialog)?.[1];
  const planDialog = source.slice(source.indexOf('    changePlan:'), source.indexOf('    suspendOrganization:'));
  const submitId = /<button[^>]*id="([^"]+)"/.exec(planDialog)?.[1];
  assert.ok(slugId, '組織作成のslug入力が見つからない');
  assert.ok(submitId, 'プラン変更の送信ボタンが見つからない');
  assert.notEqual(submitId, slugId, 'slug入力のクリックがプラン変更の送信に誤って入る');
  assert.ok(source.includes(`ev.target.closest("#${submitId}")`), 'クリックの振り分けはプラン送信ボタンを指す');
  const sendingText = /submit\.textContent = "([^"]+)"/.exec(
    source.slice(source.indexOf(`ev.target.closest("#${submitId}")`)),
  )?.[1];
  assert.equal(sendingText, dictionary.operatorChanging, '送信中の文言は本番と同じ');
});

test('スプリントの見本の開始と削除は、名前なしでも期間を重ねない', () => {
  const source = read('kit.js');
  const ast = ts.createSourceFile('kit.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
    let found: ts.Node | undefined;
    function visit(node: ts.Node) {
      if (found) return;
      if (predicate(node)) found = node;
      else ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(found, 'kit.js に検証対象の構文が見つからない');
    return found;
  }
  const labels = ['sprintLabel', 'sprintLabelWithPeriod']
    .map((name) => {
      const node = findNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
      return node.getText(ast);
    })
    .join('\n');
  function dialogBody(name: string): string {
    const property = findNode((node) => ts.isPropertyAssignment(node) && node.name.getText(ast) === name);
    let body: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'openDialog') body = node.arguments[1];
      else ts.forEachChild(node, visit);
    }
    visit(property);
    assert.ok(body, `${name} の openDialog 本文が見つからない`);
    return body.getText(ast);
  }
  for (const name of [null, 'スプリント 12']) {
    const sprint = { name, start: '2099-01-04', end: '2099-01-17' };
    const context = vm.createContext({
      D: { sprints: { sp15: sprint, sp16: sprint } },
      md: (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8))}`,
      t: (key: string) => ({ sprint: 'スプリント', task: 'タスク' })[key],
      esc: (value: string) => value,
    });
    vm.runInContext(labels, context);
    for (const [dialog, action] of [
      ['deleteSprint', '削除します'],
      ['sprintStart', '始めます'],
    ]) {
      const html = /<p>(.*?)<\/p>/s.exec(dialogBody(dialog))?.[1];
      assert.ok(html, `${dialog} の冒頭が見つからない`);
      const rendered = vm.runInContext('`' + html + '`', context) as string;
      const label = name === null ? '1/4〜1/17' : `${name}（1/4〜1/17）`;
      assert.ok(rendered.startsWith(`スプリント「${label}」を${action}`), rendered);
    }
    const closing = dialogBody('sprintEnd');
    const carry = /<b>([^<]*へ持ち越す)<\/b>/s.exec(closing)?.[1];
    assert.ok(carry, 'sprintEnd の持ち越し先が見つからない');
    const renderedCarry = vm.runInContext('`' + carry + '`', context) as string;
    const label = name === null ? '1/4〜1/17' : `${name}（1/4〜1/17）`;
    assert.equal(renderedCarry, `スプリント「${label}」へ持ち越す`);
  }
});

test('見本の fitTabCount は、本番の fitTabCount（src/lib/tab-fit.ts）と同じ数を返す', () => {
  const source = read('kit.js').match(/function fitTabCount\([\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(source, 'design/kit.js に fitTabCount が無い');
  const designFit = vm.runInNewContext(`(${source.replace('function fitTabCount', 'function')})`) as typeof fitTabCount;
  for (const widths of [[], [60], [60, 60, 60, 60], [100, 20, 20], [20, 100, 60, 44]]) {
    for (const available of [Number.NaN, -1, 0, 40, 100, 190, 215, 216, 263, 264, 400]) {
      for (const gap of [0, 4, 8]) {
        for (const moreWidth of [0, 70, 80]) {
          assert.equal(
            designFit(widths, available, gap, moreWidth),
            fitTabCount(widths, available, gap, moreWidth),
            JSON.stringify({ widths, available, gap, moreWidth }),
          );
        }
      }
    }
  }
});
