import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// migrations/ のファイル名の先頭4桁が重ならないことを確かめる（docs/development.md の「並行して作業するときの決まり」）。
// 並んだ PR が別々に最大の番号の次を取ると重なる。CI の migration のジョブは空の D1 に順に当てるだけで、重なっても通る。
// 重なった番号が test/schema.test.ts の startsWith('<番号>_') で別のファイルを拾い、main の CI が落ちた（#1685、#1700）。
// 重なりを見つけたら、後から main に入る PR が sync-base で取り込むときに番号を取り直す。
// 既にマージ済みのものは、本番の D1 が当てたファイル名を覚えているので改名も書き換えもできず、ALLOWED_DUPLICATES に足す。
const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

// 0049 は #1681 と #1682 が同時に取った。互いの表を参照せず、ファイル名の辞書順で当たるので DB は壊れない。
export const ALLOWED_DUPLICATES: Record<string, string[]> = {
  '0049': ['0049_add_kind_conversions.sql', '0049_make_epics_reward_tier_nullable.sql'],
};

export function findDuplicates(names: string[]): Record<string, string[]> {
  const byNumber = new Map<string, string[]>();
  for (const name of names) {
    const match = /^(\d{4})_/.exec(name);
    if (!match) continue;
    byNumber.set(match[1], [...(byNumber.get(match[1]) ?? []), name]);
  }
  return Object.fromEntries(
    [...byNumber].filter(([, files]) => files.length > 1).map(([n, files]) => [n, files.sort()]),
  );
}

function unexpected(duplicates: Record<string, string[]>): string[] {
  return Object.entries(duplicates)
    .filter(([n, files]) => JSON.stringify(files) !== JSON.stringify(ALLOWED_DUPLICATES[n]))
    .map(([n, files]) => `${n}: ${files.join(', ')}`);
}

const sqlNames = () => readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));

describe('migrations の番号', () => {
  test('.sql の名前は <4桁の番号>_<名前>.sql の形', () => {
    const bad = sqlNames().filter((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name));
    assert.deepEqual(bad, [], '形に当たらないと番号の重なりの検査から外れる');
  });

  test('今の migrations/ は、許した重なりのほかに番号が重ならない', () => {
    const names = sqlNames();
    assert.deepEqual(
      unexpected(findDuplicates(names)),
      [],
      '番号が重なっている。後から main に入る PR は sync-base で取り込むときに番号を取り直す（docs/development.md の「並行して作業するときの決まり」）',
    );
  });

  test('許した重なりのファイルが、今も migrations/ にある', () => {
    const names = sqlNames();
    for (const files of Object.values(ALLOWED_DUPLICATES)) {
      for (const file of files) assert.ok(names.includes(file), `${file} が無い。許可の一覧から外す`);
    }
  });

  test('新しい重なりを見つける', () => {
    const names = ['0049_a.sql', '0049_b.sql', '0050_a.sql', '0050_b.sql', '0051_c.sql'];
    assert.deepEqual(unexpected(findDuplicates(names)), [
      '0049: 0049_a.sql, 0049_b.sql',
      '0050: 0050_a.sql, 0050_b.sql',
    ]);
  });

  test('許した重なりに3つ目が加わると見つける', () => {
    const names = [...ALLOWED_DUPLICATES['0049'], '0049_c.sql'];
    assert.equal(unexpected(findDuplicates(names)).length, 1);
  });

  test('許した2つだけなら通る', () => {
    assert.deepEqual(unexpected(findDuplicates(ALLOWED_DUPLICATES['0049'])), []);
  });
});
