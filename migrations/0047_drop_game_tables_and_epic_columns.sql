-- ゲームの仕組みを外した（#1431〜#1435）ので、使わなくなった表と列を消す（縮める変更。#1438）。
-- 消す表: xp_grants（経験値）、thanks（感謝）、epic_party_members（討伐隊）。索引は表と一緒に消える。
-- 消す索引: tasks_created_by_open（経験値の見込みだけが使っていた。外部キーの検査は tasks_created_by が足りる）。
-- 消す列: epics.reward_tier、canceled_at、canceled_by。CHECK と外部キーに出る列があるので、epics を作り直す。
-- notifications.kind の CHECK にある party_assigned、reward_changed、thanked は残す（変えるには表の作り直しが要り、コードからは書かない）。

PRAGMA defer_foreign_keys = true;

-- xp_grants は thanks、epics、自分の表を指すので、指される表より先に消す。
DROP TABLE xp_grants;
DROP TABLE thanks;
DROP TABLE epic_party_members;

DROP INDEX tasks_created_by_open;

CREATE TABLE epics_new (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  title TEXT NOT NULL,
  body_md TEXT CHECK (length(body_md) <= 100000),
  category_id TEXT REFERENCES categories (id),
  due_on TEXT CHECK (due_on IS date(due_on)),
  link_url TEXT CHECK (link_url LIKE 'http://%' OR link_url LIKE 'https://%'),
  requester_user_id TEXT NOT NULL REFERENCES users (id),
  created_by TEXT NOT NULL REFERENCES users (id),
  completed_at TEXT,
  completed_by TEXT REFERENCES users (id),
  position TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO epics_new (
  id, workspace_id, title, body_md, category_id, due_on, link_url, requester_user_id, created_by,
  completed_at, completed_by, position, deleted_at, created_at, updated_at
)
SELECT
  id, workspace_id, title, body_md, category_id, due_on, link_url, requester_user_id, created_by,
  completed_at, completed_by, position, deleted_at, created_at, updated_at
FROM epics;

DROP TABLE epics;
ALTER TABLE epics_new RENAME TO epics;

CREATE INDEX epics_workspace ON epics (workspace_id, position) WHERE deleted_at IS NULL;
CREATE INDEX epics_requester_user ON epics (requester_user_id);
CREATE INDEX epics_created_by ON epics (created_by);
CREATE INDEX epics_completed_by ON epics (completed_by) WHERE completed_by IS NOT NULL;
CREATE INDEX epics_workspace_fk ON epics (workspace_id, deleted_at, position);
CREATE INDEX epics_category_fk ON epics (category_id) WHERE category_id IS NOT NULL;

PRAGMA defer_foreign_keys = false;
