-- task_sources_connection_status (connection_id, source_status)（0045）が先頭の列に connection_id を持つので、
-- connection_id だけの索引 task_sources_connection_id（0022）は冗長になった（#1658）。
-- connection_id だけで引く文と、connection_id を指す外部キーの検査は、複合索引で引かれる。
-- 縮める変更（一意でない索引を消す）。使わなくなった版（#1656 を含む v0.27.0）は本番に出ている。
DROP INDEX task_sources_connection_id;
