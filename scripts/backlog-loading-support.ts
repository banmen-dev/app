import { backlogTree } from '../src/shared/operations/task/index.ts';
import { categoryRepositoryList } from '../src/shared/operations/definition/index.ts';

export const backlogOutputs = {
  'backlog-tree': backlogTree.output,
  'category-repository-list': categoryRepositoryList.output,
};

// 片方の失敗後も、並行したもう片方の待ちを回収してからブラウザを閉じる。
export async function collectBacklogReadiness<T, U>(primary: Promise<T>, choices: Promise<U>): Promise<[T, U]> {
  const [main, secondary] = await Promise.allSettled([primary, choices]);
  const errors = [main, secondary].flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, '木の操作または選択肢の準備を確認できません');
  return [(main as PromiseFulfilledResult<T>).value, (secondary as PromiseFulfilledResult<U>).value];
}

// HTTP成功だけでは正常試行にしない。従も全件検証してから次へ進む。
export class BacklogBrowserChecks {
  private errors: string[] = [];
  private pending: Promise<void>[] = [];

  requestFailed(path: string, reason: string) {
    this.errors.push(`${path}: ${reason}`);
  }
  pageError(message: string) {
    this.errors.push(message);
  }
  response(path: string, status: number, body: () => Promise<unknown>) {
    if (status >= 400) this.errors.push(`HTTP ${status} ${path}`);
    const name = path.split('/').at(-1);
    if (!name || !Object.hasOwn(backlogOutputs, name)) return;
    const schema = backlogOutputs[name as keyof typeof backlogOutputs];
    this.pending.push(
      body()
        .then((value) => {
          if (status !== 200 || !schema.safeParse(value).success)
            this.errors.push(`${path}: 応答の形またはstatusが不正`);
        })
        .catch(() => {
          this.errors.push(`${path}: 応答のJSONを読めません`);
        }),
    );
  }
  async assertSuccess() {
    await Promise.all(this.pending);
    this.pending = [];
    if (this.errors.length) throw new Error(this.errors.join('\n'));
  }
}
