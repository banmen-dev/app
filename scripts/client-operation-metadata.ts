// 画面は操作の入力を検証せず、応答もサーバーで検証済み。ブラウザの束からだけ
// 未使用のスキーマを外す。Worker・CLI・テストは元の定義をそのまま読む。
import ts from 'typescript';
import type { Plugin } from 'vite';

export const clientOutputOperationNames = new Set(['me-avatar-upload', 'attachment-upload']);

// この2操作の応答は object/string/number だけ。元の定義から同じスキーマを
// Miniで組み、Classicのメソッド群を配らない。未対応の変更はビルドで止める。
function miniOutput(node: ts.Expression, source: ts.SourceFile): string {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'z'
  ) {
    const method = node.expression.name.text;
    if (['string', 'number'].includes(method) && node.arguments.length === 0) return `__sgClientOutputZod.${method}()`;
    if (method === 'object' && node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
      const fields = node.arguments[0].properties.map((property) => {
        if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name))
          throw new Error('client output の属性を直接書いてください');
        return `${property.name.getText(source)}: ${miniOutput(property.initializer, source)}`;
      });
      return `__sgClientOutputZod.object({${fields.join(',')}})`;
    }
  }
  throw new Error(`${source.fileName}: client output の Mini 対応と比較テストを更新してください`);
}

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
      let usesMini = false;
      let hasOperations = false;
      const operationBindings = new Set<string>(['defineOperation']);
      function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
          let root: ts.Expression = node.initializer.expression;
          while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root)) root = root.expression;
          if (
            ts.isIdentifier(root) &&
            root.text === 'z' &&
            ts.isPropertyAccessExpression(node.initializer.expression) &&
            !['config', 'parse', 'safeParse', 'parseAsync', 'safeParseAsync'].includes(
              node.initializer.expression.name.text,
            )
          ) {
            // 呼び出しだけにPUREを付けても、引数内の別のスキーマ生成は残る。
            // 初期化式全体を遅らせ、未使用なら引数もまとめて除く。
            edits.push({
              start: node.initializer.getStart(source),
              end: node.initializer.end,
              text: `/* @__PURE__ */ (() => (${node.initializer.getText(source)}))()`,
            });
            return;
          }
        }
        if (
          file.includes('/src/shared/operations/') &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'defineOperation' &&
          node.arguments.length === 1 &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          const properties = node.arguments[0].properties;
          hasOperations = true;
          function record(node: ts.Node) {
            if (ts.isTypeNode(node)) return;
            if (ts.isIdentifier(node)) operationBindings.add(node.text);
            ts.forEachChild(node, record);
          }
          record(node.arguments[0]);
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
          const keepOutput = clientOutputOperationNames.has(name.initializer.text);
          const kept = properties.filter((p) => {
            const key = p.name?.getText(source);
            return (
              ['name', 'mode', 'permission', 'workspace', 'clientTimeoutMs', 'response', 'body'].includes(key ?? '') ||
              (key === 'output' && keepOutput)
            );
          });
          const fields = kept.map((property) => {
            if (property.name?.getText(source) === 'output' && ts.isPropertyAssignment(property)) {
              usesMini = true;
              return `output: ${miniOutput(property.initializer, source)}`;
            }
            return property.getText(source);
          });
          edits.push({
            start: node.getStart(source),
            end: node.end,
            // 未使用の操作では output の生成もまとめて除ける。定義自体の検査は
            // Worker とテストで行い、ブラウザには縮めたオブジェクトだけを配る。
            text: `/* @__PURE__ */ (() => ({${fields.join(',')}}))()`,
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
      // input/outputだけが参照していたimportを残すと、手動の束のまとめ方が
      // 別画面専用のスキーマまで初回へ取り込む。型だけの参照は数えない。
      const transformed = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const used = new Set<string>();
      function collect(node: ts.Node) {
        if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
        if (ts.isIdentifier(node)) used.add(node.text);
        ts.forEachChild(node, collect);
      }
      collect(transformed);
      const keep = (name: string) => used.has(name) || !operationBindings.has(name);
      const printer = ts.createPrinter();
      for (const node of [...transformed.statements].reverse()) {
        if (!ts.isImportDeclaration(node) || !node.importClause || node.importClause.isTypeOnly) continue;
        const clause = node.importClause;
        const name = clause.name && keep(clause.name.text) ? clause.name : undefined;
        let bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          const elements = bindings.elements.filter((item) => item.isTypeOnly || keep(item.name.text));
          bindings = elements.length ? ts.factory.updateNamedImports(bindings, elements) : undefined;
        } else if (bindings && !keep(bindings.name.text)) bindings = undefined;
        const replacement =
          name || bindings
            ? printer.printNode(
                ts.EmitHint.Unspecified,
                ts.factory.updateImportDeclaration(
                  node,
                  node.modifiers,
                  ts.factory.updateImportClause(clause, false, name, bindings),
                  node.moduleSpecifier,
                  node.attributes,
                ),
                transformed,
              )
            : '';
        code = code.slice(0, node.getStart(transformed)) + replacement + code.slice(node.end);
      }
      if (hasOperations) {
        const shared = file.slice(0, file.indexOf('/src/shared/') + '/src/shared/'.length);
        code = `import ${JSON.stringify(`${shared}zod-config.ts`)};\n${code}`;
      }
      if (usesMini) code = `import * as __sgClientOutputZod from 'zod/mini';\n${code}`;
      return { code, map: null };
    },
  };
}
