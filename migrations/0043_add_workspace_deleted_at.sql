-- 終了済みのワークスペースの論理削除。既存のワークスペースはすべて未削除。
ALTER TABLE workspaces ADD COLUMN deleted_at TEXT CHECK (deleted_at IS NULL OR closed_at IS NOT NULL);
