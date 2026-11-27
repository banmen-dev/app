// 保存済みの Issue と PR を、不変の ID で1件取る（担当が外れた項目と、範囲の外へ移った項目の同期。#1543）。
// 一覧の絞り込み（担当、範囲、since）を使わず、保存した入れ物のリポジトリ ID と番号で1件を直接引く。
// リポジトリの ID で呼ぶので、リポジトリの改名に影響されない。Issue を別のリポジトリへ移した（transfer）ときは、
// GitHub が 301 で移動先を返すので、api.github.com の `/repositories/{ID}/issues/{番号}` の形のときだけ1回追う。
// 番号は移動や再利用で別の項目を指しうるので、番号だけで一致と判断せず、応答の ID が保存した ID と同じかを確かめる。
// DB には書かない（書くのは同期の仕組み）。
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import type { ImportItem, KnownItemInput } from '../source.ts';
import { FULL_NAME_PATTERN, GithubResourceMissing, getJson, idOf, isRecord } from './client.ts';
import { convertIssue } from './issues.ts';
import { convertPull } from './pulls.ts';

const ID = /^[1-9][0-9]{0,15}$/;
const KEY = /^([A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,15})$/;
const MOVED_ISSUE = /^https:\/\/api\.github\.com\/repositories\/[1-9][0-9]{0,15}\/issues\/[1-9][0-9]{0,15}$/;

function invalid(): never {
  // 保存済みの行の形の不備。1行のために同期を止めず、取れない項目として扱わせる（通信はしない）
  throw new GithubResourceMissing();
}

// 移動先は、固定のホストと形の URL だけを許す（クエリ、断片、認証情報は通さない）
function movedIssueUrl(location: string): string | null {
  return MOVED_ISSUE.test(location) ? location : null;
}

export async function fetchKnownItem(input: KnownItemInput): Promise<ImportItem> {
  const { target } = input;
  const key = KEY.exec(target.key);
  if (
    (target.kind !== 'issue' && target.kind !== 'pull_request') ||
    !ID.test(target.sourceId) ||
    !ID.test(target.containerId) ||
    !FULL_NAME_PATTERN.test(target.containerName) ||
    key === null
  ) {
    invalid();
  }
  const scope = { id: target.containerId, name: target.containerName };
  const number = key[2]!;
  const base = `https://api.github.com/repositories/${scope.id}`;

  if (target.kind === 'issue') {
    const raw = await getJson(`${base}/issues/${number}`, input.credential, input.fetcher, movedIssueUrl);
    if (!isRecord(raw) || idOf(raw.id) !== target.sourceId) throw new GithubResourceMissing();
    // 一覧は PR も返す。Issue の ID に PR が返った応答は、別の項目なので断る
    const item = convertIssue(raw, scope, null);
    if (item === null) throw new GithubResourceMissing();
    return item;
  }
  const raw = await getJson(`${base}/pulls/${number}`, input.credential, input.fetcher);
  if (!isRecord(raw) || idOf(raw.id) !== target.sourceId) throw new GithubResourceMissing();
  const item = convertPull(raw, scope, null);
  if (item === null) throw new GithubResourceMissing();
  return item;
}
