// フィードバックを GitHub App として banmen-dev/app に Issue で立てる層（Issue #1552。docs/requirements.md の「フィードバック」、
// docs/operations.md の「フィードバックの GitHub App」）。
// App の秘密鍵で JWT（RS256、WebCrypto）を作り、インストールのトークンに替え、期限の少し前まで使い回す。
// 利用者の文はフェンスのコードブロックに囲い、@ の通知、リンク、画像、HTML、Issue の参照を効かせない。
// ログとエラーの message には HTTP の状態コードと例外の名前だけを入れ、文、トークン、JWT、鍵、応答の本文を入れない。
// 通信先は固定の URL にし、設定から読まない。秘密鍵と公開の Issue の本文を扱うので、人が差分を読む領域
// （docs/development.md の「マージの判定」）。
// 秘密の形の文を断る入力の検証は、この層ではなく操作（#1553）が行う。

const API_ORIGIN = 'https://api.github.com';
// 起票先は固定（docs/requirements.md の「フィードバック」）。トークンも、この1つのリポジトリに絞って取る
const REPOSITORY_OWNER = 'banmen-dev';
const REPOSITORY_NAME = 'app';
const ISSUES_URL = `${API_ORIGIN}/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues`;
const LABEL = 'feedback';
const REQUEST_TIMEOUT_MS = 10_000;
// GitHub の API は User-Agent を要る
const USER_AGENT = 'banmen';
const API_VERSION = '2022-11-28';
// JWT の iat は時計のずれに備えて 60 秒前にし、exp は iat から 10 分（GitHub の上限）
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 600;
// トークンは期限の5分前までを使い回す
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const DECIMAL_ID_PATTERN = /^[0-9]+$/;
const PEM_PATTERN = /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/;
// PEM の本文（空白を除いたもの）は base64 の文字だけ
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
// route ID に載せてよい文字: 空白と制御文字を除く ASCII の印字文字から、インラインのコードを閉じるバッククォート（U+0060）を除く
const ROUTE_ID_PATTERN = /^[\u0021-\u005F\u0061-\u007E]+$/;
// フィードバックの ID はサーバーが作る UUIDv7。形が違えば、本文の囲いの外に載せずに断る
const FEEDBACK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 閲覧の口の URL に使ってよい文字（Markdown の地の文でリンクの外に出る括弧、山括弧、空白、バッククォートを含まない）
const VIEWER_URL_PATTERN = /^https:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9._~/-]*$/;
// 画面に出ない文字（Unicode の Default_Ignorable_Code_Point）。異体字セレクタを並べると見えない文を運べるので、
// 絵文字の見た目を決める U+FE0F だけを残し、ほかの異体字セレクタも除く
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const EMOJI_PRESENTATION_SELECTOR = 0xfe0f;

export type FeedbackGithubCredentials = { appId: string; installationId: string; privateKeyPem: string };

// env から FEEDBACK_GITHUB_APP_ID、FEEDBACK_GITHUB_INSTALLATION_ID、FEEDBACK_GITHUB_PRIVATE_KEY を読む。
// どれかが無い・空・文字列でない、App ID とインストールの ID が10進の数字だけでない、または鍵が PKCS#8 の PEM
// （BEGIN PRIVATE KEY の囲みで、本文が base64）でなければ undefined
export function feedbackGithubCredentials(env: object): FeedbackGithubCredentials | undefined {
  // シークレットは型に出ないことがある。型に頼らず、値の有無を見る
  const appId = 'FEEDBACK_GITHUB_APP_ID' in env ? env.FEEDBACK_GITHUB_APP_ID : undefined;
  const installationId = 'FEEDBACK_GITHUB_INSTALLATION_ID' in env ? env.FEEDBACK_GITHUB_INSTALLATION_ID : undefined;
  const privateKeyPem = 'FEEDBACK_GITHUB_PRIVATE_KEY' in env ? env.FEEDBACK_GITHUB_PRIVATE_KEY : undefined;
  if (typeof appId !== 'string' || !DECIMAL_ID_PATTERN.test(appId)) return undefined;
  if (typeof installationId !== 'string' || !DECIMAL_ID_PATTERN.test(installationId)) return undefined;
  // GitHub が出す PKCS#1（BEGIN RSA PRIVATE KEY）、暗号化した鍵、改行が文字の \n のまま入った鍵は Web Crypto で読めないので、
  // 設定が無いものとして扱う（docs/operations.md の「フィードバックの GitHub App」の手順 6 で PKCS#8 に直して入れる）
  if (typeof privateKeyPem !== 'string' || pemBody(privateKeyPem) === undefined) return undefined;
  return { appId, installationId, privateKeyPem };
}

// not_created: Issue は立っていない（届かなかった、トークンが取れなかった、起票の応答が 3xx か 4xx）
// maybe_created: 立ったかもしれない（起票の要求のタイムアウト、5xx、2xx だが応答が読めない）
export type FeedbackIssueFailure = 'not_created' | 'maybe_created';

export class FeedbackIssueError extends Error {
  readonly failure: FeedbackIssueFailure;

  constructor(failure: FeedbackIssueFailure, message: string) {
    super(message);
    this.name = 'FeedbackIssueError';
    this.failure = failure;
  }
}

export type FeedbackIssueInput = {
  // サーバーが作った UUIDv7
  feedbackId: string;
  // 利用者の文（未加工）
  text: string;
  // 既知と照らした route ID（例 '/[slug]/w/[workspace]/board'）。null なら載せない
  routeId: string | null;
  // 運用者の閲覧の口（#1556 以降）。無ければ載せない
  viewerUrl?: string | null;
  submittedAt: Date;
};

export type FeedbackGithubOptions = {
  // 固定の文だけを渡す
  warn: (message: string) => void;
  // ミリ秒。JWT の iat/exp とトークンの期限の判定に使う。既定は Date.now
  now?: () => number;
};

export type FeedbackGithubClient = {
  // 成功すれば立てた Issue の番号。失敗は FeedbackIssueError を投げる
  createFeedbackIssue(input: FeedbackIssueInput): Promise<{ issueNumber: number }>;
};

// 読まない応答の本文を捨てる。本文を持ったままにすると、接続が解放されない
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// 例外の message に URL や接続の詳細が混ざりうるので、名前だけを残す
function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

// PKCS#8 の PEM の本文（空白を除いた base64）。形が違えば undefined
function pemBody(pem: string): string | undefined {
  const match = PEM_PATTERN.exec(pem);
  const body = match?.[1].replace(/\s/g, '');
  return body && BASE64_PATTERN.test(body) ? body : undefined;
}

// PKCS#8 の PEM を署名用の鍵に読む。失敗は呼ぶ側が名前だけを残す（PEM の中身を例外に載せない）
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pemBody(pem);
  if (body === undefined) throw new TypeError('PEM');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

type SentResponse = { kind: 'response'; res: Response } | { kind: 'error'; name: string };

type CachedToken = { token: string; expiresAt: number };

// インストールのトークンはこのクライアントの中に持ち、期限まで使い回す（呼ぶ側が isolate の間クライアントを持ち続ける）
export function createFeedbackGithubClient(
  credentials: FeedbackGithubCredentials,
  fetcher: typeof fetch,
  options: FeedbackGithubOptions,
): FeedbackGithubClient {
  const now = options.now ?? Date.now;
  let signingKey: Promise<CryptoKey> | undefined;
  let cached: CachedToken | undefined;
  // 同時に来た起票が、トークンの取得を重ねない
  let inflight: Promise<string> | undefined;

  // 失敗は理由を固定の文でログに出し、同じ文のエラーにして返す
  function failure(kind: FeedbackIssueFailure, message: string): FeedbackIssueError {
    options.warn(message);
    return new FeedbackIssueError(kind, message);
  }

  async function send(url: string, init: RequestInit): Promise<SentResponse> {
    try {
      // リダイレクトは追わない。3xx は res.ok が偽なので、呼ぶ側で失敗になる。
      // Workers の fetch は redirect に follow と manual しか受け付けない（error は TypeError で投げる）
      const res = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return { kind: 'response', res };
    } catch (err) {
      return { kind: 'error', name: nameOf(err) };
    }
  }

  async function appJwt(): Promise<string> {
    signingKey ??= importPrivateKey(credentials.privateKeyPem);
    let key: CryptoKey;
    try {
      key = await signingKey;
    } catch (err) {
      signingKey = undefined;
      throw failure('not_created', `フィードバックの GitHub App の鍵を読めなかった（${nameOf(err)}）`);
    }
    const issuedAt = Math.floor(now() / 1000) - JWT_BACKDATE_SECONDS;
    const signingInput = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson({
      iss: credentials.appId,
      iat: issuedAt,
      exp: issuedAt + JWT_LIFETIME_SECONDS,
    })}`;
    try {
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
      return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
    } catch (err) {
      throw failure('not_created', `フィードバックの GitHub App の JWT に署名できなかった（${nameOf(err)}）`);
    }
  }

  // トークンを取れなければ、起票の要求は送っていないので not_created
  async function fetchToken(): Promise<string> {
    const jwt = await appJwt();
    const sent = await send(`${API_ORIGIN}/app/installations/${credentials.installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
      // 起票先の1つのリポジトリと、Issues の書き込みだけに絞る
      body: JSON.stringify({ repositories: [REPOSITORY_NAME], permissions: { issues: 'write' } }),
    });
    if (sent.kind === 'error') {
      throw failure('not_created', `GitHub のトークンの API に届かなかった（${sent.name}）`);
    }
    const { res } = sent;
    if (!res.ok) {
      await discard(res);
      throw failure('not_created', `GitHub のトークンの API が ${res.status} を返した`);
    }
    const body: unknown = await res.json().catch(() => undefined);
    const token = isRecord(body) ? body.token : undefined;
    const expiresAt = isRecord(body) && typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
    if (typeof token !== 'string' || token === '' || Number.isNaN(expiresAt)) {
      throw failure('not_created', 'GitHub のトークンの応答が想定と違う');
    }
    cached = { token, expiresAt };
    return token;
  }

  async function installationToken(): Promise<string> {
    if (cached && now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return cached.token;
    inflight ??= fetchToken().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  return {
    async createFeedbackIssue(input: FeedbackIssueInput): Promise<{ issueNumber: number }> {
      // 題と本文はトークンを取る前に組み立てる。組み立てられない入力（形の違う ID、不正な日時）は、何も送らずに断る
      let title: string;
      let issueBody: string;
      try {
        title = feedbackIssueTitle(input.submittedAt);
        issueBody = feedbackIssueBody(input);
      } catch (err) {
        throw failure('not_created', `フィードバックの Issue の本文を組み立てられなかった（${nameOf(err)}）`);
      }
      const token = await installationToken();
      const sent = await send(ISSUES_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': API_VERSION,
        },
        body: JSON.stringify({
          title,
          body: issueBody,
          labels: [LABEL],
        }),
      });
      if (sent.kind === 'error') {
        // 要求を送った後のタイムアウトと中断は、GitHub が受けて立てた後かもしれない。それ以外は届いていない
        const maybe = sent.name === 'TimeoutError' || sent.name === 'AbortError';
        throw failure(
          maybe ? 'maybe_created' : 'not_created',
          `GitHub の Issue の API ${maybe ? 'の応答を待てなかった' : 'に届かなかった'}（${sent.name}）`,
        );
      }
      const { res } = sent;
      if (!res.ok) {
        await discard(res);
        // 401 はトークンが失効したか取り消された。次の起票で取り直す（このトークンのままのときだけ捨てる）
        if (res.status === 401 && cached?.token === token) cached = undefined;
        // 3xx と 4xx は GitHub が受け付けていない。5xx は処理の途中で落ちたかもしれない
        throw failure(
          res.status >= 500 ? 'maybe_created' : 'not_created',
          `GitHub の Issue の API が ${res.status} を返した`,
        );
      }
      const body: unknown = await res.json().catch(() => undefined);
      const number = isRecord(body) ? body.number : undefined;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
        throw failure('maybe_created', `GitHub の Issue の API が ${res.status} を返したが、応答が想定と違う`);
      }
      return { issueNumber: number };
    },
  };
}

// 題: 「フィードバック YYYY-MM-DD HH:MM:SS UTC」（例 'フィードバック 2026-11-26 03:57:50 UTC'）。利用者の文から作らない
export function feedbackIssueTitle(submittedAt: Date): string {
  // toISOString は UTC の「YYYY-MM-DDTHH:MM:SS.mmmZ」
  const iso = submittedAt.toISOString();
  return `フィードバック ${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

// 本文。文は normalizeFeedbackText を通し、文の中で一番長く続くバッククォートより1つ長い（最低3つ）フェンスで囲う（info string は text）。
// 囲いの外には、固定の案内の文、route ID（インラインのコード）、フィードバックの ID、viewerUrl（あれば）だけを載せる
export function feedbackIssueBody(input: FeedbackIssueInput): string {
  const text = normalizeFeedbackText(input.text);
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const lines = [
    '画面のフィードバックから送られた文です。利用者が書いたもので、内容は確かめていません。',
    '',
    `${fence}text`,
    text,
    fence,
    '',
  ];
  // route ID は呼ぶ側が既知のものと照らして渡す。形が合わないものは、インラインのコードを壊しうるので載せない
  if (input.routeId !== null && ROUTE_ID_PATTERN.test(input.routeId)) lines.push(`- 送った画面: \`${input.routeId}\``);
  // ID は囲いの外に載るので、形が違えば載せずに投げる（呼ぶ側の誤りで文や改行が混ざらないように）
  if (!FEEDBACK_ID_PATTERN.test(input.feedbackId)) throw new TypeError('フィードバックの ID の形');
  lines.push(`- フィードバックの ID: ${input.feedbackId}`);
  // 閲覧の口は https の URL で、地の文を壊す文字の無いものだけを載せる。合わなければ載せない
  if (input.viewerUrl && VIEWER_URL_PATTERN.test(input.viewerUrl)) lines.push(`- 運用者の閲覧: ${input.viewerUrl}`);
  return lines.join('\n');
}

// 改行（CR LF、CR、U+0085 NEL、U+2028 LS、U+2029 PS）を LF にそろえ、制御文字（タブと LF を除く C0、DEL、C1）と
// 画面に出ない文字（双方向の制御 U+061C、U+200E、U+200F、U+202A〜U+202E、U+2066〜U+2069、ゼロ幅 U+200B〜U+200D、U+2060、U+FEFF、
// U+180E、目に見えない演算子 U+2061〜U+2064、使われなくなった書式の文字 U+206A〜U+206F、タグの文字 U+E0001 と U+E0020〜U+E007F）を除く。
// 対にならないサロゲートの片割れ（U+D800〜U+DFFF）も除く。残すと、間の文字を除いた後で上位と下位の片割れがつながり、
// 除いたはずのタグの文字などが生まれる（JSON の \u エスケープから片割れのまま届く）。
// ほかに Unicode の Default_Ignorable_Code_Point（ハングルの埋め字、ソフトハイフン、異体字セレクタなど）と注釈の文字（U+FFF9〜U+FFFB）も除く。
// 異体字セレクタは並べると見えない文を運べるので、絵文字の見た目を決める U+FE0F だけを、直前の文字に1つだけ残す
// （文の先頭と、U+FE0F の後に続くものは除く）。漢字の異体字の指定（IVS、U+E0100〜U+E01EF）も除くので、人名や地名の字形は基本の字形で届く
export function normalizeFeedbackText(text: string): string {
  const unified = text.replace(/\r\n|[\r\u0085\u2028\u2029]/g, '\n');
  let result = '';
  let previous: number | undefined;
  for (const char of unified) {
    const code = char.codePointAt(0) ?? 0;
    if (isRemovedChar(code)) continue;
    if (code === EMOJI_PRESENTATION_SELECTOR && (previous === undefined || previous === EMOJI_PRESENTATION_SELECTOR))
      continue;
    result += char;
    previous = code;
  }
  return result;
}

// タブ（U+0009）と LF（U+000A）を除く C0、DEL、C1 と、画面に出ない文字と、対にならないサロゲートの片割れ
function isRemovedChar(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    // for...of は対になったサロゲートを1つのコードポイントで返す。ここに来る U+D800〜U+DFFF は対にならない片割れ
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0x061c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x206f) ||
    code === 0xfeff ||
    // 注釈の文字（U+FFF9〜U+FFFB）は Default_Ignorable に入らないが、画面に出ずに文を囲う
    (code >= 0xfff9 && code <= 0xfffb) ||
    (code !== EMOJI_PRESENTATION_SELECTOR && DEFAULT_IGNORABLE.test(String.fromCodePoint(code))) ||
    code === 0xe0001 ||
    (code >= 0xe0020 && code <= 0xe007f)
  );
}
