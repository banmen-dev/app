import { TASK_TITLE_MAX_LENGTH, taskTitleProblem } from '../shared/task.ts';
import type { ApiResult } from './api.ts';
import { t } from './vocabulary.svelte.ts';

// タスクの題の検査の文（引き出しの題とボードのカードの題で共通）。使える題なら null
export function taskTitleMessage(raw: string): string | null {
  const problem = taskTitleProblem(raw.trim());
  if (problem === 'required') return t('taskTitleRequired');
  if (problem === 'too_long') return t('taskTitleTooLong', { max: TASK_TITLE_MAX_LENGTH });
  if (problem === 'invalid_character') return t('taskTitleInvalidCharacter');
  return null;
}

// ボードのカードで題の保存（task-update）が断られた理由。stale は画面の値が古いと分かったこと（読み直しを促す）
export function cardTitleFailure(result: Exclude<ApiResult<unknown>, { ok: true }>): {
  message: string;
  stale: boolean;
} {
  if (result.status === 401) return { message: t('taskSaveFailed'), stale: true };
  if (result.status === 404) return { message: t('taskGone', { task: t('task') }), stale: false };
  if (result.status === 409 && result.error?.code === 'workspace_closed') {
    return { message: t('workspaceClosedReadOnly', { workspace: t('workspace') }), stale: true };
  }
  if (result.status === 409) {
    const details = result.error?.details;
    const raced =
      typeof details === 'object' && details !== null && (details as { reason?: unknown }).reason === 'stale';
    // 取り込んだタスクの題は同期で書き直すので、サーバーが断る（カードを読んだ後に取り込まれた）
    return raced
      ? { message: t('taskSaveRaced'), stale: false }
      : { message: t('taskImportedLocked', { task: t('task') }), stale: false };
  }
  if (result.status === 400) return { message: t('taskBadRequest'), stale: false };
  return { message: t('taskSaveFailed'), stale: false };
}
