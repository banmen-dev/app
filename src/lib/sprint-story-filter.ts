import type { SprintBoardColumn } from '../shared/operations/sprint/index.ts';

// 列は残し、親のないカードは絞り込みに含めない。全体の集計には元の列を使う。
export function storyColumns(columns: readonly SprintBoardColumn[], storyId: string | null): SprintBoardColumn[] {
  return columns.map((column) => ({
    ...column,
    tasks: storyId === null ? column.tasks : column.tasks.filter((task) => task.story?.id === storyId),
  }));
}

export function storyHref(url: Pick<URL, 'href'>, storyId: string | null): string {
  const next = new URL(url.href);
  if (storyId === null) next.searchParams.delete('story');
  else next.searchParams.set('story', storyId);
  return `${next.pathname}${next.search}${next.hash}`;
}

// 可視カードだけから決めた直前のカードを、全体の並びにも適用する。
// 非表示カードを落とさず、APIに送る after_task_id と同じ位置へ置く。
export function applyStoryMove(
  columns: readonly SprintBoardColumn[],
  taskId: string,
  columnId: string,
  afterTaskId: string | null | undefined,
): SprintBoardColumn[] {
  const task = columns.flatMap((column) => column.tasks).find((item) => item.id === taskId);
  if (task === undefined) return [...columns];
  return columns.map((column) => {
    const tasks = column.tasks.filter((item) => item.id !== taskId);
    if (column.id !== columnId) return { ...column, tasks };
    const index =
      afterTaskId === undefined
        ? tasks.length
        : afterTaskId === null
          ? 0
          : tasks.findIndex((item) => item.id === afterTaskId) + 1;
    tasks.splice(index, 0, task);
    return { ...column, tasks };
  });
}
