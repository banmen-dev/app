import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import SprintNamingSetting from './SprintNamingSetting.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/aoba') } }));
function body(
  template: string | null,
  number: number,
  canWrite = true,
  options: { refreshFailed?: boolean; retrying?: boolean; retryFailed?: boolean } = {},
) {
  return render(SprintNamingSetting, {
    props: {
      ...options,
      slug: 'aoba',
      workspaceId: 'w',
      value: { start_on: '2026-01-05', sprint_name_template: template, sprint_number_next: number },
      canWrite,
      onsaved: async () => {},
      onstale: () => {},
      ondirty: () => {},
      onretry: async () => {},
    },
  }).body;
}
test('正しい例だけを通常の文で出し、例を読み上げ領域に置かない', () => {
  const html = body('次{n}', 12);
  expect(html).toContain('次の名前の例（2026-01-05）: 次12');
  const example = /<([a-z][\w-]*)\b([^>]*id="[^"]+-example"[^>]*)>/.exec(html);
  expect(example).not.toBeNull();
  expect(example![2]).not.toContain('role="status"');
  expect(body('{unknown}', 12)).not.toContain('次の名前の例');
  expect(body('次{n}', 0)).not.toContain('次の名前の例');
});
test('展開超過は保存可能な設定用の警告として欄へ関連付ける', () => {
  const html = body('あ'.repeat(97) + '{n}', 1000);
  expect(html).not.toContain('次の名前の例');
  expect(html).toContain('100字');
  expect(html).toContain('このルールは保存できます');
  expect(html).not.toContain('aria-invalid="true"');
  expect(html).toContain('role="note"');
});
test('読み取り専用の長いルールも、ラベル付きの折り返す部品で出す', () => {
  const html = body('長い名前'.repeat(25), 12, false);
  expect(html).toContain('命名ルール');
  expect(html).toContain('次の番号');
  expect(html.match(/class="doc-box is-plain"/g)).toHaveLength(2);
  expect(html).not.toContain('<input');
  const labels = [...html.matchAll(/role="note" aria-labelledby="([^"]+)"/g)];
  expect(labels).toHaveLength(2);
  for (const label of labels) expect(html).toContain(`id="${label[1]}"`);
});

test('変更なしでも保存ボタンを押せる', () => {
  expect(body(null, 1)).toMatch(/<button[^>]*type="submit"[^>]*aria-disabled="false"/);
});
test('入力中の誤りの理由を欄へ結び、消えた例を参照しない', () => {
  for (const [template, number, reason] of [
    ['{unknown}', 12, '使えない変数'],
    ['次{n}', 0, '次の番号は1以上'],
  ] as const) {
    const html = body(template, number);
    expect(html).toContain(reason);
    expect(html).toContain('aria-invalid="true"');
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
    for (const input of inputs) {
      const described = /aria-describedby="([^"]*)"/.exec(input)?.[1]?.split(' ') ?? [];
      for (const id of described) expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('次の名前の例');
  }
});
test('命名だけの再試行中と再失敗を常設statusで知らせる', () => {
  expect(body(null, 1, true, { refreshFailed: true, retrying: true })).toContain('読み込んでいます');
  expect(body(null, 1, true, { refreshFailed: true, retryFailed: true })).toContain('まだ読み込めませんでした');
});
