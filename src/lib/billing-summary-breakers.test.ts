// #1241 請求画面の「契約と使用量」（BillingSummary.svelte）を、容量と人数の境目の値と大きな値で崩しにかかる。
// 見るのは、使った量の丸め（1 MB 未満、1 MB・1 GB ちょうど、その直前、上限の直前、0）、大きな上限（10,000 人、100 TB）、
// 状態の印と予定日・お試しの期限、未契約と自分用のプランの出し方、決済・請求額・更新日を出さないこと
import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';
vi.mock('$app/paths', () => ({ asset: (path: string) => path, resolve: (path: string) => path }));
import BillingSummary from './components/BillingSummary.svelte';
import type { OutputOf } from '../shared/operations/define.ts';
import type { billingOrganizationSummary } from '../shared/operations/billing.ts';

type Summary = OutputOf<typeof billingOrganizationSummary>;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

function summaryOf(override: Partial<Summary> = {}): Summary {
  return {
    kind: 'team',
    state: 'active',
    purge_on: null,
    purge_due: false,
    trial_ends_on: null,
    contract: {
      plan: 'team',
      billing_interval: 'monthly',
      extra_10gb_units: 0,
      extra_50gb_units: 0,
      custom_member_limit: null,
      custom_attachment_quota_bytes: null,
    },
    member_limit: 10,
    attachment_quota_bytes: 30 * GIB,
    usage: { seats_used: 0, attachment_used_bytes: 0 },
    ...override,
  } as Summary;
}
// 本文のタグを外し、空白を1つにした文字
function textOf(summary: Summary): string {
  const { body } = render(BillingSummary, { props: { summary } });
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}
const storage = (used: number, quota = 30 * GIB) =>
  textOf(summaryOf({ attachment_quota_bytes: quota, usage: { seats_used: 0, attachment_used_bytes: used } }));

describe('使った容量の境目', () => {
  test.each([
    [0, '0 B / 30 GB'],
    [1, '1 B / 30 GB'],
    [MIB - 1, '1,048,575 B / 30 GB'],
    [MIB, '1 MB / 30 GB'],
    [GIB - 1, '1,023.9 MB / 30 GB'],
    [GIB, '1 GB / 30 GB'],
    [1.5 * GIB, '1.5 GB / 30 GB'],
  ])('%d バイトは「%s」', (used, expected) => {
    expect(storage(used)).toContain(expected);
  });

  test('上限の 1 バイト手前は、上限と同じ値に丸めない（満杯と見間違えない）', () => {
    expect(storage(30 * GIB - 1)).toContain('29.9 GB / 30 GB');
    expect(storage(GIB - 1, GIB)).toContain('1,023.9 MB / 1 GB');
    expect(storage(512 * MIB - 1, 512 * MIB)).toContain('511.9 MB / 512 MB');
  });

  test('上限ちょうどは上限と同じ値、上限を超えた値はそのまま出す', () => {
    expect(storage(30 * GIB)).toContain('30 GB / 30 GB');
    expect(storage(31 * GIB)).toContain('31 GB / 30 GB');
  });

  test('100 TB の上限と使用量も、指数や NaN にせず GB の桁区切りで出す', () => {
    const text = storage(100 * TIB - 1, 100 * TIB);
    expect(text).toContain('102,399.9 GB / 102,400 GB');
    expect(text).not.toMatch(/NaN|e\+|Infinity/);
  });
});

describe('人数の境目と大きな値', () => {
  test('0 人と 10,000 人の上限は桁区切りで並べる', () => {
    expect(textOf(summaryOf({ usage: { seats_used: 0, attachment_used_bytes: 0 } }))).toContain('0 / 10 人');
    const text = textOf(summaryOf({ member_limit: 10_000, usage: { seats_used: 9_999, attachment_used_bytes: 0 } }));
    expect(text).toContain('9,999 / 10,000 人');
  });
  test('上限を超えた人数もそのまま出す', () => {
    expect(textOf(summaryOf({ member_limit: 3, usage: { seats_used: 4, attachment_used_bytes: 0 } }))).toContain(
      '4 / 3 人',
    );
  });
});

describe('状態と期限', () => {
  test('利用中は予定日の注記を出さない', () => {
    const text = textOf(summaryOf());
    expect(text).toContain('利用中');
    expect(text).not.toContain('データを消');
  });
  test('一時停止中は印を出し、予定日の注記を出さない', () => {
    const text = textOf(summaryOf({ state: 'suspended' }));
    expect(text).toContain('一時停止中');
    expect(text).not.toContain('データを消');
  });
  test('解約で停止は予定日を出し、過ぎていればその旨を出す', () => {
    const before = textOf(summaryOf({ state: 'cancelled', purge_on: '2026-12-01', purge_due: false }));
    expect(before).toContain('解約で停止');
    expect(before).toContain('2026-12-01 にデータを消します');
    const due = textOf(summaryOf({ state: 'cancelled', purge_on: '2026-11-01', purge_due: true }));
    expect(due).toContain('データを消す予定日（2026-11-01）を過ぎています');
    expect(due).not.toContain('2026-11-01 にデータを消します');
  });
  test('お試しの期限は、期限があるときだけ出す', () => {
    expect(textOf(summaryOf())).not.toContain('お試しの期限');
    expect(textOf(summaryOf({ contract: null, trial_ends_on: '2026-12-24' }))).toContain('お試しの期限');
  });
});

describe('プランと追加容量', () => {
  test('チーム用の未契約は「未契約」で、追加容量の行を出さない', () => {
    const text = textOf(summaryOf({ contract: null }));
    expect(text).toContain('未契約');
    // 案内の文（「追加容量を変えるときは」）には出るので、項目の行（「追加容量 なし」や口数）が無いことを見る
    expect(text).not.toMatch(/追加容量 (なし|\+)/);
  });
  test('自分用の未契約は「未契約」にせず、パーソナルとして出す', () => {
    const text = textOf(summaryOf({ kind: 'personal', contract: null, member_limit: 1, attachment_quota_bytes: GIB }));
    expect(text).toContain('パーソナル');
    expect(text).not.toContain('未契約');
  });
  test('追加容量の口数は 10 GB と 50 GB を両方並べる', () => {
    const text = textOf(
      summaryOf({
        contract: {
          plan: 'business',
          billing_interval: 'yearly',
          extra_10gb_units: 2,
          extra_50gb_units: 1,
          custom_member_limit: null,
          custom_attachment_quota_bytes: null,
        },
      }),
    );
    expect(text).toContain('年払い');
    expect(text).toContain('+10 GB × 2 口、+50 GB × 1 口');
  });
});

describe('出さないもの', () => {
  test.each([
    ['利用中・契約あり', summaryOf()],
    ['未契約のお試し', summaryOf({ contract: null, trial_ends_on: '2026-12-24' })],
    ['解約で停止', summaryOf({ state: 'cancelled', purge_on: '2026-11-01', purge_due: true })],
  ])('%s: 請求額・決済・更新日を出さず、運用者への連絡の案内を出す', (_name, summary) => {
    const text = textOf(summary);
    expect(text).not.toMatch(/更新日|請求額|円|￥|¥|決済|カード/);
    expect(text).toMatch(/連絡|問い合わせ/);
  });
});
