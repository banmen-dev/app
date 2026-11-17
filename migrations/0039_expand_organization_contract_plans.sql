-- スモールとプロを読めるようにする。新しい値を書くのは、この版の本番リリース後（#1337）。
PRAGMA defer_foreign_keys = true;

CREATE TABLE organization_contracts_new (
  organization_id TEXT NOT NULL PRIMARY KEY REFERENCES organizations (id),
  plan TEXT NOT NULL CHECK (plan IN ('personal', 'small', 'team', 'business', 'pro', 'custom')),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'yearly')),
  extra_10gb_units INTEGER NOT NULL DEFAULT 0 CHECK (extra_10gb_units >= 0),
  extra_50gb_units INTEGER NOT NULL DEFAULT 0 CHECK (extra_50gb_units >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'),
  custom_member_limit INTEGER CHECK (custom_member_limit IS NULL OR
    (typeof(custom_member_limit) = 'integer' AND custom_member_limit BETWEEN 1 AND 10000)),
  custom_attachment_quota_bytes INTEGER CHECK (custom_attachment_quota_bytes IS NULL OR
    (typeof(custom_attachment_quota_bytes) = 'integer'
      AND custom_attachment_quota_bytes BETWEEN 1073741824 AND 109951162777600
      AND custom_attachment_quota_bytes % 1073741824 = 0))
);

INSERT INTO organization_contracts_new (organization_id, plan, billing_interval, extra_10gb_units, extra_50gb_units, created_at, updated_at, custom_member_limit, custom_attachment_quota_bytes)
SELECT organization_id, plan, billing_interval, extra_10gb_units, extra_50gb_units, created_at, updated_at, custom_member_limit, custom_attachment_quota_bytes FROM organization_contracts;
DROP TABLE organization_contracts;
ALTER TABLE organization_contracts_new RENAME TO organization_contracts;

-- organization_contracts の索引は主キーの自動索引のみ。トリガーは無い。
PRAGMA defer_foreign_keys = false;
