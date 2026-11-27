// 発見の走査だけを確かめるテスト用の取り込み元。保存済みの項目を ID で取る段（#1543）を外し、要求数と頁の数を発見の走査だけで数える
import { githubImportSource } from '../../src/server/import/github/index.ts';
import type { ImportSource } from '../../src/server/import/source.ts';

export const discoveryOnly: ImportSource = { ...githubImportSource, fetchKnownItem: undefined };
