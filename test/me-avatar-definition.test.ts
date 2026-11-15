// プロフィール画像（Issue #1265）の操作の定義と、定義の cacheControl、本文の上限（maxBodyBytes）の仕組み。
// セッションが置いた前提: 定義に 200 のバイナリの応答の Cache-Control の指定を足す（response: 'binary' の操作だけ、private で始まる値だけ）。
// src/server/app.ts のミドルウェアは、指定があり状態が 200 のときだけそれを付け、ほかは今どおり private, no-store。
// readBinaryBody は定義の maxBodyBytes を見て、超えた本文を 413 の invalid_input で断る（無ければ添付の 50MB）
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  assertOperationDefinition,
  defineOperation,
  type AnyOperationDefinition,
} from '../src/shared/operations/define.ts';
import { operations } from '../src/shared/operations/index.ts';
import {
  meAvatarDelete,
  meAvatarUpload,
  organizationInfo,
  userAvatar,
  userDisable,
  userEnable,
} from '../src/shared/operations/organization/index.ts';
import { AVATAR_MAX_BYTES } from '../src/shared/operations/organization/me-avatar.ts';
import { attachmentDownload } from '../src/shared/operations/attachment/index.ts';
import { createApp } from '../src/server/app.ts';
import { ApiError } from '../src/server/errors.ts';
import { implement, type ImplementedOperation } from '../src/server/operations/implement.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { tokenAllows } from '../src/server/operations/token-scope.ts';
import { chunkedStream } from './attachment-helpers.ts';
import { pngImage } from './avatar-images.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

// 定義の型を広げて、付いていない項目も読めるようにする
const widened = (definition: AnyOperationDefinition): AnyOperationDefinition => definition;

describe('3つの操作の定義', () => {
  test('me-avatar-upload: 組織の中の write、本文はバイナリ、本文の上限 512KiB、10 分に 20 回、入力は空、出力は avatar_url', () => {
    expect(meAvatarUpload).toMatchObject({
      name: 'me-avatar-upload',
      permission: 'organization',
      mode: 'write',
      body: 'binary',
      maxBodyBytes: AVATAR_MAX_BYTES,
      rateLimit: { max: 20, windowSeconds: 600 },
    });
    expect(widened(meAvatarUpload).storage).toBeUndefined();
    expect(Object.keys(meAvatarUpload.input.shape)).toEqual([]);
    expect(meAvatarUpload.output.safeParse({ avatar_url: '/api/aoba/user-avatar/x' }).success).toBe(true);
    expect(meAvatarUpload.output.safeParse({ avatar_url: null }).success).toBe(false);
  });

  test('me-avatar-delete: 組織の中の write、R2 を消す道具を受け取る、入力は空、出力の avatar_url は null を許す', () => {
    expect(meAvatarDelete).toMatchObject({
      name: 'me-avatar-delete',
      permission: 'organization',
      mode: 'write',
      storage: 'attachments',
    });
    expect(widened(meAvatarDelete).body).toBeUndefined();
    expect(Object.keys(meAvatarDelete.input.shape)).toEqual([]);
    expect(meAvatarDelete.output.safeParse({ avatar_url: null }).success).toBe(true);
    expect(meAvatarDelete.output.safeParse({ avatar_url: 'https://avatars.githubusercontent.com/u/1' }).success).toBe(
      true,
    );
  });

  test('user-avatar: 組織の直下の read、ファイルを返す GET、200 は private, max-age=3600', () => {
    expect(userAvatar).toMatchObject({
      name: 'user-avatar',
      permission: 'organization',
      mode: 'read',
      response: 'binary',
      cacheControl: 'private, max-age=3600',
    });
    expect(Object.keys(userAvatar.input.shape)).toEqual(['id']);
    const response = new Response('x');
    expect(userAvatar.output.parse(response)).toBe(response);
  });

  test('本番の定義の一覧と、登録する操作の一覧に入っている', () => {
    const implemented = implementedOperations.map((operation) => operation.definition);
    for (const definition of [meAvatarUpload, meAvatarDelete, userAvatar]) {
      expect(operations).toContain(definition);
      expect(implemented).toContain(definition);
    }
  });

  test('上げる操作と配る操作は API トークンで呼べない（バイナリ）。外す操作は書き込みのトークンで呼べる', () => {
    for (const definition of [meAvatarUpload, userAvatar]) {
      expect(tokenAllows(definition, 'write')).toBe(false);
      expect(tokenAllows(definition, 'read')).toBe(false);
    }
    expect(tokenAllows(meAvatarDelete, 'write')).toBe(true);
    expect(tokenAllows(meAvatarDelete, 'read')).toBe(false);
  });

  test('user-disable は R2 を消す道具を受け取り、user-enable は受け取らない', () => {
    expect(widened(userDisable).storage).toBe('attachments');
    expect(widened(userEnable).storage).toBeUndefined();
  });

  test('組織の枠（organization）の me に、null を許す avatar_url がある', () => {
    const me = (organizationInfo.output.shape.me as unknown as z.ZodObject).shape as Record<string, z.ZodType>;
    expect(Object.keys(me)).toContain('avatar_url');
    expect(me.avatar_url!.safeParse(null).success).toBe(true);
    expect(me.avatar_url!.safeParse('/api/aoba/user-avatar/x').success).toBe(true);
    expect(me.avatar_url!.safeParse(undefined).success).toBe(false);
  });
});

// 型の検査を抜けた定義（型を消した一覧、手で組んだオブジェクト）
const forgedDownload = (overrides: Record<string, unknown>) =>
  ({
    name: 'lantern-picture',
    description: '灯りの絵を返す仮の操作',
    permission: 'organization',
    mode: 'read',
    response: 'binary',
    input: z.object({ id: z.string() }),
    output: z.instanceof(Response),
    ...overrides,
  }) as unknown as AnyOperationDefinition;

describe('定義の cacheControl の検査', () => {
  test.each(['private, max-age=3600', 'private, max-age=60', 'private'])(
    'ファイルを返す操作に %j を付けられる',
    (cacheControl) => {
      expect(() => assertOperationDefinition(forgedDownload({ cacheControl }))).not.toThrow();
    },
  );

  test('付けない定義は今までどおり通る（添付のダウンロード）', () => {
    expect(() => assertOperationDefinition(forgedDownload({}))).not.toThrow();
    expect(() => assertOperationDefinition(attachmentDownload)).not.toThrow();
    expect(() => assertOperationDefinition(userAvatar)).not.toThrow();
  });

  test.each([
    'public, max-age=3600',
    'max-age=3600',
    'no-store',
    's-maxage=3600, private',
    'immutable',
    '',
    ' private, max-age=3600',
    123,
    true,
    null,
  ])('private で始まらない %j は断る', (cacheControl) => {
    expect(() => assertOperationDefinition(forgedDownload({ cacheControl }))).toThrow(/cacheControl/);
  });

  test.each([
    ['JSON を返す read', { response: undefined, input: z.object({}), output: z.object({}) }],
    ['書き込み', { response: undefined, mode: 'write', input: z.object({}), output: z.object({}) }],
    [
      'バイナリの本文の書き込み',
      { response: undefined, mode: 'write', body: 'binary', input: z.object({}), output: z.object({}) },
    ],
  ])('ファイルを返さない操作（%s）には付けられない', (_label, overrides) => {
    expect(() =>
      assertOperationDefinition(forgedDownload({ ...overrides, cacheControl: 'private, max-age=60' })),
    ).toThrow(/cacheControl/);
  });

  test('defineOperation も、登録（createApp）も、誤った cacheControl を断る', () => {
    const broken = forgedDownload({ cacheControl: 'public, max-age=60' });
    expect(() => defineOperation(broken)).toThrow(/cacheControl/);
    const operation = { definition: broken, handler: async () => new Response() } as unknown as ImplementedOperation;
    expect(() => createApp([operation])).toThrow(/cacheControl/);
  });
});

describe('ミドルウェアは、定義に cacheControl があり状態が 200 のときだけ付ける', () => {
  const cached = defineOperation({
    name: 'lantern-picture',
    description: '灯りの絵を返す仮の操作',
    permission: 'organization',
    mode: 'read',
    response: 'binary',
    cacheControl: 'private, max-age=60',
    input: z.object({ id: z.string() }),
    output: z.instanceof(Response),
  });
  const plain = defineOperation({
    name: 'lantern-sketch',
    description: '灯りの下絵を返す仮の操作',
    permission: 'organization',
    mode: 'read',
    response: 'binary',
    input: z.object({ id: z.string() }),
    output: z.instanceof(Response),
  });
  // id で応答を選ぶ。ok は 200、partial は 206、missing は 404 の例外、handler-cache はハンドラーが付けた Cache-Control
  const respond = async ({ input }: { input: { id: string } }) => {
    if (input.id === 'missing') throw new ApiError(404, 'not_found');
    if (input.id === 'partial') return new Response('ab', { status: 206, headers: { 'Content-Range': 'bytes 0-1/4' } });
    if (input.id === 'handler-cache') {
      return new Response('abcd', { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=99' } });
    }
    return new Response('abcd', { headers: { 'Content-Type': 'image/png' } });
  };
  const app = createApp([implement(cached, respond), implement(plain, respond)]);

  async function get(definition: AnyOperationDefinition, id: string) {
    const target = await createTarget();
    return post(app, definition, { slug: target.slug, token: target.member.token, body: { id }, origin: null });
  }

  test('200 は定義の値で、sandbox の CSP と nosniff も付く', async () => {
    const res = await get(cached, 'ok');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
  });

  test('ハンドラーが付けた Cache-Control は使わず、定義の値にする', async () => {
    const res = await get(cached, 'handler-cache');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
  });

  test('206 は private, no-store', async () => {
    const res = await get(cached, 'partial');
    expect(res.status).toBe(206);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  test('404 は private, no-store', async () => {
    const res = await get(cached, 'missing');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('ログインしていない 401 も private, no-store', async () => {
    const target = await createTarget();
    const res = await post(app, cached, { slug: target.slug, body: { id: 'ok' }, origin: null });
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  test('cacheControl の無いバイナリの応答は、200 でも今どおり private, no-store', async () => {
    const res = await get(plain, 'ok');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const handler = await get(plain, 'handler-cache');
    expect(handler.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('readBinaryBody は定義の maxBodyBytes を見る', () => {
  const small = defineOperation({
    name: 'lantern-upload',
    description: '灯りの絵を上げる仮の操作',
    permission: 'organization',
    mode: 'write',
    body: 'binary',
    maxBodyBytes: 100,
    input: z.object({}),
    output: z.object({ size: z.number() }),
  });
  const unbounded = defineOperation({
    name: 'lantern-upload-large',
    description: '灯りの大きな絵を上げる仮の操作',
    permission: 'organization',
    mode: 'write',
    body: 'binary',
    input: z.object({}),
    output: z.object({ size: z.number() }),
  });
  const handler = async ({ binary }: { binary: { contentLength: number; body: ReadableStream<Uint8Array> } }) => {
    await binary.body.cancel();
    return { size: binary.contentLength };
  };
  const app = createApp([implement(small, handler), implement(unbounded, handler)]);

  async function send(definition: AnyOperationDefinition, bytes: number, contentLength?: string) {
    const target = await createTarget();
    return post(app, definition, {
      slug: target.slug,
      token: target.member.token,
      body: {},
      // 申告を本文と変えるときは、長さを持たないストリームで送る
      file: contentLength === undefined ? new Uint8Array(bytes) : chunkedStream([new Uint8Array(bytes)]),
      ...(contentLength === undefined ? {} : { contentLength }),
    });
  }

  test('上限ちょうどは通る', async () => {
    const res = await send(small, 100);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 100 });
  });

  test('上限を 1 バイト超えると 413 の invalid_input', async () => {
    const res = await send(small, 101);
    expect(res.status).toBe(413);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });

  test('申告の Content-Length が上限を超えれば、本文が短くても 413', async () => {
    const res = await send(small, 10, '1000');
    expect(res.status).toBe(413);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });

  test('maxBodyBytes の無い定義は今どおり 50MB まで受け付ける（1MiB は通る）', async () => {
    const res = await send(unbounded, 1024 * 1024);
    expect(res.status).toBe(200);
  });

  test('maxBodyBytes の無い定義でも 50MB を超える申告は今どおり 413', async () => {
    const res = await send(unbounded, 10, String(52_428_801));
    expect(res.status).toBe(413);
  });

  test('本番の me-avatar-upload も、512KiB を 1 バイト超える申告を 413 で断る', async () => {
    const target = await createTarget();
    const res = await post(createApp(), meAvatarUpload, {
      slug: target.slug,
      token: target.member.token,
      body: {},
      file: chunkedStream([pngImage(8, 8)]),
      contentLength: String(AVATAR_MAX_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });
});

describe('定義の cacheControl は、private の後ろに共有キャッシュに載せる指示を足した値も断る（done-check の反証）', () => {
  test.each(['private, public, max-age=3600', 'private, s-maxage=60', 'private,public', 'private, max-age=60, Public'])(
    '%j は断る',
    (cacheControl) => {
      expect(() => assertOperationDefinition(forgedDownload({ cacheControl }))).toThrow(/cacheControl/);
    },
  );

  test.each(['private, max-age=3600, publicity', 'private, no-cache'])('%j は通る', (cacheControl) => {
    expect(() => assertOperationDefinition(forgedDownload({ cacheControl }))).not.toThrow();
  });
});
