-- 接続の一覧が、取り込んだ項目の状態名（DISTINCT）を接続ごとに読むための索引（#1654）。
-- 取り込みが数万件の接続でも、表を読まずに索引だけで重複を除いて並べる。広げる変更（一意でない索引を足すだけ）。
CREATE INDEX task_sources_connection_status ON task_sources (connection_id, source_status);
