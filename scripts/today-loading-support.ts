import { cpSync, existsSync, rmSync } from 'node:fs';
import { today, firstSteps } from '../src/shared/operations/organization/index.ts';

// 保存・停止のいずれが失敗しても、残りの後片付けまで試みる。
export async function finishTodayBenchmark(save: () => unknown, cleanup: (() => unknown)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const action of [save, ...cleanup]) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, '計測結果の保存または後片付けに失敗しました');
}

export function preserveTodayBuild(output: string, backup: string): () => void {
  const existed = existsSync(output);
  if (existed) cpSync(output, backup, { recursive: true });
  let restored = false;
  return () => {
    if (restored) return;
    rmSync(output, { recursive: true, force: true });
    if (existed) cpSync(backup, output, { recursive: true });
    restored = true;
  };
}

export class TodayBrowserChecks {
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
    if (name !== 'today' && name !== 'first-steps') return;
    const schema = name === 'today' ? today.output : firstSteps.output;
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
