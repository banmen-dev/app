// 取り込み元に依らない同期の仕組み（docs/requirements.md の「取り込み」、docs/data-model.md の「書き込みの単位」）。
// 接続を1つ、範囲ごとに続きの位置で頁を取り、頁ごとに1回の batch() で、新しい項目をタスクと task_sources に書く。
// 「今すぐ同期」と、後の定期処理が同じ関数を呼ぶ。取り込み元ごとの違いは ImportSource の実装の中に閉じ、ここは取り込み元の名前を知らない。
// 通常項目は新規未完了だけを取り込み、既にある項目は取り込み元が持つ属性（タイトル、状態、期限、URL、完了の印）だけを更新する。
// レビュー依頼は target で照合し、完了印と再依頼時の復帰を保存する。応答保存は別工程。
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { generateNKeysBetween } from 'fractional-indexing';
import {
  importTaskStatements,
  readKnownTarget,
  readReviewTarget,
  reviewUpdateStatements,
  updateImportedStatements,
  readInboxTailPosition,
  readRepositoriesByContainer,
  readSyncConnection,
  syncOutcomeStatement,
  type ImportedTask,
  type OrganizationDb,
  type SyncOutcome,
} from '../db/index.ts';
import { decryptCredential } from '../crypto/credential.ts';
import { uuidv7 } from '../uuid.ts';
import { stripHiddenCharacters } from '../../shared/hidden-characters.ts';
import { TASK_TITLE_MAX_LENGTH } from '../../shared/task.ts';
import { BLANK_CHARACTERS } from '../../shared/text-rules.ts';
import { importSourceOf, isImportSourceKind } from './index.ts';
import {
  ImportSourceError,
  type ImportItem,
  type ImportSource,
  type ImportSourceFailure,
  type FetchPageResult,
} from './source.ts';

// 1回の同期で取る要求・取得口の呼び出しの上限。超えたら続きの位置を保存して止め、次の同期で続ける
export const DEFAULT_MAX_PAGES = 10;
// 頁の間で判定する。開始済みの1頁（GitHub は1要求、初回だけ本人照会が加わる）は完了してから保存する。
export const DEFAULT_MAX_DURATION_MS = 60_000;
// 1頁の項目の数の上限。超える応答は想定と違うものとして断る（1回の batch() の文を抑える）
export const MAX_ITEMS_PER_PAGE = 100;
// 続きの位置の長さの上限（取り込み元が返した値をそのまま保存するため）
const MAX_CURSOR_LENGTH = 2000;
const MAX_FIELD_LENGTH = 2000;

// connections.last_error_message に書く固定の文。取り込み元や例外の message は書かない（認証情報や URL が混ざりうるため）
const FAILURE_MESSAGES: Record<ImportSourceFailure, string> = {
  invalid_format: '認証情報が使えない形になっている',
  unauthorized: '取り込み元が認証情報を受け付けなかった',
  forbidden: '取り込み元が権限を認めなかった',
  unavailable: '取り込み元に届かないか、応答が想定と違う',
};
const CREDENTIAL_UNAVAILABLE_MESSAGE = '認証情報を取り出せなかった';
const UNKNOWN_FAILURE_MESSAGE = '同期で想定外の失敗が起きた';

// 差分の起点は、前回の同期が終わった時点（last_success_at）から少し戻す。
// 終わった時点の直前に更新された項目と、取り込み元との時計のずれ、複数の要求にまたがる走査の間の更新を拾うため
export const SINCE_MARGIN_MS = 5 * 60_000;
function sinceOf(lastSuccessAt: string | null): string | null {
  if (lastSuccessAt === null) return null;
  const time = Date.parse(lastSuccessAt);
  return Number.isNaN(time) ? null : new Date(time - SINCE_MARGIN_MS).toISOString();
}

export type SyncOptions = {
  // 取り込み元の実装。省くと接続の種類から引く（テストが偽の取り込み元を差す）
  source?: ImportSource;
  fetcher?: typeof fetch;
  now?: () => Date;
  maxPages?: number;
  maxDurationMs?: number;
};

type ScheduledSyncOptions = SyncOptions & { absoluteDeadline: number };
type DeferredSync = { outcome: 'budget_exhausted' };

export type SyncResult =
  // 接続が無い（別の組織、別のワークスペース、削除済み）か、閉じたワークスペース
  | { outcome: 'not_found' }
  // 止まっている接続は同期しない
  | { outcome: 'stopped' }
  // 範囲が空で、取り込み元に問い合わせていない
  | { outcome: 'no_scope' }
  // imported: 今回入れたタスクの数。more: 上限で止め、続きの位置を保存した
  | { outcome: 'success'; imported: number; more: boolean }
  // imported: 失敗するまでに入れた数
  | { outcome: 'auth_failed' | 'error'; imported: number };

type Resume = {
  scope: string;
  cursor: string | null;
  phase: 'items' | 'reviews' | 'targets';
  after: string;
  targetId?: string;
  targetRevision?: number;
};
type ScopeBatch = { candidates: Scope[]; next: string | null };
type Progress = { resume: Resume | null; scopeBatch: ScopeBatch | null; candidateCursor: string | null };
// 発見の走査の後で、取り込み済みの項目を不変の ID で取りに行く段の続きの位置（#1543）。after は最後に取りに行った task_id
type Known = { after: string };
type SyncState = Progress & {
  credential: string | null;
  known: Known | null;
  itemsOnly: boolean;
  reviewRetry: Progress | null;
  // 進行中の同期の差分の起点。同期の始めに決め、途中保存をまたいで変えない
  since: string | null;
  // 進行中の同期を始めた時刻。全部を読み終えたとき、last_success_at にこれを書く（次の起点を、終わった時刻でなく始めた時刻から作るため）
  startedAt: string | null;
};
function parseProgress(value: Record<string, unknown>): Progress {
  const r = value.position as Partial<Resume> | undefined;
  const validCursor = (v: unknown): v is string | null =>
    v === null || (typeof v === 'string' && v.length > 0 && v.length <= MAX_CURSOR_LENGTH);
  const resume: Resume | null =
    r && typeof r.scope === 'string' && validCursor(r.cursor) && ['items', 'reviews', 'targets'].includes(r.phase ?? '')
      ? {
          scope: r.scope,
          cursor: r.cursor,
          phase: r.phase!,
          after: typeof r.after === 'string' ? r.after : '',
          targetId: typeof r.targetId === 'string' ? r.targetId : undefined,
          targetRevision: Number.isSafeInteger(r.targetRevision) ? r.targetRevision : undefined,
        }
      : null;
  const batch = value.scopeBatch as Partial<ScopeBatch> | undefined;
  const scopeBatch =
    batch &&
    Array.isArray(batch.candidates) &&
    batch.candidates.length <= MAX_ITEMS_PER_PAGE &&
    batch.candidates.every((c) => c && isText(c.id) && isText(c.name)) &&
    validCursor(batch.next)
      ? (batch as ScopeBatch)
      : null;
  return { resume, scopeBatch, candidateCursor: validCursor(value.candidateCursor) ? value.candidateCursor : null };
}
function parseSyncState(json: string): SyncState {
  const empty: SyncState = {
    resume: null,
    credential: null,
    scopeBatch: null,
    candidateCursor: null,
    itemsOnly: false,
    reviewRetry: null,
    known: null,
    since: null,
    startedAt: null,
  };
  try {
    const value = JSON.parse(json);
    if (typeof value !== 'object' || value === null || value.version !== 2) return empty;
    return {
      ...parseProgress(value),
      credential: typeof value.credential === 'string' ? value.credential : null,
      itemsOnly: value.itemsOnly === true,
      known:
        value.known && typeof value.known === 'object' && typeof value.known.after === 'string'
          ? { after: value.known.after.slice(0, MAX_CURSOR_LENGTH) }
          : null,
      startedAt:
        typeof value.startedAt === 'string' && !Number.isNaN(Date.parse(value.startedAt)) ? value.startedAt : null,
      since: typeof value.since === 'string' && !Number.isNaN(Date.parse(value.since)) ? value.since : null,
      reviewRetry: value.reviewRetry && typeof value.reviewRetry === 'object' ? parseProgress(value.reviewRetry) : null,
    };
  } catch {
    return empty;
  }
}
function progressValue(progress: Progress) {
  return { position: progress.resume, scopeBatch: progress.scopeBatch, candidateCursor: progress.candidateCursor };
}

function validPage(page: FetchPageResult, cursor: string | null): boolean {
  return (
    typeof page === 'object' &&
    page !== null &&
    Array.isArray(page.items) &&
    page.items.length <= MAX_ITEMS_PER_PAGE &&
    (page.next === null ||
      (typeof page.next === 'string' &&
        page.next !== '' &&
        page.next.length <= MAX_CURSOR_LENGTH &&
        page.next !== cursor))
  );
}

function parseSettings(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 壊れた設定は空として扱う
  }
  return {};
}

// 手で入れるタイトルと同じ整え方: 見えない文字を除いて前後の空白を落とし、200字（コードポイント）で切る。
// 改行とタブは語をつなげないよう、除く前に空白にする。何も残らなければ取り込み元のキーを使う
export function importedTitle(raw: string, fallback: string): string {
  const blank = (text: string) => text.replace(BLANK_CHARACTERS, '') === '';
  // 手で入れるタイトルと同じく、空白や幅の無い文字だけのタイトルは空と同じ扱いにする。切った後に空に見えるものも同じ
  const shape = (text: string) => {
    const cleaned = stripHiddenCharacters(text.replace(/[\t\n\r]+/g, ' ')).trim();
    const cut = [...cleaned].slice(0, TASK_TITLE_MAX_LENGTH).join('').trim();
    return blank(cut) ? '' : cut;
  };
  return shape(raw) || shape(fallback);
}

function invalid(): ImportSourceError {
  return new ImportSourceError('unavailable', FAILURE_MESSAGES.unavailable);
}

function isText(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= MAX_FIELD_LENGTH && (allowEmpty || value !== '');
}

// 画面がリンクにする値なので http と https だけを通す
function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// ISO 8601 の日時（ミリ秒なしの Z や UTC からのずれ付きも受ける）。受けた値は保存の前にミリ秒付きの UTC に直す
function isoInstant(value: string): string | null {
  if (!ISO_INSTANT.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// 取り込み元の実装が返した項目の形を確かめる。外から来た値なので、書く前に形と長さを見る。
// 合わない項目は取り込まずに飛ばす（1件の不備で、その頁より後の頁と後ろの範囲を塞がない）
function isValidItem(item: ImportItem): boolean {
  const kinds = ['issue', 'pull_request', 'review_request'];
  if (
    typeof item !== 'object' ||
    item === null ||
    !kinds.includes(item.kind) ||
    !isText(item.sourceId) ||
    !isText(item.reviewerSourceId, true) ||
    (item.kind === 'review_request') !== (item.reviewerSourceId !== '') ||
    (item.kind === 'review_request' && !isText(item.reviewCycle)) ||
    !isText(item.key) ||
    !isText(item.url) ||
    !isWebUrl(item.url) ||
    !isText(item.title, true) ||
    !isText(item.containerId) ||
    !isText(item.containerName) ||
    !isText(item.status) ||
    !isText(item.updatedAt) ||
    isoInstant(item.updatedAt) === null ||
    typeof item.isDone !== 'boolean' ||
    (item.dueOn !== null && (typeof item.dueOn !== 'string' || !isDate(item.dueOn)))
  ) {
    return false;
  }
  // 見えない文字を除いて空になる欄は、表示に使えない
  // 手で入れるタイトルと同じ判定（BLANK_CHARACTERS）で、空白や幅の無い文字だけの欄も飛ばす。sourceId はタイトルの最後の替えにも使う
  return [item.key, item.containerName, item.status, item.sourceId].every(
    (text) => stripHiddenCharacters(text).replace(BLANK_CHARACTERS, '') !== '',
  );
}

type Scope = { id: string; name: string };

async function scopesOf(
  source: ImportSource,
  mode: string,
  stored: Scope[],
  credential: string,
  fetcher: typeof fetch,
): Promise<Scope[]> {
  if (mode !== 'exclude') return stored;
  // 「すべてから除外を挙げる」: 持ち主のすべての範囲の候補から、除外に挙げたものを引く
  const excluded = new Set(stored.map((scope) => scope.id));
  const candidates = await source.listScopeCandidates(credential, fetcher);
  return candidates.filter((candidate) => !excluded.has(candidate.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function syncConnection(
  env: object,
  db: OrganizationDb,
  workspaceId: string,
  connectionId: string,
  options: ScheduledSyncOptions,
): Promise<SyncResult | DeferredSync>;
export function syncConnection(
  env: object,
  db: OrganizationDb,
  workspaceId: string,
  connectionId: string,
  options?: SyncOptions & { absoluteDeadline?: never },
): Promise<SyncResult>;
export async function syncConnection(
  env: object,
  db: OrganizationDb,
  workspaceId: string,
  connectionId: string,
  options: SyncOptions & { absoluteDeadline?: number } = {},
): Promise<SyncResult | DeferredSync> {
  const absoluteDeadline = options.absoluteDeadline;
  const jobTimeExpired = () => absoluteDeadline !== undefined && Date.now() >= absoluteDeadline;
  let requests = 0;
  let budgetReached = false;
  const requestLimit = DEFAULT_MAX_PAGES;
  const fetcher: typeof fetch = async (...args) => {
    if (requests >= requestLimit) {
      budgetReached = true;
      throw invalid();
    }
    requests++;
    return (options.fetcher ?? fetch)(...args);
  };
  const now = options.now ?? (() => new Date());
  const maxPages = Math.min(DEFAULT_MAX_PAGES, Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES));

  const read = await readSyncConnection(db, workspaceId, connectionId);
  if (read === undefined) return { outcome: 'not_found' };
  const { connection } = read;
  if (connection.status === 'stopped') return { outcome: 'stopped' };
  // 対象を挙げる接続で範囲が空なら、取り込み元に問い合わせない（登録した直後の状態）
  if (connection.scope_mode !== 'exclude' && read.scopes.length === 0) return { outcome: 'no_scope' };
  if (jobTimeExpired()) return { outcome: 'budget_exhausted' };

  let imported = 0;
  let resume: Resume | null = null;
  let scopeBatch: ScopeBatch | null = null;
  let candidateCursor: string | null = null;
  let reviewRetry: Progress | null = null;
  let known: Known | null = null;
  let itemsOnly = false;
  // 認証情報を替えた場合、本人 ID を含む保存カーソルは使わない。平文も暗号文も状態には保存しない。
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${connection.credential_key_version}:${connection.credential_ciphertext}`),
  );
  const credentialStamp = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const storedState = parseSyncState(connection.sync_state_json);
  if (storedState.credential === credentialStamp) {
    resume = storedState.resume;
    scopeBatch = storedState.scopeBatch;
    candidateCursor = storedState.candidateCursor;
    reviewRetry = storedState.reviewRetry;
    known = storedState.known;
    itemsOnly = storedState.itemsOnly;
  }
  // 続きの位置があるのに認証情報の指紋が合わず捨てた状態は、起点を失っているので全部を読む
  // （途中保存でも last_success_at は進むので、そこから起点を作ると、まだ読んでいない古い項目を飛ばす）
  const discardedProgress =
    storedState.credential !== credentialStamp &&
    (storedState.resume !== null ||
      storedState.scopeBatch !== null ||
      storedState.candidateCursor !== null ||
      storedState.reviewRetry !== null ||
      storedState.known !== null);
  const inProgress =
    resume !== null || scopeBatch !== null || candidateCursor !== null || reviewRetry !== null || known !== null;
  // 続きの同期は、始めに決めた起点を使う（途中保存でも last_success_at は進むので、新しい同期の起点とは別に持つ）。
  // 新しい同期は、前の同期が全部を読み終えた時点（その書き込みが最後の last_success_at）から始める。
  // 起点が無い途中の状態（旧形式）は全部を読む。初めての同期（last_success_at が空）も全部を読む
  const since: string | null = inProgress
    ? storedState.since
    : discardedProgress
      ? null
      : // 除外で持つ接続は、後から見えるようになった範囲の古い項目を差分で飛ばさないよう、毎回全部を読む
        connection.scope_mode === 'exclude'
        ? null
        : sinceOf(connection.last_success_at);
  const startedAt: string = (inProgress ? storedState.startedAt : null) ?? now().toISOString();
  const stateJson = () =>
    resume === null && scopeBatch === null && candidateCursor === null && reviewRetry === null && known === null
      ? '{}'
      : JSON.stringify({
          version: 2,
          ...progressValue({ resume, scopeBatch, candidateCursor }),
          credential: credentialStamp,
          since,
          startedAt,
          itemsOnly,
          known,
          reviewRetry: reviewRetry === null ? null : progressValue(reviewRetry),
        });
  // 通常項目（Issue/PR）だけの走査はレビューの失敗を解消していないので、接続の成功・失敗の記録を変えない。
  const checkpoint = (preserveFailure = false): SyncOutcome =>
    preserveFailure || itemsOnly || reviewRetry !== null
      ? { kind: 'progress', syncStateJson: stateJson() }
      : { kind: 'success', syncStateJson: stateJson() };
  // 保存条件が変わった場合も、認証情報の差し替えを「停止」とは報告しない。
  const interrupted = async (): Promise<SyncResult> => {
    const latest = await readSyncConnection(db, workspaceId, connectionId);
    return latest === undefined || latest.connection.status === 'stopped'
      ? { outcome: 'stopped' }
      : { outcome: 'error', imported };
  };
  // 状態の文が通らなかった（同期の最中に接続が止まった、削除された）ときは false
  const finish = async (outcome: SyncOutcome): Promise<boolean> => {
    const result = await db.run(
      syncOutcomeStatement(
        db,
        {
          id: connection.id,
          workspaceId,
          credential: connection.credential_ciphertext,
          keyVersion: connection.credential_key_version,
        },
        outcome,
        now().toISOString(),
      ),
    );
    return result.changes > 0;
  };

  try {
    if (jobTimeExpired()) return { outcome: 'budget_exhausted' };
    const source =
      options.source ?? (isImportSourceKind(connection.provider) ? importSourceOf(connection.provider) : undefined);
    if (source === undefined) throw invalid();

    const credential = await credentialOf(env, connection);
    if (jobTimeExpired()) return { outcome: 'budget_exhausted' };
    const settings = parseSettings(connection.settings_json);
    const stored = read.scopes.map((scope) => ({ id: scope.source_id, name: scope.source_name }));
    const deadline = absoluteDeadline ?? Date.now() + (options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
    const repositories = await readRepositoriesByContainer(db, workspaceId, connection.provider);
    let pages = 0;
    const pause = async (): Promise<SyncResult | DeferredSync> => {
      // 接続の始めの読み取りだけで定期処理の期限に達した場合、同期の進捗も巡回位置も進めない。
      if (pages === 0 && requests === 0 && jobTimeExpired()) return { outcome: 'budget_exhausted' };
      if (!(await finish(checkpoint()))) return interrupted();
      return { outcome: 'success', imported, more: true };
    };
    const pagedCandidates = connection.scope_mode === 'exclude' && source.fetchScopeCandidatesPage !== undefined;
    // 取り込み済みの項目の段（known）で止まった続きは、発見の走査を終えているので、その段から再開する
    while (known === null) {
      if (pagedCandidates && scopeBatch === null) {
        if (requests >= requestLimit || pages >= maxPages || Date.now() >= deadline) {
          // 候補一覧だけで上限に達しても、その続きの位置から再開する。
          return await pause();
        }
        pages++;
        const page = await source.fetchScopeCandidatesPage!({ credential, fetcher, cursor: candidateCursor });
        if (
          !Array.isArray(page.candidates) ||
          page.candidates.length > MAX_ITEMS_PER_PAGE ||
          !page.candidates.every((s) => s && isText(s.id) && isText(s.name)) ||
          (page.next !== null && (!isText(page.next) || page.next === candidateCursor))
        )
          throw invalid();
        scopeBatch = page;
      }
      if (jobTimeExpired()) return await pause();
      const excluded = new Set(stored.map((s) => s.id));
      const scopes = pagedCandidates
        ? scopeBatch!.candidates.filter((s) => !excluded.has(s.id))
        : await scopesOf(source, connection.scope_mode, stored, credential, fetcher);
      const start = resume === null ? -1 : scopes.findIndex((scope) => scope.id === resume!.scope);
      for (let index = Math.max(start, 0); index < scopes.length; index++) {
        const scope = scopes[index]!;
        let current: Resume =
          index === start && resume !== null
            ? { ...resume }
            : {
                scope: scope.id,
                cursor: null,
                phase: !itemsOnly && source.fetchReviewRequestsPage ? 'targets' : 'items',
                after: '',
              };
        while (true) {
          resume = current;
          if (pages >= maxPages || requests >= requestLimit || Date.now() >= deadline) {
            return await pause();
          }
          const input = { credential, fetcher, settings, scope, cursor: current.cursor, since };
          if (current.phase === 'targets') {
            const target = await readReviewTarget(db, connection, scope.id, current.after);
            if (jobTimeExpired()) return await pause();
            if (!target) {
              current = { ...current, phase: 'items', cursor: null };
              continue;
            }
            if (!source.fetchReviewRequestsPage) throw invalid();
            // 対象の削除や並行同期を挟んだら、別の項目・古い版の履歴カーソルを使わない。
            current = {
              ...current,
              targetId: target.task_id,
              targetRevision: target.review_revision,
              cursor:
                current.targetId === target.task_id && current.targetRevision === target.review_revision
                  ? current.cursor
                  : null,
            };
            resume = current;
            pages++;
            let page: FetchPageResult;
            try {
              page = await source.fetchReviewRequestsPage({
                ...input,
                cursor: current.cursor,
                target: { sourceId: target.source_id, key: target.source_key },
              });
            } catch (error) {
              if (budgetReached) throw error;
              if (!(error instanceof ImportSourceError) || error.failure !== 'unavailable') throw error;
              // 不明な項目は動かさず、他の保存済み項目を照合する。次の走査で再試行する。
              current = { ...current, after: target.task_id, cursor: null };
              continue;
            }
            if (!validPage(page, current.cursor)) throw invalid();
            for (const item of page.items) {
              if (
                !isValidItem(item) ||
                item.kind !== 'review_request' ||
                item.sourceId !== target.source_id ||
                item.reviewerSourceId !== target.reviewer_source_id ||
                item.containerId !== scope.id
              )
                continue;
              const tail = await readInboxTailPosition(db, workspaceId);
              const [position] = generateNKeysBetween(tail ?? null, null, 1);
              await db.batch(reviewUpdateStatements(db, connection, target, item, position!, now().toISOString()));
            }
            current =
              page.next === null
                ? { ...current, cursor: null, after: target.task_id }
                : { ...current, cursor: page.next };
            continue;
          }
          pages++;
          const page =
            current.phase === 'reviews' ? await source.fetchReviewRequestsPage!(input) : await source.fetchPage(input);
          if (!validPage(page, current.cursor)) throw invalid();
          // 発見は未完了新規だけを作る。既存は target の応答だけが更新できる。
          const items =
            current.phase === 'reviews'
              ? page.items.filter((item) => item.containerId === scope.id && item.kind === 'review_request')
              : page.items;
          imported += await writePage(db, connection, workspaceId, items, repositories, now);
          if (page.next !== null) {
            current = { ...current, cursor: page.next };
            continue;
          }
          if (!itemsOnly && current.phase === 'items' && source.fetchReviewRequestsPage) {
            current = { ...current, phase: 'reviews', cursor: null };
            continue;
          }
          break;
        }
      }
      resume = null;
      if (!pagedCandidates || scopeBatch!.next === null) {
        scopeBatch = null;
        candidateCursor = null;
        break;
      }
      candidateCursor = scopeBatch!.next;
      scopeBatch = null;
    }
    if (itemsOnly && reviewRetry !== null) {
      ({ resume, scopeBatch, candidateCursor } = reviewRetry);
      reviewRetry = null;
      itemsOnly = false;
      if (!(await finish(checkpoint(true)))) return interrupted();
      return { outcome: 'success', imported, more: true };
    }
    resume = null;
    // 発見の走査で見えなかった取り込み済みの項目（担当が外れた、範囲の外へ移った）も、不変の ID で取りに行って同じ更新を当てる。
    // 頁と時間の上限は発見の走査と同じに数え、尽きたら続きの task_id から再開する
    if (source.fetchKnownItem !== undefined) {
      known ??= { after: '' };
      while (true) {
        if (pages >= maxPages || requests >= requestLimit || Date.now() >= deadline) return await pause();
        const target = await readKnownTarget(db, connection, known.after);
        if (jobTimeExpired()) return await pause();
        if (!target) break;
        pages++;
        let item: ImportItem;
        try {
          item = await source.fetchKnownItem({
            credential,
            fetcher,
            settings,
            target: {
              kind: target.source_kind as 'issue' | 'pull_request',
              sourceId: target.source_id,
              key: target.source_key,
              containerId: target.source_container_id,
              containerName: target.source_container_name,
            },
          });
        } catch (error) {
          if (budgetReached) throw error;
          // 取れない項目（見つからない、権限で断られた、応答が想定と違う）は動かさず、次の項目へ進む。
          // 「取り込み元で見つからない」の印は #914 の照合が付ける
          if (
            error instanceof ImportSourceError &&
            (error.failure === 'unavailable' || error.failure === 'forbidden')
          ) {
            known = { after: target.task_id };
            continue;
          }
          throw error;
        }
        // 別の項目が返った応答は使わない（不変の ID と種別が保存した値と同じ項目だけ更新する）
        if (isValidItem(item) && item.kind === target.source_kind && item.sourceId === target.source_id) {
          await writeKnown(db, connection, workspaceId, item, now);
        }
        known = { after: target.task_id };
      }
      known = null;
    }
    if (!(await finish({ kind: 'success', syncStateJson: '{}', lastSuccessAt: startedAt }))) return interrupted();
    return { outcome: 'success', imported, more: false };
  } catch (error) {
    if (budgetReached && (resume !== null || candidateCursor !== null || scopeBatch !== null || known !== null)) {
      if (!(await finish(checkpoint()))) return interrupted();
      return { outcome: 'success', imported, more: true };
    }
    // 403/429の回は直ちに止める。失敗したレビューの位置を保持し、次回は通常項目（Issue/PR）だけを全範囲へ通す。
    // 権限不足とレート制限を推測で区別せず、Issueの走査が終わった後で元のレビューを再試行する。
    if (
      error instanceof ImportSourceError &&
      error.failure === 'forbidden' &&
      resume !== null &&
      resume.phase !== 'items' &&
      !itemsOnly
    ) {
      reviewRetry = { resume, scopeBatch, candidateCursor };
      resume = null;
      itemsOnly = true;
    }
    const failure = failureOf(error);
    // 認証の失敗（取り込み元が受け付けない、保存した認証情報が使えない形）は接続を止める。ほかは止めず、次の同期で再試行する
    if (failure.stop) {
      if (!(await finish({ kind: 'auth_failed', message: failure.message, syncStateJson: stateJson() })))
        return interrupted();
      return { outcome: 'auth_failed', imported };
    }
    if (!(await finish({ kind: 'error', message: failure.message, syncStateJson: stateJson() }))) return interrupted();
    return { outcome: 'error', imported };
  }
}

async function credentialOf(
  env: object,
  connection: { id: string; credential_ciphertext: string | null; credential_key_version: number | null },
): Promise<string> {
  if (connection.credential_ciphertext === null || connection.credential_key_version === null) {
    throw new CredentialUnavailable();
  }
  try {
    return await decryptCredential(
      env,
      { ciphertext: connection.credential_ciphertext, keyVersion: connection.credential_key_version },
      connection.id,
    );
  } catch {
    throw new CredentialUnavailable();
  }
}

class CredentialUnavailable extends Error {
  constructor() {
    super(CREDENTIAL_UNAVAILABLE_MESSAGE);
    this.name = 'CredentialUnavailable';
  }
}

function failureOf(error: unknown): { stop: boolean; message: string } {
  if (error instanceof ImportSourceError) {
    const known = Object.hasOwn(FAILURE_MESSAGES, error.failure);
    return {
      stop: error.failure === 'unauthorized' || error.failure === 'invalid_format',
      message: known ? FAILURE_MESSAGES[error.failure] : UNKNOWN_FAILURE_MESSAGE,
    };
  }
  if (error instanceof CredentialUnavailable) return { stop: false, message: CREDENTIAL_UNAVAILABLE_MESSAGE };
  return { stop: false, message: UNKNOWN_FAILURE_MESSAGE };
}

// 1頁を、1回の batch() で書く。入れたタスクの数を返す。
// 既にある項目（Issue と PR）は、取り込み元が持つ属性だけを更新する（完了した項目の完了の印と、開き直された項目の印の取り外しもここ）。
// 新しく入れるのは未完了の項目だけ（取り込んでいない項目が完了していたら取り込まない）。形の合わない項目は飛ばす
async function writePage(
  db: OrganizationDb,
  connection: {
    id: string;
    provider: string;
    owner_user_id: string;
    credential_ciphertext: string | null;
    credential_key_version: number | null;
  },
  workspaceId: string,
  items: readonly ImportItem[],
  repositories: ReadonlyMap<string, string>,
  now: () => Date,
): Promise<number> {
  const valid = items.filter((item) => isValidItem(item));
  const open = valid.filter((item) => !item.isDone);
  const at = now();
  // 更新の文を先に流す（新しい項目の行はまだ無いので0件になり、入れた直後の行を書き直さない）。レビュー依頼は個別の照合が持つので対象にしない
  const updates = valid.flatMap((item) => updateStatementsOf(db, connection, workspaceId, item, at));
  if (open.length === 0) {
    if (updates.length > 0) await db.batch(updates);
    return 0;
  }

  const tail = await readInboxTailPosition(db, workspaceId);
  const positions = generateNKeysBetween(tail ?? null, null, open.length);
  const tasks: ImportedTask[] = open.map((item, index) => ({
    taskId: uuidv7(at),
    workspaceId,
    connectionId: connection.id,
    provider: connection.provider,
    assigneeUserId: connection.owner_user_id,
    repositoryId: repositories.get(item.containerId) ?? null,
    position: positions[index]!,
    title: titleOf(item),
    kind: item.kind,
    sourceId: item.sourceId,
    reviewerSourceId: item.reviewerSourceId,
    reviewCycle: item.reviewCycle,
    credentialCiphertext: connection.credential_ciphertext,
    credentialKeyVersion: connection.credential_key_version,
    key: stripHiddenCharacters(item.key),
    url: item.url,
    containerId: item.containerId,
    containerName: stripHiddenCharacters(item.containerName),
    status: stripHiddenCharacters(item.status),
    dueOn: item.dueOn,
    updatedAt: isoInstant(item.updatedAt)!,
  }));
  const groups = tasks.map((task) => importTaskStatements(db, task, at.toISOString()));
  const results = await db.batch([...updates, ...groups.flat()]);
  // 各組の先頭（tasks）が書いた数が、入れたタスクの数。レビュー依頼は依頼回の記録も含む。更新の文の結果は数えない
  let imported = 0;
  let index = updates.length;
  for (const group of groups) {
    imported += results[index]!.changes;
    index += group.length;
  }
  return imported;
}

type UpdateConnection = Parameters<typeof writePage>[1];

// 取り込み済みの1件に当てる更新の文。発見の走査と、不変の ID で取りに行く段が同じ更新を当てる
function updateStatementsOf(
  db: OrganizationDb,
  connection: UpdateConnection,
  workspaceId: string,
  item: ImportItem,
  at: Date,
) {
  // レビュー依頼は対象にしない（個別の照合が持つ）
  if (item.kind === 'review_request') return [];
  return updateImportedStatements(
    db,
    {
      workspaceId,
      connectionId: connection.id,
      provider: connection.provider,
      credentialCiphertext: connection.credential_ciphertext,
      credentialKeyVersion: connection.credential_key_version,
      kind: item.kind,
      sourceId: item.sourceId,
      title: titleOf(item),
      url: item.url,
      status: stripHiddenCharacters(item.status),
      dueOn: item.dueOn,
      isDone: item.isDone,
      updatedAt: isoInstant(item.updatedAt)!,
    },
    at.toISOString(),
  );
}

// 不変の ID で取った1件を、更新だけで書く（新しい項目は入れない。項目の行が無ければ0件になる）
async function writeKnown(
  db: OrganizationDb,
  connection: UpdateConnection,
  workspaceId: string,
  item: ImportItem,
  now: () => Date,
): Promise<void> {
  const statements = updateStatementsOf(db, connection, workspaceId, item, now());
  if (statements.length > 0) await db.batch(statements);
}

function titleOf(item: ImportItem): string {
  return importedTitle(item.title, item.key) || importedTitle(item.sourceId, '');
}
