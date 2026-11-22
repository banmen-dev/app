-- ネオンのテーマ（値は modern）を消した。選んでいた人は、選んでいない（シンプル（自動））に戻す。0027 と同じ形。
-- 列の CHECK は modern を許したまま残す（CHECK を変えるには表を作り直すため）。アプリは modern を書かない。
UPDATE users SET theme = NULL WHERE theme = 'modern';
