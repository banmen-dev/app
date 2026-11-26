// 本文の種類 body: 'multipart'（権限 login の write だけ）と、運用者のファイルを返す操作（response: 'binary'）の
// 定義の決まりと、登録の関数の読み取り（Issue #1555）
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  assertOperationDefinition,
  defineOperation,
  operationMethod,
  operationPath,
  type AnyOperationDefinition,
} from '../src/shared/operations/define.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { createApp } from '../src/server/app.ts';
import { implement, type ImplementedOperation } from '../src/server/operations/implement.ts';
import { tokenAllows } from '../src/server/operations/token-scope.ts';
import { insertApiToken } from './operations/api-token.ts';
import { createLoginPerson, getOperator, testEnv, type Person } from './operations/world.ts';

const MAX = 64 * 1024;

const multipartBase = {
  name: 'lantern-feedback',
  description: '文と画像を受ける仮の操作',
  mode: 'write',
  permission: 'login',
  input: z.object({ text: z.string().min(1).max(100) }).strict(),
  output: z.object({ files: z.number(), names: z.array(z.string()), text: z.string() }),
  maxBodyBytes: MAX,
} as const;

const downloadBase = {
  name: 'lantern-picture',
  description: '運用者に画像を返す仮の操作',
  mode: 'read',
  permission: 'operator',
  input: z.object({ id: z.uuid() }),
  output: z.instanceof(Response),
} as const;

const forged = (base: object, overrides: Record<string, unknown>) =>
  ({ ...base, ...overrides }) as unknown as AnyOperationDefinition;

describe('assertOperationDefinition と body: multipart', () => {
  test('権限 login の write で maxBodyBytes があれば通る', () => {
    expect(() => assertOperationDefinition(forged(multipartBase, { body: 'multipart' }))).not.toThrow();
    expect(() =>
      assertOperationDefinition(forged(multipartBase, { body: 'multipart', skipsConsent: true })),
    ).not.toThrow();
  });

  test.each([
    ['operator の write', { permission: 'operator' }],
    ['組織の中の write（organization）', { permission: 'organization' }],
    ['組織の中の write（admin）', { permission: 'admin' }],
    [
      'ワークスペースの下の write',
      { permission: 'member', workspace: true, input: z.object({ workspace_id: z.string() }) },
    ],
    ['login の read', { mode: 'read' }],
  ])('%s に付けると断る', (_label, overrides) => {
    const definition = forged(multipartBase, { body: 'multipart', ...overrides });
    expect(() => assertOperationDefinition(definition)).toThrow(/body/);
    expect(() => defineOperation(definition)).toThrow(/body/);
    expect(() => createApp([{ definition, handler: async () => ({}) } as unknown as ImplementedOperation])).toThrow(
      /body/,
    );
  });

  test('maxBodyBytes が無いと断る', () => {
    expect(() =>
      assertOperationDefinition(forged(multipartBase, { body: 'multipart', maxBodyBytes: undefined })),
    ).toThrow(/maxBodyBytes/);
  });

  test('binary は今までどおり、組織の外には付けられない', () => {
    expect(() => assertOperationDefinition(forged(multipartBase, { body: 'binary' }))).toThrow(/body/);
  });

  test('API トークンでは書き込みでも呼べない', () => {
    const definition = defineOperation({ ...multipartBase, body: 'multipart' });
    expect(tokenAllows(definition, 'write')).toBe(false);
    expect(tokenAllows(definition, 'read')).toBe(false);
  });
});

describe('assertOperationDefinition と運用者の response: binary', () => {
  test('運用者の read に付けられ、GET の URL は /api/<名前>/<id>', () => {
    const definition = defineOperation({ ...downloadBase, response: 'binary' });
    expect(operationMethod(definition)).toBe('GET');
    expect(operationPath(definition)).toBe('/api/lantern-picture/:id');
    expect(operationPath(definition, undefined, { id: 'a/b' })).toBe('/api/lantern-picture/a%2Fb');
    expect(tokenAllows(definition, 'read')).toBe(false);
    expect(tokenAllows(definition, 'write')).toBe(false);
  });

  test.each([
    ['運用者の write', { mode: 'write' }],
    ['login の read', { permission: 'login' }],
    ['body と併用', { body: 'multipart' }],
  ])('%s は断る', (_label, overrides) => {
    expect(() => assertOperationDefinition(forged(downloadBase, { response: 'binary', ...overrides }))).toThrow();
  });
});

function multipartForm(input: unknown, files: { name: string; type: string; body: string }[] = []): FormData {
  const form = new FormData();
  form.append('input', typeof input === 'string' ? input : JSON.stringify(input));
  for (const file of files) form.append('file', new File([file.body], file.name, { type: file.type }));
  return form;
}

describe('multipart の読み取り', () => {
  const definition = defineOperation({ ...multipartBase, body: 'multipart' });
  const seen: { text: string; names: string[] }[] = [];
  const app = createApp([
    implement(definition, async ({ input, multipart }) => {
      seen.push({ text: input.text, names: multipart.files.map((file) => file.name) });
      return { files: multipart.files.length, names: multipart.files.map((file) => file.name), text: input.text };
    }),
  ]);

  async function send(person: Person, body: BodyInit, headers: Record<string, string> = {}) {
    return app.request(
      operationPath(definition),
      {
        method: 'POST',
        headers: {
          Origin: testEnv.PUBLIC_ORIGIN,
          Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${person.token}`,
          ...headers,
        },
        body,
      },
      testEnv,
    );
  }

  async function code(res: Response): Promise<string | undefined> {
    return ((await res.json()) as { error?: { code?: string } }).error?.code;
  }

  test('文とファイルを1リクエストで受け、入力を検証してファイルを処理に渡す', async () => {
    const person = await createLoginPerson();
    const res = await send(
      person,
      multipartForm({ text: '押せない' }, [
        { name: 'a.png', type: 'image/png', body: 'AAA' },
        { name: 'b.png', type: 'image/png', body: 'BBB' },
      ]),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: 2, names: ['a.png', 'b.png'], text: '押せない' });
  });

  test('ファイルが無くても通る', async () => {
    const person = await createLoginPerson();
    const res = await send(person, multipartForm({ text: '文だけ' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { files: number }).files).toBe(0);
  });

  test('入力の JSON の部分が無い本文は 400 の invalid_input', async () => {
    const person = await createLoginPerson();
    const form = new FormData();
    form.append('file', new File(['x'], 'a.png', { type: 'image/png' }));
    const res = await send(person, form);
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('invalid_input');
  });

  test.each([
    ['JSON でない', 'not json'],
    ['スキーマに合わない', JSON.stringify({ text: '' })],
    ['未知のキー', JSON.stringify({ text: 'a', extra: 1 })],
  ])('入力の部分が %s なら 400 の invalid_input', async (_label, input) => {
    const person = await createLoginPerson();
    const res = await send(person, multipartForm(input));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('invalid_input');
  });

  test('入力の部分が2つ、入力がファイル、ファイルでない部分は 400 の invalid_input', async () => {
    const person = await createLoginPerson();
    const twice = new FormData();
    twice.append('input', JSON.stringify({ text: 'a' }));
    twice.append('input', JSON.stringify({ text: 'b' }));
    const asFile = new FormData();
    asFile.append('input', new File([JSON.stringify({ text: 'a' })], 'input.json'));
    const stray = multipartForm({ text: 'a' });
    stray.append('note', 'ファイルではない文');
    for (const body of [twice, asFile, stray]) {
      const res = await send(person, body);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe('invalid_input');
    }
  });

  test('部分の数が多すぎる本文は 400 の invalid_input', async () => {
    const person = await createLoginPerson();
    const form = multipartForm({ text: 'a' });
    for (let index = 0; index < 25; index += 1) form.append('file', new File(['x'], `${index}.png`));
    const res = await send(person, form);
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('invalid_input');
  });

  test('壊れた multipart（境界が合わない、境界が無い、multipart でない）は 400 の invalid_input', async () => {
    const person = await createLoginPerson();
    const broken = [
      await send(person, '--nope\r\ngarbage', { 'Content-Type': 'multipart/form-data; boundary=zzz' }),
      await send(person, '--zzz\r\nContent-Disposition: form-data; name="input"\r\n\r\n{', {
        'Content-Type': 'multipart/form-data; boundary=zzz',
      }),
      await send(person, 'x', { 'Content-Type': 'multipart/form-data' }),
      await send(person, JSON.stringify({ text: 'a' }), { 'Content-Type': 'application/json' }),
    ];
    for (const res of broken) {
      expect(res.status).toBe(400);
      expect(await code(res)).toBe('invalid_input');
    }
  });

  test('申告が上限を超える本文は読まずに 413 の invalid_input', async () => {
    const person = await createLoginPerson();
    const res = await send(person, multipartForm({ text: 'a' }), { 'Content-Length': String(MAX + 1) });
    expect(res.status).toBe(413);
    expect(await code(res)).toBe('invalid_input');
  });

  test('Content-Length の無い（chunked の）本文も、読んだ分が上限を超えれば 413 の invalid_input', async () => {
    const person = await createLoginPerson();
    const request = new Request('https://x.example/', {
      method: 'POST',
      body: multipartForm({ text: 'a' }, [{ name: 'big.png', type: 'image/png', body: 'x'.repeat(MAX + 1) }]),
    });
    const stream = request.body as ReadableStream<Uint8Array>;
    const res = await send(person, stream, { 'Content-Type': request.headers.get('Content-Type')! });
    expect(res.status).toBe(413);
    expect(await code(res)).toBe('invalid_input');
  });

  test('上限ちょうどに収まる本文は通り、ログインしていない呼び出しと Origin の違いは本文を読まずに断る', async () => {
    const person = await createLoginPerson();
    const ok = await send(
      person,
      multipartForm({ text: 'a' }, [{ name: 'a.png', type: 'image/png', body: 'x'.repeat(MAX - 1024) }]),
    );
    expect(ok.status).toBe(200);
    const before = seen.length;
    const anonymous = await app.request(
      operationPath(definition),
      { method: 'POST', headers: { Origin: testEnv.PUBLIC_ORIGIN }, body: multipartForm({ text: 'a' }) },
      testEnv,
    );
    expect(anonymous.status).toBe(401);
    const foreign = await send(person, multipartForm({ text: 'a' }), { Origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  test('API トークンでは 403', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { scope: 'write' });
    const res = await app.request(
      operationPath(definition),
      { method: 'POST', headers: { Authorization: `Bearer ${raw}` }, body: multipartForm({ text: 'a' }) },
      testEnv,
    );
    expect(res.status).toBe(403);
  });
});

describe('運用者のファイルを返す操作', () => {
  const definition = defineOperation({ ...downloadBase, response: 'binary' });
  const id = crypto.randomUUID();
  const app = createApp([
    implement(definition, async ({ input, download }) => {
      expect(download.bucket).toBeDefined();
      return new Response(`picture:${input.id}`, { headers: { 'Content-Type': 'image/png' } });
    }),
  ]);

  const get = (path: string, init: RequestInit) => app.request(path, { method: 'GET', ...init }, testEnv);
  const cookie = (person: Person) => ({ Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${person.token}` });

  test('運用者は GET /api/<名前>/<id> で画像を受け取れ、応答は private, no-store で sandbox の CSP が付く', async () => {
    const operator = await getOperator();
    const res = await get(operationPath(definition, undefined, { id }), { headers: cookie(operator) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`picture:${id}`);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
  });

  test('運用者でない人が呼ぶと 403', async () => {
    const person = await createLoginPerson();
    const res = await get(operationPath(definition, undefined, { id }), { headers: cookie(person) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  test('ログインしていなければ 401、別のサイトからの読み込みは 403、API トークンは運用者でも 403、id が UUID でなければ 400', async () => {
    const operator = await getOperator();
    expect((await get(operationPath(definition, undefined, { id }), {})).status).toBe(401);
    expect(
      (
        await get(operationPath(definition, undefined, { id }), {
          headers: { ...cookie(operator), 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    const { raw } = await insertApiToken(operator.accountId, { scope: 'read' });
    expect(
      (await get(operationPath(definition, undefined, { id }), { headers: { Authorization: `Bearer ${raw}` } })).status,
    ).toBe(403);
    expect(
      (await get(operationPath(definition, undefined, { id: 'not-a-uuid' }), { headers: cookie(operator) })).status,
    ).toBe(400);
  });
});
