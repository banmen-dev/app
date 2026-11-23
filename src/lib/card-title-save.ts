import type { SprintBoardTask } from '../shared/operations/sprint/index.ts';
import { taskUpdate, type TaskDetail } from '../shared/operations/task/index.ts';
import { callOperation, type ApiResult } from './api.ts';
import { cardTitleFailure } from './task-title.ts';
import { showToast } from './toast.svelte.ts';
import { t } from './vocabulary.svelte.ts';

// ボードのカードの題の保存（SprintCard の鉛筆）。送る前の配線（target）を受け取って最後まで使う
// （送っている間にワークスペースが終了すると、カードの attrs は undefined に替わるため）。
// setSending は、送っている間に出す題を渡し、終わったら必ず null に戻す（応答の後の処理が失敗しても、カードの題を固めない）。
// 通ったらカードの題を直してトーストで知らせ、断られたら理由をトーストで出して盤を読み直す
export type CardTitleTarget = {
  workspaceId: string;
  slug: string;
  onpatch: (id: string, patch: Partial<Pick<SprintBoardTask, 'title'>>) => void;
  onStale: () => void;
  onSaved: () => Promise<void> | void;
};

type Send = (
  input: { workspace_id: string; task_id: string; title: string; expected: { title: string } },
  slug: string,
) => Promise<ApiResult<{ task: TaskDetail }>>;

const sendUpdate: Send = (input, slug) => callOperation(taskUpdate, input, { slug });

export async function saveCardTitle({
  target,
  taskId,
  title,
  base,
  imported,
  setSending,
  send = sendUpdate,
}: {
  target: CardTitleTarget;
  taskId: string;
  title: string;
  // 書き始めた時点の題（expected）
  base: string;
  imported: boolean;
  setSending: (title: string | null) => void;
  send?: Send;
}): Promise<void> {
  setSending(title);
  let failure: ReturnType<typeof cardTitleFailure>;
  try {
    const result = await send(
      { workspace_id: target.workspaceId, task_id: taskId, title, expected: { title: base } },
      target.slug,
    );
    if (result.ok) {
      try {
        target.onpatch(taskId, { title: result.data.task.title });
      } catch {
        /* 画面の直しに失敗しても、保存は通っている。読み直しで映る */
      }
      showToast(t('taskSaved'), 'check');
      return;
    }
    failure = cardTitleFailure(result, imported);
  } finally {
    setSending(null);
  }
  showToast(failure.message, 'alert');
  if (failure.stale) target.onStale();
  try {
    await target.onSaved();
  } catch {
    /* 読み直しの失敗で、知らせた理由を隠さない */
  }
}
