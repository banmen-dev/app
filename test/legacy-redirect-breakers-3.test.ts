// 旧 URL の転送用の Worker（src/legacy-redirect/worker.ts）を崩す手口の3周目。
// test/legacy-redirect.test.ts、test/legacy-redirect-breakers.test.ts、test/legacy-redirect-breakers-2.test.ts と重ならないものだけを置く。
// wrangler.legacy-redirect.jsonc の Workers の実行環境で動かす（vitest の project legacy-redirect と同じ設定）
import { exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

const LEGACY = 'https://scrum-guild.ucan-lab.workers.dev';
const TARGET_HOST = 'banmen.ucan-lab.workers.dev';

// 旧 URL に残るブラウザの Cookie と、URL に載りうる秘密に見立てた値（架空）
const SECRET = 'sentinel-secret-7f3a9c';
const OLD_COOKIE = `__Host-sg_session=${SECRET}`;

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${LEGACY}${path}`, { redirect: 'manual', ...init });
}

function headerEntries(res: Response): [string, string][] {
  return [...res.headers.entries()];
}

describe('崩し: 応答のヘッダーは Location のほかに転送先も受けた値も出さない', () => {
  // Issue #1421「転送先は固定」。転送先は Location だけで伝え、Set-Cookie で旧 URL の Cookie を書き換えたり、
  // 受けた Cookie やクエリを応答のヘッダーに映したりしない
  test('画面の 302 は Location のほかに転送先を載せたヘッダーも Set-Cookie も無い', async () => {
    const res = await get(`/invite?token=${SECRET}`, { headers: { cookie: OLD_COOKIE } });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toBeNull();
    for (const [name, value] of headerEntries(res)) {
      if (name === 'location') continue;
      expect(value, name).not.toContain(TARGET_HOST);
      expect(value, name).not.toContain(SECRET);
    }
  });

  test('410 の moved も Set-Cookie が無く、受けた Cookie とクエリをヘッダーにも本文にも映さない', async () => {
    const res = await get(`/api/auth/github/callback?code=${SECRET}&state=${SECRET}`, {
      headers: { cookie: OLD_COOKIE, authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(410);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
    for (const [name, value] of headerEntries(res)) expect(value, name).not.toContain(SECRET);
    expect(await res.text()).not.toContain(SECRET);
  });

  test('GET と HEAD 以外の 410 も、受けた本文を映さない', async () => {
    const res = await get('/somewhere', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: OLD_COOKIE },
      body: JSON.stringify({ password: SECRET }),
    });
    expect(res.status).toBe(410);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).not.toContain(SECRET);
  });
});

// done-check のレビュー（falsification-qa）: 302 に鮮度を付けると、301 を避けた前提（転送先を後で差し替える）が崩れる
describe('レビュー: 応答をキャッシュさせない', () => {
  test('302 と 410 は cache-control が no-store で、expires を付けない', async () => {
    for (const res of [
      await exports.default.fetch('https://scrum-guild.ucan-lab.workers.dev/aoba?x=1', { redirect: 'manual' }),
      await exports.default.fetch('https://scrum-guild.ucan-lab.workers.dev/api/health', { redirect: 'manual' }),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('expires')).toBeNull();
      await res.body?.cancel();
    }
  });
});
