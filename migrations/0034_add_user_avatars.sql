-- プロフィール画像のメタデータ（#1265）。列と制約は docs/data-model.md の user_avatars の写し。組織の中の表で、1人1行（user_id が主キー）。
-- 広げる変更（表を足す）で、前の版のコードはこの表を読み書きしない。
-- 画像の中身は R2（バケット ATTACHMENTS）の <organization_id>/avatars/<user_id>/<id> に置く。object_key の CHECK でこの形を揃え、
-- 別の組織の接頭辞のファイルを指す行を作れなくする。
-- organization_id には外部キーを張らない。組織の中の表から共通の表へ張ってよい organization_id は users、workspaces、
-- organization_holidays、change_logs だけで（後で組織ごとに D1 を分けるとき、これらだけを外してアプリの検査に替える）、組織は users 経由で辿れる。
-- users の行を消すのはログインしていない待ちの行だけで、待ちの行は画像を持てない。user_id の外部キーの検査の索引は主キーが兼ねる。
-- INTEGER の列は整数に直せない値（1.5）を REAL のまま持ち、TEXT の列も BLOB をそのまま持つので、size_bytes は型も確かめる。

CREATE TABLE user_avatars (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users (id),
  id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE CHECK (object_key = organization_id || '/avatars/' || user_id || '/' || id),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 1 AND 524288),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z')
);
