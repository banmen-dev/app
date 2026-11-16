import { expect, test } from 'vitest';
import { load } from '../routes/[slug]/w/[id]/settings/+page.ts';

async function read(namingStatus: number, options: { member?: boolean; failed?: string } = {}) {
  const bodies: Record<string, unknown> = {
    'category-repository-list': { categories: [], repositories: [] },
    'column-list': { columns: [] },
    'detail-field-list': { fields: [] },
    'sprint-list': {
      sprints: [],
      defaults: { start_on: '2026-01-05', length: 14, sprint_name_template: '次{n}', sprint_number_next: 12 },
      today: '2026-01-01',
    },
  };
  let calls = 0;
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    calls++;
    const name = String(input).split('/').at(-1)!;
    const status = name === options.failed ? 500 : name === 'sprint-list' ? namingStatus : 200;
    return new Response(
      JSON.stringify(
        status === 200
          ? bodies[name]
          : { error: { code: status === 401 ? 'unauthenticated' : 'internal', message: 'x' } },
      ),
      {
        status,
      },
    );
  };
  const event = {
    params: { slug: 'aoba', id: '019a0000-0000-7000-8000-000000000401' },
    fetch: fetcher,
    url: new URL('http://localhost/aoba/w/019a0000-0000-7000-8000-000000000401/settings'),
    depends: () => {},
    parent: async () => ({
      workspace: { role: options.member ? 'member' : 'leader' },
      organization: { me: { is_admin: false } },
    }),
  } as unknown as Parameters<typeof load>[0];
  return { result: await (load as (e: typeof event) => Promise<unknown>)(event), calls };
}

test('命名の読み取りだけが失敗しても、ほかの設定を残す', async () => {
  expect((await read(500)).result).toEqual({
    forbidden: false,
    naming: null,
    definitions: { categories: [], repositories: [], columns: [], fields: [] },
  });
});

test('次の開始日とルール・番号は一覧とは分けて返す', async () => {
  expect((await read(200)).result).toMatchObject({
    naming: { start_on: '2026-01-05', sprint_name_template: '次{n}', sprint_number_next: 12 },
    definitions: { columns: [] },
  });
});

test('メンバーには設定の読み取りを送らない', async () => {
  expect(await read(200, { member: true })).toEqual({
    result: { forbidden: true, naming: null, definitions: null },
    calls: 0,
  });
});
test('命名の401もログインへ移す', async () => {
  await expect(read(401)).rejects.toMatchObject({ status: 307 });
});
test('列だけの失敗は一覧の失敗にし、読めた命名の初期値は残す', async () => {
  expect((await read(200, { failed: 'column-list' })).result).toMatchObject({
    definitions: null,
    naming: { sprint_number_next: 12 },
  });
});
