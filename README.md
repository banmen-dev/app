# Banmen

チームのタスクを集め、スクラムで回すサービスです。Cloudflare Workers（Hono、D1、R2）と SvelteKit の SPA モードで作っています。

## 始め方

Node は `.node-version`、pnpm は `package.json` の `packageManager` の版を使います。
ワークツリーで始める場合は、[ワークツリーで作業する](docs/development.md#ワークツリーで作業する) に従って pnpm の保存先を確認し、依存を入れてから下の `pnpm db:seed` 以降を実行します。

```sh
pnpm install
pnpm db:seed   # 手元の D1 にマイグレーションを当て、seed を入れる
pnpm dev       # http://localhost:5173
```

`pnpm db:seed` は手元の D1 の行をすべて消してから seed を入れ直します。手元で入れたデータは失われるので、残したいときは実行しないでください。

テスト、型の検査、lint、build、本番と同じ配り方での確認などのコマンドは `CLAUDE.md` の「コマンド」にまとめています。ここには重ねて書きません。

## 開発の決まり

- `main` に直接コミットも push もしません。1 Issue に 1 ブランチ、1 PR で進めます。
- 手元では Issue 番号つきのワークツリーを切って作業します。手順は `docs/development.md` の「ワークツリーで作業する」。
- 画面の文言は言葉の辞書を通し、スクラムの言葉で出します。

## 文書

| 知りたいこと | 文書 |
| --- | --- |
| 要件 | `docs/requirements.md` |
| 誰が何をできるか | `docs/use-cases.md` |
| 表と列 | `docs/data-model.md` |
| 見た目の刻みと禁止 | `DESIGN.md` |
| 画面とデザインの決まり | `docs/design.md` |
| ブランチ、PR、CI/CD の流れ | `docs/development.md` |
| 本番の用意、出し方、戻し方 | `docs/operations.md` |
| レビューで繰り返された確認項目 | `REVIEW.md` |

全体の一覧は `CLAUDE.md` の「文書」にあります。

## ライセンス

`LICENSE` を参照してください。
