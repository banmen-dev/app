# 横書き用の共通フォント（#1236）

`@fontsource-variable/noto-sans-jp` 5.3.1 の共通の日本語の範囲（109〜119）と Latin から生成する。
元の文字範囲・100〜900 の可変軸・横書きの GSUB/GPOS 機能・ヒンティングを保ち、縦書き専用の `vert`、`vrt2`、`vhal`、`vpal`、`vkrn` と、到達しなくなった字形を外す。画面は横書きで、縦書きの CSS は持たない。縮小後の方が大きい場合は元のファイルを使う。異体字セレクタ（cmap format 14）、`.notdef` の輪郭、name表の著作権・ライセンス情報は保持する。

`python scripts/generate-boot-assets.py` で生成する。必要な Python の依存と版はスクリプトの先頭にある。通常の pnpm install/build では Python を使わず、この生成物を読む。Fontsource を更新したときは再生成し、前後の横書きの描画と計測を確認する。文字を削ったり、太さを固定したりしない。`python scripts/boot-font-assets.test.py` は異体字の全対応、400・500・600・700・900での異体字と`.notdef`の輪郭・送り幅、name表の著作権とライセンス情報を元と比較する。

`scripts/fontsource-woff2.ts` はこの12個だけを Vite の資産として読み、残りの文字範囲は Fontsource のファイルをそのまま使う。CSS の unicode-range と font-weight は変更しない。縦書きを導入する場合は元のフォントへ戻すか、その機能も保って再生成する。

OFL の LICENSE は元のパッケージからコピーする。
