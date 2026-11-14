-- 共通DBの請求専用権限。業務用の users/memberships と独立させる（#1240）。
-- 広げる変更。旧版の補償削除は請求行の無い作成直後の組織だけを扱う。
-- コードを戻しても、解約の物理削除には新しい子表を知る最新版のpurge生成器を使う。
CREATE TABLE billing_administrators (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'declined', 'revoked')),
  invited_by TEXT NOT NULL REFERENCES accounts (id),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (organization_id, account_id)
);
CREATE INDEX billing_administrators_account ON billing_administrators (account_id, status);
CREATE INDEX billing_administrators_invited_by ON billing_administrators (invited_by);
CREATE TABLE billing_admin_events (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  actor_account_id TEXT NOT NULL REFERENCES accounts (id),
  target_account_id TEXT NOT NULL REFERENCES accounts (id),
  action TEXT NOT NULL CHECK (action IN ('invited', 'accepted', 'declined', 'removed')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE INDEX billing_admin_events_organization ON billing_admin_events (organization_id, created_at DESC, id DESC);
CREATE INDEX billing_admin_events_actor ON billing_admin_events (actor_account_id);
CREATE INDEX billing_admin_events_target ON billing_admin_events (target_account_id);
