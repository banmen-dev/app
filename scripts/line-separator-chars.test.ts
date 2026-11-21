import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const rootPrefix = Buffer.from(root + sep);
const extensions = new Set(['.ts', '.js', '.mjs', '.cjs', '.svelte', '.json', '.jsonc']);
const separators = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, 'g');

test('追跡中のコードと JSON に生の U+2028・U+2029 がない', () => {
  // Git のパスに UTF-8 で読めないバイトがあっても、ファイルを開くときまで保持する。
  const files = execFileSync('git', ['ls-files', '-z', '--deduplicate'], { cwd: root, encoding: 'latin1' });
  const findings: string[] = [];

  for (const path of files.split('\0')) {
    if (!extensions.has(extname(path))) continue;
    const pathBytes = Buffer.from(path, 'latin1');
    const absolutePath = Buffer.concat([rootPrefix, pathBytes]);
    if (!lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile()) continue;

    const validUtf8 = isUtf8(pathBytes);
    const escapedBackslashes = (validUtf8 ? pathBytes.toString('utf8') : path).replaceAll('\\', '\\\\');
    const reportedPath = validUtf8
      ? escapedBackslashes.replaceAll('\r', '\\r').replaceAll('\n', '\\n')
      : escapedBackslashes.replaceAll(
          /[^\x20-\x7e]/g,
          (byte) => `\\x${byte.charCodeAt(0).toString(16).padStart(2, '0')}`,
        );
    const lines = readFileSync(absolutePath, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(separators)) {
        const code = match[0].charCodeAt(0).toString(16);
        findings.push(`${reportedPath}:${index + 1}:${match.index + 1} U+${code}`);
      }
    }
  }

  if (findings.length > 0) {
    assert.fail(
      [
        '生の U+2028・U+2029 は \\u2028・\\u2029 のようにエスケープして書いてください。',
        'docs/development.md の「vitest 5 の Workers の実行環境」の箇条を参照してください。',
        ...findings,
      ].join('\n'),
    );
  }
});
