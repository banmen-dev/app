import { loadingEpic, loadingFeedback, loadingWorkspace } from './loading-fixture.ts';
export type Reading = { name: string; secondary: boolean; input: Record<string, unknown>; global: boolean };
const op = (name: string, input: Record<string, unknown> = {}, secondary = false, global = false): Reading => ({
  name,
  input,
  secondary,
  global,
});
const ws = { workspace_id: loadingWorkspace };
const w = (name: string, secondary = false) => op(name, ws, secondary);
export type Screen = {
  route: string;
  operations: Reading[];
  operator?: boolean;
  note?: string;
  after?: Reading[];
  deferSecondary?: boolean;
};
// 通常の管理者の成功経路。条件分岐は行を分ける。レイアウトはページと分けて測る。
export const screens: Screen[] = [
  {
    route: '/',
    deferSecondary: true,
    operations: [op('my-organizations', {}, false, true)],
    after: [
      op('my-workspaces', {}, true, true),
      op('my-today', {}, true, true),
      op('my-recent-activity', {}, true, true),
    ],
    note: 'ワークスペース、今日やること、最近の更新は面を描いてから読み、組織の入口の表示を待たせない。',
  },
  {
    route: '/auth/billing',
    operations: [op('my-billing-organizations', {}, false, true)],
    after: [
      op('billing-admin-list', { slug: 'aoba' }, false, true),
      op('billing-organization-summary', { slug: 'aoba' }, false, true),
    ],
    note: '担当組織を選択した経路。一覧取得後に担当者と履歴、契約と使用量を並べて取得する。',
  },
  { route: '/auth/setup', operations: [op('onboarding-status', {}, false, true), op('me', {}, false, true)] },
  { route: '/operator', operator: true, operations: [op('list-organizations', {}, false, true)] },
  {
    route: '/operator/feedback/[id]',
    operator: true,
    operations: [op('operator-feedback', { id: loadingFeedback }, false, true)],
    note: 'R2 の meta.json を1回読む。D1 は引かない。',
  },
  {
    route: '/[slug]/+layout',
    deferSecondary: true,
    operations: [
      op('token-notice', {}, true, true),
      op('organization'),
      op('my-organizations', {}, false, true),
      op('favorite-list'),
    ],
  },
  {
    route: '/[slug]/+layout（招待あり）',
    deferSecondary: true,
    operations: [
      op('token-notice', {}, true, true),
      op('organization'),
      op('my-organizations', {}, false, true),
      op('favorite-list'),
    ],
    after: [op('invitation-list', {}, true)],
    note: '主の群の完了後に招待件数を開始し、通知・件数の完了は枠の表示を待たせない。招待だけの人の一覧は主として待つ別経路。',
  },
  { route: '/[slug]', operations: [op('today'), op('first-steps', {}, true)] },
  { route: '/[slug]/admin', operations: [], note: 'parent() の権限確認だけ。節の部品の読み込みは load 外。' },
  {
    route: '/[slug]/invitations',
    operations: [op('invitation-list')],
    note: '組織に入れる管理者。招待だけの人は親の結果を再利用。',
  },
  {
    route: '/[slug]/me',
    operations: [op('token-list', {}, false, true), op('invitation-list'), op('me', {}, false, true)],
  },
  { route: '/[slug]/w/[id]/+layout', operations: [w('workspace')] },
  {
    route: '/[slug]/w/[id]',
    operations: [w('backlog-tree'), w('category-repository-list', true)],
  },
  { route: '/[slug]/w/[id]/plan', operations: [w('sprint-list'), w('plan-summary', true)] },
  { route: '/[slug]/w/[id]/board', operations: [w('sprint-board')] },
  { route: '/[slug]/w/[id]/sprint', operations: [], note: '前の経路。/board へ移すだけ（#1497）。' },
  {
    route: '/[slug]/w/[id]/settings',
    operations: [w('category-repository-list'), w('column-list'), w('detail-field-list'), w('sprint-list')],
    note: 'parent() 後の並列群。',
  },
  { route: '/[slug]/w/[id]/members', operations: [w('member-list')] },
  { route: '/[slug]/w/[id]/inbox', operations: [w('inbox-list')] },
  { route: '/[slug]/w/[id]/connections', operations: [w('connection-list')] },
  {
    route: '/[slug]/w/[id]/epics/[epicId]',
    operations: [op('epic-detail', { ...ws, epic_id: loadingEpic })],
  },
  { route: '/[slug]/wiki', operations: [op('org-wiki-tree')] },
  {
    route: '/[slug]/wiki/[pageId]',
    operations: [op('org-wiki-tree'), op('org-wiki-page', { page_id: '019c0000-0000-7000-8000-000000000001' })],
  },
  { route: '/[slug]/w/[id]/wiki', operations: [w('workspace-wiki-tree')] },
  {
    route: '/[slug]/w/[id]/wiki/[pageId]',
    operations: [
      w('workspace-wiki-tree'),
      op('workspace-wiki-page', { ...ws, page_id: '019c0001-0000-7000-8000-000000000001' }),
    ],
  },
];
