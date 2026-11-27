// 取り込み元の共通の型（docs/requirements.md の「取り込み」）。取り込み元ごとの固有の処理と値は、型の実装の中に閉じる。
// この型が持つのは、登録に要る部分（認証情報の形の検査と確かめ、範囲の候補の一覧）と、同期に要る部分（範囲ごとの項目の取得）。
// 項目の取得と変換は取り込み元ごとの固有の処理で、同期の仕組み（sync.ts）は取り込み元に依らず、この型の取得口を呼ぶ。
// 取り込み元の一覧（種類から実装への表）を知るのは index.ts だけ。
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）

export type ImportSourceKind = 'github';

// 範囲の種類。connection_scopes.scope_kind に保存する値で、範囲の候補の ID と名前が何を指すか（GitHub はリポジトリ）を表す
export type ScopeKind = 'github_repo';

// 認証情報の持ち主。1接続は1人の持ち主に結ぶ。id は取り込み元の不変の ID を10進の文字列で持つ
export type CredentialOwner = { kind: 'user' | 'organization'; id: string; name: string };

// 範囲の候補。id は取り込み元の不変の ID（10進の文字列）、name は画面に出す名前（GitHub は `owner/name`）
export type ScopeCandidate = { id: string; name: string };

// invalid_format: 認証情報の形が合わない（取り込み元に問い合わせていない）
// unauthorized: 取り込み元が認証情報を受け付けなかった（401。無効、期限切れ、取り消し済み）
// forbidden: 取り込み元が権限を認めなかった（403。上限に当たった場合も含む）
// unavailable: 届かない、5xx、応答が想定と違う、候補が多すぎる
export type ImportSourceFailure = 'invalid_format' | 'unauthorized' | 'forbidden' | 'unavailable';

// message は固定の文だけにする。認証情報、応答の本文、URL を入れない（ログに出るため）
export class ImportSourceError extends Error {
  readonly failure: ImportSourceFailure;
  // 保存済みの項目の取得で、その項目が恒久的に取れない（取り込み元に無い、ID が合わない、保存値の形が合わない）とき真。
  // 取り込み元の一時的な障害や制限（権限、5xx、届かない）とは区別する
  readonly gone: boolean;

  constructor(failure: ImportSourceFailure, message: string, gone = false) {
    super(message);
    this.name = 'ImportSourceError';
    this.failure = failure;
    this.gone = gone;
  }
}

// 取り込み元に依らない項目の形。取り込み元の実装が、自分の応答をこの形に直して返す（tasks と task_sources に書く値）。
// kind: 種別（task_sources.source_kind）。reviewerSourceId はレビュー依頼のときだけ入れ、ほかは空文字
// title は取り込み元の文字のまま渡してよい（見えない文字の除去と長さの切り詰めは同期の仕組みが行う）
// dueOn は日付（YYYY-MM-DD）か null、updatedAt は取り込み元での更新日時（ISO 8601）
export type ImportItem = {
  kind: 'issue' | 'pull_request' | 'review_request';
  sourceId: string;
  reviewerSourceId: string;
  // レビュー依頼の回を表す不透明な不変識別子。属性の更新では変わらない。
  reviewCycle?: string;
  key: string;
  url: string;
  title: string;
  containerId: string;
  containerName: string;
  status: string;
  dueOn: string | null;
  updatedAt: string;
  isDone: boolean;
};

export type FetchPageInput = {
  credential: string;
  fetcher: typeof fetch;
  // 接続の設定（connections.settings_json を解釈した値）。GitHub の「自分」など、取り込み元に固有の設定
  settings: Record<string, unknown>;
  scope: ScopeCandidate;
  // 取り込み元が返した続きの位置。最初の頁は null。同期の仕組みは中身を読まず、そのまま返す。
  // 頁の番号などの不透明な値にし、URL は入れない（入れるなら、認証情報を付けて送る前に取り込み元のホストかを確かめる）
  cursor: string | null;
  // 差分の起点（ISO 8601）。この時点より前に更新された項目は読まなくてよい。null は全部を読む（初めての同期）。
  // 同期の仕組みが同期の始めに決め、続きの頁でも変えない。使わない取得口は無視してよい
  since?: string | null;
};

// 保存済み項目の照合では、不変 ID と現在の表示キーを渡す。番号だけで一致と判断しない。
export type ReviewRequestPageInput = FetchPageInput & {
  target?: { sourceId: string; key: string };
};

// items は未完了のものも完了したものも含んでよい（同期の仕組みが完了を除く）。next が null なら、この範囲は終わり
export type FetchPageResult = { items: ImportItem[]; next: string | null };

// 保存済みの項目を不変の ID で取るときの入力。同期の仕組みが task_sources から読んだ値を、そのまま渡す。
// 範囲（担当や範囲の絞り込み）では引かないので、担当が外れた項目も範囲の外へ移った項目も取れる。
// key は保存したときの表示キー、containerId と containerName は保存したときの入れ物。取り込み元は、番号やキーだけで一致と判断せず、
// 応答の不変の ID が sourceId と同じかを確かめる（#914 の照合も同じ口を使う）
export type KnownItemInput = {
  credential: string;
  fetcher: typeof fetch;
  settings: Record<string, unknown>;
  target: {
    kind: 'issue' | 'pull_request';
    sourceId: string;
    key: string;
    containerId: string;
    containerName: string;
  };
};

export interface ImportSource {
  readonly kind: ImportSourceKind;
  readonly scopeKind: ScopeKind;
  // 取り込み元に固有の設定の検証。受け付ける形ならそれを返し、合わなければ null。GitHub は設定を持たず、`{}` か未指定（undefined）だけを受けて `{}` を返す
  parseSettings(settings: unknown): Record<string, never> | null;
  // 認証情報の形の検査。取り込み元に問い合わせない
  isCredentialShape(credential: string): boolean;
  // 画面に出す、認証情報の末尾4文字。形が合わないときは ImportSourceError('invalid_format') を投げる
  credentialLast4(credential: string): string;
  // 認証情報を取り込み元で確かめ、持ち主を返す。形が合わなければ問い合わせずに ImportSourceError('invalid_format') を投げる
  verifyCredential(credential: string, fetcher: typeof fetch): Promise<CredentialOwner>;
  // 範囲の候補を、頁をまたいで漏れなく返す。形が合わなければ問い合わせずに ImportSourceError('invalid_format') を投げる
  listScopeCandidates(credential: string, fetcher: typeof fetch): Promise<ScopeCandidate[]>;
  // 同期用の候補列挙。任意口だが、多頁を持つ取り込み元は1要求ずつ再開できる形で実装する。
  fetchScopeCandidatesPage?(input: {
    credential: string;
    fetcher: typeof fetch;
    cursor: string | null;
  }): Promise<{ candidates: ScopeCandidate[]; next: string | null }>;
  // 範囲の項目を1頁取る。失敗は ImportSourceError で投げる（unauthorized は接続を止め、ほかは次の同期で再試行する）
  fetchPage(input: FetchPageInput): Promise<FetchPageResult>;
  // 任意のレビュー依頼取得口。1呼び出し1要求。履歴の途中は空の items と next を返す。
  // 同期はこの取得口を fetchPage と分けて呼び、依頼回と照合状態を保存する。
  fetchReviewRequestsPage?(input: ReviewRequestPageInput): Promise<FetchPageResult>;
  // 任意の保存済み項目の取得口。1呼び出しで1項目を不変の ID で取り、現在の属性を ImportItem で返す（閉じていれば isDone を真に）。
  // 取れない項目（見つからない、ID が合わない、権限で断られた）は ImportSourceError を投げる。同期は、その項目を動かさず次へ進む
  fetchKnownItem?(input: KnownItemInput): Promise<ImportItem>;
}
