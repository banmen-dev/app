// #1241 の請求管理者に見せる使用量の集計（readBillingOrganizationSummary）を、組織の外の操作の文脈
// （src/server/operations/account.ts）の外から使う書き方を、scripts/eslint-db-entry.test.ts の forms に無い形で崩しにかかる。
// 見るのは、取り出しの別の形（文字列や計算済みのキー、引数での取り出し、then の中、optional chaining）、プロパティを読む関数の別の口、
// account.ts に似たパス、.svelte の script、指摘の種類（accountOnly）と、account.ts に運用者の道具だけの関数が開いていないこと
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { ESLint } from 'eslint';

const RULE = 'db-entry/guard';

let eslint: ESLint;
before(() => {
  eslint = new ESLint({ cwd: import.meta.dirname + '/..' });
});

async function messagesOf(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(result);
  const fatal = result.messages.filter((message) => message.fatal);
  assert.deepEqual(fatal, [], `${filePath} を読めない: ${code}`);
  return result.messages.filter((message) => message.ruleId === RULE);
}

const NAME = 'readBillingOrganizationSummary';

const forms: Record<string, string> = {
  '名前空間の取り出し（別名）': `import * as db from './db/index.ts'; const { ${NAME}: read } = db; export const a = read;`,
  '名前空間の取り出し（文字列のキー）': `import * as db from './db/index.ts'; const { '${NAME}': read } = db; export const a = read;`,
  '名前空間の取り出し（計算済みのテンプレートのキー）': `import * as db from './db/index.ts'; const { [\`${NAME}\`]: read } = db; export const a = read;`,
  '名前空間からの参照（テンプレートのキー）': `import * as db from './db/index.ts'; export const a = db[\`${NAME}\`];`,
  '名前空間からの optional chaining': `import * as db from './db/index.ts'; export const a = db?.${NAME};`,
  引数での取り出し: `import * as db from './db/index.ts'; const pick = ({ ${NAME} }: typeof db) => ${NAME}; export const a = pick(db);`,
  '動的な import の then での取り出し': `export const a = import('./db/index.ts').then(({ ${NAME} }) => ${NAME});`,
  '動的な import の then での参照': `export const a = import('./db/index.ts').then((m) => m.${NAME});`,
  '動的な import の結果を直に参照': `export const a = (await import('./db/index.ts')).${NAME};`,
  '動的な import の取り出し（別名）': `const { ${NAME}: read } = await import('./db/index.ts'); export const a = read;`,
  '文字列の名前の import': `import { '${NAME}' as read } from './db/index.ts'; export const a = read;`,
  '別名の export from': `export { ${NAME} as read } from './db/index.ts';`,
  '型だけの import': `import { type ${NAME} } from './db/index.ts'; export type A = typeof ${NAME};`,
  '名前空間から Reflect.getOwnPropertyDescriptor': `import * as db from './db/index.ts'; export const a = Reflect.getOwnPropertyDescriptor(db, '${NAME}');`,
  '名前空間から Object.getOwnPropertyDescriptor': `import * as db from './db/index.ts'; export const a = Object.getOwnPropertyDescriptor(db, '${NAME}');`,
  '動的な import から Reflect.get': `export const a = Reflect.get(await import('./db/index.ts'), '${NAME}');`,
  '名前空間から Reflect.get（テンプレートのキー）': `import * as db from './db/index.ts'; export const a = Reflect.get(db, \`${NAME}\`);`,
  '入口のモジュールでない場所（拡張子の無い db）から': `import { ${NAME} } from '../db'; export const a = ${NAME};`,
};

// account.ts と同じ名前や似たパスでも、src/server/operations/account.ts そのものでなければ使えない
const nearAccount = [
  'src/server/operations/account.test.ts',
  'src/server/operations/accounts.ts',
  'src/server/operations/account/index.ts',
  'src/server/operations/billing/account.ts',
  'src/server/account.ts',
  'src/shared/operations/account.ts',
  'test/operations/account.ts',
  'src/server/operations/account.tsx',
];

describe('readBillingOrganizationSummary: forms に無い取り出しの形', () => {
  for (const file of ['src/server/operations/billing.ts', 'src/server/app.ts', 'test/billing-x.test.ts']) {
    test(`${file}: どの形でも落ち、指摘は accountOnly`, async () => {
      for (const [name, code] of Object.entries(forms)) {
        const messages = await messagesOf(file, code);
        assert.ok(
          messages.some((message) => message.messageId === 'accountOnly'),
          `落ちなかった: ${name}（${JSON.stringify(messages.map((m) => m.messageId))}）`,
        );
      }
    });
  }

  test('src/server/operations/account.ts では、どの形でも accountOnly の指摘が出ない', async () => {
    for (const [name, code] of Object.entries(forms)) {
      if (name.startsWith('入口のモジュールでない')) continue;
      const messages = await messagesOf('src/server/operations/account.ts', code);
      assert.deepEqual(
        messages.map((message) => message.messageId),
        [],
        name,
      );
    }
  });
});

describe('readBillingOrganizationSummary: account.ts に似たパス', () => {
  for (const file of nearAccount) {
    test(`${file}: 使えない`, async () => {
      const code = `import { ${NAME} } from '../server/db/index.ts'; export const a = ${NAME};`;
      const messages = await messagesOf(file, code);
      assert.ok(
        messages.some((message) => message.messageId === 'accountOnly'),
        JSON.stringify(messages),
      );
    });
  }
});

test('.svelte の script でも readBillingOrganizationSummary は落ちる', async () => {
  const code = `<script lang="ts">\n  import * as db from '../../server/db/index.ts';\n  const { ${NAME}: read } = db;\n  export const a = read;\n</script>\n`;
  const messages = await messagesOf('src/lib/components/BillingSummary.svelte', code);
  assert.ok(
    messages.some((message) => message.messageId === 'accountOnly'),
    JSON.stringify(messages),
  );
});

test('account.ts は、運用者の道具だけの関数と定期処理だけの関数を使えないまま', async () => {
  for (const name of [
    'organizationUsageOf',
    'adminStatusesOf',
    'appendOperatorChangeLog',
    'reassignOrganizationAdmin',
    'appendScheduledChangeLog',
    'deleteExpiredAttachments',
  ]) {
    const code = `import { ${name} } from '../db/index.ts'; export const a = ${name};`;
    const messages = await messagesOf('src/server/operations/account.ts', code);
    assert.ok(messages.length >= 1, `account.ts で ${name} が通った`);
    assert.ok(!messages.some((message) => message.messageId === 'accountOnly'), name);
  }
});

test('運用者の道具と定期処理では、指摘は accountOnly（運用者の道具・定期処理の指摘と取り違えない）', async () => {
  for (const file of ['src/server/operations/operator-tools.ts', 'src/server/scheduled/cleanup-attachments.ts']) {
    const code = `import { ${NAME} } from '../db/index.ts'; export const a = ${NAME};`;
    const messages = await messagesOf(file, code);
    assert.deepEqual(
      messages.map((message) => message.messageId),
      ['accountOnly'],
      file,
    );
  }
});

test('同じ文で運用者の道具だけの関数と並べて取り出すと、両方の指摘が出る', async () => {
  const code = `import * as db from './db/index.ts'; const { ${NAME}: a, organizationUsageOf: b } = db; export { a, b };`;
  const messages = await messagesOf('src/server/operations/billing.ts', code);
  const ids = messages.map((message) => message.messageId).sort();
  assert.deepEqual(ids, ['accountOnly', 'operatorToolsOnly']);
});
