import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PREVIEW_REPOSITORY_ID } from '../src/server/preview-trigger/webhook.ts';
import { openPreviewBranches } from './deploy-preview.ts';

// 掃除の照合を崩す手口。既存のテストに無い型の揺れ・ページ送り・値の一致を確かめる。
const own = (ref: string) => ({ head: { ref, repo: { id: PREVIEW_REPOSITORY_ID } } });

test('掃除の宛先は Worker の PREVIEW_REPOSITORY_ID と同じ ID を使う', async () => {
  const urls: string[] = [];
  await openPreviewBranches(async (url) => {
    urls.push(url);
    return [];
  });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith(`https://api.github.com/repositories/${PREVIEW_REPOSITORY_ID}/pulls?`));
});

test('2ページ目で id が読めなければ、1ページ目の結果を返さずに例外にする', async () => {
  let page = 0;
  await assert.rejects(
    openPreviewBranches(async () => {
      page++;
      return page === 1
        ? Array.from({ length: 100 }, () => own('374-preview'))
        : [{ head: { ref: '375-preview', repo: { id: `${PREVIEW_REPOSITORY_ID}` } } }];
    }),
  );
  assert.equal(page, 2);
});

test('head.repo が undefined・配列のときは削除済み fork と同じ扱いにせず例外にする', async () => {
  for (const repo of [undefined, [{ id: PREVIEW_REPOSITORY_ID }]]) {
    await assert.rejects(
      openPreviewBranches(async () => [{ head: { ref: '374-preview', repo } }]),
      /開いた PR のブランチを読めませんでした/,
      String(JSON.stringify(repo)),
    );
  }
});

test('id が小数・BigInt 風の文字列・Infinity なら例外にする', async () => {
  for (const id of [PREVIEW_REPOSITORY_ID + 0.5, '1425341812n', ' 1425341812', Number.POSITIVE_INFINITY, Number.NaN]) {
    await assert.rejects(
      openPreviewBranches(async () => [{ head: { ref: '374-preview', repo: { id } } }]),
      /開いた PR のブランチを読めませんでした/,
      String(id),
    );
  }
});

test('負の ID や -0 の fork は数えず、例外にもしない', async () => {
  const branches = await openPreviewBranches(async () => [
    { head: { ref: '275-task', repo: { id: -PREVIEW_REPOSITORY_ID } } },
    { head: { ref: '276-task', repo: { id: -0 } } },
    own('374-preview'),
  ]);
  assert.deepEqual(branches, ['374-preview']);
});
