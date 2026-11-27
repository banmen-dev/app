// 設定ファイルのストア。トークンを持つので、本人だけが読める 0600 で書く（Issue #582 の前提）
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileConfigStore } from './config-file.ts';
import type { Config } from './main.ts';

const sample: Config = {
  default_profile: 'main',
  profiles: { main: { url: 'https://guild.example', token: `bnp_${'F'.repeat(43)}`, org: 'aoba', workspace: 'ws-1' } },
};

async function inTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sg-config-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('fileConfigStore', () => {
  test('ファイルが無ければ read は undefined', async () => {
    await inTempDir(async (dir) => {
      assert.equal(await fileConfigStore(join(dir, 'none', 'config.json')).read(), undefined);
    });
  });

  test('write は親のディレクトリを作り、0600 で書き、read で同じ値を返す', async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, 'banmen', 'nested', 'config.json');
      const store = fileConfigStore(path);
      await store.write(sample);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(await store.read(), sample);
    });
  });

  test('既にある 0644 のファイルに書いても 0600 になる', async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, 'config.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ profiles: {} }));
      chmodSync(path, 0o644);
      await fileConfigStore(path).write(sample);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(await fileConfigStore(path).read(), sample);
    });
  });

  // 2026-11-22 に置き場所を scrum-guild から banmen に改めた。前の置き場所の設定を失わない
  test('新しい置き場所に無ければ前の置き場所を読み、書くのは新しい置き場所だけ', async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, 'banmen', 'config.json');
      const legacy = join(dir, 'scrum-guild', 'config.json');
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(legacy, JSON.stringify(sample));
      const store = fileConfigStore(path, legacy);
      assert.deepEqual(await store.read(), sample);
      const next: Config = { ...sample, default_profile: 'other' };
      await store.write(next);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(await store.read(), next);
      assert.deepEqual(await fileConfigStore(legacy).read(), sample);
    });
  });

  test('新しい置き場所にあれば前の置き場所は読まない', async () => {
    await inTempDir(async (dir) => {
      const path = join(dir, 'banmen', 'config.json');
      const legacy = join(dir, 'scrum-guild', 'config.json');
      for (const [file, value] of [
        [path, sample],
        [legacy, { profiles: {} }],
      ] as const) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(value));
      }
      assert.deepEqual(await fileConfigStore(path, legacy).read(), sample);
    });
  });

  test('どちらにも無ければ undefined', async () => {
    await inTempDir(async (dir) => {
      assert.equal(
        await fileConfigStore(join(dir, 'a', 'config.json'), join(dir, 'b', 'config.json')).read(),
        undefined,
      );
    });
  });
});
