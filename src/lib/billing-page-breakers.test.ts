// #1241 請求画面（src/routes/auth/billing/+page.svelte）を、svelte/server で描いて崩しにかかる（3周目）。
// 見るのは、選んだ組織の紙の並び（契約と使用量 → 請求管理者 → 変更履歴）、契約と使用量だけが読めなかったときの
// 失敗ともう一度試すボタン、自分用の組織の名前の出し方（一覧の行と選んだ組織の紙）、一覧の行の読み上げで組織が区別できること、
// 個別契約の人数と標準容量（docs/requirements.md の「請求管理者（#1240）」の #1241 の項）
import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';
vi.mock('$app/paths', () => ({ asset: (path: string) => path, resolve: (path: string) => path }));
vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, invalidateAll: async () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/auth/billing') } }));
import Page from '../routes/auth/billing/+page.svelte';
import BillingSummary from './components/BillingSummary.svelte';
import type { OutputOf } from '../shared/operations/define.ts';
import type { billingOrganizationSummary } from '../shared/operations/billing.ts';

type Summary = OutputOf<typeof billingOrganizationSummary>;
const GIB = 1024 ** 3;

const summary: Summary = {
  kind: 'team',
  state: 'active',
  purge_on: null,
  purge_due: false,
  trial_ends_on: null,
  contract: null,
  member_limit: 15,
  attachment_quota_bytes: 30 * GIB,
  usage: { seats_used: 3, attachment_used_bytes: 0 },
};

type Row = { slug: string; name: string; kind: 'team' | 'personal'; plan: string | null; state: string };
function listData(organizations: Row[]) {
  return {
    failed: false,
    account_id: 'acct-fictional-0001',
    operator: false,
    organizations,
    invitations: [],
    selected: null,
  };
}
function selectedData(organization: Row, selectedSummary: Summary | null) {
  return {
    failed: false,
    account_id: 'acct-fictional-0001',
    operator: false,
    organizations: [organization],
    invitations: [],
    selected: { ...organization, administrators: [], events: [], summary: selectedSummary },
  };
}
const htmlOf = (data: unknown) => render(Page, { props: { data } as never }).body.replace(/<!--[\s\S]*?-->/g, '');
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// 一覧の行（<a class="choice" …>…</a>）の中の文字。読み上げではこの文字がリンクの名前になる
function rowNames(html: string): string[] {
  return [...html.matchAll(/<a class="choice"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => textOf(match[1]!).trim());
}

describe('選んだ組織の紙', () => {
  test('契約と使用量 → 請求管理者 → 変更履歴の順に並ぶ（docs/design.md の「請求管理者の専用画面」）', () => {
    const text = textOf(
      htmlOf(selectedData({ slug: 'aoba', name: 'あおば開発', kind: 'team', plan: null, state: 'active' }, summary)),
    );
    const order = ['あおば開発の契約と使用量', 'あおば開発の請求管理者', '変更履歴'].map((word) => text.indexOf(word));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('契約と使用量だけが読めなかったら、その紙に失敗ともう一度試すボタンを出し、担当者の紙と指名の欄は残す', () => {
    const html = htmlOf(
      selectedData({ slug: 'aoba', name: 'あおば開発', kind: 'team', plan: null, state: 'active' }, null),
    );
    const text = textOf(html);
    expect(html).toMatch(/role="alert"[^>]*>\s*契約と使用量を読み込めませんでした/);
    expect(html).toMatch(/<button class="btn is-sm" type="button"[^>]*>もう一度試す<\/button>/);
    // 失敗の文とボタンは「契約と使用量」の紙の中にあり、「請求管理者」の紙より前
    expect(text.indexOf('あおば開発の契約と使用量')).toBeLessThan(text.indexOf('読み込めませんでした'));
    expect(text.indexOf('もう一度試す')).toBeLessThan(text.indexOf('あおば開発の請求管理者'));
    // 使用量の値は出さない（前の組織や古い値を出さない）
    expect(text).not.toContain('利用の状態');
    // 担当者の管理は使えるまま
    expect(html).toMatch(/<form>[\s\S]*<button class="btn is-primary" type="submit">指名する<\/button>/);
    // 画面全体の失敗（LoadFailed）にしない
    expect(text).not.toContain('読み込めませんでした。もう一度');
  });

  test('自分用の組織を選んだときも、紙の題は名前の代わりに「自分用」で出す（docs/data-model.md の organizations の kind）', () => {
    // docs/data-model.md「画面は kind が personal の組織を、名前の代わりに辞書の「自分用」で出す」、
    // Issue #1241「自分用の組織は名前を辞書の「自分用」で出す」。一覧の行は「自分用」なのに、選ぶと生の名前が題に出る
    const text = textOf(
      htmlOf(
        selectedData(
          { slug: 'minato-own', name: 'ミナトの組織', kind: 'personal', plan: 'personal', state: 'active' },
          { ...summary, kind: 'personal', member_limit: 1, attachment_quota_bytes: GIB },
        ),
      ),
    );
    expect(text).toContain('自分用の契約と使用量');
    expect(text).not.toContain('ミナトの組織');
  });
});

describe('担当組織の一覧の行', () => {
  test('行には組織名・プラン・利用の状態だけが出て、状態ごとに区別できる', () => {
    const names = rowNames(
      htmlOf(
        listData([
          { slug: 'aoba', name: 'あおば開発', kind: 'team', plan: 'team', state: 'active' },
          { slug: 'kaede', name: 'かえで製作所', kind: 'team', plan: null, state: 'suspended' },
          { slug: 'sumire', name: 'すみれ商会', kind: 'team', plan: 'pro', state: 'cancelled' },
        ]),
      ),
    );
    expect(names).toEqual(['あおば開発 チーム 利用中', 'かえで製作所 未契約 一時停止中', 'すみれ商会 プロ 解約で停止']);
  });

  test('ほかの人の自分用の組織を2つ担当すると、2つの行の読み上げの名前が同じにならない', () => {
    // docs/requirements.md「担当組織の一覧の各行は、組織名・プラン・利用の状態だけを出し」、docs/design.md「担当組織の行には組織名と…」。
    // 請求管理者は1アカウントで複数組織を担当でき（requirements の「請求管理者（#1240）」）、自分用の組織にも担当者を置ける
    // （test/billing-organization-summary.test.ts の「自分用の組織は kind personal で出る」）。名前を「自分用」に置き換えると、
    // 2つのリンクが「自分用 パーソナル 利用中」で並び、どちらがどの組織か読み上げでも見た目でも分からない
    const names = rowNames(
      htmlOf(
        listData([
          { slug: 'minato-own', name: 'ミナトの組織', kind: 'personal', plan: 'personal', state: 'active' },
          { slug: 'hikari-own', name: 'ヒカリの組織', kind: 'personal', plan: 'personal', state: 'active' },
        ]),
      ),
    );
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

describe('個別契約', () => {
  test('個別契約は、人数と標準容量の個別の値も出す（追加容量を足した上限と別に）', () => {
    // docs/requirements.md の #1241 の項「担当組織の契約（プラン、支払いの周期、追加容量の口数、個別契約の人数と標準容量）…を見られる」。
    // API は custom_member_limit と custom_attachment_quota_bytes を返すのに、BillingSummary は planLabel が周期までしか出さず、
    // 標準容量（200 GB）は画面のどこにも出ない（上限は追加容量を足した 250 GB）
    const { body } = render(BillingSummary, {
      props: {
        summary: {
          ...summary,
          contract: {
            plan: 'custom',
            billing_interval: 'yearly',
            extra_10gb_units: 0,
            extra_50gb_units: 1,
            custom_member_limit: 120,
            custom_attachment_quota_bytes: 200 * GIB,
          },
          member_limit: 120,
          attachment_quota_bytes: 250 * GIB,
        },
      },
    });
    const text = textOf(body.replace(/<!--[\s\S]*?-->/g, ''));
    expect(text).toContain('標準 200 GB');
  });

  test('標準値が空の古い個別契約は、空の値を「null」や「NaN」にせず、プランと周期だけを出す', () => {
    const { body } = render(BillingSummary, {
      props: {
        summary: {
          ...summary,
          contract: {
            plan: 'custom',
            billing_interval: 'monthly',
            extra_10gb_units: 0,
            extra_50gb_units: 0,
            custom_member_limit: null,
            custom_attachment_quota_bytes: null,
          },
        },
      },
    });
    const text = textOf(body.replace(/<!--[\s\S]*?-->/g, ''));
    expect(text).toContain('個別・月払い');
    expect(text).not.toMatch(/null|NaN|undefined/);
  });
});
