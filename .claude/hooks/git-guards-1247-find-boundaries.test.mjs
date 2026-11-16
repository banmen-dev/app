import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { judgeBash } from './bash-rules.mjs';

const decision = (command) => judgeBash(command, { cwd: '/repo', branchOf: () => '1247-secret-substitution' })?.[0] ?? 'allow';

describe('#1247 find 起点の brace と basename の組み合わせ', () => {
  for (const [command, expected] of [
    ['find "$(echo .e)"{nv,x/y} -execdir cat {} \\;', 'deny'],
    ['find "$(echo .dev)"{.vars,x/y} -execdir cat {} \\;', 'deny'],
    ['find "$(echo .e)"{nv,x/y} -execdir cat {} +', 'deny'],
    ['find "$(echo safe)"{.txt,x/y} -execdir cat {} \\;', 'allow'],
  ]) {
    test(`${command} は ${expected}`, () => assert.equal(decision(command), expected, command));
  }
});

describe('#1247 find の省略起点と先頭オプション', () => {
  for (const [command, expected] of [
    ['find -exec cat {} \\;', 'allow'],
    ['find -execdir cat {} \\;', 'allow'],
    ['find -- "$(echo .env)" -exec cat {} \\;', 'deny'],
    ['find -- "$(echo safe.txt)" -exec cat {} \\;', 'allow'],
    ['find -D tree "$(echo .dev.vars)" -exec cat {} \\;', 'deny'],
    ['find -D tree "$(echo safe.txt)" -exec cat {} \\;', 'allow'],
  ]) {
    test(`${command} は ${expected}`, () => assert.equal(decision(command), expected, command));
  }
});

describe('#1247 パラメーターの既定値に含まれるコマンド置換', () => {
  for (const [command, expected] of [
    ['cat "${X:-$(echo .env)}"', 'deny'],
    ['cat ${X:-$(echo .env)}', 'deny'],
    ['find "${X:-$(echo .dev.vars)}" -exec cat {} \\;', 'deny'],
    ['cat "${X:-$(mktemp)}"', 'allow'],
    ['find "${X:-$(echo safe.txt)}" -exec cat {} \\;', 'allow'],
  ]) {
    test(`${command} は ${expected}`, () => assert.equal(decision(command), expected, command));
  }
});
