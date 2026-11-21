// メールアドレスとパスワードでのログイン（POST /api/auth/password/login、Issue #256）。
// 未ログインの人が呼ぶ口なので、操作の定義（ログインした人向け）の外に直に書く例外（docs/development.md の「操作の定義」。
// POST /api/client-errors と同じ扱い）。OAuth の道（login-routes.ts）の外に置き、成功したら同じ completeLogin に合流する。
// 検査の順:
//   1. Origin が公開する URL と一致し、Sec-Fetch-Site があれば same-origin → 違えば 403 forbidden（数えず、本文も読まない）
//   2. Content-Type が JSON、本文が 4KiB まで、形が { email, password, return_to? } → 違えば 400 invalid_input（数えない）
//   3. レート制限（IP の枠と、そろえたメールアドレスの SHA-256 の枠）→ 上限なら 429 rate_limited（ハッシュを回さない）
//   4. 照合。違うパスワード、無いメールアドレス、そろえ方に合わない入力は、どれも同じ 401 invalid_credentials で、
//      どれもハッシュを今の回数で1回回す（無いときはダミーの値で）。応答の形と所要時間でメールアドレスの有無を見分けさせない
//   5. completeLogin。アカウントが無く、入れる組織も招待も無いことは、パスワードが合った後にだけ 403 forbidden の details.reason（denied）で
//      伝える。結ぶ書き込みの失敗は 503 unavailable。成功は 200 { return_to } とセッションの Cookie
// 通常のログインでは、パスワード、ハッシュ、メールアドレスはログにも応答にも出さない。
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { CLAIM_TOKEN_PATTERN } from '../../shared/claim-token.ts';
import { normalizeEmail } from '../../shared/email.ts';
import { normalizePassword } from '../../shared/password.ts';
import { resolvedReturnTo, safeReturnTo } from '../../shared/return-to.ts';
import { sessionCookieName, sessionCookieOptions } from '../../shared/session-cookie.ts';
import { shortTextProblem } from '../../shared/text-rules.ts';
import type { AppEnv } from '../app-env.ts';
import { commonDb, readPasswordNominationEmail } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { readBodyText, requireOrigin } from '../operations/guards.ts';
import { uuidv7 } from '../uuid.ts';
import { completeLogin } from './login.ts';
import { hashPassword, passwordHashNeedsUpgrade, verifyDummyPassword, verifyPassword } from './password-hash.ts';
import { consumeLoginRateLimits, consumePasswordEmailRateLimit, consumePasswordLoginRateLimits } from './rate-limit.ts';
import { sha256Hex } from './tokens.ts';

export const PASSWORD_LOGIN_MAX_BODY_BYTES = 4096;

const PROVIDER = 'password';

// 値の長さは本文の上限で抑える。そろえ方（メールアドレスとパスワード）に合わない値は 400 にせず、照合で 401 にする
const loginBodySchema = z
  .object({
    email: z.string(),
    password: z.string(),
    return_to: z.string().optional(),
  })
  .strict();

const nominationInspectSchema = z.object({ claim_token: z.string() }).strict();
const nominationAcceptSchema = nominationInspectSchema.extend({
  password: z.string(),
  password_confirmation: z.string().optional(),
  display_name: z.string().optional(),
});

type NominationAcceptBody = z.output<typeof nominationAcceptSchema>;
type Nomination = { email: string; tokenHash: string };

// ログの1行。login-routes.ts の log と同じ形。パスワード、ハッシュ、メールアドレスは出さない
function log(c: Context<AppEnv>, entry: { outcome: string; accountId?: string; step?: string }): void {
  console.log(
    JSON.stringify({
      level: 'info',
      requestId: c.get('requestId'),
      route: 'auth',
      step: 'login',
      provider: PROVIDER,
      ...entry,
    }),
  );
}

function logNomination(step: 'nomination_inspect' | 'nomination_accept'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const outcome = c.error instanceof ApiError ? c.error.code : c.res.ok ? 'ok' : 'internal';
    log(c, { step, outcome });
  };
}

// Origin が公開する URL と一致し、Sec-Fetch-Site があれば same-origin だけ（none のアドレス欄やほかのサイトからの送信を断る）
function requireSameOrigin(c: Context<AppEnv>): void {
  requireOrigin(c);
  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined && site !== 'same-origin') throw new ApiError(403, 'forbidden');
}

async function readPasswordBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(400, 'invalid_input');
  let body: unknown;
  try {
    body = JSON.parse(await readBodyText(c, PASSWORD_LOGIN_MAX_BODY_BYTES));
  } catch {
    // 大きすぎる本文（readBodyText の 413）も、壊れた JSON も、同じ 400 にする
    throw new ApiError(400, 'invalid_input');
  }
  const parsed = schema.safeParse(body);
  // 誰でも呼べる口なので、どの項目が合わないか（details）は返さない
  if (!parsed.success) throw new ApiError(400, 'invalid_input');
  return parsed.data;
}

type Credential = { login_subject: string; password_hash: string; password_changed_at: string; display_name: string };

async function findCredential(env: Env, email: string): Promise<Credential | undefined> {
  const db = commonDb(env);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('password_credentials')
        .select(['login_subject', 'password_hash', 'password_changed_at', 'display_name'])
        .where('email', '=', email),
    ),
  );
}

// 照合する。合えば資格情報の行を返す。合わないとき、照合する相手が無いときは undefined。どの道もハッシュを1回回す
async function verifyCredential(
  env: Env,
  email: string | undefined,
  password: string | undefined,
  rawPassword: string,
): Promise<Credential | undefined> {
  const credential = email === undefined ? undefined : await findCredential(env, email);
  if (credential === undefined || password === undefined) {
    await verifyDummyPassword(password ?? rawPassword);
    return undefined;
  }
  return (await verifyPassword(password, credential.password_hash)) ? credential : undefined;
}

// 保存した回数が今の回数より少なければ、今の回数で書き直す。失敗してもログインは止めない（次のログインでまた書き直す）。
// 照合の後に別のログインやパスワードの変更が書き直していれば、上書きしない
async function upgradeHashIfNeeded(c: Context<AppEnv>, credential: Credential, password: string, now: Date) {
  if (!passwordHashNeedsUpgrade(credential.password_hash)) return;
  try {
    const upgraded = await hashPassword(password);
    const db = commonDb(c.env);
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('password_credentials')
          .set({ password_hash: upgraded, updated_at: now.toISOString() })
          .where('login_subject', '=', credential.login_subject)
          .where('password_hash', '=', credential.password_hash),
      ),
    ]);
  } catch (err) {
    // 例外の message に SQL や値が混ざりうるので、名前だけを残す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: c.get('requestId'),
        route: 'auth',
        provider: PROVIDER,
        reason: 'パスワードのハッシュを今の回数で書き直せなかった',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
}

async function readNomination(env: Env, token: string, now: Date): Promise<Nomination> {
  if (!CLAIM_TOKEN_PATTERN.test(token)) throw new ApiError(404, 'not_found');
  const tokenHash = await sha256Hex(token);
  const email = await readPasswordNominationEmail(env, tokenHash, now);
  if (email === undefined) throw new ApiError(404, 'not_found');
  return { email, tokenHash };
}

async function createNominationCredential(
  env: Env,
  nomination: Nomination,
  password: string,
  displayName: string,
): Promise<Credential | undefined> {
  const passwordHash = await hashPassword(password);
  const now = new Date();
  const { email, tokenHash } = nomination;
  // ハッシュを作る間に取り消されたり期限を過ぎたりした指名から、資格情報を作らない。
  if ((await readPasswordNominationEmail(env, tokenHash, now)) !== email) throw new ApiError(404, 'not_found');
  const at = now.toISOString();
  const credential = {
    login_subject: uuidv7(now),
    display_name: displayName,
    password_hash: passwordHash,
    password_changed_at: at,
  };
  const db = commonDb(env);
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .insertInto('password_credentials')
        .values({ ...credential, email, created_at: at, updated_at: at })
        .onConflict((oc) => oc.column('email').doNothing()),
    ),
  ]);
  return result.changes === 1 ? credential : undefined;
}

async function credentialForNomination(
  env: Env,
  nomination: Nomination,
  body: NominationAcceptBody,
): Promise<Credential> {
  const { email } = nomination;
  const password = normalizePassword(body.password);
  let credential = await findCredential(env, email);
  if (credential === undefined) {
    const name = body.display_name?.trim() ?? '';
    if (
      password === undefined ||
      body.password_confirmation === undefined ||
      normalizePassword(body.password_confirmation) !== password ||
      !name.isWellFormed() ||
      shortTextProblem(name, 100) !== null
    ) {
      throw new ApiError(400, 'invalid_input');
    }
    const created = await createNominationCredential(env, nomination, password, name);
    if (created !== undefined) return created;
    // 同じメールアドレスの登録が並行したときは、先に保存された資格情報で照合する。
    credential = await findCredential(env, email);
    if (credential === undefined) throw new ApiError(503, 'unavailable');
  }
  if (password === undefined || !(await verifyPassword(password, credential.password_hash))) {
    throw new ApiError(401, 'invalid_credentials');
  }

  // 照合中に変更されていれば、指名を消費する前に再入力を求める。セッションの発行時にも変更時刻を検査する。
  const current = await findCredential(env, email);
  if (
    current?.login_subject !== credential.login_subject ||
    current.password_changed_at !== credential.password_changed_at
  ) {
    throw new ApiError(401, 'invalid_credentials');
  }
  return credential;
}

export function passwordLoginRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/login', async (c) => {
    try {
      requireSameOrigin(c);
    } catch (err) {
      log(c, { outcome: 'forbidden_origin' });
      throw err;
    }
    const body = await readPasswordBody(c, loginBodySchema);

    const email = normalizeEmail(body.email);
    const emailHash = email === undefined ? undefined : await sha256Hex(email);
    if (!(await consumePasswordLoginRateLimits(c.env, c.req.header('CF-Connecting-IP'), emailHash, new Date()))) {
      log(c, { outcome: 'too_many' });
      throw new ApiError(429, 'rate_limited');
    }

    const password = normalizePassword(body.password);
    const credential = await verifyCredential(c.env, email, password, body.password);
    if (credential === undefined || password === undefined) {
      log(c, { outcome: 'invalid_credentials' });
      throw new ApiError(401, 'invalid_credentials');
    }

    const now = new Date();
    const sessionCookie = sessionCookieName(c.env.PUBLIC_ORIGIN);
    const outcome = await completeLogin(c.env, {
      provider: PROVIDER,
      profile: {
        subject: credential.login_subject,
        loginName: credential.display_name,
        displayName: credential.display_name,
        avatarUrl: null,
      },
      now,
      replacedSessionToken: getCookie(c, sessionCookie),
      passwordProof: { subject: credential.login_subject, changedAt: credential.password_changed_at },
      requestId: c.get('requestId'),
    });
    if (!outcome.ok) {
      log(c, { outcome: outcome.reason });
      if (outcome.reason === 'denied') {
        throw new ApiError(403, 'forbidden', { reason: outcome.reason });
      }
      throw new ApiError(503, 'unavailable');
    }
    await upgradeHashIfNeeded(c, credential, password, now);
    setCookie(c, sessionCookie, outcome.sessionToken, sessionCookieOptions(c.env.PUBLIC_ORIGIN));
    log(c, { outcome: 'ok', accountId: outcome.accountId });
    // 戻る先は、自分のオリジンのパスであることを URL の解決の後でもう一度確かめてから返す。画面はこの値へ移る
    return c.json({
      return_to: resolvedReturnTo(safeReturnTo(body.return_to), new URL(c.env.PUBLIC_ORIGIN).origin),
    });
  });

  // 指名の URL からの登録。秘密は本文でだけ受け、メールアドレスと資格情報の有無は有効な指名を持つ人にだけ返す。
  app.post('/nomination/inspect', logNomination('nomination_inspect'), async (c) => {
    requireSameOrigin(c);
    const body = await readPasswordBody(c, nominationInspectSchema);
    const now = new Date();
    if (!(await consumeLoginRateLimits(c.env, c.req.header('CF-Connecting-IP'), now))) {
      throw new ApiError(429, 'rate_limited');
    }
    const { email } = await readNomination(c.env, body.claim_token, now);
    return c.json({ email, existing_account: (await findCredential(c.env, email)) !== undefined });
  });

  app.post('/nomination/accept', logNomination('nomination_accept'), async (c) => {
    requireSameOrigin(c);
    const body = await readPasswordBody(c, nominationAcceptSchema);
    const now = new Date();
    if (!(await consumePasswordLoginRateLimits(c.env, c.req.header('CF-Connecting-IP'), undefined, now))) {
      throw new ApiError(429, 'rate_limited');
    }
    const nomination = await readNomination(c.env, body.claim_token, now);
    if (!(await consumePasswordEmailRateLimit(c.env, await sha256Hex(nomination.email), now))) {
      throw new ApiError(429, 'rate_limited');
    }
    const credential = await credentialForNomination(c.env, nomination, body);
    const sessionCookie = sessionCookieName(c.env.PUBLIC_ORIGIN);
    const outcome = await completeLogin(c.env, {
      provider: PROVIDER,
      profile: {
        subject: credential.login_subject,
        loginName: credential.display_name,
        displayName: credential.display_name,
        avatarUrl: null,
      },
      now: new Date(),
      replacedSessionToken: getCookie(c, sessionCookie),
      passwordProof: { subject: credential.login_subject, changedAt: credential.password_changed_at },
      claimTokenHash: nomination.tokenHash,
      passwordClaimEmail: nomination.email,
      requestId: c.get('requestId'),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'invite') throw new ApiError(404, 'not_found');
      throw new ApiError(503, 'unavailable');
    }
    if (outcome.claimed?.kind !== 'user') throw new ApiError(503, 'unavailable');

    // 指名の結び付けでは、既存ハッシュの反復回数も書き換えない。
    setCookie(c, sessionCookie, outcome.sessionToken, sessionCookieOptions(c.env.PUBLIC_ORIGIN));
    const destination = safeReturnTo(`/${outcome.claimed.organizationSlug}`);
    return c.json({ return_to: resolvedReturnTo(destination, new URL(c.env.PUBLIC_ORIGIN).origin) });
  });

  return app;
}
