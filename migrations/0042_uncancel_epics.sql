-- エピックの中止を外した（#1435）。中止していたエピックは、中止を解いて進行中に戻す。0041 と同じ形。
-- 列 canceled_at、canceled_by は表の CHECK と外部キーに出るので残す（消すには表を作り直すため）。アプリは読まず、書くのは
-- クリアのときに空に戻すことだけ（マイグレーションを当ててから版が切り替わるまでに、前の版が中止した行のため）。
UPDATE epics SET canceled_at = NULL, canceled_by = NULL WHERE canceled_at IS NOT NULL OR canceled_by IS NOT NULL;
