// 読み込み中の骨組み（LoadingSheet と、最初の読み込みの #boot-loading）の形を、行き先の画面から決める。
// 枠の外の画面（ログイン、組織の選択、届いた招待など）は紙の形（null）。組織の枠の中は、行き先の本文の組みに近い形を選ぶ。
// 最初の読み込みの static/boot-shape.js は import できないので、同じ対応を URL から持つ（scripts/boot-shape.test.ts が突き合わせる）
export const loadingShapes = ['today', 'aside', 'tree', 'board', 'plan', 'list', 'settings', 'wiki', 'task'] as const;
export type LoadingShape = (typeof loadingShapes)[number];

// route.id ごとの形。組織の枠の中の画面はすべて載せる（scripts/boot-shape.test.ts が確かめる）。載っていないものは紙の形
const byRoute: Record<string, LoadingShape | null> = {
  // 今日やること: 本文だけの1列（右の脇は無い）
  '/[slug]': 'today',
  '/[slug]/admin': 'settings',
  // お気に入り: 見出しと行の並び
  '/[slug]/favorites': 'list',
  // 通知: 見出しと知らせの行の並び
  '/[slug]/notifications': 'list',
  // マイプロフィール: 設定の節の並び
  '/[slug]/me': 'settings',
  // 届いた招待は、組織に入れる人にも枠を出さない紙の画面
  '/[slug]/invitations': null,
  '/[slug]/wiki': 'wiki',
  '/[slug]/wiki/[pageId]': 'wiki',
  '/[slug]/w/[id]': 'tree',
  '/[slug]/w/[id]/connections': 'list',
  '/[slug]/w/[id]/epics/[epicId]': 'aside',
  '/[slug]/w/[id]/inbox': 'list',
  '/[slug]/w/[id]/members': 'list',
  '/[slug]/w/[id]/plan': 'plan',
  '/[slug]/w/[id]/settings': 'settings',
  '/[slug]/w/[id]/board': 'board',
  // 前の経路（/board へ移すだけ。#1497）。最初の読み込みの骨組み（static/boot-shape.js）と形をそろえる
  '/[slug]/w/[id]/sprint': 'board',
  '/[slug]/w/[id]/tasks/[taskId]': 'task',
  '/[slug]/w/[id]/wiki': 'wiki',
  '/[slug]/w/[id]/wiki/[pageId]': 'wiki',
};

export function loadingShape(routeId: string | null | undefined): LoadingShape | null {
  if (!routeId) return null;
  return byRoute[routeId] ?? null;
}

// 見出しの右に操作のボタン（ページを足す、スプリントを作る）が並ぶ形
export function loadingShapeHasActions(shape: LoadingShape): boolean {
  return shape === 'plan' || shape === 'wiki';
}

// 形ごとの帯の数。LoadingSheet がこの数で並べ、最初の読み込みの static/boot-shape.js は同じ数を写す
// （import できないので、scripts/boot-shape.test.ts がこの値と突き合わせる）
export const loadingShapeCounts = {
  treeSelects: 4,
  treeRows: 8,
  boardColumns: 4,
  planLanes: 3,
  settingSections: 3,
  taskButtons: 4,
  taskFields: 6,
  listRows: 6,
} as const;

export type LoadingEyebrow = 'always' | 'narrow' | 'none';

// バックログと進行中のスプリントのボードには小見出しが無い。ボードの骨組みはスプリントの有無を読む前に出るので、進行中の表示に合わせる。
// ほかのワークスペースの画面で名前を出す小見出しは 760px 以下だけに出す。エピックの区分などはどの幅でも出す。
// 最初の読み込みの static/boot-shape.js も同じ扱いにする（scripts/boot-shape.test.ts が突き合わせる）
const narrowEyebrowShapes: readonly LoadingShape[] = ['list', 'plan', 'settings', 'wiki'];
export function loadingShapeEyebrow(routeId: string | null | undefined): LoadingEyebrow {
  if (!routeId) return 'none';
  const shape = loadingShape(routeId);
  if (shape === null || shape === 'task' || shape === 'tree' || shape === 'board') return 'none';
  return routeId.startsWith('/[slug]/w/[id]') && narrowEyebrowShapes.includes(shape) ? 'narrow' : 'always';
}

// 枠の外の紙のうち、/ だけはダッシュボードの広い2列にする。
export function loadingDashboard(routeId: string | null | undefined): boolean {
  return routeId === '/';
}

// ワークスペースの画面（タスクとエピックの詳細も）は、761px 以上でパンくずの下にタブの帯（WorkspaceTabs）を持つ。
// 骨組みも同じ画面にだけ帯を出し、読み込んだ後と見出しの位置を揃える。最初の読み込みの static/boot-shape.js は同じ対応を URL から持つ
// （scripts/boot-shape.test.ts が突き合わせる）
export function loadingShapeTabs(routeId: string | null | undefined): boolean {
  return loadingShape(routeId) !== null && routeId!.startsWith('/[slug]/w/[id]');
}

// タブの帯の骨組みに並べる帯の数（タブは7つか8つ。帯は見た目の目安なので、一般のメンバーの数にそろえる）
export const loadingTabCount = 7;
