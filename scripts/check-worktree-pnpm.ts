import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { parseNulSeparated } from './ci.ts';

const worktree = /ワークツリー|\bworktrees?\b/i;
const worktreeSetup =
  /\bworktree\s+(?:add|move)\b|ワークツリー(?:を(?:切|作|用意|使)|(?:に|へ)移動|(?:内)?で(?:以下|次の))/i;
const cloneCommand = /^[ \t]*(?:\$[ \t]+)?git[ \t]+clone\b/m;
const normalCheckout =
  /(?:クローン(?:直後|した作業コピー)?では?|本体の作業コピーで)(?:以下|次の|実行(?:する|して|します))|本体の作業コピー(?:に|へ)移動(?:する|して|します)/;
const shellWorktree = /\bworktree\s+(?:add|move)\b|(?:\b|-C)worktrees\/|\$(?:\{worktree\}|worktree\b)/i;
// pnpm は -C などで作業ディレクトリを渡せる。引用したパスやシェルの行継続も読む。
const directoryOption = String.raw`(?:-C(?:[ \t]+|=)?|--dir(?:[ \t]+|=))("[^"\n]*"|'[^'\n]*'|[^\s\x60;&|()]+)`;
const trailingDirectory = new RegExp('[ \\t]+' + directoryOption);
const pnpm = '\\bpnpm(?:[ \\t]+' + directoryOption + String.raw`)?(?:[ \t]|\\\r?\n)+`;
const install = new RegExp(pnpm + '(?:install|i|ci)(?![\\w-])', 'g');
const storePath = new RegExp(pnpm + 'store[ \\t]+path(?![\\w-])', 'g');
const listItem = /^\s*(?:[-+*]|\d+[.)])\s+/;

function linksToGuide(path: string, text: string): boolean {
  const anchor = '#ワークツリーで作業する';
  for (const [, destination] of text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
    if (!destination.endsWith(anchor)) continue;
    const document = destination.slice(0, -anchor.length);
    if ((document ? posix.join(posix.dirname(path), document) : path) === 'docs/development.md') return true;
  }
  return /(?:^|\s|\x60)docs\/development\.md\x60?\s*の「ワークツリーで作業する」/.test(text);
}

type Block = {
  text: string;
  firstLine: number;
  heading: string;
  section: number;
  fenced: boolean;
};

function markdownBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const headings: string[] = [];
  let lines: string[] = [];
  let firstLine = 1;
  let section = 0;
  let fence = '';
  let fenced = false;
  function flush(): void {
    if (lines.length) blocks.push({ text: lines.join('\n'), firstLine, heading: headings.join(' '), section, fenced });
    lines = [];
    fenced = false;
  }
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const marker = /^\s*(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      lines.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = '';
        flush();
      }
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      headings.length = heading[1].length;
      headings[heading[1].length - 1] = heading[2];
      section++;
    } else if (!line.trim()) {
      flush();
    } else {
      if (marker || listItem.test(line) || line.trimStart().startsWith('|')) flush();
      if (!lines.length) firstLine = index + 1;
      if (marker) {
        fence = marker[1];
        fenced = true;
      }
      lines.push(line);
      if (line.trimStart().startsWith('|')) flush();
    }
  }
  flush();
  return blocks;
}

function commandDirectory(match: RegExpMatchArray, text: string): string {
  const argumentsAfterCommand = text.slice(match.index! + match[0].length).split(/[\n;&|\x60]/, 1)[0];
  const directory = trailingDirectory.exec(argumentsAfterCommand)?.[1] ?? match[1] ?? '.';
  return posix.normalize(directory.replace(/^(["'])(.*)\1$/, '$2')).replace(/(.+)\/$/, '$1');
}

function checkBlock(path: string, block: Block, priorCommands = '', previous?: Block): number[] {
  const content = block.fenced ? withoutShellComments(block.text) : block.text;
  const preceding =
    previous?.section === block.section ? (previous.fenced ? withoutShellComments(previous.text) : previous.text) : '';
  // 開発文書への参照は同じ手順か、その直前の説明から読む。
  const linked = linksToGuide(path, content) || (!listItem.test(content) && linksToGuide(path, preceding));
  if (!path.endsWith('.sh') && linked) return [];
  return [...content.matchAll(install)].flatMap((match) => {
    const end = match.index + match[0].length;
    // 文中の「pnpm install の prepare」のような説明は、実行手順として扱わない。
    if (!block.fenced && /^[^\x60\n]*\x60\s*(?:の|を(?:していない|動かさない))/.test(content.slice(end))) return [];
    const before = content.slice(0, match.index);
    const precedingCommands = priorCommands + '\n' + before;
    // cd/pushd より前に表示した保存先は、移動後の確認に数えない。
    const currentDirectory = precedingCommands.split(/(?:^|[\n;&])[ \t]*(?:cd|pushd)[ \t]/).at(-1)!;
    const directory = commandDirectory(match, content);
    const checked = [...currentDirectory.matchAll(storePath)].some(
      (check) => commandDirectory(check, currentDirectory) === directory,
    );
    return checked ? [] : [block.firstLine + before.split('\n').length - 1];
  });
}

function withoutShellComments(source: string): string {
  return source.replace(/^[ \t]*#[^\n]*/gm, '');
}

export function findWorktreePnpmInstalls(path: string, source: string): number[] {
  if (path.endsWith('.sh')) {
    const text = withoutShellComments(source);
    return shellWorktree.test(text)
      ? checkBlock(path, { text, firstLine: 1, heading: '', section: 0, fenced: true })
      : [];
  }

  const problems: number[] = [];
  let previous: Block | undefined;
  let scope: 'worktree' | 'checkout' | undefined;
  let priorCommands = '';
  // HTML コメントを表示上の手順・確認として数えず、元の行番号は保つ。
  const visibleSource = source.replace(/<!--[^]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
  for (const block of markdownBlocks(visibleSource)) {
    if (previous?.section !== block.section) {
      scope = undefined;
      priorCommands = '';
    }
    const content = block.fenced ? withoutShellComments(block.text) : block.text;
    const tableRow = block.text.trimStart().startsWith('|');
    // 表の各行は独立した手順として扱う。本文の確認は同じ節で作業場所を切り替えるまで有効。
    const previousProse = previous?.section === block.section && !previous.fenced ? previous.text : '';
    const startsWorktreeList = listItem.test(content) && !listItem.test(previousProse) && worktree.test(previousProse);
    if (!tableRow) {
      const changesToCheckout = block.fenced ? cloneCommand.test(content) : normalCheckout.test(content);
      if (changesToCheckout) {
        scope = 'checkout';
        priorCommands = '';
      } else if (worktreeSetup.test(content) || startsWorktreeList) {
        if (scope !== 'worktree' && !startsWorktreeList) priorCommands = '';
        scope = 'worktree';
      }
    }
    const followsWorktreeProse = block.fenced && worktree.test(previousProse);
    if (
      worktree.test(content) ||
      (scope !== 'checkout' &&
        (worktree.test(block.heading) || (!tableRow && (scope === 'worktree' || followsWorktreeProse))))
    ) {
      problems.push(...checkBlock(path, block, tableRow ? '' : priorCommands, tableRow ? undefined : previous));
    }
    if (!tableRow) priorCommands += content + '\n';
    previous = block;
  }
  return problems;
}

if (import.meta.main) {
  const paths = parseNulSeparated(execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.sh'], { encoding: 'utf8' }));
  for (const path of paths) {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) continue;
    for (const line of findWorktreePnpmInstalls(path, readFileSync(path, 'utf8'))) {
      console.error(
        `${path}:${line}: ワークツリーで依存を入れる前に pnpm store path で保存先を確認するか、docs/development.md の「ワークツリーで作業する」を参照してください。`,
      );
      process.exitCode = 1;
    }
  }
}
