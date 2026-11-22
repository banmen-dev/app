// エピックの読み取り（ダイアログの欄と、画面の中身）、作成、変更、並べ替え、削除の操作の定義。クリアとその取り消しは epic-clear.ts
import type { AnyOperationDefinition } from '../define.ts';
import { epicComplete, epicReopen } from './epic-clear.ts';
import { epicCreate } from './epic-create.ts';
import { epicDelete } from './epic-delete.ts';
import { epicDetail } from './epic-detail.ts';
import { epicGet } from './epic-get.ts';
import { epicMove } from './epic-move.ts';
import { epicUpdate } from './epic-update.ts';

export { epicComplete, epicCreate, epicDelete, epicDetail, epicGet, epicMove, epicReopen, epicUpdate };
export { epicClearConflictReasonOf, epicClearConflictReasons, type EpicClearConflictReason } from './epic-clear.ts';
export { epicDetailSchema, type EpicDetail } from './epic.ts';

export const epicOperations: readonly AnyOperationDefinition[] = [
  epicCreate,
  epicGet,
  epicDetail,
  epicUpdate,
  epicMove,
  epicDelete,
  epicComplete,
  epicReopen,
];
