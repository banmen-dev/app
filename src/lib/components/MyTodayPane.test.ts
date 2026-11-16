import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import type { OutputOf } from '../../shared/operations/define.ts';
import type { myToday } from '../../shared/operations/organization/my-today.ts';
import * as drawer from '../drawer.svelte.ts';
import MyTodayPane from './MyTodayPane.svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock('$app/state', () => ({ page: { params: {}, url: new URL('https://example.test/') } }));
vi.mock('$app/paths', () => ({
  resolve: (route: string, params: Record<string, string>) =>
    route.replace(/\[(\w+)\]/g, (_, key: string) => encodeURIComponent(params[key]!)),
}));

type Data = OutputOf<typeof myToday>;
const empty: Data = { tasks: [], omitted_organizations: 0, failed_organizations: [] };
const row = (id: string, organization: Data['tasks'][number]['organization']): Data['tasks'][number] => ({
  id,
  title: id,
  organization,
  workspace_id: 'w1',
  workspace_name: '制作班',
  points: null,
  due_on: null,
  today_on: '2026-11-17',
  completed_at: null,
  today: '2026-11-17',
  week_start: 1,
  position: 'a0',
  carry_days: 0,
  sprint_active: false,
  is_today_completed: false,
  reopenable: false,
  assignee: null,
  delegatee: null,
  repository: null,
  sprint: null,
});

test('別組織の行を同じ区分に混ぜ、正しい組織とタスクの引き出しへリンクする。書くボタンは無い', () => {
  const tasks = [
    row('後のタスク', { slug: 'aoba', name: '青葉工房', kind: 'team' }),
    { ...row('先のタスク', { slug: 'solo', name: '固定名', kind: 'personal' }), carry_days: 2 },
  ];
  const { body } = render(MyTodayPane, { props: { today: { ...empty, tasks } } });
  expect(body).toContain('全組織の今日やること');
  expect(body).toContain('青葉工房');
  expect(body).toContain('自分用');
  expect(body).not.toContain('固定名');
  expect(body).toContain('制作班');
  expect(body.indexOf('先のタスク')).toBeLessThan(body.indexOf('後のタスク'));
  expect(body).toContain('href="/solo/w/w1?task=%E5%85%88%E3%81%AE%E3%82%BF%E3%82%B9%E3%82%AF"');
  expect(body).not.toContain('<button');
});

test('上限と部分失敗を空の案内と区別し、失敗した組織へ進める', () => {
  const { body } = render(MyTodayPane, {
    props: {
      today: {
        ...empty,
        omitted_organizations: 2,
        failed_organizations: [{ slug: 'aoba', name: '青葉工房', kind: 'team' }],
      },
    },
  });
  expect(body).toContain('ほか 2 組織');
  expect(body).toContain('今日やることを読めませんでした');
  expect(body).toContain('青葉工房');
  expect(body).toContain('href="/aoba"');
  expect(body).not.toContain('今日やることはまだありません');
});

test('本当に空のときだけ空の案内を出す', () => {
  const { body } = render(MyTodayPane, { props: { today: empty } });
  expect(body).toContain('今日やることはまだありません');
  expect(body).not.toContain('<button');
});

test('読取失敗は再試行を出し、空の案内を出さない', () => {
  const { body } = render(MyTodayPane, { props: { today: null } });
  expect(body).toContain('<button');
  expect(body).toContain('もう一度試す');
  expect(body).not.toContain('今日やることはまだありません');
});

test('未取得の初回は面の中だけ骨組みを出す', () => {
  const { body } = render(MyTodayPane);
  expect(body).toContain('aria-busy="true"');
  expect(body).toContain('class="skeleton"');
  expect(body).not.toContain('今日やることはまだありません');
});

test('上限を超えた空は未取得を明示し、全組織が空とは言わない', () => {
  const { body } = render(MyTodayPane, { props: { today: { ...empty, omitted_organizations: 3 } } });
  expect(body).toContain('ほか 3 組織は読み込んでいません');
  expect(body).toContain('読み込んだ組織には今日やることがありません');
  expect(body).not.toContain('今日やることはまだありません');
});

test('失敗は警告の形と固有文、組織への入口はchoiceで表示する', () => {
  const failed = render(MyTodayPane, { props: { today: null } }).body;
  expect(failed).toContain('callout is-warn');
  expect(failed).toContain('role="alert"');
  expect(failed).toContain('今日やることを読み込めませんでした');
  const partial = render(MyTodayPane, {
    props: { today: { ...empty, failed_organizations: [{ slug: 'aoba', name: '<架空の組織>', kind: 'team' }] } },
  }).body;
  expect(partial).toContain('class="choice"');
  expect(partial).toContain('&lt;架空の組織>');
  expect(partial).toContain('href="/aoba"');
});

test('組織の指定があっても、タスク詳細の開き方の設定を使う', () => {
  const href = vi.spyOn(drawer, 'taskDetailHref').mockReturnValue('/preferred/detail');
  const attrs = vi.spyOn(drawer, 'taskLinkAttrs').mockReturnValue({ target: '_blank', rel: 'noopener noreferrer' });
  try {
    const { body } = render(MyTodayPane, {
      props: { today: { ...empty, tasks: [row('設定の確認', { slug: 'aoba', name: '青葉工房', kind: 'team' })] } },
    });
    expect(href).toHaveBeenCalledWith('/aoba/w/w1?task=%E8%A8%AD%E5%AE%9A%E3%81%AE%E7%A2%BA%E8%AA%8D');
    expect(attrs).toHaveBeenCalled();
    expect(body).toContain('href="/preferred/detail"');
    expect(body).toContain('target="_blank"');
  } finally {
    href.mockRestore();
    attrs.mockRestore();
  }
});
