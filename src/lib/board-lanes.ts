import type { SprintBoardColumn } from '../shared/operations/sprint/index.ts';
import { boardChoicesOf, boardFilterValue, type BoardChoice, type BoardGroup } from './board-filter.ts';

export type BoardLane = BoardChoice & { columns: SprintBoardColumn[] };

export function boardLanesOf(columns: readonly SprintBoardColumn[], group: BoardGroup): BoardLane[] {
  const tasksByColumn = columns.map((column) => Map.groupBy(column.tasks, (task) => boardFilterValue(task, group)));
  return boardChoicesOf(columns)[group].map((choice) => ({
    ...choice,
    columns: columns.map((column, index) => ({
      ...column,
      tasks: tasksByColumn[index]?.get(choice.id) ?? [],
    })),
  }));
}
