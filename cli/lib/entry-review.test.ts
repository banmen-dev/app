// banmen の入口（cli/banmen.ts）の設定ファイルの場所を、子プロセスで確かめる。XDG Base Directory の決まり:
// XDG_CONFIG_HOME は絶対パスのときだけ使い、空や相対パスは未設定と同じく $HOME/.config を使う
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../banmen.ts', import.meta.url));

function sg(argv: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [ENTRY, ...argv],
      { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv, cwd },
      (error, _stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr });
      },
    );
    child.stdin!.end('');
  });
}

describe('XDG_CONFIG_HOME が絶対パスでないとき', () => {
  for (const xdg of ['relative/config', './config', '~/config']) {
    test(`${xdg} は使わず、~/.config/banmen/config.json に書く`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'sg-review-home-'));
      const cwd = mkdtempSync(join(tmpdir(), 'sg-review-cwd-'));
      try {
        const result = await sg(
          ['config', 'set', 'url', 'https://guild.example'],
          { HOME: home, XDG_CONFIG_HOME: xdg },
          cwd,
        );
        assert.equal(result.code, 0, result.stderr);
        assert.ok(existsSync(join(home, '.config', 'banmen', 'config.json')));
        assert.ok(!existsSync(join(cwd, xdg)), 'カレントディレクトリの下に書かない');
        assert.ok(!existsSync(join(home, xdg)), 'HOME の下の相対パスに書かない');
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});

// 2026-11-22 に置き場所を ~/.config/scrum-guild/ から ~/.config/banmen/ に改めた（#1415）。前の置き場所の設定を引き継ぐ
describe('前の置き場所（~/.config/scrum-guild/config.json）だけがあるとき', () => {
  test('前の設定を読んで banmen に書き、前のファイルは残す', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sg-review-home-'));
    try {
      const legacy = join(home, '.config', 'scrum-guild', 'config.json');
      mkdirSync(join(home, '.config', 'scrum-guild'), { recursive: true });
      const before = { default_profile: 'main', profiles: { main: { url: 'https://guild.example' } } };
      writeFileSync(legacy, JSON.stringify(before));
      const result = await sg(['config', 'set', 'org', 'aoba'], { HOME: home }, home);
      assert.equal(result.code, 0, result.stderr);
      const written = JSON.parse(
        readFileSync(join(home, '.config', 'banmen', 'config.json'), 'utf8'),
      ) as typeof before & {
        profiles: { main: { org?: string } };
      };
      assert.equal(written.profiles.main.url, 'https://guild.example');
      assert.equal(written.profiles.main.org, 'aoba');
      assert.deepEqual(JSON.parse(readFileSync(legacy, 'utf8')), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
