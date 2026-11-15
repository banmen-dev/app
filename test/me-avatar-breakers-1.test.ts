// プロフィール画像（Issue #1265）を崩す側から確かめるテスト。既存のテスト（me-avatar-upload、me-avatar-delete、user-avatar、
// avatar-image、me-avatar-extra、me-avatar-definition、user-avatar-purge）と重ならない手口だけを置く。
// - 本文の奥（数百 KB 先）にある acTL と SOF、ストリームの複数の塊に分かれた本文（「全部読んでから判定する」の前提）
// - 幅か高さの片方だけが 513px の WebP（VP8、VP8X）、拡大の指定のビットを立てた 512px の VP8、ヘッダーの切れた PNG と WebP
// - 失敗の道（R2 の put、D1 の batch、409 の後の削除、配る応答の R2 の get）で前の画像が残り、ログにキーも例外の文も出ないこと
// - 配る応答の HEAD の 404 と Range の付いた GET のキャッシュ
// - 並んだ外す操作、同じアカウントの別の組織、束縛の上限を超える人数の user-list、ワークスペースに所属しない管理者
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { AVATAR_MAX_BYTES } from '../src/shared/operations/organization/me-avatar.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { chunkedStream, recordingBucket } from './attachment-helpers.ts';
import {
  PNG_SIGNATURE,
  actl,
  app1Exif,
  concatBytes,
  dqt,
  fctl,
  fdat,
  ihdr,
  jpegImage,
  pngImage,
  riffChunk,
  textChunk,
  vp8Frame,
  webpAnimated,
  webpExtended,
  webpFile,
  webpLossy,
} from './avatar-images.ts';
import { createMembership, createUser } from './factories.ts';
import {
  app,
  avatarIdOf,
  avatarObjectKeys,
  avatarRowOf,
  avatarRows,
  avatarUrlOf,
  captureLogs,
  deleteAvatar,
  disableUser,
  expectError,
  expectNotFound,
  getAvatar,
  meAvatarOf,
  memberListAvatars,
  newMember,
  objectBytes,
  setLoginAvatar,
  storeAvatar,
  uploadAvatar,
  uploadedUrl,
  userListAvatars,
} from './me-avatar-helpers.ts';
import { createPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// バイトを決まった数の塊に分けて流す（Content-Length は全体の長さで申告する）
function inPieces(bytes: Uint8Array, pieces: number): { stream: ReadableStream<Uint8Array>; length: string } {
  const size = Math.ceil(bytes.byteLength / pieces);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += size) chunks.push(bytes.subarray(at, at + size));
  return { stream: chunkedStream(chunks), length: String(bytes.byteLength) };
}

function parsedLogs(lines: readonly string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function expectNoSecrets(lines: readonly string[], secrets: readonly string[]): void {
  for (const line of lines) {
    expect(line).not.toContain('/avatars/');
    for (const secret of secrets) expect(line).not.toContain(secret);
  }
}

describe('本文の奥にある印も読む（512KiB までの本文を全部読んでから判定する）', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  async function expectRejectedAndEmpty(person: Person, res: Response): Promise<void> {
    await expectError(res, 400, 'invalid_input');
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([]);
  }

  test('500KB の tEXt の後ろ（IDAT の直前）にある acTL を、8 つの塊に分けて流しても動く PNG として断る', async () => {
    const person = await newMember(target);
    const file = pngImage(64, 64, {
      beforeIdat: [textChunk(500_000), actl(2), fctl(0, 64, 64)],
      afterIdat: [fctl(1, 64, 64), fdat(2)],
    });
    expect(file.byteLength).toBeLessThanOrEqual(AVATAR_MAX_BYTES);
    const { stream, length } = inPieces(file, 8);
    await expectRejectedAndEmpty(person, await uploadAvatar(target, person, stream, { contentLength: length }));
  });

  test('ちょうど 524288 バイトで、acTL が最後の塊にある動く PNG も断る', async () => {
    const person = await newMember(target);
    const tail = [actl(2), fctl(0, 64, 64)];
    const base = pngImage(64, 64, { beforeIdat: tail }).byteLength;
    const file = pngImage(64, 64, { beforeIdat: [textChunk(AVATAR_MAX_BYTES - base - 12), ...tail] });
    expect(file.byteLength).toBe(AVATAR_MAX_BYTES);
    const { stream, length } = inPieces(file, 5);
    await expectRejectedAndEmpty(person, await uploadAvatar(target, person, stream, { contentLength: length }));
  });

  test('IDAT より前に fcTL だけがあり acTL が IDAT の後ろの PNG は、静止画として通る', async () => {
    const person = await newMember(target);
    const file = pngImage(48, 48, { beforeIdat: [fctl(0, 48, 48)], afterIdat: [actl(2), fctl(1, 48, 48), fdat(2)] });
    await uploadedUrl(target, person, file);
    expect((await avatarRowOf(target, person))?.content_type).toBe('image/png');
  });

  test('7 つの大きな APP1 の後ろ（約 455KB 先）の SOF0 を、塊に分けて流しても読む（512px は通り、513px は断る）', async () => {
    const segments = Array.from({ length: 7 }, () => app1Exif(65_000));
    const ok = jpegImage(512, 300, { beforeSof: [...segments, dqt()] });
    const tooWide = jpegImage(513, 300, { beforeSof: [...segments, dqt()] });
    expect(ok.byteLength).toBeGreaterThan(450_000);
    expect(tooWide.byteLength).toBeLessThanOrEqual(AVATAR_MAX_BYTES);

    const accepted = await newMember(target);
    const first = inPieces(ok, 6);
    const res = await uploadAvatar(target, accepted, first.stream, { contentLength: first.length });
    expect(res.status).toBe(200);
    const row = await avatarRowOf(target, accepted);
    expect(row).toMatchObject({ content_type: 'image/jpeg', size_bytes: ok.byteLength });
    expect(await objectBytes(row!.object_key)).toEqual(ok);

    const rejected = await newMember(target);
    const second = inPieces(tooWide, 6);
    await expectRejectedAndEmpty(
      rejected,
      await uploadAvatar(target, rejected, second.stream, { contentLength: second.length }),
    );
  });

  test('ちょうど 524288 バイトの動く WebP（VP8X の印）は、大きさでなく動くことで 400', async () => {
    const person = await newMember(target);
    const animated = webpAnimated(64, 64);
    // 後ろに未知のチャンクを足して全体を 524288 バイトにする（RIFF の長さの欄も合わせる）。
    // RIFF(4) 長さ(4) WEBP(4) の後ろのチャンクを取り出し、webpFile で組み直す
    const pad = AVATAR_MAX_BYTES - animated.byteLength - 8;
    const rebuilt = webpFile(animated.subarray(12), riffChunk('XPAD', new Uint8Array(pad)));
    expect(rebuilt.byteLength).toBe(AVATAR_MAX_BYTES);
    await expectRejectedAndEmpty(person, await uploadAvatar(target, person, rebuilt));
  });
});

describe('Content-Length の欠落と形の誤り（docs/development.md の「本文の種類」: 無い、10進の整数でないなら 400）', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test.each([
    ['申告の無い（chunked の）正しい小さな PNG', () => chunkedStream([pngImage(20, 20)]), null],
    [
      '申告の無い（chunked の）512KiB を超える本文',
      () => chunkedStream([pngImage(20, 20, { totalBytes: AVATAR_MAX_BYTES + 2048 })]),
      null,
    ],
    ['指数の形の申告（1e3）', () => chunkedStream([pngImage(20, 20)]), '1e3'],
    ['負の申告', () => chunkedStream([pngImage(20, 20)]), '-1'],
  ])('%s は 400 の invalid_input で、何も残らない', async (_label, make, contentLength) => {
    const person = await newMember(target);
    const res = await uploadAvatar(target, person, make(), { contentLength });
    await expectError(res, 400, 'invalid_input');
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([]);
  });
});

describe('縦横の片方だけが上限を超える WebP と、境界の VP8', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test.each([
    ['VP8（非可逆）の幅だけ 513px', () => webpLossy(513, 512)],
    ['VP8（非可逆）の高さだけ 513px', () => webpLossy(1, 513)],
    ['VP8X の幅だけ 513px', () => webpExtended(513, 1)],
    ['VP8X の高さだけ 513px', () => webpExtended(512, 513)],
    ['JPEG（プログレッシブ）の高さだけ 513px', () => jpegImage(512, 513, { sofMarker: 0xc2 })],
  ])('%s は 400 で、何も残らない', async (_label, make) => {
    const person = await newMember(target);
    await expectError(await uploadAvatar(target, person, make()), 400, 'invalid_input');
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([]);
  });

  test('VP8 の拡大の指定のビットを立てた 512×512（16 ビットの値は 512 を超える）は通る', async () => {
    const person = await newMember(target);
    const file = webpFile(riffChunk('VP8 ', vp8Frame(512, 512, 3)));
    await uploadedUrl(target, person, file);
    expect((await avatarRowOf(target, person))?.content_type).toBe('image/webp');
  });

  test('JPEG の SOF1（拡張）の 512×512 は通る', async () => {
    const person = await newMember(target);
    await uploadedUrl(target, person, jpegImage(512, 512, { sofMarker: 0xc1 }));
    expect((await avatarRowOf(target, person))?.content_type).toBe('image/jpeg');
  });

  test.each([
    ['IHDR と acTL の後で切れた PNG（IDAT が無い）', () => concatBytes(PNG_SIGNATURE, ihdr(10, 10), actl(2))],
    ['VP8X のチャンクの長さがファイルの終わりを越える WebP', () => webpExtended(64, 64).subarray(0, 25)],
    ['VP8 のフレームが縦横の手前で切れた WebP', () => webpFile(riffChunk('VP8 ', vp8Frame(64, 64))).subarray(0, 28)],
  ])('%s は 400 で、前の画像が残る', async (_label, make) => {
    const person = await newMember(target);
    const url = await uploadedUrl(target, person);
    const before = await avatarRowOf(target, person);
    await expectError(await uploadAvatar(target, person, make()), 400, 'invalid_input');
    expect(await avatarRowOf(target, person)).toEqual(before);
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([before!.object_key]);
    expect((await getAvatar(url, target.leader)).status).toBe(200);
  });
});

describe('失敗の道: 前の画像が残り、ログにキーも例外の文も出ない', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test('R2 の put が書いた後に失敗すると 500 で、書いたファイルは消え、前の行、ファイル、URL は残る', async () => {
    const person = await newMember(target);
    const url = await uploadedUrl(target, person);
    const before = (await avatarRowOf(target, person))!;
    const marker = 'fictional-r2-put-failure-91c2';
    const { env: failing } = recordingBucket({
      put: async (...args: unknown[]) => {
        await (env.ATTACHMENTS.put as (...a: unknown[]) => Promise<unknown>)(...args);
        throw new Error(`${marker} ${String(args[0])}`);
      },
    });
    const logs = captureLogs();
    const res = await uploadAvatar(target, person, pngImage(40, 40), { env: failing });
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).not.toContain('max-age');
    expect(await avatarRowOf(target, person)).toEqual(before);
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([before.object_key]);
    expect((await getAvatar(url, target.leader)).status).toBe(200);
    expectNoSecrets(logs, [marker]);
  });

  test('D1 の batch が失敗すると 500 で、R2 に書いた新しいファイルは消え、前の画像が残る', async () => {
    const person = await newMember(target);
    const url = await uploadedUrl(target, person);
    const before = (await avatarRowOf(target, person))!;
    const marker = 'fictional-d1-failure-5be0';
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "user_avatars"'))) throw new Error(marker);
      },
    });
    const logs = captureLogs();
    const res = await uploadAvatar(target, person, jpegImage(40, 40), { env: failing });
    expect(res.status).toBe(500);
    expect(await avatarRowOf(target, person)).toEqual(before);
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([before.object_key]);
    expect((await getAvatar(url, target.leader)).status).toBe(200);
    expectNoSecrets(logs, [marker]);
  });

  test('409 で負けた側のファイルを消せなかったときも、ログは件数だけ（キーも例外の文も出さない）', async () => {
    const person = await newMember(target);
    await uploadedUrl(target, person);
    const marker = 'fictional-r2-delete-failure-0d4e';
    let interleaved: Response | undefined;
    const { env: noDelete } = recordingBucket({
      delete: async (...args: unknown[]) => {
        throw new Error(`${marker} ${String(args[0])}`);
      },
    });
    // 前の行を読んだ直後に、同じ人の別の差し替えを最後まで進める
    const racing = envWithD1Hooks(noDelete, {
      afterQuery: async (sql) => {
        if (interleaved !== undefined || !sql.startsWith('select "object_key" from "user_avatars"')) return;
        interleaved = await uploadAvatar(target, person, webpLossy(30, 30));
      },
    });
    const logs = captureLogs();
    const res = await uploadAvatar(target, person, pngImage(33, 33), { env: racing, headers: { 'cf-ray': 'ray-409' } });
    expect(interleaved?.status, '割り込ませた差し替え').toBe(200);
    await expectError(res, 409, 'conflict');
    const row = (await avatarRowOf(target, person))!;
    const keys = await avatarObjectKeys(target.organization.id, person.userId);
    expect(keys).toContain(row.object_key);
    expect(keys, '残るのは行のファイルと、消せなかった負けた側の1つ').toHaveLength(2);
    const counted = parsedLogs(logs).filter((entry) => entry.count === 1);
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ requestId: 'ray-409' });
    expectNoSecrets(logs, [marker]);
    await env.ATTACHMENTS.delete(keys.filter((key) => key !== row.object_key));
  });

  test('配る応答で R2 の get が失敗すると 500 で、キャッシュに残さず（private, no-store）、ログにキーを出さない', async () => {
    const person = await newMember(target);
    const url = await uploadedUrl(target, person);
    const marker = 'fictional-r2-get-failure-77aa';
    const { env: failing } = recordingBucket({
      get: async (...args: unknown[]) => {
        throw new Error(`${marker} ${String(args[0])}`);
      },
    });
    const logs = captureLogs();
    const res = await getAvatar(url, target.leader, { env: failing });
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expectNoSecrets(logs, [marker, avatarIdOf(target, url)]);
  });
});

describe('配る応答のキャッシュ: HEAD の 404 と Range の付いた GET', () => {
  test('外した画像の URL を HEAD で開くと 404 で、private, no-store', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const url = await uploadedUrl(target, person);
    expect((await deleteAvatar(target, person)).status).toBe(200);
    const res = await app.request(
      url,
      { method: 'HEAD', headers: { Cookie: `${sessionCookieName(testEnv.PUBLIC_ORIGIN)}=${target.leader.token}` } },
      testEnv,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  test('Range を付けた GET は、200 なら全体のバイトと private, max-age=3600、206 なら private, no-store', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const file = pngImage(70, 70);
    const url = await uploadedUrl(target, person, file);
    const res = await getAvatar(url, target.leader, { headers: { Range: 'bytes=0-9' } });
    expect([200, 206]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(file);
    } else {
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      await res.arrayBuffer();
    }
  });
});

describe('並び: 上げる操作が前の行を読んだ後に、本人が外す', () => {
  test('どちらが勝っても、行は多くても1つで、R2 に残るのは行が指すファイルだけ', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const firstUrl = await uploadedUrl(target, person);
    let removed: Response | undefined;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (removed !== undefined || !sql.startsWith('select "object_key" from "user_avatars"')) return;
        removed = await deleteAvatar(target, person);
      },
    });
    const res = await uploadAvatar(target, person, jpegImage(50, 50), { env: racing });
    expect(removed?.status, '割り込ませた外す操作').toBe(200);
    expect([200, 409]).toContain(res.status);
    const rows = (await avatarRows(target.organization.id)).filter((row) => row.user_id === person.userId);
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual(rows.map((row) => row.object_key));
    await expectNotFound(await getAvatar(firstUrl, target.leader));
  });
});

describe('同じアカウントの別の組織', () => {
  test('組織 A で上げても、組織 B の me、member-list、user-list はログインの手段のアイコンのまま。A で無効にしても B の画像は残る', async () => {
    const a = await createTarget();
    const b = await createTarget();
    const icon = 'https://avatars.githubusercontent.com/u/7300099';
    const inA = await newMember(a);
    await setLoginAvatar(inA, icon);
    const userInB = await createUser(b.organization, {
      account_id: inA.accountId,
      login_provider: inA.login.provider,
      login_subject: inA.login.subject,
    });
    await createMembership(b.organization, b.workspace.id, userInB.id, { role: 'member' });
    const inB: Person = { ...inA, userId: userInB.id };

    const urlA = await uploadedUrl(a, inA);
    expect(await meAvatarOf(b, inB)).toBe(icon);
    expect((await memberListAvatars(b, inB)).get(userInB.id)).toBe(icon);
    expect((await userListAvatars(b)).get(userInB.id)).toBe(icon);
    // A の画像の ID を B の slug で開いても 404
    await expectNotFound(await getAvatar(avatarUrlOf(b, avatarIdOf(a, urlA)), inB));

    const urlB = await uploadedUrl(b, inB, pngImage(22, 22));
    expect(avatarIdOf(b, urlB)).not.toBe(avatarIdOf(a, urlA));
    expect((await disableUser(a, inA.userId!)).status).toBe(200);
    await expectNotFound(await getAvatar(urlA, a.leader));
    expect((await getAvatar(urlB, b.leader)).status).toBe(200);
    expect(await avatarObjectKeys(b.organization.id, userInB.id)).toHaveLength(1);
    expect(await meAvatarOf(b, inB)).toBe(urlB);
  });
});

describe('一覧の人数が束縛の上限を超える', () => {
  test('user-list の 150 人のうち、後ろの区切りにいる人の上げた画像も配る URL になる', async () => {
    const target = await createTarget();
    const users = [];
    for (let i = 0; i < 147; i++) users.push(await createUser(target.organization));
    const stored = new Map<string, string>();
    for (const user of users.filter((_, index) => index % 7 === 0 || index >= 140)) {
      const row = await storeAvatar(target.organization, user.id, { r2: false });
      stored.set(user.id, avatarUrlOf(target, row.id));
    }
    const avatars = await userListAvatars(target);
    expect(avatars.size).toBeGreaterThanOrEqual(150);
    for (const user of users) {
      expect(avatars.get(user.id), user.id).toBe(stored.get(user.id) ?? null);
    }
  });
});

describe('ワークスペースに所属しない管理者', () => {
  test('上げられ、user-list と組織の枠の me がその URL になり、同じ組織の人が開ける', async () => {
    const target = await createTarget();
    const admin = await createPerson({ organization: target.organization, admin: true });
    const url = await uploadedUrl(target, admin, webpExtended(100, 100));
    expect((await userListAvatars(target)).get(admin.userId!)).toBe(url);
    expect(await meAvatarOf(target, admin)).toBe(url);
    const res = await getAvatar(url, target.member);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    await res.arrayBuffer();
  });
});
