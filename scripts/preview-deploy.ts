import { previewBranchNumber } from '../src/shared/preview-branch.ts';
import {
  isIsolatedPreviewSubdomain,
  isPreviewDatabaseName,
  LEGACY_PREVIEW_SUBDOMAIN,
  PREVIEW_DATABASE_PATTERN,
  previewDatabaseName,
  previewOrigin,
} from '../src/shared/preview-cloudflare.ts';
import { PRODUCTION_DATABASE_ID, UUID_PATTERN } from './preview-config.ts';

export type PreviewDatabase = { name: string; uuid: string };

// 掃除を打ち切ったときにログへ出してよい理由を持つ例外。本文、URL、認証情報を入れない。
export class PreviewStepError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string = message) {
    super(message);
    this.name = 'PreviewStepError';
    this.reason = reason;
  }
}

export class PreviewHttpError extends PreviewStepError {
  readonly status: number;
  constructor(status: number) {
    super(`外部 API が HTTP ${status} を返しました`, `HTTP ${status}`);
    this.name = 'PreviewHttpError';
    this.status = status;
  }
}

// 番号付きのビルドで掃除を打ち切ったとき、配信を続けてよい D1 の数の上限（この数未満なら続ける）。
// 無料プランの上限 10 に対し、並行するビルドが作る分の余裕を残す（#1456）。
export const PREVIEW_CLEANUP_CONTINUE_BELOW = 8;

export type PreviewDeps = {
  env: Record<string, string | undefined>;
  commitSha: string;
  listDatabases: () => Promise<PreviewDatabase[]>;
  createDatabase: (name: string) => Promise<PreviewDatabase>;
  deleteDatabase: (database: PreviewDatabase) => Promise<void>;
  openBranches: () => Promise<string[]>;
  publish: (input: { number: string; origin: string; database: PreviewDatabase; commitSha: string }) => Promise<void>;
  log: (message: string) => void;
};

function databaseValue(value: unknown): PreviewDatabase {
  if (typeof value !== 'object' || value === null) throw new Error('D1 の一覧に不正な項目があります');
  const { name, uuid } = value as Partial<PreviewDatabase>;
  if (typeof name !== 'string' || name.length === 0 || typeof uuid !== 'string' || !UUID_PATTERN.test(uuid)) {
    throw new Error('D1 の名前と ID を読めませんでした');
  }
  if (isPreviewDatabaseName(name) && uuid.toLowerCase() === PRODUCTION_DATABASE_ID) {
    throw new Error('本番の D1 はプレビューに使えません');
  }
  return { name, uuid };
}

function databaseList(value: unknown): PreviewDatabase[] {
  if (!Array.isArray(value)) throw new Error('D1 の一覧を読めませんでした');
  const databases = value.map(databaseValue);
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const database of databases) {
    const name = database.name.toLowerCase();
    const id = database.uuid.toLowerCase();
    if (names.has(name) || ids.has(id)) throw new Error('D1 の一覧に重複があります');
    names.add(name);
    ids.add(id);
  }
  return databases;
}

// gone は削除が 404 を返したもの。消えたことを確かめていないので、残りの数から引かない。
type CleanupResult = { deleted: PreviewDatabase[]; gone: PreviewDatabase[]; abortReason?: string };

// ログに出す理由。fetch や子プロセスの例外の本文は URL や認証情報を含みうるので、名前だけにする。
function abortReason(error: unknown): string {
  if (error instanceof PreviewStepError) return error.reason;
  if (error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name)) return error.name;
  return '不明なエラー';
}

function openNumbersFrom(branches: unknown): Set<string> {
  if (
    !Array.isArray(branches) ||
    branches.some(
      (value) =>
        typeof value !== 'string' ||
        !value ||
        Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127),
    )
  ) {
    throw new PreviewStepError('開いた PR のブランチ一覧を読めませんでした');
  }
  return new Set((branches as string[]).map(previewBranchNumber).filter((value) => value !== undefined));
}

// 並行する別番号のビルドが先に同じ D1 を消すと 404 になる。打ち切らずに続け、'gone' を返す。
// API の経路の食い違いでも 404 になりうるので、呼び出し側は消せた数に入れない。
async function deleteUnlessGone(deps: PreviewDeps, database: PreviewDatabase): Promise<'deleted' | 'gone'> {
  try {
    await deps.deleteDatabase(database);
    return 'deleted';
  } catch (error) {
    if (error instanceof PreviewHttpError && error.status === 404) {
      deps.log(`削除が 404 を返しました（既に消えたと見て続けます）: ${database.name}`);
      return 'gone';
    }
    throw error;
  }
}

// 先に読んだ D1 の一覧のうち、開いた PR に番号の無い banmen-pr-* を消す。一覧より後に作られた D1 は消さない。
// GitHub の読み取りか削除に失敗したら、それ以上は消さずに打ち切り、理由を返す（例外にしない）。
async function cleanupClosedPreviews(
  deps: PreviewDeps,
  databases: PreviewDatabase[],
  keep?: string,
): Promise<CleanupResult> {
  const deleted: PreviewDatabase[] = [];
  const gone: PreviewDatabase[] = [];
  let openNumbers: Set<string>;
  try {
    openNumbers = openNumbersFrom(await deps.openBranches());
  } catch (error) {
    return { deleted, gone, abortReason: `開いた PR を読めませんでした（${abortReason(error)}）` };
  }
  // 起動専用 Worker は開いた PR のブランチだけをビルドする。自分が一覧に無ければ、一覧が欠けていると見て消さない。
  if (keep !== undefined && !openNumbers.has(keep)) {
    return { deleted, gone, abortReason: '開いた PR の一覧にこのビルドの番号がありません' };
  }
  for (const database of databases) {
    const previewNumber = PREVIEW_DATABASE_PATTERN.exec(database.name)?.[1];
    if (!previewNumber || previewNumber === keep || openNumbers.has(previewNumber)) continue;
    deps.log(`閉じた PR の D1 を削除します: ${database.name}`);
    try {
      const outcome = await deleteUnlessGone(deps, database);
      (outcome === 'deleted' ? deleted : gone).push(database);
    } catch (error) {
      return { deleted, gone, abortReason: `${database.name} を削除できませんでした（${abortReason(error)}）` };
    }
  }
  return { deleted, gone };
}

function logCleanup(deps: PreviewDeps, before: number, result: CleanupResult): void {
  const after = before - result.deleted.length;
  const names = result.deleted.map((database) => database.name).join(', ') || 'なし';
  const goneNames = result.gone.length ? `、404 ${result.gone.map((database) => database.name).join(', ')}` : '';
  deps.log(`閉じた PR の D1 の掃除: 前 ${before} 個、後 ${after} 個、削除 ${names}${goneNames}`);
  if (result.abortReason) deps.log(`閉じた PR の D1 の掃除を打ち切りました: ${result.abortReason}`);
}

export async function deployPreview(deps: PreviewDeps): Promise<void> {
  if (deps.env.WORKERS_CI !== '1') throw new Error('Workers Builds の外では動かしません');
  const subdomain = deps.env.CLOUDFLARE_PREVIEW_SUBDOMAIN;
  if (subdomain !== undefined && !isIsolatedPreviewSubdomain(subdomain)) {
    throw new Error('プレビュー専用の workers.dev サブドメインが必要です');
  }
  const branch = deps.env.WORKERS_CI_BRANCH;
  const number = typeof branch === 'string' ? previewBranchNumber(branch) : undefined;
  if (branch !== 'main' && !number) throw new Error('プレビューのブランチを判定できません');
  if (typeof deps.commitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(deps.commitSha)) {
    throw new Error('コミットの SHA を判定できません');
  }

  // 一覧全体を検査してから最初の変更を行う。部分的な一覧から削除対象を推測しない。
  const databases = databaseList(await deps.listDatabases());
  if (branch === 'main') {
    // 人が手で掃除する入口。作成しないので、打ち切りは失敗として Builds に残す。
    const result = await cleanupClosedPreviews(deps, databases);
    logCleanup(deps, databases.length, result);
    if (result.abortReason) throw new Error('閉じた PR の D1 の掃除を打ち切りました');
    return;
  }

  const name = previewDatabaseName(number!);
  // 自分の D1 を作る前に枠を空ける。D1 の上限が効くのは作成の瞬間だけ（#1456）。
  const result = await cleanupClosedPreviews(deps, databases, number);
  logCleanup(deps, databases.length, result);
  // 自分の D1 も数える。作り直しで先に消すが、並行するビルドが同じ枠を取りうるため（#1456）。
  const remaining = databases.length - result.deleted.length;
  const deletedIds = new Set([...result.deleted, ...result.gone].map((database) => database.uuid.toLowerCase()));
  const kept = databases.filter((database) => !deletedIds.has(database.uuid.toLowerCase()));
  if (result.abortReason) {
    if (remaining >= PREVIEW_CLEANUP_CONTINUE_BELOW) {
      // deploy-preview.ts は例外の本文を出さないので、止める理由はログに出す。
      deps.log(
        `D1 が ${remaining} 個あり、掃除できないまま作ると上限に当たりうるので、D1 を作らずに止めます（${PREVIEW_CLEANUP_CONTINUE_BELOW} 個未満なら続けます）`,
      );
      throw new Error('閉じた PR の D1 を掃除できず、D1 の数が多いので止めました');
    }
    deps.log(`警告: D1 が ${remaining} 個で ${PREVIEW_CLEANUP_CONTINUE_BELOW} 個未満なので、掃除せずに配信を続けます`);
  }

  const previous = kept.find((database) => database.name === name);
  if (previous) {
    deps.log(`プレビューの D1 を作り直します: ${name}`);
    await deleteUnlessGone(deps, previous);
  }
  deps.log(`プレビューの D1 を作成します: ${name}`);
  const database = databaseValue(await deps.createDatabase(name));
  if (
    database.name !== name ||
    database.uuid.toLowerCase() === PRODUCTION_DATABASE_ID ||
    databases.some((existing) => existing.uuid.toLowerCase() === database.uuid.toLowerCase())
  ) {
    throw new Error('作成した D1 の名前または ID がプレビューに使えません');
  }
  const origin = previewOrigin(number!, subdomain ?? LEGACY_PREVIEW_SUBDOMAIN);
  // branch の検査で、main 以外なら number が存在することを確かめている。
  await deps.publish({ number: number!, origin, database, commitSha: deps.commitSha });
  deps.log(`プレビュー: ${origin}`);
}
