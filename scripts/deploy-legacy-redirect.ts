// 旧 URL に転送用の Worker を置く（docs/operations.md の「旧 URL の転送」）。人が手元で node scripts/deploy-legacy-redirect.ts と打つ。

// 転送用の Worker を置く旧 URL。本番の Worker が名前を変えて空けた後にだけ置く
export const LEGACY_ORIGIN = 'https://scrum-guild.ucan-lab.workers.dev';

export type LegacyRedirectDeps = {
  // GET して、状態、Location、JSON の本文（読めなければ null）を返す。リダイレクトは辿らない。届かなければ投げる
  request: (url: string, timeoutMs: number) => Promise<{ status: number; location: string | null; body: unknown }>;
  // wrangler を引数で動かし、終了コードを返す
  wrangler: (args: string[]) => { status: number };
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  error: (message: string) => void;
};

// 終了コードを返す。0 は置いて確かめた、ほかは止まったか確かめられなかった
export async function deployLegacyRedirect(_deps: LegacyRedirectDeps): Promise<number> {
  throw new Error('未実装');
}
