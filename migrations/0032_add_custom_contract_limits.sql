-- 個別契約の標準値。既存プランの行と旧版が書く行は NULL のまま扱う。
ALTER TABLE organization_contracts ADD COLUMN custom_member_limit INTEGER;
ALTER TABLE organization_contracts ADD COLUMN custom_attachment_quota_bytes INTEGER;
