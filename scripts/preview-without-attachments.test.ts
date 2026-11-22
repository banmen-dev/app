import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewConfig } from './preview-config.ts';

test('専用アカウント向けの共有プレビューは R2 バケットを要求しない', () => {
  const config = previewConfig(
    '1406',
    { name: 'banmen-pr-1406', uuid: '11111111-1111-4111-8111-111111111111' },
    'a'.repeat(40),
    '/workspace/app',
    'banmen-preview',
  );
  assert.equal(Object.hasOwn(config, 'r2_buckets'), false);
  assert.equal('PREVIEW_WITHOUT_ATTACHMENTS' in config.vars && config.vars.PREVIEW_WITHOUT_ATTACHMENTS, '1');
  assert.equal(config.d1_databases[0].binding, 'DB');
});
