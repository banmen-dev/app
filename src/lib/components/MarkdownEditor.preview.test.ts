import { render } from 'svelte/server';
import { expect, test, vi } from 'vitest';
import MarkdownEditor from './MarkdownEditor.svelte';

vi.mock('../preview-without-attachments.ts', () => ({ previewWithoutAttachments: true }));

test('共有プレビューは添付可能な欄でもファイル選択を出さず、本文と書式ボタンを保つ', () => {
  const { body } = render(MarkdownEditor, {
    props: { value: '書きかけの本文', slug: 'aoba', workspaceId: 'w1', toolbar: true },
  });
  expect(body).toContain('書きかけの本文');
  expect(body).toContain('<textarea');
  expect(body).toContain('class="markdown-toolbar"');
  expect(body).not.toContain('type="file"');
  expect(body).not.toContain('class="dropzone"');
});
