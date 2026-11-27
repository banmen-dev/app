// 接続の一覧、登録、範囲の候補と保存の操作の定義
import type { AnyOperationDefinition } from '../define.ts';
import { connectionCreate } from './connection-create.ts';
import { connectionDelete } from './connection-delete.ts';
import { connectionMappingSave } from './connection-mapping-save.ts';
import { connectionList } from './connection-list.ts';
import { connectionScopeCandidates } from './connection-scope-candidates.ts';
import { connectionScopesSave } from './connection-scopes-save.ts';
import { connectionStop } from './connection-stop.ts';
import { connectionSync } from './connection-sync.ts';

import { connectionUpdate } from './connection-update.ts';

export {
  connectionCreate,
  connectionDelete,
  connectionList,
  connectionMappingSave,
  connectionScopeCandidates,
  connectionScopesSave,
  connectionStop,
  connectionSync,
  connectionUpdate,
};
export * from './connection-sync.ts';
export * from './connection.ts';

export const connectionOperations: readonly AnyOperationDefinition[] = [
  connectionList,
  connectionCreate,
  connectionUpdate,
  connectionScopeCandidates,
  connectionScopesSave,
  connectionMappingSave,
  connectionSync,
  connectionStop,
  connectionDelete,
];
