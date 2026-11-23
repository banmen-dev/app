import { expect, test, vi } from 'vitest';
import { removeAvatarObjects } from '../src/server/avatars/remove.ts';

test('プロフィール画像を1000件ずつ削除し、失敗した束の件数だけを記録する', async () => {
  const keys = Array.from({ length: 1001 }, (_, index) => `avatar-${index}`);
  const deleteObjects = vi
    .fn<Pick<R2Bucket, 'delete'>['delete']>()
    .mockRejectedValueOnce(new Error('保存先のエラー'))
    .mockResolvedValueOnce(undefined);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await removeAvatarObjects({ delete: deleteObjects }, keys, { operation: 'workspace-delete' });
    expect(deleteObjects.mock.calls).toEqual([[keys.slice(0, 1000)], [keys.slice(1000)]]);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        operation: 'workspace-delete',
        reason: 'プロフィール画像のファイルを消せなかった',
        count: 1000,
      }),
    );
  } finally {
    errorLog.mockRestore();
  }
});
