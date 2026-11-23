---
name: issue-audit
description: >-
  整備。開いている Issue を全件読み、階層のラベル、親子のつなぎ方、末端だけに付ける pt: と sprint:、状態のラベルの同居、マイルストーンと area: の欠けを検査して、承認を得て直す。
  「Issue を整備して」「ラベルの漏れを見て」「バックログを点検して」「issue-audit」と言われたとき、スプリントの計画の前にバックログを整えたいときに使う。
  Issue を立てる、計画を書く、分ける、論点を人と詰めるのは issue-create。
---

# issue-audit

ルールの正本は `docs/development.md` の「Issue の運用」「スプリントとポイント」「Issue の状態」。対象は開いている Issue（PR とスプリントの記録の `sprint-log` は除く）。Issue の読み書きは `gh api` の REST で行う（理由: クラウドのセッションでは GraphQL の `gh issue` が 403 になる）。

## 絶対にやらないこと

- `status:ready` を付け外ししない（理由: `.github/workflows/ready.yml` が全件を数え直して付け外しする。手で直しても次の実行で戻る）
- 判断が要るものを推測で直さない。階層、親、ポイント、スプリント、マイルストーン、領域は人に値を聞いてから直す
- 本文を書き換えない。本文の節が古いものは、着手するときに `increment-build` が直す（`docs/agent-workflows/issue.md` の「記録する」）

## 手順

### 1. 全件を取る

```bash
gh api "repos/{owner}/{repo}/issues?state=open&per_page=100" --paginate --jq '.[] | select(.pull_request == null) | select(([.labels[].name] | index("sprint-log")) == null) | {number, title, labels: [.labels[].name], milestone: .milestone.title, subs: .sub_issues_summary.total, parent: (.parent_issue_url // "" | split("/") | last)}'
```

結果はスクラッチパッドのファイルに書き出してから読む。親が一覧に無い（閉じている）ときは `gh api repos/{owner}/{repo}/issues/<親の番号> --jq '{state, labels: [.labels[].name]}'` で親の階層を引く。
今のスプリントの番号は、開いている `sprint-log` の題の番号（`gh api "repos/{owner}/{repo}/issues?labels=sprint-log&state=open" --jq '.[] | .title'`。2つ開いていれば大きいほう）。

### 2. 判定する

階層は、`epic` があればエピック、`story` があればストーリー、どちらも無ければタスク。末端は、エピックでなく、サブ Issue が 0 の Issue。

| 軸 | 違反 | 直し方 |
| --- | --- | --- |
| 階層 | `epic` と `story` が両方付いている | 判断 |
| 親子 | エピックに親がある | 判断 |
| 親子 | ストーリーの親がエピックでない | 判断 |
| 親子 | タスクの親がストーリーでない（エピックの直下、タスクの下） | 判断。ストーリーを挟むか、タスクをストーリーにするかを聞く |
| ポイント | `pt:` が2つ以上 | 判断 |
| ポイント | 末端でない Issue に `pt:` が付いている | 機械的に外す。`sprint:<番号>` も付いているときは判断（計画のポイントは記録の Issue に残っているため） |
| ポイント | 末端に `pt:` が無い | 判断。本文の「やること」と完了条件から案（1、2、3、5、8）と理由を1行添えて聞く |
| スプリント | `sprint:` が2つ以上 | 判断 |
| スプリント | 末端でない Issue に `sprint:<番号>` が付いている | 判断 |
| スプリント | `sprint:<番号>` が今のスプリントより前の番号 | 判断。持ち越すか、外してバックログに戻すかを聞く（締めの扱いは `sprint-plan`） |
| 状態 | `status:accepting` と `status:in-progress` か `status:refining` が同居している | 機械的に後者を外す（`accepting.yml` の外し残り） |
| 状態 | 末端でない Issue に `status:accepting` が付いている | 判断（子を持つ Issue の受け入れ待ちはラベルで表さない） |
| マイルストーン | 付いていない | 判断。入るリリースを聞く |
| 領域 | `area:` が1つも無い | 判断 |

違反ではないが報告に含めるもの: サブ Issue が 0 のエピック（`issue-create` で分ける候補）。

### 3. 結果を見せる

Issue 番号ごとの表（番号、題、違反、直し方）にし、機械的に直せるものと判断が要るものに分けて見せる。違反の無い Issue は件数だけ書く。

### 4. 直す

機械的に直せるものは、まとめて `AskUserQuestion` で承認を得てから直す。判断が要るものは、`AskUserQuestion` で1件ずつ値を聞いてから直す。「直さない」も選べるようにし、選ばれたら理由を報告に残す。

```bash
gh api -X POST repos/{owner}/{repo}/issues/<番号>/labels -f 'labels[]=<名前>'
gh api -X DELETE "repos/{owner}/{repo}/issues/<番号>/labels/<名前>"
gh api -X PATCH repos/{owner}/{repo}/issues/<番号> -F milestone=<番号>
```

ラベルの名前の `:` はそのまま渡してよい。マイルストーンの番号は `gh api repos/{owner}/{repo}/milestones --jq '.[] | {number, title}'` で引く。親の付け替えは `issue-create` の手順 7 のコマンド（`sub_issues` と `-F replace_parent=true`）で行う。

## 完了条件

- 取得した全件を判定した
- 違反は「直した」か「判断待ち」か「直さない（理由つき）」のどれかに入っている
- 直したものは手順 1 のコマンドで取り直し、違反が消えたことを確かめた

直した Issue と残した Issue の一覧を報告する。
