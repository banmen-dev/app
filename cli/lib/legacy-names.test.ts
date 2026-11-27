// 名前を改める前の pnpm sg と SG_* を、次のリリースまで読むことを確かめる（#1429）。
// 期待は Issue の「人が決めたこと」: BANMEN_* が勝ち、SG_* は使わずに注意を出す。旧名で動いたら標準エラーに1行の注意を出す
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { legacyNoticeOf, main, type CliDeps } from './main.ts';
import { runMcp } from './mcp-server.ts';

const URL_NEW = 'https://aoba.guild.example';
const URL_OLD = 'https://kaede.guild.example';
const TOKEN_NEW = `bnp_${'N'.repeat(43)}`;
const TOKEN_OLD = `bnp_${'O'.repeat(43)}`;

const operationOf = (name: string, scope: string, properties: Record<string, unknown> = {}) => ({
  name,
  description: name,
  mode: 'read',
  scope,
  permission: 'login',
  input_schema: { type: 'object', properties, required: [] },
  output_schema: { type: 'object', properties: {}, required: [] },
});

const catalog = {
  operations: [
    operationOf('lantern-ws', 'workspace', { workspace_id: { type: 'string' } }),
    {
      name: 'lantern-org',
      description: 'lantern-org',
      mode: 'read',
      scope: 'organization',
      permission: 'login',
      input_schema: { type: 'object', properties: {}, required: [] },
      output_schema: { type: 'object', properties: {}, required: [] },
    },
  ],
};

type Call = { url: string; authorization: string; body: unknown };

function world(env: Record<string, string>) {
  const calls: Call[] = [];
  let stdout = '';
  let stderr = '';
  const deps: CliDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        body: JSON.parse(String(init?.body ?? 'null')),
      });
      if (new URL(url).pathname === '/api/operation-list') return Response.json(catalog);
      return Response.json({ ok: true });
    }) as typeof fetch,
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => '',
    config: { read: async () => undefined, write: async () => {} },
  };
  return { deps, calls, output: () => ({ stdout, stderr }) };
}

async function run(argv: string[], env: Record<string, string>) {
  const w = world(env);
  const code = await main(argv, w.deps);
  return { code, calls: w.calls, ...w.output() };
}

const lines = (text: string) => text.split('\n').filter((line) => line !== '');

describe('旧名の注意（legacyNoticeOf）', () => {
  test('旧名を使っていなければ注意は無い', () => {
    assert.equal(legacyNoticeOf({}), undefined);
    assert.equal(
      legacyNoticeOf({ BANMEN_URL: URL_NEW, BANMEN_TOKEN: TOKEN_NEW, npm_lifecycle_event: 'banmen' }),
      undefined,
    );
  });

  test('pnpm sg で動いたら pnpm banmen へ移るよう促す', () => {
    const notice = legacyNoticeOf({ npm_lifecycle_event: 'sg' });
    assert.ok(notice?.includes('pnpm sg → pnpm banmen'));
  });

  test('スクリプトの名前が sg で始まるだけなら、pnpm sg とみなさない', () => {
    assert.equal(legacyNoticeOf({ npm_lifecycle_event: 'sg:dev' }), undefined);
    assert.equal(legacyNoticeOf({ npm_lifecycle_event: 'sgx' }), undefined);
  });

  test('空の SG_* は未設定と同じで、注意を出さない', () => {
    assert.equal(legacyNoticeOf({ SG_URL: '', SG_TOKEN: '', SG_ORG: '' }), undefined);
  });

  test('注意は1行で、値（トークン、URL、組織）を含めない', () => {
    const notice = legacyNoticeOf({
      npm_lifecycle_event: 'sg',
      SG_URL: URL_OLD,
      SG_TOKEN: TOKEN_OLD,
      SG_ORG: 'kaede',
      BANMEN_WORKSPACE: 'ws-new',
      SG_WORKSPACE: 'ws-old',
    });
    assert.ok(notice !== undefined);
    assert.ok(!notice.includes('\n'));
    for (const value of [URL_OLD, TOKEN_OLD, 'kaede', 'ws-new', 'ws-old']) assert.ok(!notice.includes(value), value);
    assert.ok(notice.includes('SG_ORG → BANMEN_ORG'));
    assert.ok(notice.includes('SG_WORKSPACE は使わない'));
  });
});

describe('BANMEN_* と SG_* の選び方', () => {
  test('BANMEN_URL と BANMEN_TOKEN で呼べ、注意は出ない', async () => {
    const result = await run(['call', 'lantern-org'], {
      BANMEN_URL: URL_NEW,
      BANMEN_TOKEN: TOKEN_NEW,
      BANMEN_ORG: 'aoba',
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.calls.at(-1)?.url, `${URL_NEW}/api/aoba/lantern-org`);
    assert.equal(result.calls.at(-1)?.authorization, `Bearer ${TOKEN_NEW}`);
  });

  test('SG_URL と SG_TOKEN だけでも呼べ、標準出力と終了コードは BANMEN_* と同じで、標準エラーに注意が1行出る', async () => {
    const legacy = await run(['call', 'lantern-org'], { SG_URL: URL_OLD, SG_TOKEN: TOKEN_OLD, SG_ORG: 'kaede' });
    const current = await run(['call', 'lantern-org'], {
      BANMEN_URL: URL_OLD,
      BANMEN_TOKEN: TOKEN_OLD,
      BANMEN_ORG: 'kaede',
    });
    assert.equal(legacy.code, current.code);
    assert.equal(legacy.stdout, current.stdout);
    assert.deepEqual(legacy.calls, current.calls);
    assert.equal(lines(legacy.stderr).length, 1);
    assert.ok(legacy.stderr.includes('SG_URL → BANMEN_URL'));
    assert.ok(!legacy.stderr.includes(TOKEN_OLD));
  });

  test('両方の組があれば BANMEN_* の組を使い、使わなかった SG_* の名前を出す', async () => {
    const result = await run(['call', 'lantern-org', '--org', 'aoba'], {
      BANMEN_URL: URL_NEW,
      BANMEN_TOKEN: TOKEN_NEW,
      SG_URL: URL_OLD,
      SG_TOKEN: TOKEN_OLD,
    });
    assert.equal(result.code, 0);
    assert.ok(
      result.calls.every((call) => call.url.startsWith(URL_NEW) && call.authorization === `Bearer ${TOKEN_NEW}`),
    );
    assert.ok(result.stderr.includes('SG_URL、SG_TOKEN は使わない'));
    assert.ok(!result.stderr.includes(TOKEN_OLD) && !result.stderr.includes(TOKEN_NEW));
  });

  for (const [name, env, message] of [
    [
      'BANMEN_URL と SG_TOKEN',
      { BANMEN_URL: URL_NEW, SG_TOKEN: TOKEN_OLD },
      'BANMEN_URL と BANMEN_TOKEN は両方を設定する',
    ],
    [
      'SG_URL と BANMEN_TOKEN',
      { SG_URL: URL_OLD, BANMEN_TOKEN: TOKEN_NEW },
      'BANMEN_URL と BANMEN_TOKEN は両方を設定する',
    ],
    [
      'BANMEN_URL だけと SG_* の組',
      { BANMEN_URL: URL_NEW, SG_URL: URL_OLD, SG_TOKEN: TOKEN_OLD },
      'BANMEN_URL と BANMEN_TOKEN は両方を設定する',
    ],
    ['SG_URL だけ', { SG_URL: URL_OLD }, 'SG_URL と SG_TOKEN は両方を設定する'],
  ] as const) {
    test(`${name} は系統を混ぜずに使い方の誤り（2）で、何も送らない`, async () => {
      const result = await run(['ops'], { ...env });
      assert.equal(result.code, 2);
      assert.equal(result.calls.length, 0);
      const error = JSON.parse(lines(result.stderr).at(-1)!);
      assert.equal(error.error.code, 'usage');
      assert.equal(error.error.message, message);
      assert.ok(!result.stderr.includes(TOKEN_OLD) && !result.stderr.includes(TOKEN_NEW));
    });
  }

  test('BANMEN_ORG は SG_ORG に勝ち、SG_ORG だけなら SG_ORG を使う', async () => {
    const base = { BANMEN_URL: URL_NEW, BANMEN_TOKEN: TOKEN_NEW };
    const both = await run(['call', 'lantern-org'], { ...base, BANMEN_ORG: 'aoba', SG_ORG: 'kaede' });
    assert.equal(both.calls.at(-1)?.url, `${URL_NEW}/api/aoba/lantern-org`);
    assert.ok(both.stderr.includes('SG_ORG は使わない'));
    const legacy = await run(['call', 'lantern-org'], { ...base, SG_ORG: 'kaede' });
    assert.equal(legacy.calls.at(-1)?.url, `${URL_NEW}/api/kaede/lantern-org`);
    assert.ok(legacy.stderr.includes('SG_ORG → BANMEN_ORG'));
  });

  test('BANMEN_WORKSPACE は SG_WORKSPACE に勝ち、SG_WORKSPACE だけなら SG_WORKSPACE を使う', async () => {
    const base = { BANMEN_URL: URL_NEW, BANMEN_TOKEN: TOKEN_NEW, BANMEN_ORG: 'aoba' };
    const both = await run(['call', 'lantern-ws'], { ...base, BANMEN_WORKSPACE: 'ws-new', SG_WORKSPACE: 'ws-old' });
    assert.deepEqual(both.calls.at(-1)?.body, { workspace_id: 'ws-new' });
    assert.ok(both.stderr.includes('SG_WORKSPACE は使わない'));
    const legacy = await run(['call', 'lantern-ws'], { ...base, SG_WORKSPACE: 'ws-old' });
    assert.deepEqual(legacy.calls.at(-1)?.body, { workspace_id: 'ws-old' });
    assert.ok(legacy.stderr.includes('SG_WORKSPACE → BANMEN_WORKSPACE'));
  });

  test('config set も BANMEN_PROFILE を SG_PROFILE より先に見る', async () => {
    const w = world({ BANMEN_PROFILE: 'night', SG_PROFILE: 'day' });
    let saved: unknown;
    w.deps.config = {
      read: async () => ({ profiles: {} }),
      write: async (config) => {
        saved = config;
      },
    };
    assert.equal(await main(['config', 'set', 'org', 'kaede'], w.deps), 0);
    assert.deepEqual(saved, { profiles: { night: { org: 'kaede' } } });
  });

  const twoProfiles = () => ({
    read: async () => ({
      default_profile: 'main',
      profiles: {
        main: { url: URL_NEW, token: TOKEN_NEW, org: 'aoba' },
        sub: { url: URL_OLD, token: TOKEN_OLD, org: 'kaede' },
      },
    }),
    write: async () => {},
  });

  test('SG_PROFILE だけでも接続先を選び、注意を出す', async () => {
    const w = world({ SG_PROFILE: 'sub' });
    w.deps.config = twoProfiles();
    assert.equal(await main(['call', 'lantern-org'], w.deps), 0);
    assert.equal(w.calls.at(-1)?.url, `${URL_OLD}/api/kaede/lantern-org`);
    assert.equal(w.calls.at(-1)?.authorization, `Bearer ${TOKEN_OLD}`);
    assert.ok(w.output().stderr.includes('SG_PROFILE → BANMEN_PROFILE'));
  });

  test('config set は SG_PROFILE だけでもその名前の接続先に書く', async () => {
    const w = world({ SG_PROFILE: 'sub' });
    let saved: unknown;
    w.deps.config = {
      read: async () => ({ profiles: {} }),
      write: async (config) => {
        saved = config;
      },
    };
    assert.equal(await main(['config', 'set', 'org', 'kaede'], w.deps), 0);
    assert.deepEqual(saved, { profiles: { sub: { org: 'kaede' } } });
  });

  test('BANMEN_PROFILE は SG_PROFILE に勝つ', async () => {
    const w = world({ BANMEN_PROFILE: 'main', SG_PROFILE: 'sub' });
    w.deps.config = {
      read: async () => ({
        profiles: { main: { url: URL_NEW, token: TOKEN_NEW, org: 'aoba' }, sub: { url: URL_OLD, token: TOKEN_OLD } },
      }),
      write: async () => {},
    };
    assert.equal(await main(['call', 'lantern-org'], w.deps), 0);
    assert.equal(w.calls.at(-1)?.url, `${URL_NEW}/api/aoba/lantern-org`);
  });
});

describe('banmen mcp の旧名の注意', () => {
  test('注意は標準エラーにだけ出し、標準出力に書かない', async () => {
    const w = world({ SG_TOKEN: TOKEN_OLD });
    const [, serverSide] = InMemoryTransport.createLinkedPair();
    const code = await runMcp([], w.deps, serverSide);
    const { stdout, stderr } = w.output();
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.ok(lines(stderr)[0]?.startsWith('banmen: 注意:'));
    assert.equal(JSON.parse(lines(stderr).at(-1)!).error.message, 'SG_URL と SG_TOKEN は両方を設定する');
    assert.ok(!stderr.includes(TOKEN_OLD));
  });
});

describe('banmen mcp を SG_* だけで起動する', () => {
  test('SG_URL と SG_TOKEN で起動して tools/list に答え、注意は標準エラーにだけ出る', async () => {
    const w = world({ SG_URL: URL_OLD, SG_TOKEN: TOKEN_OLD, SG_ORG: 'kaede' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const running = runMcp([], w.deps, serverSide);
    const client = new Client({ name: 'legacy-test', version: '0.0.0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'lantern-org'));
    assert.ok(w.calls.every((call) => call.url.startsWith(URL_OLD) && call.authorization === `Bearer ${TOKEN_OLD}`));
    await client.close();
    assert.equal(await running, 0);
    const { stdout, stderr } = w.output();
    assert.equal(stdout, '');
    assert.equal(lines(stderr).length, 1);
    assert.ok(stderr.includes('SG_URL → BANMEN_URL'));
    assert.ok(!stderr.includes(TOKEN_OLD));
  });
});

describe('入口の名前', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));

  test('pnpm banmen が正で、pnpm sg は同じ入口を指す別名。cli/sg.ts は無い', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.banmen, 'node cli/banmen.ts');
    assert.equal(pkg.scripts.sg, pkg.scripts.banmen);
    await assert.rejects(access(join(root, 'cli/sg.ts')));
  });

  test('pnpm sg として起動しても、成功の標準出力と終了コードは pnpm banmen と同じ', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url === '/api/operation-list' ? catalog : { ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const home = await mkdtemp(join(tmpdir(), 'banmen-legacy-'));
    try {
      const runAs = (script: string) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
          const child = execFile(
            process.execPath,
            [join(root, 'cli/banmen.ts'), 'ops'],
            {
              env: {
                PATH: process.env.PATH,
                HOME: home,
                BANMEN_URL: `http://127.0.0.1:${port}`,
                BANMEN_TOKEN: TOKEN_NEW,
                npm_lifecycle_event: script,
              },
            },
            (_error, stdout, stderr) => resolve({ code: child.exitCode, stdout, stderr }),
          );
        });
      const legacy = await runAs('sg');
      const current = await runAs('banmen');
      assert.equal(current.code, 0);
      assert.equal(legacy.code, current.code);
      assert.equal(legacy.stdout, current.stdout);
      assert.ok(current.stdout.includes('lantern-org'));
      assert.equal(current.stderr, '');
      assert.ok(legacy.stderr.includes('pnpm sg → pnpm banmen'));
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test('pnpm sg として起動されたら（npm_lifecycle_event が sg）、標準エラーに注意を出す', async () => {
    const home = await mkdtemp(join(tmpdir(), 'banmen-legacy-'));
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = execFile(
          process.execPath,
          [join(root, 'cli/banmen.ts'), 'ops'],
          { env: { PATH: process.env.PATH, HOME: home, npm_lifecycle_event: 'sg' } },
          (_error, stdout, stderr) => resolve({ code: child.exitCode, stdout, stderr }),
        );
      });
      // 設定が無いので使い方の誤り。注意はその前に1行出る
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.ok(lines(result.stderr)[0]?.includes('pnpm sg → pnpm banmen'));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
