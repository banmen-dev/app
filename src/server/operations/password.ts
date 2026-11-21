import { passwordChange } from '../../shared/operations/session/password.ts';
import { normalizePassword } from '../../shared/password.ts';
import { hashPassword, verifyPassword } from '../auth/password-hash.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

export const passwordChangeOperation = implement(passwordChange, async ({ db, accountId, session, input }) => {
  const credential = await db.first(
    db.statement((q) =>
      q
        .selectFrom('account_logins')
        .innerJoin('password_credentials', 'password_credentials.login_subject', 'account_logins.login_subject')
        .select(['password_credentials.login_subject', 'password_hash', 'password_changed_at'])
        .where('account_id', '=', accountId)
        .where('login_provider', '=', 'password')
        .limit(1),
    ),
  );
  if (credential === undefined) throw new ApiError(403, 'forbidden');

  const current = normalizePassword(input.current_password);
  const next = normalizePassword(input.new_password);
  if (next === undefined) throw new ApiError(400, 'invalid_input');
  if (current === undefined || !(await verifyPassword(current, credential.password_hash))) {
    throw new ApiError(400, 'invalid_credentials');
  }

  const hash = await hashPassword(next);
  const now = new Date();
  const nowIso = now.toISOString();
  // セッション発行もこの値で競合を検査する。同じミリ秒や時計が戻った場合にも、前の値を使い直さない。
  const previousChange = Date.parse(credential.password_changed_at);
  const changedAt = previousChange >= now.getTime() ? new Date(previousChange + 1).toISOString() : nowIso;
  const [updated] = await db.batch([
    db.statement((q) =>
      q
        .updateTable('password_credentials')
        .set({ password_hash: hash, password_changed_at: changedAt, updated_at: nowIso })
        .where('login_subject', '=', credential.login_subject)
        .where('password_hash', '=', credential.password_hash)
        .where('password_changed_at', '=', credential.password_changed_at)
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('account_logins')
              .select('login_subject')
              .where('login_subject', '=', credential.login_subject)
              .where('login_provider', '=', 'password')
              .where('account_id', '=', accountId),
          ),
        )
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('sessions')
              .select('token_hash')
              .where('token_hash', '=', session.tokenHash)
              .where('account_id', '=', accountId)
              .where('expires_at', '>', nowIso),
          ),
        ),
    ),
    // この batch の UPDATE が通ったときだけ、新しく塩を作ったハッシュが入る。
    db.statement((q) =>
      q
        .deleteFrom('sessions')
        .where('account_id', '=', accountId)
        .where('token_hash', '!=', session.tokenHash)
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('password_credentials')
              .select('login_subject')
              .where('login_subject', '=', credential.login_subject)
              .where('password_hash', '=', hash),
          ),
        ),
    ),
  ]);

  if (updated.changes !== 1) throw new ApiError(409, 'conflict');
  return {};
});
