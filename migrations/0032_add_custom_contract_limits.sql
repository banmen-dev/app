-- 個別契約の標準値。既存プランの行と旧版が書く行は NULL のまま扱う。
-- 新しい列の値だけを検査し、旧版のプラン変更を妨げないよう plan との組の制約は付けない。
ALTER TABLE organization_contracts ADD COLUMN custom_member_limit INTEGER
  CHECK (custom_member_limit IS NULL OR
    (typeof(custom_member_limit) = 'integer' AND custom_member_limit BETWEEN 1 AND 10000));
ALTER TABLE organization_contracts ADD COLUMN custom_attachment_quota_bytes INTEGER
  CHECK (custom_attachment_quota_bytes IS NULL OR
    (typeof(custom_attachment_quota_bytes) = 'integer'
      AND custom_attachment_quota_bytes BETWEEN 1073741824 AND 109951162777600
      AND custom_attachment_quota_bytes % 1073741824 = 0));
