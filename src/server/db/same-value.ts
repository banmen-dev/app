import { sql } from 'kysely';

// 列の値が、読んだ値と同じという条件。null どうしも同じに数える（SQLite の IS は null も比べられる）。
// 読んでから書くまでに別の要求が列を変えたら書かない、という条件に使う
export function sameValue(column: string, value: string | number | null) {
  return sql<boolean>`${sql.ref(column)} is ${value}`;
}
