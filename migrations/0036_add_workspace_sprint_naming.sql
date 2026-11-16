-- Migration number: 0036
-- 広げる変更。既存のスプリントの名前は変えない。
ALTER TABLE workspaces ADD COLUMN sprint_name_template TEXT CHECK (sprint_name_template IS NULL OR length(sprint_name_template) <= 100);
ALTER TABLE workspaces ADD COLUMN sprint_number_next INTEGER NOT NULL DEFAULT 1 CHECK (sprint_number_next >= 1);

UPDATE workspaces
SET sprint_number_next = (
  SELECT count(*) + 1 FROM sprints
  WHERE sprints.workspace_id = workspaces.id AND sprints.deleted_at IS NULL
);
