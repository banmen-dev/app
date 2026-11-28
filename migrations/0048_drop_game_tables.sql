-- ゲームの仕組みを外した（#1431〜#1435）ので、使わなくなった表と索引を消す（縮める変更。#1438）。
-- 消す表: xp_grants（経験値）、thanks（感謝）、epic_party_members（討伐隊）。索引は表と一緒に消える。
-- 消す索引: tasks_created_by_open（経験値の見込みだけが使っていた。外部キーの検査は tasks_created_by が足りる）。
-- epics の列 reward_tier、canceled_at、canceled_by は、本番の版がまだ書くので残す（消すには epics の作り直しが要り、
-- 書くコードを外した版が本番に出た後の別の PR で行う）。
-- notifications.kind の CHECK にある party_assigned、reward_changed、thanked は残す（変えるには表の作り直しが要り、コードからは書かない）。

-- xp_grants は thanks、epics、自分の表を指すので、指される表より先に消す。
DROP TABLE xp_grants;
DROP TABLE thanks;
DROP TABLE epic_party_members;

DROP INDEX tasks_created_by_open;
