import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '1247-secret-substitution' })?.[0] ?? 'allow';

describe('#1247 find の起点の置換を読み取りへ引き継ぐ', () => {
  for (const secret of ['.env', '.dev.vars']) {
    for (const action of ['-exec', '-execdir', '-ok', '-okdir']) {
      for (const ending of action.startsWith('-ok') ? ['\\;'] : ['\\;', '+']) {
        const command = `find "$(echo ${secret})" ${action} cat {} ${ending}`;
        test(`${command} は deny`, () => assert.equal(decision(command), 'deny', command));
      }
    }
  }

  for (const start of ['"$(mktemp)"', 'docs']) {
    for (const action of ['-exec', '-execdir', '-ok', '-okdir']) {
      for (const ending of action.startsWith('-ok') ? ['\\;'] : ['\\;', '+']) {
        const command = `find ${start} ${action} cat {} ${ending}`;
        test(`${command} は allow`, () => assert.equal(decision(command), 'allow', command));
      }
    }
  }

  for (const command of [
    'find "$(echo .en)v" -exec head {} \\;',
    'find "$(echo .dev)$(echo .vars)" -exec cat {} +',
    'find "`echo .env`" -exec cat {} \\;',
    'find "$(echo .env.example)" -exec cat {} +',
  ]) {
    const expected = command.includes('.env.example') ? 'allow' : 'deny';
    test(`${command} は ${expected}`, () => assert.equal(decision(command), expected, command));
  }
});
