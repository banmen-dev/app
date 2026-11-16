// 自分のプロフィール画像を上げる操作（me-avatar-upload。Issue #1265）。
// 完了条件: PNG、JPEG、WebP を上げると member-list と user-list の自分の avatar_url が user-avatar の URL（画像の ID を含む）になり、
// 同じ組織の人に画像を返す。SVG、GIF、画像でないバイト、512px を超える画像、APNG、動く WebP は 400、512KiB を超える本文は 413 の
// invalid_input で断り、行と R2 のファイルが残らない。差し替えると URL が変わり、前の URL は 404、前の R2 のファイルが消える。
// セッションが置いた前提: 入力に人の ID を持たず本人の行だけを触る、回数の上限は 10 分に 20 回、R2 のキーは
// <組織>/avatars/<人>/<画像の ID>、前のファイルの削除の失敗は件数だけをログに出す、UPSERT は無効でないことも条件にする。
// 組織の分離と権限の一覧の検査は test/operation-registry-production-*.test.ts が回す（test/operations/pointers.ts）
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { AVATAR_MAX_BYTES, AVATAR_MAX_PIXELS } from '../src/shared/operations/organization/me-avatar.ts';
import { meAvatarUpload } from '../src/shared/operations/organization/index.ts';
import { chunkedStream, recordingBucket } from './attachment-helpers.ts';
import {
  actl,
  apngImage,
  app1Exif,
  ascii,
  concatBytes,
  dqt,
  fctl,
  fdat,
  gifImage,
  jpegImage,
  pngChunk,
  pngImage,
  svgImage,
  VP8X_ALPHA,
  webpAnimated,
  webpExtended,
  webpLossless,
  webpLossy,
} from './avatar-images.ts';
import { bearerFor } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import {
  app,
  avatarIdOf,
  avatarObjectKeys,
  avatarRowOf,
  avatarRows,
  avatarUrlOf,
  captureLogs,
  disableUser,
  expectError,
  expectNotFound,
  getAvatar,
  meAvatarOf,
  memberListAvatars,
  newMember,
  objectBytes,
  setLoginAvatar,
  uploadAvatar,
  uploadedUrl,
  userListAvatars,
} from './me-avatar-helpers.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('定数', () => {
  test('本文は 512KiB、縦横は 512px まで', () => {
    expect(AVATAR_MAX_BYTES).toBe(524_288);
    expect(AVATAR_MAX_PIXELS).toBe(512);
  });
});

describe('上げると、行と R2 のファイルができ、URL は画像の ID を含む', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test.each([
    ['PNG', () => pngImage(128, 96), 'image/png'],
    [
      'IDAT の後にだけ acTL のある PNG（動く PNG にしない）',
      () => pngImage(64, 64, { afterIdat: [actl(2), fctl(1, 64, 64), fdat(2)] }),
      'image/png',
    ],
    ['JPEG（ベースライン）', () => jpegImage(320, 240), 'image/jpeg'],
    ['JPEG（プログレッシブ）', () => jpegImage(200, 200, { sofMarker: 0xc2 }), 'image/jpeg'],
    [
      'JPEG（携帯の写真のように SOF の前に大きな Exif）',
      () => jpegImage(512, 384, { beforeSof: [app1Exif(30_000), dqt()] }),
      'image/jpeg',
    ],
    ['WebP（VP8）', () => webpLossy(256, 256), 'image/webp'],
    ['WebP（VP8L）', () => webpLossless(300, 200), 'image/webp'],
    ['WebP（VP8X の静止画、透明あり）', () => webpExtended(400, 400, VP8X_ALPHA), 'image/webp'],
  ])('%s', async (_label, make, contentType) => {
    const person = await newMember(target);
    const file = make();
    const res = await uploadAvatar(target, person, file);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { avatar_url: string };
    expect(meAvatarUpload.output.safeParse(body).success).toBe(true);
    expect(Object.keys(body)).toEqual(['avatar_url']);
    const id = avatarIdOf(target, body.avatar_url);
    expect(body.avatar_url).toBe(avatarUrlOf(target, id));

    const row = await avatarRowOf(target, person);
    expect(row).toEqual({
      user_id: person.userId,
      id,
      organization_id: target.organization.id,
      // 組織の接頭辞の下に置くので、組織を消す手順で接頭辞ごと消える。キーの末尾は表の id と同じ値
      object_key: `${target.organization.id}/avatars/${person.userId}/${id}`,
      content_type: contentType,
      size_bytes: file.byteLength,
      created_at: expect.any(String),
    });
    expect(new Date(row!.created_at).toISOString()).toBe(row!.created_at);
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([row!.object_key]);
    expect(await objectBytes(row!.object_key)).toEqual(file);
  });

  test('種類は中身で決め、申告の Content-Type を読まない', async () => {
    const jpegAsPng = await newMember(target);
    await uploadedUrl(target, jpegAsPng, jpegImage(64, 64), { headers: { 'Content-Type': 'image/png' } });
    expect((await avatarRowOf(target, jpegAsPng))?.content_type).toBe('image/jpeg');

    const pngAsSvg = await newMember(target);
    await uploadedUrl(target, pngAsSvg, pngImage(64, 64), { headers: { 'Content-Type': 'image/svg+xml' } });
    expect((await avatarRowOf(target, pngAsSvg))?.content_type).toBe('image/png');
  });

  test('管理者、リーダー、ほかのワークスペースの人も、それぞれ自分の行を作る', async () => {
    const fresh = await createTarget();
    for (const person of [fresh.admin, fresh.leader, fresh.bystander]) {
      const url = await uploadedUrl(fresh, person);
      const row = await avatarRowOf(fresh, person);
      expect(row?.id).toBe(avatarIdOf(fresh, url));
    }
    expect((await avatarRows(fresh.organization.id)).map((row) => row.user_id).sort()).toEqual(
      [fresh.admin.userId, fresh.leader.userId, fresh.bystander.userId].sort(),
    );
  });

  test('別の組織の人の画像は、別の ID で、別の組織の接頭辞の下に置く', async () => {
    const other = await createTarget();
    const url = await uploadedUrl(target, await newMember(target));
    const otherUrl = await uploadedUrl(other, other.member);
    expect(avatarIdOf(target, url)).not.toBe(avatarIdOf(other, otherUrl));
    expect((await avatarRowOf(other, other.member))?.object_key.startsWith(`${other.organization.id}/avatars/`)).toBe(
      true,
    );
  });
});

describe('上げると、一覧と組織の枠の自分のアバターがその URL になり、同じ組織の人に画像を返す', () => {
  let target: Target;
  let url: string;
  const file = pngImage(200, 150);
  const leaderIcon = 'https://avatars.githubusercontent.com/u/7300001';
  const memberIcon = 'https://avatars.githubusercontent.com/u/7300002';

  beforeAll(async () => {
    target = await createTarget();
    await setLoginAvatar(target.leader, leaderIcon);
    await setLoginAvatar(target.member, memberIcon);
    url = await uploadedUrl(target, target.member, file);
  });

  test('member-list の自分の avatar_url は配る URL で、上げていない人はログインの手段のアイコンのまま', async () => {
    for (const viewer of [target.member, target.leader, target.admin]) {
      const avatars = await memberListAvatars(target, viewer);
      expect(avatars.get(target.member.userId!), '上げた人').toBe(url);
      expect(avatars.get(target.leader.userId!), '上げていない人').toBe(leaderIcon);
    }
  });

  test('user-list の avatar_url も同じ URL で、アイコンの無い人は null のまま', async () => {
    const avatars = await userListAvatars(target);
    expect(avatars.get(target.member.userId!)).toBe(url);
    expect(avatars.get(target.leader.userId!)).toBe(leaderIcon);
    expect(avatars.get(target.bystander.userId!)).toBeNull();
  });

  test('組織の枠（organization）の me.avatar_url も同じ規則（上げた人は URL、ほかはアイコンか null）', async () => {
    expect(await meAvatarOf(target, target.member)).toBe(url);
    expect(await meAvatarOf(target, target.leader)).toBe(leaderIcon);
    expect(await meAvatarOf(target, target.bystander)).toBeNull();
  });

  test('同じ組織の別の人（リーダー、管理者、ほかのワークスペースの人）が開くと、200 で同じバイトと保存した種類', async () => {
    for (const viewer of [target.leader, target.admin, target.bystander, target.member]) {
      const res = await getAvatar(url, viewer);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(file);
    }
  });

  test('配る応答は private, max-age=3600、nosniff、添付と同じ sandbox の CSP', async () => {
    const res = await getAvatar(url, target.leader);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
    await res.arrayBuffer();
  });
});

describe('断る種類と大きさ: 400 の invalid_input で、行も R2 のファイルも残らない', () => {
  // 断ることだけを試す組織。成功する呼び出しを混ぜないので、組織の接頭辞の下が空のままであることまで見る
  let target: Target;
  // 対照: どの呼び出しも同じ理由で断る実装（今の入れ物）で断る検査がたまたま通らないよう、正しい呼び出しが別の組織で 200 になることも見る
  let control: Target;
  beforeAll(async () => {
    [target, control] = await Promise.all([createTarget(), createTarget()]);
  });

  async function expectNothingWritten(person: Person): Promise<void> {
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarRows(target.organization.id)).toEqual([]);
    expect(await avatarObjectKeys(target.organization.id)).toEqual([]);
    const res = await uploadAvatar(control, await newMember(control));
    expect(res.status, '対照: 正しい呼び出しは 200').toBe(200);
  }

  test.each([
    ['SVG', svgImage()],
    ['PNG と偽った SVG（申告は image/png）', svgImage()],
    ['GIF', gifImage(32, 32)],
    ['画像でないバイト（文章）', ascii('ただの文章です')],
    ['HTML', ascii('<!DOCTYPE html><html><script>alert(1)</script></html>')],
    ['PNG の署名だけ', pngImage(10, 10).subarray(0, 8)],
    ['縦横を読めない JPEG', concatBytes(jpegImage(10, 10).subarray(0, 2), ascii('壊れた'))],
    ['幅が 513px の PNG', pngImage(513, 512)],
    ['高さが 513px の PNG', pngImage(1, 513)],
    ['幅が 513px の JPEG', jpegImage(513, 10)],
    ['高さが 513px の WebP（VP8L）', webpLossless(10, 513)],
    ['キャンバスが 513px の WebP（VP8X）', webpExtended(513, 513)],
    ['動く PNG（IDAT より前の acTL）', apngImage(64, 64)],
    ['動く WebP（VP8X のアニメーションの印）', webpAnimated(64, 64)],
  ])('%s', async (label, file) => {
    const person = await newMember(target);
    const headers = label.includes('申告') ? { 'Content-Type': 'image/png' } : undefined;
    const res = await uploadAvatar(target, person, file, headers === undefined ? {} : { headers });
    await expectError(res, 400, 'invalid_input');
    await expectNothingWritten(person);
  });

  test('空の本文は 400 の invalid_input', async () => {
    const person = await newMember(target);
    const res = await uploadAvatar(target, person, new Uint8Array(0));
    await expectError(res, 400, 'invalid_input');
    expect(await avatarRowOf(target, person)).toBeUndefined();
  });
});

describe('大きすぎる本文: 413 の invalid_input で、行も R2 のファイルも残らない', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  async function expectNothingWritten(person: Person): Promise<void> {
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([]);
  }

  test('512KiB+1 バイトの正しい PNG（Content-Length で申告）は 413', async () => {
    const person = await newMember(target);
    const file = pngImage(64, 64, { totalBytes: AVATAR_MAX_BYTES + 1 });
    const res = await uploadAvatar(target, person, file);
    await expectError(res, 413, 'invalid_input');
    await expectNothingWritten(person);
  });

  test('定義の上限で断り、添付の 50MB の上限まで本文を受け付けない（1MiB も 413）', async () => {
    const person = await newMember(target);
    const res = await uploadAvatar(target, person, pngImage(64, 64, { totalBytes: 1024 * 1024 }));
    await expectError(res, 413, 'invalid_input');
    await expectNothingWritten(person);
  });

  test('Content-Length を小さく偽って 512KiB を超える本文を流しても、成功せず何も残らない', async () => {
    const person = await newMember(target);
    const file = pngImage(64, 64, { totalBytes: AVATAR_MAX_BYTES + 4096 });
    const chunks = [file.subarray(0, 65_536), file.subarray(65_536, 300_000), file.subarray(300_000)];
    const res = await uploadAvatar(target, person, chunkedStream(chunks), { contentLength: '1000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await expectNothingWritten(person);
  });

  test('Content-Length が本文より長いと、成功せず何も残らない', async () => {
    const person = await newMember(target);
    const file = pngImage(64, 64);
    const res = await uploadAvatar(target, person, chunkedStream([file]), {
      contentLength: String(file.byteLength + 10),
    });
    expect(res.status).not.toBe(200);
    await expectNothingWritten(person);
  });
});

describe('境界: 512px ちょうどと 524288 バイトちょうどは通る', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test.each([
    ['PNG 512×512', () => pngImage(512, 512)],
    ['PNG 512×1', () => pngImage(512, 1)],
    ['PNG 1×512', () => pngImage(1, 512)],
    ['PNG 1×1', () => pngImage(1, 1)],
    ['JPEG 512×512', () => jpegImage(512, 512)],
    ['WebP（VP8）512×512', () => webpLossy(512, 512)],
    ['WebP（VP8L）512×512', () => webpLossless(512, 512)],
    ['WebP（VP8X）512×512', () => webpExtended(512, 512)],
  ])('%s', async (_label, make) => {
    const person = await newMember(target);
    await uploadedUrl(target, person, make());
    expect(await avatarRowOf(target, person)).toBeDefined();
  });

  test('ちょうど 524288 バイトの 512×512 の PNG は通り、size_bytes は 524288', async () => {
    const person = await newMember(target);
    const file = pngImage(512, 512, { totalBytes: AVATAR_MAX_BYTES });
    expect(file.byteLength).toBe(524_288);
    const url = await uploadedUrl(target, person, file);
    const row = await avatarRowOf(target, person);
    expect(row?.size_bytes).toBe(524_288);
    expect(await objectBytes(row!.object_key)).toEqual(file);
    const res = await getAvatar(url, target.leader);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(524_288);
  });
});

describe('差し替え: URL が変わり、前の URL は 404、前の R2 のファイルが消える', () => {
  let target: Target;
  beforeAll(async () => {
    target = await createTarget();
  });

  test('2回目に上げると、ID とキーが新しくなり、行は1つのまま', async () => {
    const person = await newMember(target);
    const first = pngImage(64, 64);
    const second = jpegImage(128, 128);
    const firstUrl = await uploadedUrl(target, person, first);
    const firstRow = await avatarRowOf(target, person);
    const secondUrl = await uploadedUrl(target, person, second);
    expect(secondUrl).not.toBe(firstUrl);
    expect(avatarIdOf(target, secondUrl)).not.toBe(avatarIdOf(target, firstUrl));

    const rows = (await avatarRows(target.organization.id)).filter((row) => row.user_id === person.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: avatarIdOf(target, secondUrl),
      content_type: 'image/jpeg',
      size_bytes: second.byteLength,
    });
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([rows[0]!.object_key]);
    expect(await objectBytes(firstRow!.object_key)).toBeUndefined();

    await expectNotFound(await getAvatar(firstUrl, target.leader));
    const res = await getAvatar(secondUrl, target.leader);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(second);
    expect((await memberListAvatars(target, target.leader)).get(person.userId!)).toBe(secondUrl);
  });

  test('同じバイトを上げ直しても URL は変わる', async () => {
    const person = await newMember(target);
    const file = pngImage(32, 32);
    const firstUrl = await uploadedUrl(target, person, file);
    const secondUrl = await uploadedUrl(target, person, file);
    expect(secondUrl).not.toBe(firstUrl);
    await expectNotFound(await getAvatar(firstUrl, target.leader));
  });

  test('断った差し替えは前の画像を残す（行、R2、URL）', async () => {
    const person = await newMember(target);
    const url = await uploadedUrl(target, person);
    const before = await avatarRowOf(target, person);
    await expectError(await uploadAvatar(target, person, svgImage()), 400, 'invalid_input');
    await expectError(await uploadAvatar(target, person, apngImage(16, 16)), 400, 'invalid_input');
    await expectError(
      await uploadAvatar(target, person, pngImage(16, 16, { totalBytes: AVATAR_MAX_BYTES + 1 })),
      413,
      'invalid_input',
    );
    expect(await avatarRowOf(target, person)).toEqual(before);
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([before!.object_key]);
    expect((await getAvatar(url, target.leader)).status).toBe(200);
  });

  test('前の R2 のファイルを消せなくても成功し、ログには件数だけを出す（キーも例外の文も出さない）', async () => {
    const person = await newMember(target);
    await uploadedUrl(target, person);
    const previous = (await avatarRowOf(target, person))!;
    const { env: failing } = recordingBucket({
      delete: async () => {
        throw new Error(`R2 の削除に失敗した ${previous.object_key}`);
      },
    });
    const logs = captureLogs();
    const url = await uploadedUrl(target, person, pngImage(48, 48), {
      env: failing,
      headers: { 'cf-ray': 'avatar-ray-0001' },
    });
    const row = await avatarRowOf(target, person);
    expect(row?.id).toBe(avatarIdOf(target, url));
    // 消せなかった前のファイルは、どの行からも指されずに残る（組織を消す手順で接頭辞ごと消える）
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual(
      [previous.object_key, row!.object_key].sort(),
    );
    const counted = logs
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((entry) => entry.count === 1);
    expect(counted, '件数のログ').toHaveLength(1);
    expect(counted[0]).toMatchObject({ requestId: 'avatar-ray-0001' });
    for (const line of logs) {
      expect(line).not.toContain('/avatars/');
      expect(line).not.toContain('R2 の削除に失敗した');
    }
    await env.ATTACHMENTS.delete(previous.object_key);
  });
});

describe('本人だけ: 入力に人の ID を持たず、呼んだ人の行だけを触る', () => {
  test('入力に別の人の user_id を入れても、その人の行は作らず変えない', async () => {
    const target = await createTarget();
    const otherUrl = await uploadedUrl(target, target.leader);
    const otherRow = await avatarRowOf(target, target.leader);
    const res = await uploadAvatar(target, target.member, pngImage(20, 20), {
      input: { user_id: target.leader.userId },
    });
    expect([200, 400]).toContain(res.status);
    expect(await avatarRowOf(target, target.leader)).toEqual(otherRow);
    expect((await memberListAvatars(target, target.admin)).get(target.leader.userId!)).toBe(otherUrl);
    if (res.status === 200) {
      const { avatar_url } = (await res.json()) as { avatar_url: string };
      expect((await avatarRowOf(target, target.member))?.id).toBe(avatarIdOf(target, avatar_url));
    }
  });

  test('2人が上げると、それぞれの行とファイルになり、片方の差し替えは他方に触れない', async () => {
    const target = await createTarget();
    const leaderUrl = await uploadedUrl(target, target.leader, pngImage(30, 30));
    await uploadedUrl(target, target.member, pngImage(40, 40));
    await uploadedUrl(target, target.member, webpLossy(50, 50));
    expect((await getAvatar(leaderUrl, target.member)).status).toBe(200);
    expect(await avatarObjectKeys(target.organization.id, target.leader.userId)).toHaveLength(1);
    expect(await avatarObjectKeys(target.organization.id, target.member.userId)).toHaveLength(1);
  });
});

describe('回数の上限: 10 分に 20 回', () => {
  test('同じ人の 21 回目は 429 の rate_limited で、行も R2 も変えない。ほかの人は上げられる', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    let last = '';
    for (let i = 0; i < 20; i++) {
      last = await uploadedUrl(target, person, pngImage(10 + i, 10));
    }
    const before = await avatarRowOf(target, person);
    expect(before?.id).toBe(avatarIdOf(target, last));
    const keys = await avatarObjectKeys(target.organization.id, person.userId);

    await expectError(await uploadAvatar(target, person, pngImage(99, 99)), 429, 'rate_limited');
    expect(await avatarRowOf(target, person)).toEqual(before);
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual(keys);
    expect((await getAvatar(last, target.leader)).status).toBe(200);

    await uploadedUrl(target, await newMember(target));
  });
});

describe('並行', () => {
  test('同じ人が2回並べて上げても、行は1つで、指されない R2 のファイルは多くても負けた側の1つ', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const files = [pngImage(60, 60), jpegImage(70, 70)];
    const responses = await Promise.all(files.map((file) => uploadAvatar(target, person, file)));
    const statuses = responses.map((res) => res.status);
    for (const status of statuses) expect([200, 409]).toContain(status);
    expect(statuses).toContain(200);
    const ids: string[] = [];
    for (const res of responses) {
      if (res.status === 200) ids.push(avatarIdOf(target, ((await res.json()) as { avatar_url: string }).avatar_url));
      else expect(((await res.json()) as { error: { code: string } }).error.code).toBe('conflict');
    }
    const rows = (await avatarRows(target.organization.id)).filter((row) => row.user_id === person.userId);
    expect(rows).toHaveLength(1);
    expect(ids).toContain(rows[0]!.id);
    const keys = await avatarObjectKeys(target.organization.id, person.userId);
    expect(keys).toContain(rows[0]!.object_key);
    expect(keys.length).toBeLessThanOrEqual(2);
    expect((await getAvatar(avatarUrlOf(target, rows[0]!.id), target.leader)).status).toBe(200);
  });

  test('R2 に書いている間に同じ人の別の差し替えが済んでも、行は1つで、残るファイルは行が指すものだけ', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    await uploadedUrl(target, person, pngImage(20, 20));
    let interleaved: Response | undefined;
    const { env: racing } = recordingBucket({
      put: async (...args: unknown[]) => {
        // 先の呼び出しが R2 に書く直前に、別の差し替えを最後まで進める
        interleaved ??= await uploadAvatar(target, person, webpLossy(30, 30));
        return (env.ATTACHMENTS.put as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    });
    const res = await uploadAvatar(target, person, jpegImage(40, 40), { env: racing });
    expect(interleaved?.status, '割り込ませた差し替え').toBe(200);
    expect([200, 409]).toContain(res.status);
    if (res.status === 409) expect(((await res.json()) as { error: { code: string } }).error.code).toBe('conflict');
    const rows = (await avatarRows(target.organization.id)).filter((row) => row.user_id === person.userId);
    expect(rows).toHaveLength(1);
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([rows[0]!.object_key]);
  });

  test('R2 に書いている間に管理者がその人を無効にすると、行は戻らず、書いたファイルも残らない', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    let disabled: Response | undefined;
    const { env: racing } = recordingBucket({
      put: async (...args: unknown[]) => {
        disabled ??= await disableUser(target, person.userId!);
        return (env.ATTACHMENTS.put as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    });
    const res = await uploadAvatar(target, person, pngImage(40, 40), { env: racing });
    expect(disabled?.status, '割り込ませた無効化').toBe(200);
    expect(res.status).not.toBe(200);
    expect(await avatarRowOf(target, person)).toBeUndefined();
    expect(await avatarObjectKeys(target.organization.id, person.userId)).toEqual([]);
    expect((await userListAvatars(target)).get(person.userId!)).toBeNull();
  });
});

describe('ログ', () => {
  test('上げて、開いて、差し替える間のログに、R2 のキーと本文を出さない', async () => {
    const target = await createTarget();
    const person = await newMember(target);
    const logs = captureLogs();
    // 画像の中（tEXt）に入れた架空の印。ログに本文を出せば見つかる
    const marker = 'fictional-body-marker-7f3a';
    const file = pngImage(16, 16, { beforeIdat: [pngChunk('tEXt', ascii(`Comment\0${marker}`))] });
    const url = await uploadedUrl(target, person, file);
    await getAvatar(url, target.leader).then((res) => res.arrayBuffer());
    await uploadedUrl(target, person, pngImage(17, 17));
    const row = await avatarRowOf(target, person);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain('/avatars/');
      expect(line).not.toContain(row!.object_key);
      expect(line).not.toContain(marker);
    }
  });
});

describe('API トークン', () => {
  test('本文がバイナリの操作なので、書き込みのトークンでは 403 で、何も書かない', async () => {
    const target = await createTarget();
    const res = await post(app, meAvatarUpload, {
      slug: target.slug,
      bearer: await bearerFor(target.member, 'write'),
      origin: null,
      body: {},
      file: pngImage(8, 8),
      env: testEnv,
    });
    expect(res.status).toBe(403);
    expect(await avatarRowOf(target, target.member)).toBeUndefined();
  });
});
