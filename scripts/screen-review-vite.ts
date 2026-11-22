// Vite は SIGTERM で自身を終了する。撮影の後片付けを続けられるよう、撮影 CLI とは別のプロセスで起動する。
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = process.cwd();
const vite = await createServer({
  root,
  envDir: false,
  server: { host: 'localhost', strictPort: true, fs: { allow: [resolve(root, 'design/fonts')] } },
});
await vite.listen();
process.send?.('ready');
