---
name: screen-review
description: 実装と見本を撮り、独立した採点役に渡し、画面を直して撮り直す。
---

# screen-review（Claude）

[共通の手順](../../../docs/agent-workflows/screen-review.md) に従って対象を決め、撮影、採点、修正、引き渡しを行う。

進行役が、撮影の完了の表示に並ぶ画像の絶対パス（`pairs/` と `motion/` の合成画像）と、`design-rules.md`、`exclusions.md` の絶対パスを `Agent` で新しく起動する [`screen-critic`](../../agents/screen-critic.md) 1体に渡す。採点役の道具は `Read` のみでディレクトリを一覧できないので、周のディレクトリでなく画像を1枚ずつ渡す。読む資料は対の画像、演出の連続コマ、撮影時の `design-rules.md`（`docs/design.md` の2節の抜粋）、テキストの除外一覧に限る。採点役が使えなければ、共通手順の引き渡しにその理由を記す。
