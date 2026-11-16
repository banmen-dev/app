// guard-bash.mjs を起動するテストの土台。guard-bash.mjs は毎回、入力の session_id と CLAUDE_CONFIG_DIR（無ければ ~/.claude）で
// 環境のファイルの状態を確かめる（shell-env-state.mjs）。テストを動かす人の ~/.claude の状態で結果が変わらないよう、
// 読み込んだ時点で、このプロセスと子の CLAUDE_CONFIG_DIR を空の一時ディレクトリに向ける。入力には HOOK_SESSION_ID を渡す
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOOK_SESSION_ID = '0a1b2c3d-0000-4000-8000-00000000test';

const configDir = mkdtempSync(path.join(os.tmpdir(), 'hook-config-'));
process.env.CLAUDE_CONFIG_DIR = configDir;
process.on('exit', () => rmSync(configDir, { recursive: true, force: true }));
