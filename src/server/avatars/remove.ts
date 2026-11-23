// 行が消えた後の R2 のファイルの削除。行は確定済みなので、失敗しても操作は失敗にせず、件数だけをログに出す
// （キーと例外の文はキーを含みうるので出さない）。消せなかったファイルはどの行からも指されずに残り、
// 組織を消す手順で組織の接頭辞ごと消える（docs/development.md の「プロフィール画像」）
export async function removeAvatarObjects(
  bucket: Pick<R2Bucket, 'delete'>,
  keys: readonly string[],
  log: { operation: string; requestId?: string },
): Promise<void> {
  const maxKeysPerDelete = 1000;
  let failed = 0;
  for (let start = 0; start < keys.length; start += maxKeysPerDelete) {
    const batch = keys.slice(start, start + maxKeysPerDelete);
    try {
      await bucket.delete(batch);
    } catch {
      failed += batch.length;
    }
  }
  if (failed > 0) {
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        ...(log.requestId === undefined ? {} : { requestId: log.requestId }),
        operation: log.operation,
        reason: 'プロフィール画像のファイルを消せなかった',
        count: failed,
      }),
    );
  }
}
