-- 期限の無視を変える保存のたびに進む世代（#1662）。同期は読んだ世代を覚え、終わりの書き込み（成功、続き、失敗のすべて）で今の世代と違えば、
-- 保存が置いた「次の同期が全部を読む」印（last_success_at と sync_state_json の空）を上書きしない。
-- 値の比較では、同期の途中で 0→1→0 と往復した保存を見逃すため、世代で判定する。広げる変更（既定値のある NOT NULL の列を足すだけ）。
ALTER TABLE connections ADD COLUMN ignore_source_due_generation INTEGER NOT NULL DEFAULT 0;
