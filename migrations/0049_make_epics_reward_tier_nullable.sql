-- epics.reward_tier を NULL 可にする（値を広げる変更。#1676）。報酬の仕組みを外した（#1434）ので、作る操作は reward_tier を書かなくする。
-- NOT NULL を外すには表の作り直しが要る。列 canceled_at、canceled_by と、その CHECK、索引 epics_canceled_by は、本番の版がまだ
-- クリアで書くので残す（消すのは、この変更を含む Release が本番に出た後の別の PR）。
-- NULL を書くのはこの版の作る操作だけ。1つ前の版のコードは reward_tier を読まない（書くだけ）ので、戻しても落ちない。
PRAGMA defer_foreign_keys = true;

CREATE TABLE epics_new (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  title TEXT NOT NULL,
  body_md TEXT CHECK (length(body_md) <= 100000),
  category_id TEXT REFERENCES categories (id),
  due_on TEXT CHECK (due_on IS date(due_on)),
  link_url TEXT CHECK (link_url LIKE 'http://%' OR link_url LIKE 'https://%'),
  reward_tier TEXT CHECK (reward_tier IN ('small', 'medium', 'large')),
  requester_user_id TEXT NOT NULL REFERENCES users (id),
  created_by TEXT NOT NULL REFERENCES users (id),
  completed_at TEXT,
  completed_by TEXT REFERENCES users (id),
  canceled_at TEXT,
  canceled_by TEXT REFERENCES users (id),
  position TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (completed_at IS NULL OR canceled_at IS NULL)
);

INSERT INTO epics_new (
  id, workspace_id, title, body_md, category_id, due_on, link_url, reward_tier, requester_user_id, created_by,
  completed_at, completed_by, canceled_at, canceled_by, position, deleted_at, created_at, updated_at
)
SELECT
  id, workspace_id, title, body_md, category_id, due_on, link_url, reward_tier, requester_user_id, created_by,
  completed_at, completed_by, canceled_at, canceled_by, position, deleted_at, created_at, updated_at
FROM epics;

DROP TABLE epics;
ALTER TABLE epics_new RENAME TO epics;

CREATE INDEX epics_workspace ON epics (workspace_id, position) WHERE deleted_at IS NULL;
CREATE INDEX epics_requester_user ON epics (requester_user_id);
CREATE INDEX epics_created_by ON epics (created_by);
CREATE INDEX epics_completed_by ON epics (completed_by) WHERE completed_by IS NOT NULL;
CREATE INDEX epics_canceled_by ON epics (canceled_by) WHERE canceled_by IS NOT NULL;
CREATE INDEX epics_workspace_fk ON epics (workspace_id, deleted_at, position);
CREATE INDEX epics_category_fk ON epics (category_id) WHERE category_id IS NOT NULL;

PRAGMA defer_foreign_keys = false;
