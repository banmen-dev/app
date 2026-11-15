-- 組織のホームの「最近の更新」（recent-activity、#1262）が、ワークスペースのコメントと変更の履歴を新しい順に引くための部分索引2つ。
-- 広げる変更（一意でない索引を足すだけ）で、前の版のコードは使わないが、戻しても動く。行を書き換える文は無く、索引を作るだけ。
--
-- comments_workspace_created: 消していないコメントだけを、ワークスペースごとに created_at と id の降順（カーソルの並び）で引く。
-- 部分索引にするのは、前の版の comment-list が計画を取られないようにするため。マイグレーションは新しい版に切り替える前に当たる
-- （戻した後も同じ）ので、前の版の一覧と件数の文（task_id = ? と workspace_id = ? の条件。一覧は ORDER BY created_at DESC, id DESC）の計画は、
-- この索引で変わってはいけない。全部の行を持つ索引にすると、一覧の文も件数の文も comments_task より後から作ったこの索引を選び、
-- ワークスペースの全コメントを読んでタスクで絞る計画になる。
-- 条件は deleted_at IS NULL ではなく body_md <> '' にする。CHECK ((deleted_at IS NULL) = (body_md <> '')) で同じ行になるが、
-- 前の版の件数の文は deleted_at IS NULL を持つので、deleted_at IS NULL の部分索引にするとその文に選ばれる。body_md <> '' は
-- 前の版のどの文にも無いので、選ばれない（test/recent-activity.test.ts が前の版の2つの文の計画で確かめる）。
-- 消したコメントは本文が空で、最近の更新に出さないので、索引に持たない。
-- recent-activity のコメントの文は、同じ式（body_md <> ''）を文字のまま条件に持つ（src/server/db/recent-activity-filter.ts）。
--
-- change_logs_recent_activity: 既にある change_logs_workspace (workspace_id, created_at) は id を持たず、種類や action を後から捨てるので、
-- 最近の更新に出ない行（権限、配分、接続などと、削除の行）が続くと、21件を集めるまで長く読む。出す行（task、story、epic の削除でない行）だけを持つ。
-- 既存の索引は消さない（task-history などの問い合わせは change_logs_entity などを使い続ける）。
-- 条件の式は src/server/operations/recent-activity.ts の文と同じ形に書く（SQLite は、問い合わせの条件が索引の条件と同じ式だと示せたときだけ部分索引を使う）。

CREATE INDEX comments_workspace_created ON comments (workspace_id, created_at, id) WHERE body_md <> '';

CREATE INDEX change_logs_recent_activity ON change_logs (workspace_id, created_at, id)
  WHERE entity_type IN ('task', 'story', 'epic') AND action <> 'delete';
