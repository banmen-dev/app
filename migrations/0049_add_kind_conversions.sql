-- 種類の変更の対応表（#1647）。タスクをストーリーかエピックに変えると、行き先の表に作り直し、元は論理削除する。
-- この表は、元の種類と ID、先の種類と ID、変えた人、日時を1行ずつ残す。列と制約は docs/data-model.md の kind_conversions の写し。組織の中の表。
-- 広げる変更（表を足す）で、前の版のコードはこの表を読み書きしない。行は消さない（元の ID から先を引くため）。
-- 元と先は種類ごとに違う表の行を指すので、外部キーにしない（from_id、to_id は、tasks、stories、epics のどれかの ID）。
-- 元は1度しか変えられないので、(workspace_id, from_kind, from_id) を一意にする。同時に2回変えても、2つ目の行は入らない。
-- この一意の索引は、workspaces への外部キーの検査と、元から先を引く読み出しも兼ねる。converted_by も users を指すので索引を足す。
-- 先から元を引く索引（workspace_id、to_kind、to_id）は、ワークスペースで絞る読み出し（次のタスクで足す、ストーリーとエピックの種類の変更）に使う。

CREATE TABLE kind_conversions (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  from_kind TEXT NOT NULL CHECK (from_kind IN ('epic', 'story', 'task')),
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL CHECK (to_kind IN ('epic', 'story', 'task')),
  to_id TEXT NOT NULL,
  converted_by TEXT NOT NULL REFERENCES users (id),
  converted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', converted_at) IS converted_at),
  CHECK (from_kind <> to_kind)
);

CREATE UNIQUE INDEX kind_conversions_from ON kind_conversions (workspace_id, from_kind, from_id);
CREATE INDEX kind_conversions_to ON kind_conversions (workspace_id, to_kind, to_id);
CREATE INDEX kind_conversions_converted_by ON kind_conversions (converted_by);
