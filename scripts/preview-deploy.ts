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
    const branches: unknown = await deps.openBranches();
    if (
      !Array.isArray(branches) ||
      branches.some(
        (value) =>
          typeof value !== 'string' ||
          !value ||
          Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127),
      )
    ) {
      throw new Error('開いた PR のブランチ一覧を読めませんでした');
    }
    const openNumbers = new Set((branches as string[]).map(previewBranchNumber).filter((value) => value !== undefined));
    for (const database of databases) {
      const previewNumber = PREVIEW_DATABASE_PATTERN.exec(database.name)?.[1];
      if (!previewNumber || openNumbers.has(previewNumber)) continue;
      deps.log(`閉じた PR の D1 を削除します: ${database.name}`);
      await deps.deleteDatabase(database);
    }
    return;
  }

  const name = previewDatabaseName(number!);
  const previous = databases.find((database) => database.name === name);
  if (previous) {
    deps.log(`プレビューの D1 を作り直します: ${name}`);
    await deps.deleteDatabase(previous);
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
