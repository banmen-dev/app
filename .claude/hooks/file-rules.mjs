// Write と Edit の判定。CLAUDE.md の「守ること」のうち、書いた内容で判定できるものを止め、
// 守る仕組みそのもの（.claude/settings*.json と、セッションが使っている .claude/hooks/）と、wrangler の設定の転送先（.wrangler/deploy/config.json）の書き換えには人の確認を挟む。
// D1 の binding の判定は、ESLint の入口を守る規則（docs/development.md の「入口を守る規則」）が入るまでのつなぎ。
import { lstatSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code が各 Bash のコマンドの前に読む環境のファイル（CLAUDE_ENV_FILE。~/.claude/session-env/<セッション>/*.sh と ~/.claude/shell-snapshots/*.sh）。
// 書き足すと、以後のすべての Bash に、フックからは見えない GIT_CONFIG_*、GH_REPO、PATH、関数の定義などが付く。
// 書く前に止める早めの案内で、守りの本体は毎回の Bash の前の状態の確かめ（shell-env-state.mjs）。
// CLAUDE_CONFIG_DIR で ~/.claude の場所を替えても名前は変わらないので、字面の判定の中心は名前（大文字小文字は区別しない。APFS では同じ場所を指す）。
// CLAUDE_ENV_FILE は PreToolUse のフックと Bash の環境にふつう無い（SessionStart のフックだけが持つ）ので、$CLAUDE_ENV_FILE の字面と起動元の値の照合は補助。
// bash-rules.mjs もこの名前と理由を使う（重ねて持つと片方だけ直る）
export const SHELL_ENV_DIR_NAMES = ['session-env', 'shell-snapshots'];
export const SHELL_ENV_DIR = new RegExp(`(^|/)(${SHELL_ENV_DIR_NAMES.join('|')})(/|$)`, 'i');
export const SHELL_ENV_REASON =
  'Claude Code が各 Bash の前に読む環境のファイル（CLAUDE_ENV_FILE、~/.claude/session-env/、~/.claude/shell-snapshots/）への書き込みは、フックから見えない GIT_CONFIG_*、GH_REPO、PATH、関数の定義を以後のコマンドに付け、push の先や守りを替えうる。書き込みは人が確かめる';

// HOME が無く passwd にも無いと os.homedir() は投げる。照合は止めずに、ホームを使う形だけ諦める
export function homeOrNull() {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}

// リンクをたどる回数の上限（OS の ELOOP の上限と同じくらい）
const MAX_LINK_HOPS = 40;

// 絶対パスを、OS と同じく名前を左から 1 つずつ辿って実体の側に直す。リンクは向き先に置き換え（向き先の無いリンクも）、
// .. は直前の実体の親として解く（deep/.. は、deep がリンクならその向き先の親。字面で畳んでから解くと別の場所になる）。
// 無い名前は字面のまま。Write の先がまだ無い session-env のファイルを指すリンクや、/tmp/e -> ~/.claude/session-env の下のファイルを、名前で見るために使う。
// .. を畳んでいない字面（deep/../x.sh）を渡すこと（path.resolve と path.join は先に畳む）
export function resolveLinks(absolute) {
  const queue = absolute.split('/').filter((segment) => segment !== '');
  let current = '/';
  let hops = 0;
  while (queue.length > 0) {
    const segment = queue.shift();
    if (segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, segment);
    let target;
    try {
      if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
    } catch {
      // 無い名前は字面のまま辿る
    }
    if (target === undefined) {
      current = next;
      continue;
    }
    // 輪になったリンクは、ここから先を辿らず字面のまま返す
    if (++hops > MAX_LINK_HOPS) return path.join(next, ...queue);
    if (path.isAbsolute(target)) current = '/';
    queue.unshift(...target.split('/').filter((s) => s !== ''));
  }
  return current;
}

// paths は書かれたパスと、リンクを解いたパス。git のリポジトリの外にあるので judgeFile とは別に見る。
// envFile は起動元の環境の CLAUDE_ENV_FILE の値（無ければ undefined）。止めるものが無ければ null
export function judgeShellEnvFile(paths, envFile) {
  // 値のパスと、そのリンクを解いた実体の両方で比べる（/var が /private/var へのリンクの macOS では、リンクを解いたパスの綴りが違う）
  const targets = typeof envFile === 'string' && path.isAbsolute(envFile) ? [...new Set([path.resolve(envFile), resolveLinks(path.resolve(envFile))])].map((t) => t.toLowerCase()) : [];
  const hits = (p) => SHELL_ENV_DIR.test(p.split(path.sep).join('/')) || targets.includes(path.resolve(p).toLowerCase());
  return paths.some(hits) ? ['ask', SHELL_ENV_REASON] : null;
}

// rel はリポジトリのルートからの相対パス。shippedOnMain は origin/main に同じパスがあるか（main を引けなければ undefined）
// inWorktree は、セッションが使うフックのあるリポジトリとは別の、リンクされたワークツリーの中のファイルか
// onMain は、ファイルのある作業コピーが main にいるか（本体の detached も含む）。ほかのどの判定より先に止める
// 一番重い判定を [決定, 理由] で返す。止めるものが無ければ null
export function judgeFile({ rel, contents, shippedOnMain, inWorktree = false, onMain = false }) {
  const name = path.basename(rel);
  // 守る先は大文字小文字を区別しない。macOS の APFS では .Claude/Settings.json も本物の設定を指す
  const folded = rel.toLowerCase();

  // 文書も含めて、変更はすべて作業ブランチで作り PR を通す。main の作業コピーは読むだけにする
  if (onMain) {
    return ['deny', 'main の作業コピーは書き換えない。git fetch origin のあと git worktree add worktrees/<Issue番号>-<名前> -b <同じ名前> origin/main でワークツリーを切り、その中で書く（docs/development.md の「ワークツリーで作業する」）'];
  }

  // 設定は disableAllHooks でフックごと切れるので、どこでも確かめる
  if (/^\.claude\/settings[^/]*\.json$/.test(folded)) {
    return ['ask', '守る仕組み（Claude の設定）の変更は人が確かめる'];
  }
  // wrangler は -c が無いとき、このファイルがあれば書かれた別の設定へ転送する。ignore されていて、remote の binding を持つ設定へ向けられる
  // macOS は大文字小文字を区別しないので、.wrangler/deploy/CONFIG.JSON も同じファイルを指す（i）
  if (/(^|\/)\.wrangler\/deploy\/config\.json$/i.test(rel)) {
    return ['ask', 'wrangler の設定の転送先（.wrangler/deploy/config.json）の書き換えは人が確かめる。remote の binding を持つ設定へ向けると wrangler dev が本番に届く'];
  }
  // セッションが使うのは $CLAUDE_PROJECT_DIR のフック。別のワークツリーでの書き換えは PR で人が読むまで効かない
  if ((folded.startsWith('.claude/hooks/') || folded.startsWith('.githooks/')) && !inWorktree) {
    return ['ask', '守る仕組み（フック）の変更は人が確かめる。ワークツリーで書き換えて PR を通す'];
  }
  if (folded.startsWith('migrations/') && shippedOnMain) {
    return ['deny', 'マイグレーションは足すだけにし、main にあるファイルを書き換えない。直すときは新しい番号のファイルを足す'];
  }
  if (folded.startsWith('migrations/') && shippedOnMain === undefined) {
    return ['ask', 'main を引けず、このマイグレーションが既に main にあるかを判定できない'];
  }
  if (/^\+(page|layout)\.server\.[jt]s$|^\+server\.[jt]s$|^hooks\.server\.[jt]s$/.test(name)) {
    return ['deny', '画面は SPA として作る。データは Hono の API から取り、+page.server、+layout.server、+server、hooks.server は使わない'];
  }
  if (
    rel.startsWith('src/') &&
    !rel.startsWith('src/server/db/') &&
    /\benv\.DB\b|\bD1Database\b/.test(contents)
  ) {
    return ['deny', 'D1 には src/server/db/ の Kysely の入口からだけ問い合わせる。binding の型は wrangler types の Env を使う'];
  }
  if (name.endsWith('.svelte') && /<style[\s>]/i.test(contents)) {
    return ['deny', '画面ごとの CSS を持たない。足りない部品は先にデザインシステム（tokens.css、components.css）へ足す'];
  }
  if (/^wrangler[^/]*\.(json|jsonc|toml)$/.test(name) && /"remote"\s*:\s*true|\bremote\s*=\s*true/.test(contents)) {
    return ['deny', 'remote を有効にした binding は、wrangler dev から本番の D1 と R2 に届く'];
  }
  return null;
}
