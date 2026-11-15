// 自分のプロフィール画像の操作の処理（定義は src/shared/operations/organization/me-avatar.ts。Issue #1265）。
// 表は user_avatars（組織の中の表。1人1行）、中身は R2（ATTACHMENTS）の <組織>/avatars/<人>/<画像の ID>。
// 上げる・外す操作は入力に人の ID を持たず、呼んだ本人（actor.userId）の行だけを触る。
// 差し替えるとキーと URL が変わる（表の id とキーの末尾は同じ値）ので、配る応答は長めにキャッシュできる
import { now } from '../../shared/clock.ts';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PIXELS,
  meAvatarDelete,
  meAvatarUpload,
  userAvatar,
} from '../../shared/operations/organization/me-avatar.ts';
import { readAvatarImage } from '../avatars/image.ts';
import { removeAvatarObjects } from '../avatars/remove.ts';
import { avatarObjectKey, avatarUrl } from '../avatars/url.ts';
import type { OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement, type BinaryBody } from './implement.ts';
import { actorUserIdOf } from './write-guards.ts';

// 本文を、実際に読んだバイト数を数えながら全部読む（ヘッダーは全体を見て読むので、途中で切れない）。
// 申告（Content-Length）は readBinaryBody が定義の上限と照らし済み。実際に上限を超えたら 413、申告と違えば 400
async function readBody(binary: BinaryBody): Promise<Uint8Array> {
  const reader = binary.body.getReader();
  const bytes = new Uint8Array(binary.contentLength);
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const total = received + value.byteLength;
      if (total > AVATAR_MAX_BYTES) throw new ApiError(413, 'invalid_input');
      if (total > binary.contentLength) throw new ApiError(400, 'invalid_input');
      bytes.set(value, received);
      received = total;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (received !== binary.contentLength) throw new ApiError(400, 'invalid_input');
  return bytes;
}

export const meAvatarUploadOperation = implement(
  meAvatarUpload,
  async ({ db, actor, organization, binary, requestId }) => {
    const userId = actorUserIdOf(actor);
    const bytes = await readBody(binary);
    // 種類は中身で決める（申告の Content-Type は読まない）。静止画の PNG、JPEG、WebP の 512px 以下だけを通す
    const image = readAvatarImage(bytes);
    if (image === null || image.animated || image.width > AVATAR_MAX_PIXELS || image.height > AVATAR_MAX_PIXELS) {
      throw new ApiError(400, 'invalid_input');
    }

    // 差し替えの前の行。書く文はこのキーを条件にするので、読んでから書くまでの間に別の差し替えが済んでいれば食い違う
    const previous = await db.first(
      db.statement((q) =>
        q
          .selectFrom('user_avatars')
          .select('object_key')
          .where('user_id', '=', userId)
          .where('organization_id', '=', db.organizationId),
      ),
    );

    const at = now();
    const id = uuidv7(at);
    const objectKey = avatarObjectKey(db.organizationId, userId, id);
    const discardNew = async () => {
      await removeAvatarObjects(binary.bucket, [objectKey], { operation: meAvatarUpload.name, requestId });
    };

    try {
      await binary.bucket.put(objectKey, bytes, { httpMetadata: { contentType: image.contentType } });
    } catch (error) {
      // put が失敗しても R2 に残っていることがあるので消す
      await discardNew();
      throw failure('プロフィール画像を保存できなかった', requestId, error);
    }

    let applied: boolean;
    try {
      // 1回の batch で、前のキーを条件にした UPSERT を送る。その人が組織に無効でなくいることも条件にする
      // （無効にする batch と並んだときに、消した後に行が戻らない）
      const [result] = await db.batch([
        db.statement((q) => {
          const insert = q
            .insertInto('user_avatars')
            .columns(['user_id', 'id', 'organization_id', 'object_key', 'content_type', 'size_bytes', 'created_at'])
            .expression(
              q
                .selectFrom('users as u')
                .select((eb) => [
                  eb.ref('u.id').as('user_id'),
                  eb.val(id).as('id'),
                  eb.ref('u.organization_id').as('organization_id'),
                  eb.val(objectKey).as('object_key'),
                  eb.val(image.contentType).as('content_type'),
                  eb.val(bytes.byteLength).as('size_bytes'),
                  eb.val(at.toISOString()).as('created_at'),
                ])
                .where('u.id', '=', userId)
                .where('u.organization_id', '=', db.organizationId)
                .where('u.disabled_at', 'is', null),
            );
          return (
            previous === undefined
              ? insert.onConflict((oc) => oc.column('user_id').doNothing())
              : insert.onConflict((oc) =>
                  oc
                    .column('user_id')
                    .doUpdateSet((eb) => ({
                      id: eb.ref('excluded.id'),
                      object_key: eb.ref('excluded.object_key'),
                      content_type: eb.ref('excluded.content_type'),
                      size_bytes: eb.ref('excluded.size_bytes'),
                      created_at: eb.ref('excluded.created_at'),
                    }))
                    .where('user_avatars.object_key', '=', previous.object_key),
                )
          ).returning('id');
        }),
      ]);
      applied = (result?.rows.length ?? 0) > 0;
    } catch (error) {
      // D1 が書き込みを確定した後に応答だけが失われることがある。新しい ID の行が無いと確かめられたときだけ新しいファイルを消す
      // （確かめられなければ消さない。どの行からも指されないファイルが残るほうが、行が指すファイルを消すより安全）
      if ((await committedAvatarId(db, userId).catch(() => id)) !== id) await discardNew();
      throw failure('プロフィール画像の行を書けなかった', requestId, error);
    }
    if (!applied) {
      // 別の差し替えか無効にする書き込みが先に済んだ。書いた新しいファイルはどの行からも指されないので消す
      await discardNew();
      throw new ApiError(409, 'conflict');
    }

    // 前のファイルは、新しい行に替わった後に消す（失敗は件数だけをログに出す）
    if (previous !== undefined) {
      await removeAvatarObjects(binary.bucket, [previous.object_key], { operation: meAvatarUpload.name, requestId });
    }
    return { avatar_url: avatarUrl(organization.slug, id) };
  },
);

// 今その人の行が指す画像の ID（行が無ければ undefined）
async function committedAvatarId(db: OrganizationDb, userId: string): Promise<string | undefined> {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('user_avatars')
        .select('id')
        .where('user_id', '=', userId)
        .where('organization_id', '=', db.organizationId),
    ),
  );
  return row?.id;
}

// 書けなかった原因を、例外の名前だけをログに出して投げ直す（メッセージはキーを含みうる）
function failure(reason: string, requestId: string, cause: unknown): Error {
  console.error(
    JSON.stringify({
      level: 'error',
      code: 'internal',
      requestId,
      reason,
      error: cause instanceof Error ? cause.name : typeof cause,
    }),
  );
  return new Error(reason, { cause });
}

export const meAvatarDeleteOperation = implement(meAvatarDelete, async ({ db, actor, tools, attachmentStorage }) => {
  const userId = actorUserIdOf(actor);
  const [deleted] = await db.batch([
    db.statement((q) =>
      q
        .deleteFrom('user_avatars')
        .where('user_id', '=', userId)
        .where('organization_id', '=', db.organizationId)
        .returning('object_key'),
    ),
  ]);
  // 消した行のキーだけを消す。画像が無くても成功する
  await removeAvatarObjects(
    attachmentStorage,
    (deleted?.rows ?? []).map((row) => row.object_key),
    { operation: meAvatarDelete.name },
  );
  // 外した後の自分のアバター（ログインの手段のアイコンか null）
  const avatars = await tools.avatarsOf([userId]);
  return { avatar_url: avatars.get(userId) ?? null };
});

export const userAvatarOperation = implement(userAvatar, async ({ db, input, download }) => {
  // 画像の ID で引く。同じ組織の行だけ（別の組織の ID と外した画像は、存在しないときと同じ 404）
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('user_avatars')
        .select(['user_id', 'id', 'object_key', 'content_type'])
        .where('id', '=', input.id)
        .where('organization_id', '=', db.organizationId),
    ),
  );
  if (row === undefined || row.object_key !== avatarObjectKey(db.organizationId, row.user_id, row.id)) {
    throw new ApiError(404, 'not_found');
  }
  // 種類は R2 のメタデータでなく、検証して保存した行の値を使う
  const headers = new Headers({ 'Content-Type': row.content_type });
  if (download.head) {
    const object = await download.bucket.head(row.object_key);
    if (object === null) throw new ApiError(404, 'not_found');
    headers.set('Content-Length', String(object.size));
    return new Response(null, { headers });
  }
  const object = await download.bucket.get(row.object_key);
  if (object === null) throw new ApiError(404, 'not_found');
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
});
