-- task_sources_connection_status (connection_id, source_status)（0045）が先頭の列に connection_id を持つので、
-- connection_id だけの索引 task_sources_connection_id（0022）は冗長になった（#1658）。
-- connection_id だけで引く文と、connection_id を指す外部キーの検査は、複合索引で引かれる。
-- 縮める変更（一意でない索引を消す）。#1656 を含む v0.27.0 の Release は 2026-11-27 に公開済み（タグが #1656 のマージコミット）。
-- 本番の /api/health の version が v0.27.0 以降であることは、マージか publish の前に人が確かめる（#1672）。
DROP INDEX task_sources_connection_id;
