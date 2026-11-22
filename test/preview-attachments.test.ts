import { expect, test } from 'vitest';
import { isPreviewWithoutAttachments } from '../src/server/operations/preview-attachments.ts';

test.each([
  ['https://pr-1406-banmen-preview.banmen-preview.workers.dev', true],
  ['https://pr-1406-scrum-guild-preview.banmen-preview.workers.dev', false],
  ['https://pr-1406-banmen-preview.ucan-lab.workers.dev', false],
  ['https://pr-0-banmen-preview.banmen-preview.workers.dev', false],
  [`https://pr-${'1'.repeat(46)}-banmen-preview.banmen-preview.workers.dev`, false],
])('添付なしのプレビューは新しい名前の専用サブドメインだけ: %s', (origin, expected) => {
  expect(
    isPreviewWithoutAttachments({ PUBLIC_ORIGIN: origin as Env['PUBLIC_ORIGIN'], PREVIEW_WITHOUT_ATTACHMENTS: '1' }),
  ).toBe(expected);
});
