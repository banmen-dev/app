import { describe, expect, it } from 'vitest';
import type { ApiResult } from './api.ts';
import {
  connectionCreateFailure,
  connectionScopeFailure,
  connectionSyncFailure,
  connectionSyncOutcome,
  connectionUpdateFailure,
  validateConnectionInput,
} from './connection-form.ts';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const failed = (status: number, code: string | null, details?: unknown): Failed => ({
  ok: false,
  status,
  error: code === null ? null : ({ code, message: '', details } as NonNullable<Failed['error']>),
});

describe('validateConnectionInput', () => {
  it('表示名と認証情報の空を断る', () => {
    expect(validateConnectionInput({ name: ' ', credential: 'x' })).toEqual({
      field: 'name',
      key: 'connectionNameRequired',
    });
    expect(validateConnectionInput({ name: 'a'.repeat(51), credential: 'x' })).toEqual({
      field: 'name',
      key: 'connectionNameTooLong',
    });
    // 見えない文字だけ・向きを変える制御文字は「50字まで」でなく、それぞれの理由にする
    expect(validateConnectionInput({ name: '\u200b', credential: 'x' })).toEqual({
      field: 'name',
      key: 'connectionNameRequired',
    });
    expect(validateConnectionInput({ name: 'a\u202eb', credential: 'x' })).toEqual({
      field: 'name',
      key: 'connectionNameInvalid',
    });
    expect(validateConnectionInput({ name: 'a', credential: ' ' })).toEqual({
      field: 'credential',
      key: 'connectionCredentialRequired',
    });
    expect(validateConnectionInput({ name: 'a'.repeat(50), credential: 'x' })).toBeNull();
  });

  it('省略した認証情報は通し、明示した空文字は断る', () => {
    expect(validateConnectionInput({ name: 'GitHub' })).toBeNull();
    expect(validateConnectionInput({ name: 'GitHub', credential: '' })).toEqual({
      field: 'credential',
      key: 'connectionCredentialRequired',
    });
  });
});

describe('connectionCreateFailure', () => {
  it('形の違う認証情報と受け付けられない認証情報は、認証情報の欄の理由にする', () => {
    expect(
      connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'credential', code: 'credential_shape' }])),
    ).toEqual({ field: 'credential', key: 'connectionCredentialShape' });
    expect(
      connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'credential', code: 'credential_rejected' }])),
    ).toEqual({ field: 'credential', key: 'connectionCredentialRejected' });
  });

  it('上限を超えた認証情報（too_big）は、認証情報の欄に出す', () => {
    expect(connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'credential', code: 'too_big' }]))).toEqual({
      field: 'credential',
      key: 'connectionCredentialShape',
    });
  });

  it('名前の 400 は、上限の超過と空で文言を分け、欄のやり直しはトークンの欄へ戻す', () => {
    expect(connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'name', code: 'too_big' }])).key).toBe(
      'connectionNameTooLong',
    );
    expect(connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'name', code: 'too_small' }])).key).toBe(
      'connectionNameRequired',
    );
    expect(connectionCreateFailure(failed(503, 'unavailable')).refocus).toBe('credential');
  });

  it('読めない 400 と、そのほかの失敗は枠の理由にする', () => {
    expect(connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'x' }]))).toEqual({
      field: 'form',
      key: 'connectionCreateInvalid',
    });
    expect(connectionCreateFailure(failed(409, 'workspace_closed')).key).toBe('connectionWorkspaceClosed');
    expect(connectionCreateFailure(failed(409, 'conflict', { reason: 'connection_limit' })).key).toBe(
      'connectionLimit',
    );
    // 認証情報は欄から消してあるので、やり直しの文言は入れ直しを添える
    expect(connectionCreateFailure(failed(429, 'rate_limited')).key).toBe('connectionCreateRateLimited');
    expect(connectionCreateFailure(failed(503, 'unavailable')).key).toBe('connectionCreateUnreachable');
    expect(connectionCreateFailure(failed(0, null)).key).toBe('connectionCreateUnreachable');
    expect(connectionCreateFailure(failed(500, 'internal')).key).toBe('connectionCreateFailed');
  });
});

describe('connectionUpdateFailure', () => {
  it('取り込み元の拒否は認証情報の欄、鍵の設定不備はフォームの理由にする', () => {
    expect(
      connectionUpdateFailure(
        failed(400, 'invalid_input', [{ path: 'credential', code: 'credential_rejected' }]),
        true,
      ),
    ).toEqual({ field: 'credential', key: 'connectionCredentialRejected' });
    expect(connectionUpdateFailure(failed(400, 'invalid_input', [{ path: 'name', code: 'too_big' }]), false)).toEqual({
      field: 'name',
      key: 'connectionNameTooLong',
    });
    expect(connectionUpdateFailure(failed(503, 'credential_keys_unavailable'), true)).toEqual({
      field: 'form',
      key: 'connectionEditKeysUnavailable',
    });
  });

  it.each([
    [429, 'rate_limited', 'connectionRateLimited', 'connectionCreateRateLimited'],
    [503, 'unavailable', 'connectionEditNetwork', 'connectionCreateUnreachable'],
    [0, null, 'connectionEditNetwork', 'connectionEditNetworkCredential'],
    [500, 'internal', 'connectionUpdateFailed', 'connectionUpdateCredentialFailed'],
  ] as const)(
    '状態 %i では、送信した認証情報があるときに入力し直す欄へ戻す',
    (status, code, nameOnly, withCredential) => {
      expect(connectionUpdateFailure(failed(status, code), false)).toEqual({ field: 'form', key: nameOnly });
      expect(connectionUpdateFailure(failed(status, code), true)).toEqual({
        field: 'form',
        key: withCredential,
        refocus: 'credential',
      });
    },
  );
});

describe('connectionScopeFailure', () => {
  it('失敗を理由に振り分ける', () => {
    expect(connectionScopeFailure(failed(409, 'conflict', { reason: 'credential_rejected' }))).toBe(
      'connectionScopeRejected',
    );
    expect(connectionScopeFailure(failed(409, 'conflict', { reason: 'connection_stopped' }))).toBe(
      'connectionScopeStopped',
    );
    expect(connectionScopeFailure(failed(409, 'workspace_closed'))).toBe('connectionWorkspaceClosed');
    expect(connectionScopeFailure(failed(403, 'forbidden'))).toBe('connectionScopeGone');
    expect(connectionScopeFailure(failed(404, 'not_found'))).toBe('connectionScopeGone');
    expect(connectionScopeFailure(failed(400, 'invalid_input'))).toBe('connectionScopeInvalid');
    expect(connectionScopeFailure(failed(503, 'unavailable'))).toBe('connectionUnreachable');
    expect(connectionScopeFailure(failed(500, 'internal'))).toBe('connectionScopeFailed');
  });
});

describe('connectionSyncOutcome / connectionSyncFailure', () => {
  it('結果を文言に振り分ける', () => {
    const base = { imported: 0, more: false };
    expect(connectionSyncOutcome({ ...base, result: 'success', imported: 3 }).key).toBe('connectionSyncDone');
    expect(connectionSyncOutcome({ ...base, result: 'success' }).key).toBe('connectionSyncNone');
    expect(connectionSyncOutcome({ result: 'success', imported: 3, more: true }).key).toBe('connectionSyncMore');
    expect(connectionSyncOutcome({ ...base, result: 'no_scope' }).key).toBe('connectionSyncNoScope');
    expect(connectionSyncOutcome({ ...base, result: 'auth_failed' })).toEqual({
      key: 'connectionSyncAuthFailed',
      icon: 'alert',
    });
    expect(connectionSyncOutcome({ ...base, result: 'error' }).key).toBe('connectionSyncError');
  });

  it('断られた理由を振り分ける', () => {
    expect(connectionSyncFailure(failed(429, 'rate_limited'))).toBe('connectionSyncRateLimited');
    expect(connectionSyncFailure(failed(409, 'conflict', { reason: 'connection_stopped' }))).toBe(
      'connectionSyncStopped',
    );
    expect(connectionSyncFailure(failed(409, 'workspace_closed'))).toBe('connectionWorkspaceClosed');
    expect(connectionSyncFailure(failed(403, 'forbidden'))).toBe('connectionSyncGone');
    expect(connectionSyncFailure(failed(503, 'unavailable'))).toBe('connectionUnreachable');
    expect(connectionSyncFailure(failed(500, 'internal'))).toBe('connectionSyncFailed');
  });
});

describe('接続の暗号鍵の設定不備', () => {
  it('登録は再試行や認証情報の入れ直しではなく設定の確認を案内する', () => {
    expect(connectionCreateFailure(failed(503, 'credential_keys_unavailable'))).toEqual({
      field: 'form',
      key: 'connectionCredentialKeysUnavailable',
    });
  });
  it('範囲も通信の失敗と区別する', () => {
    expect(connectionScopeFailure(failed(503, 'credential_keys_unavailable'))).toBe(
      'connectionCredentialKeysUnavailable',
    );
  });
});
