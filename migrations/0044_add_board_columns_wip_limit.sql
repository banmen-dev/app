-- 列の上限（仕掛かりの数の目安）。空は上限なし。完了の列には付けない（完了の列は溜まるのが正しい状態）。
-- 既存の列はすべて上限なし。超えても移動と追加は止めず、画面が知らせるだけ
ALTER TABLE board_columns ADD COLUMN wip_limit INTEGER CHECK (wip_limit IS NULL OR (wip_limit BETWEEN 1 AND 99 AND is_done = 0));
