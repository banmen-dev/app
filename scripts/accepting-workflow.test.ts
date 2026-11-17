import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';

const workflow = load(readFileSync(new URL('../.github/workflows/accepting.yml', import.meta.url), 'utf8')) as {
  jobs: { accepting: { steps: { run: string }[] } };
};
const script = workflow.jobs.accepting.steps[0].run;

for (const [name, branch, body, expected] of [
  ['番号付きの途中', '1238-part', 'Refs #1238\nPart of #1238 題', []],
  ['本文から選ぶ途中', 'claude/work', 'Refs #1238\nPart of #1238', []],
  ['空白・大小文字・CRLF', '1238-part', '  pArT oF #1238 題\r\n', []],
  ['Refs がなくても番号付きの途中', '1238-part', 'Part of #1238', []],
  ['別番号は除外しない', '1238-part', 'Part of #123', ['1238']],
  ['番号の前方一致をしない', '1238-part', 'Part of #12380', ['1238']],
  ['番号の直後の文字を認めない', '1238-part', 'Part of #1238oops', ['1238']],
  ['文中の印は除外しない', '1238-part', '説明 Part of #1238', ['1238']],
  ['番号付きの完了', '1238-done', 'Refs #999', ['1238']],
  ['本文から選ぶ完了', 'claude/work', 'Refs #1238\nRefs #999', ['999', '1238']],
  ['同じ PR の途中だけ除外', 'claude/work', 'Refs #1238\nRefs #999\nPart of #1238', ['999']],
  ['印だけでは対象を増やさない', 'claude/work', 'Part of #1238', []],
  ['文中の Refs は対象外', 'claude/work', '説明 Refs #1238', []],
] as const) {
  test(name, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'accepting-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const capture = join(dir, 'calls');
    writeFileSync(capture, '');
    // 実際の API を呼ばず、読み取りとラベルの付け外しをすべて記録する。
    writeFileSync(
      join(dir, 'gh'),
      '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CAPTURE"\nif [[ "$2" =~ /issues/[0-9]+$ ]]; then printf "false\\topen\\t0\\n"; fi\n',
    );
    chmodSync(join(dir, 'gh'), 0o755);
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CAPTURE: capture,
        REPO: 'example/app',
        BRANCH: branch,
        BODY: body,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean);
    assert.deepEqual(
      calls,
      expected.flatMap((n) => [
        `api repos/example/app/issues/${n} --jq [(.pull_request != null), .state, (.sub_issues_summary.total // 0)] | @tsv`,
        `api repos/example/app/issues/${n}/labels -f labels[]=status:accepting --silent`,
        `api -X DELETE repos/example/app/issues/${n}/labels/status%3Ain-progress --silent`,
        `api -X DELETE repos/example/app/issues/${n}/labels/status%3Arefining --silent`,
      ]),
    );
  });
}
