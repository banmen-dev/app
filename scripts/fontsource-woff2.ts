// @fontsource の CSS は、src に woff2 と woff の両方を書く。woff2 はどのブラウザでも読めるので、使われない woff は
// build に出さない（日本語の書体は文字の範囲ごとに約250ファイルあり、woff が同じ数だけ増える）。
// 可変版の書体名も既存の共通トークンへそろえる。静的版を読む場合の woff 除去は互換のため残す。
// vite.config.ts が Vite のプラグインとして読み、scripts/fontsource-woff2.test.ts が置き換えを確かめる。
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

// 分割の 109〜119 と latin の置き換え先。dev では Vite が /@fs/ から配るので、配る範囲（server.fs.allow）にも足す。
// SvelteKit が server.fs.allow を src や node_modules に明示するため、Vite の既定（workspace の根）は効かず、
// 足さないと design/ は範囲の外として 403 になる（#1411）。
export const designFontsDir = fileURLToPath(new URL('../design/fonts/', import.meta.url));

const woffSource = /,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g;

export function dropWoff(css: string): string {
  return css.replace(woffSource, '');
}

export function fontAssetUrl(file: string): string {
  return `url(${JSON.stringify(file.replaceAll('\\', '/'))})`;
}

export function fontsourceWoff2Only(): Plugin {
  return {
    name: 'fontsource-woff2-and-family',
    // CSS を Vite が url() の解決とファイルへの書き出しにかける前（pre）に、src から woff を外す
    enforce: 'pre',
    config() {
      return { server: { fs: { allow: [designFontsDir] } } };
    },
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.css')) return null;
      // 可変版も同じ書体名で使い、見本と共通のトークンを変えない。
      if (file.includes('/@fontsource-variable/noto-sans-jp/')) {
        const normalized = code
          .replace(/font-family:\s*(['"])Noto Sans JP Variable\1\s*;/g, "font-family: 'Noto Sans JP';")
          .replace(/url\(\.\/files\/(noto-sans-jp-(?:10[9]|11[0-9]|latin)-wght-normal\.woff2)\)/g, (_, file: string) =>
            fontAssetUrl(fileURLToPath(new URL(`../design/fonts/${file}`, import.meta.url))),
          );
        const families = [...normalized.matchAll(/font-family:\s*([^;]+);/g)];
        if (families.length === 0 || families.some((family) => family[1] !== "'Noto Sans JP'")) {
          throw new Error('Noto Sans JP の書体名が変わりました。可変フォントの宣言を確認してください。');
        }
        return { code: normalized, map: null };
      }
      if (!file.includes('/@fontsource/')) return null;
      return { code: dropWoff(code), map: null };
    },
  };
}
