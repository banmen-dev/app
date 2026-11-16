// 画面は操作の入力を検証せず、応答もサーバーで検証済み。ブラウザの束からだけ
// 未使用のスキーマを外す。Worker・CLI・テストは元の定義をそのまま読む。
import ts from 'typescript';
import type { Plugin } from 'vite';

export function clientOperationMetadata(): Plugin {
  return {
    name: 'client-operation-metadata',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    transform(code, id) {
      const file = id.split('?')[0].replaceAll('\\', '/');
      if (!file.includes('/src/shared/') || !file.endsWith('.ts')) return null;
      const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const edits: { start: number; end: number; text: string }[] = [];
      function visit(node: ts.Node) {
        if (
          file.includes('/src/shared/operations/') &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'defineOperation' &&
          node.arguments.length === 1 &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          const properties = node.arguments[0].properties;
          const name = properties.find((p) => p.name?.getText(source) === 'name');
          if (
            !name ||
            !ts.isPropertyAssignment(name) ||
            !ts.isStringLiteral(name.initializer) ||
            properties.some((property) => ts.isSpreadAssignment(property))
          ) {
            throw new Error(`${file}: 操作の定義は名前と各属性を直接書いてください`);
          }
          // バイナリのアップロードは画面側も応答を検証する。
          const keepOutput = ['me-avatar-upload', 'attachment-upload'].includes(name.initializer.text);
          const kept = properties.filter((p) => {
            const key = p.name?.getText(source);
            return (
              ['name', 'mode', 'permission', 'workspace', 'clientTimeoutMs', 'response', 'body'].includes(key ?? '') ||
              (key === 'output' && keepOutput)
            );
          });
          edits.push({
            start: node.getStart(source),
            end: node.end,
            // 未使用の操作では output の生成もまとめて除ける。定義自体の検査は
            // Worker とテストで行い、ブラウザには縮めたオブジェクトだけを配る。
            text: `/* @__PURE__ */ (() => ({${kept.map((p) => p.getText(source)).join(',')}}))()`,
          });
          return;
        }
        if (ts.isCallExpression(node)) {
          let root: ts.Expression = node.expression;
          while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root)) {
            root = root.expression;
          }
          const schemaMethod =
            ts.isPropertyAccessExpression(node.expression) &&
            ['extend', 'refine', 'optional', 'nullable', 'nullish', 'array', 'pick', 'omit', 'partial'].includes(
              node.expression.name.text,
            );
          if (
            ts.isIdentifier(root) &&
            ((root.text === 'z' && node.expression.getText(source) !== 'z.config') ||
              (root.text.endsWith('Schema') && schemaMethod))
          ) {
            edits.push({ start: node.getStart(source), end: node.getStart(source), text: '/* @__PURE__ */ ' });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      if (!edits.length) return null;
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
      }
      return { code, map: null };
    },
  };
}
