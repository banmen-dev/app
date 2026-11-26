// フィードバックを GitHub App として banmen-dev/app に Issue で立てる層（Issue #1552。docs/requirements.md の「フィードバック」、
// docs/operations.md の「フィードバックの GitHub App」）。
// App の秘密鍵で JWT（RS256、WebCrypto）を作り、インストールのトークンに替え、期限の少し前まで使い回す。
// 利用者の文はフェンスのコードブロックに囲い、@ の通知、リンク、画像、HTML、Issue の参照を効かせない。
// ログとエラーの message には HTTP の状態コードと例外の名前だけを入れ、文、トークン、JWT、鍵、応答の本文を入れない。
// 秘密の形の文を断る入力の検証は、この層ではなく操作（#1553）が行う。
// 実装は後から入れる（いまは呼び口だけの入れ物）

export type FeedbackGithubCredentials = { appId: string; installationId: string; privateKeyPem: string };

// env から FEEDBACK_GITHUB_APP_ID、FEEDBACK_GITHUB_INSTALLATION_ID、FEEDBACK_GITHUB_PRIVATE_KEY を読む。
// どれかが無い・空・文字列でない、または App ID とインストールの ID が10進の数字だけでなければ undefined
export function feedbackGithubCredentials(env: object): FeedbackGithubCredentials | undefined {
  void env;
  throw new Error('未実装');
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

// インストールのトークンはこのクライアントの中に持ち、期限まで使い回す（呼ぶ側が isolate の間クライアントを持ち続ける）
export function createFeedbackGithubClient(
  credentials: FeedbackGithubCredentials,
  fetcher: typeof fetch,
  options: FeedbackGithubOptions,
): FeedbackGithubClient {
  void credentials;
  void fetcher;
  void options;
  return {
    async createFeedbackIssue(input: FeedbackIssueInput): Promise<{ issueNumber: number }> {
      void input;
      throw new Error('未実装');
    },
  };
}

// 題: 「フィードバック YYYY-MM-DD HH:MM:SS UTC」（例 'フィードバック 2026-11-26 03:57:50 UTC'）。利用者の文から作らない
export function feedbackIssueTitle(submittedAt: Date): string {
  void submittedAt;
  throw new Error('未実装');
}

// 本文。文は normalizeFeedbackText を通し、文の中で一番長く続くバッククォートより1つ長い（最低3つ）フェンスで囲う（info string は text）。
// 囲いの外には、固定の案内の文、route ID（インラインのコード）、フィードバックの ID、viewerUrl（あれば）だけを載せる
export function feedbackIssueBody(input: FeedbackIssueInput): string {
  void input;
  throw new Error('未実装');
}

// 改行（CR LF、CR、U+0085 NEL、U+2028 LS、U+2029 PS）を LF にそろえ、制御文字（タブと LF を除く C0、DEL、C1）と
// 画面に出ない文字（双方向の制御 U+061C、U+200E、U+200F、U+202A〜U+202E、U+2066〜U+2069、ゼロ幅 U+200B〜U+200D、U+2060、U+FEFF）を除く
export function normalizeFeedbackText(text: string): string {
  void text;
  throw new Error('未実装');
}
