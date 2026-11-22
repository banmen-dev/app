// pnpm dev:open の引数の読み取りと、開く先の判定。通信とブラウザは scripts/dev-open.ts が受け持つ。
// 止める理由は例外でなく結果の reason で返す（scripts/ci.ts の ciOkVerdict と同じ形）
import { SEED_SESSIONS } from '../seed/sessions.ts';
import {
  isIsolatedPreviewSubdomain,
  LEGACY_PREVIEW_SUBDOMAIN,
  previewAlias,
  PREVIEW_ORIGIN_PATTERN,
} from '../src/shared/preview-cloudflare.ts';
import { resolvedReturnTo, safeReturnTo } from '../src/shared/return-to.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { devPorts, devPublicOrigin } from './dev-ports.ts';

export type SeedWho = keyof typeof SEED_SESSIONS;

export type DevOpenArgs = { preview: boolean; who: SeedWho; path: string; remoteOrigin?: string };

export type DevOpenTarget = DevOpenArgs & {
  origin: string;
  url: string;
  cookieName: string;
  token: string;
};

type Failure = { ok: false; reason: string };

export const DEFAULT_WHO: SeedWho = 'admin';
export const DEFAULT_PATH = '/';

// remote は本番と別のプレビューだけ。URL の正規化で別の表記になる値も断る。
export function isPreviewOrigin(origin: string, subdomain?: string): boolean {
  if (subdomain !== undefined && !isIsolatedPreviewSubdomain(subdomain)) return false;
  const match = PREVIEW_ORIGIN_PATTERN.exec(origin);
  return (
    !!match &&
    previewAlias(match[1]).length <= 63 &&
    match[2] === (subdomain ?? LEGACY_PREVIEW_SUBDOMAIN) &&
    new URL(origin).origin === origin
  );
}

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

function whoChoices(): string {
  return Object.entries(SEED_SESSIONS)
    .map(([key, session]) => `  ${key}: ${session.description}`)
    .join('\n');
}

function isSeedWho(value: string): value is SeedWho {
  return Object.hasOwn(SEED_SESSIONS, value);
}

// 位置でなく形で見分ける: `--preview` はフラグ、`/` で始まれば path、それ以外は who
export function parseDevOpenArgs(argv: readonly string[], subdomain?: string): ({ ok: true } & DevOpenArgs) | Failure {
  let preview = false;
  let remoteOrigin: string | undefined;
  let who: string | undefined;
  let path: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--preview') {
      preview = true;
    } else if (arg === '--origin') {
      if (remoteOrigin !== undefined) return { ok: false, reason: '--origin は1回だけ指定する' };
      const value = argv[++index];
      if (!value || !isPreviewOrigin(value, subdomain)) {
        return {
          ok: false,
          reason:
            '--origin はプレビュー専用の workers.dev の URL を指定する。別アカウントでは CLOUDFLARE_PREVIEW_SUBDOMAIN を設定する',
        };
      }
      remoteOrigin = value;
    } else if (arg.startsWith('--')) {
      return { ok: false, reason: `知らないフラグ ${arg} がある。使えるのは --preview と --origin だけ` };
    } else if (arg.startsWith('/')) {
      if (path !== undefined) return { ok: false, reason: `path が2つある（${path} と ${arg}）。1回に開くのは1つ` };
      path = arg;
    } else {
      if (who !== undefined) return { ok: false, reason: `who が2つある（${who} と ${arg}）。1回に開くのは1人` };
      who = arg;
    }
  }
  if (preview && remoteOrigin) return { ok: false, reason: '--preview と --origin は同時に指定できない' };
  const resolvedWho = who ?? DEFAULT_WHO;
  if (!isSeedWho(resolvedWho)) {
    return {
      ok: false,
      reason: `知らない who: ${resolvedWho}。選べるのは次のとおり（開く path は / で始める。完全な URL は受け付けない）\n${whoChoices()}`,
    };
  }
  return { ok: true, preview, who: resolvedWho, path: path ?? DEFAULT_PATH, ...(remoteOrigin ? { remoteOrigin } : {}) };
}

// 開く先を決める。ここを通った結果だけが、Cookie を置いて通信してよい先になる
export function resolveDevOpenTarget(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): ({ ok: true } & DevOpenTarget) | Failure {
  const args = parseDevOpenArgs(argv, env.CLOUDFLARE_PREVIEW_SUBDOMAIN);
  if (!args.ok) return args;
  const { preview, who, path, remoteOrigin } = args;
  if (remoteOrigin && (!env.CF_ACCESS_CLIENT_ID?.trim() || !env.CF_ACCESS_CLIENT_SECRET?.trim())) {
    return { ok: false, reason: 'プレビューには CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET の両方が必要' };
  }

  // ログイン後の戻り先と同じ基準。`/` への直しはしない
  if (safeReturnTo(path) !== path) {
    return {
      ok: false,
      reason: `path ${path} は開けない。自分のサイトのパスだけを受け付ける（//host、バックスラッシュ、ドット区間、最初の区間が api か login のパスは開けない）`,
    };
  }

  let origin: string;
  try {
    origin = remoteOrigin ?? devPublicOrigin(devPorts(env), preview);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // 二重の守り: 解決した結果が path と変わらず、ローカル指定が手元のサーバーのときだけ進む。
  // origin の検査は、devPublicOrigin が今は http の localhost しか返さないので通らないが、
  // dev-ports.ts の変更で別のホストを返すようになったときに、トークンを外へ送らないために残す
  const { protocol, hostname } = new URL(origin);
  if (!remoteOrigin && (protocol !== 'http:' || !LOCAL_HOSTNAMES.has(hostname))) {
    return { ok: false, reason: `${origin} は手元のサーバーではないので、seed のトークンを送らない` };
  }
  if (resolvedReturnTo(path, origin) !== path) {
    return { ok: false, reason: `path ${path} は ${origin} の中で別のパスになるので開けない` };
  }

  return {
    ok: true,
    preview,
    who,
    path,
    origin,
    url: `${origin}${path}`,
    cookieName: sessionCookieName(origin),
    token: SEED_SESSIONS[who].token,
    ...(remoteOrigin ? { remoteOrigin } : {}),
  };
}
