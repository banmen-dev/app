import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import type { OutputOf } from '../../shared/operations/define.ts';
import type { myToday } from '../../shared/operations/organization/my-today.ts';
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
  expect(body).toContain('今日やることを読めませんでした：青葉工房');
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
