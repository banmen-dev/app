import { describe, expect, test } from 'vitest';
import type { ApiResult } from './api.ts';
import { workspaceReopenRefusal } from './workspace-reopen-refusal.ts';

type Failure = Extract<ApiResult<never>, { ok: false }>;
type ReopenLimit = 'workspace_limit_reached' | 'member_limit_reached';

function refusal(code: ReopenLimit, details?: unknown): Failure {
  return { ok: false, status: 409, error: { code, message: 'conflict', details } };
}

describe('workspaceReopenRefusal', () => {
  test('個数の上限と設定の画面から枠を空ける方法を案内する', () => {
    const result = refusal('workspace_limit_reached', { used: 3, limit: 3 });
    const fromSettings = workspaceReopenRefusal(result, '青葉チーム', 'settings');
    expect(fromSettings).toContain('今3個');
    expect(fromSettings).toContain('「組織の管理」で');
    expect(fromSettings).not.toContain('この一覧');
    expect(workspaceReopenRefusal(result, '青葉チーム', 'list')).toContain('この一覧で');
  });

  test('個数の情報が読めなくても設定の画面から枠を空ける方法を案内する', () => {
    expect(workspaceReopenRefusal(refusal('workspace_limit_reached'), '青葉チーム', 'settings')).toContain(
      '個数が上限に達しています。アカウントのメニューの「組織の管理」で',
    );
  });

  test('人数の上限を説明し、情報が読めなければ人数の値を省く', () => {
    expect(
      workspaceReopenRefusal(
        refusal('member_limit_reached', { used: 5, limit: 6, adding: 2 }),
        '青葉チーム',
        'settings',
      ),
    ).toContain('上限の 6');
    expect(workspaceReopenRefusal(refusal('member_limit_reached'), '青葉チーム', 'list')).toContain(
      '人数が上限を超えます',
    );
  });

  test('上限以外のエラーには文言を返さない', () => {
    expect(workspaceReopenRefusal({ ok: false, status: 503, error: null }, '青葉チーム', 'settings')).toBeNull();
  });
});
