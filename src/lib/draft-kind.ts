// バックログの木の末尾の空の行で、最後に選んだ種類。端末の見た目の好みなので、ブラウザの localStorage に覚える（ワークスペースをまたいで同じ）。
export const draftKinds = ['epic', 'story', 'task'] as const;
export type DraftKind = (typeof draftKinds)[number];

// 初めて開いたとき、または覚えた値が読めないときの種類
export const defaultDraftKind: DraftKind = 'task';
export const draftKindKey = 'banmen-backlog-draft-kind';

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function isDraftKind(value: unknown): value is DraftKind {
  return typeof value === 'string' && (draftKinds as readonly string[]).includes(value);
}

export function readDraftKind(): DraftKind {
  try {
    const value = storage()?.getItem(draftKindKey);
    return isDraftKind(value) ? value : defaultDraftKind;
  } catch {
    return defaultDraftKind;
  }
}

export function writeDraftKind(kind: DraftKind): void {
  try {
    storage()?.setItem(draftKindKey, kind);
  } catch {
    /* 覚えられない端末では、今の画面の間だけ選んだままにする */
  }
}
