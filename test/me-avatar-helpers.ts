// プロフィール画像（Issue #1265）のテストが使う道具。上げる・外す・配る操作を呼び、user_avatars の行と R2 の中身を読み、
// 処理を通さずに行と R2 のファイルを置く。user_avatars は組織の中の表で、行は organization_id で絞って読む
import { env } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import {
  meAvatarDelete,
  meAvatarUpload,
  organizationInfo,
  userDisable,
  userEnable,
  userList,
} from '../src/shared/operations/organization/index.ts';
import { memberList } from '../src/shared/operations/workspace/index.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { runStatementsForTest, tableRowsForTest } from '../src/server/db/testing.ts';
import { pngImage } from './avatar-images.ts';
import { AT, uuidv7 } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createPerson, testEnv, type Person, type Target } from './operations/world.ts';

export const app = createApp();

export const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type AvatarRow = {
  user_id: string;
  id: string;
  organization_id: string;
  object_key: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
};

// 組織の user_avatars の行（組織で絞る）
export async function avatarRows(organizationId: string): Promise<AvatarRow[]> {
  const rows = (await tableRowsForTest(env, 'user_avatars')) as AvatarRow[];
  return rows.filter((row) => row.organization_id === organizationId);
}

export async function avatarRowOf(target: Target, person: Person): Promise<AvatarRow | undefined> {
  return (await avatarRows(target.organization.id)).find((row) => row.user_id === person.userId);
}

// 組織のプロフィール画像の接頭辞（<組織>/avatars/）の下の R2 のキー。人を渡せば、その人の接頭辞の下だけ
export async function avatarObjectKeys(organizationId: string, userId?: string | null): Promise<string[]> {
  const prefix = `${organizationId}/avatars/${userId == null ? '' : `${userId}/`}`;
  const listed = await env.ATTACHMENTS.list({ prefix });
  return listed.objects.map((object) => object.key).sort();
}

export async function objectBytes(key: string): Promise<Uint8Array | undefined> {
  const object = await env.ATTACHMENTS.get(key);
  if (object === null) return undefined;
  return new Uint8Array(await object.arrayBuffer());
}

export const avatarUrlOf = (target: Target, id: string) => `/api/${target.slug}/user-avatar/${id}`;

// 配る URL から画像の ID を取り出す。形が違えば落とす
export function avatarIdOf(target: Target, url: string | null | undefined): string {
  const prefix = `/api/${target.slug}/user-avatar/`;
  expect(url, '配る URL の形').toMatch(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^/]+$`));
  const id = url!.slice(prefix.length);
  expect(id, '画像の ID は UUIDv7').toMatch(UUIDV7);
  return id;
}

export type CallOptions = {
  env?: Env;
  headers?: Record<string, string>;
  contentLength?: string | null;
  input?: unknown;
};

export function uploadAvatar(
  target: Target,
  person: Person,
  file: Uint8Array | ReadableStream<Uint8Array> = pngImage(64, 64),
  options: CallOptions = {},
): Promise<Response> {
  return post(app, meAvatarUpload, {
    slug: target.slug,
    token: person.token,
    body: options.input ?? {},
    file,
    ...(options.contentLength === undefined ? {} : { contentLength: options.contentLength }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

// 上げて 200 を確かめ、配る URL を返す
export async function uploadedUrl(
  target: Target,
  person: Person,
  file: Uint8Array = pngImage(64, 64),
  options: CallOptions = {},
): Promise<string> {
  const res = await uploadAvatar(target, person, file, options);
  expect(res.status, '上げる').toBe(200);
  const body = (await res.json()) as { avatar_url: string };
  expect(meAvatarUpload.output.safeParse(body).success).toBe(true);
  return body.avatar_url;
}

export function deleteAvatar(target: Target, person: Person, options: CallOptions = {}): Promise<Response> {
  return post(app, meAvatarDelete, {
    slug: target.slug,
    token: person.token,
    body: options.input ?? {},
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

export function disableUser(target: Target, userId: string, options: { env?: Env } = {}): Promise<Response> {
  return post(app, userDisable, {
    slug: target.slug,
    token: target.admin.token,
    body: { user_id: userId },
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

export function enableUser(target: Target, userId: string): Promise<Response> {
  return post(app, userEnable, { slug: target.slug, token: target.admin.token, body: { user_id: userId } });
}

// 画面の img と同じく、Origin の無い GET で開く。person が null ならログインしていない
export async function getAvatar(
  url: string,
  person: Person | null,
  options: { env?: Env; headers?: Record<string, string> } = {},
): Promise<Response> {
  const bindings = options.env ?? testEnv;
  const headers = new Headers(options.headers);
  if (person !== null) headers.set('Cookie', `${sessionCookieName(bindings.PUBLIC_ORIGIN)}=${person.token}`);
  return app.request(url, { method: 'GET', headers }, bindings);
}

export async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(await errorCodeOf(res)).toBe(code);
}

// 404 の応答。キャッシュに残さない（前の URL の 404 を確かめられるように）
export async function expectNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await errorCodeOf(res)).toBe('not_found');
}

// workspace に一般のメンバーとして所属する新しい人。回数の上限（人ごと）に当たらないよう、テストごとに作る
export function newMember(target: Target): Promise<Person> {
  return createPerson({
    organization: target.organization,
    membership: { workspaceId: target.workspace.id, role: 'member' },
  });
}

// ログインの手段のアイコン（account_logins は共通の表なので、共通の表の入口から書く）
export async function setLoginAvatar(person: Person, avatarUrl: string | null): Promise<void> {
  const db = commonDb(env);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('account_logins')
        .set({ avatar_url: avatarUrl })
        .where('login_provider', '=', person.login.provider)
        .where('login_subject', '=', person.login.subject),
    ),
  );
}

export async function memberListAvatars(target: Target, person: Person): Promise<Map<string, string | null>> {
  const res = await post(app, memberList, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { members: { id: string; avatar_url: string | null }[] };
  return new Map(body.members.map((member) => [member.id, member.avatar_url]));
}

export async function userListAvatars(target: Target): Promise<Map<string, string | null>> {
  const res = await post(app, userList, { slug: target.slug, token: target.admin.token, body: {} });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { users: { id: string; avatar_url: string | null }[] };
  return new Map(body.users.map((user) => [user.id, user.avatar_url]));
}

// 組織の枠の操作（organization）の me.avatar_url。キーが無ければ undefined
export async function meAvatarOf(target: Target, person: Person): Promise<string | null | undefined> {
  const res = await post(app, organizationInfo, { slug: target.slug, token: person.token, body: {} });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { me: { avatar_url?: string | null } };
  return body.me.avatar_url;
}

// SQL に埋める値。UUID とキーの形と、決まった種類だけを通す
function literal(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`整数でない: ${value}`);
    return String(value);
  }
  if (!/^[0-9A-Za-z/._:+-]*$/.test(value)) throw new Error(`SQL に埋められない値: ${value}`);
  return `'${value}'`;
}

// 処理を通さずに、user_avatars の行と R2 のファイルを置く。R2 のメタデータの種類は、行と違う値（text/html）にする
// （配る種類は行の保存値で決めることを見るため）
export async function storeAvatar(
  organization: Target['organization'],
  userId: string,
  options: {
    id?: string;
    contentType?: 'image/png' | 'image/jpeg' | 'image/webp';
    bytes?: Uint8Array;
    r2?: boolean;
  } = {},
): Promise<AvatarRow & { bytes: Uint8Array }> {
  const id = options.id ?? uuidv7();
  const bytes = options.bytes ?? pngImage(32, 32);
  const row: AvatarRow = {
    user_id: userId,
    id,
    organization_id: organization.id,
    object_key: `${organization.id}/avatars/${userId}/${id}`,
    content_type: options.contentType ?? 'image/png',
    size_bytes: bytes.byteLength,
    created_at: AT,
  };
  await runStatementsForTest(env, [
    `INSERT INTO user_avatars (user_id, id, organization_id, object_key, content_type, size_bytes, created_at) VALUES (${[
      row.user_id,
      row.id,
      row.organization_id,
      row.object_key,
      row.content_type,
      row.size_bytes,
      row.created_at,
    ]
      .map(literal)
      .join(', ')})`,
  ]);
  if (options.r2 !== false) {
    await env.ATTACHMENTS.put(row.object_key, bytes, { httpMetadata: { contentType: 'text/html' } });
  }
  return { ...row, bytes };
}

// console の出力を集める（ログに本文やキーを出さないことを見る）。テストの afterEach で vi.restoreAllMocks() を呼んで外す
export function captureLogs(): string[] {
  const lines: string[] = [];
  for (const method of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  return lines;
}
