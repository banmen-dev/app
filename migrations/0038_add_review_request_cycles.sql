-- 広げる変更。旧版は追加した列と表を読まず、既存の一意キーは維持する。
ALTER TABLE task_sources ADD COLUMN review_cycle TEXT;
ALTER TABLE task_sources ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_sources ADD COLUMN last_received_at TEXT CHECK (last_received_at IS NULL OR last_received_at IS strftime('%Y-%m-%dT%H:%M:%fZ', last_received_at));

-- 完了回の経験値重複防止にも使う。完了との接続・付与は #1315。
CREATE TABLE review_request_cycles (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  review_cycle TEXT NOT NULL,
  completion_id TEXT REFERENCES completions(id),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  PRIMARY KEY (task_id, review_cycle)
);
CREATE INDEX review_request_cycles_completion ON review_request_cycles(completion_id);
