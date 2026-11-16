import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import SprintNamingSetting from './SprintNamingSetting.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/aoba') } }));
function body(template: string | null, number: number, canWrite = true) {
  return render(SprintNamingSetting, {
    props: {
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
  expect(html).not.toMatch(/<p[^>]*role="status"/);
  expect(body('{unknown}', 12)).not.toContain('次の名前の例');
  expect(body('次{n}', 0)).not.toContain('次の名前の例');
});
test('展開の失敗は例へ混ぜず、名前の欄のエラーとして結ぶ', () => {
  const html = body('あ'.repeat(97) + '{n}', 1000);
  expect(html).not.toContain('次の名前の例');
  expect(html).toContain('名前の初期値が100字を超えます');
  expect(html).toContain('aria-invalid="true"');
  expect(html).toMatch(/id="[^"]+-template"/);
});
test('読み取り専用の長いルールも、ラベル付きの折り返す部品で出す', () => {
  const html = body('長い名前'.repeat(25), 12, false);
  expect(html).toContain('命名ルール');
  expect(html).toContain('次の番号');
  expect(html.match(/class="doc-box is-plain"/g)).toHaveLength(2);
  expect(html).not.toContain('<input');
});
