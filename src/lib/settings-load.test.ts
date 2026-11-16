import { expect, test } from 'vitest';
import { load } from '../routes/[slug]/w/[id]/settings/+page.ts';

async function read(namingStatus: number) {
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
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const name = String(input).split('/').at(-1)!;
    const status = name === 'sprint-list' ? namingStatus : 200;
    return new Response(JSON.stringify(status === 200 ? bodies[name] : { error: { code: 'internal', message: 'x' } }), {
      status,
    });
  };
  const event = {
    params: { slug: 'aoba', id: '019a0000-0000-7000-8000-000000000401' },
    fetch: fetcher,
    url: new URL('http://localhost/aoba/w/019a0000-0000-7000-8000-000000000401/settings'),
    depends: () => {},
    parent: async () => ({ workspace: { role: 'leader' }, organization: { me: { is_admin: false } } }),
  } as unknown as Parameters<typeof load>[0];
  return await (load as (e: typeof event) => Promise<unknown>)(event);
}

test('命名の読み取りだけが失敗しても、ほかの設定を残す', async () => {
  expect(await read(500)).toEqual({
    forbidden: false,
    naming: null,
    definitions: { categories: [], repositories: [], columns: [], fields: [] },
  });
});

test('次の開始日とルール・番号は一覧とは分けて返す', async () => {
  expect(await read(200)).toMatchObject({
    naming: { start_on: '2026-01-05', sprint_name_template: '次{n}', sprint_number_next: 12 },
    definitions: { columns: [] },
  });
});
