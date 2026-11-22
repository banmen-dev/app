import type { Plugin } from 'vite';

export const epicVariants = ['A', 'B', 'C'] as const;
export type EpicVariant = (typeof epicVariants)[number];

export function epicLoadingSource(source: string, variant: EpicVariant): string {
  const primary = 'callOperation(epicDetail, { workspace_id: params.id, epic_id: params.epicId }, options)';
  const secondary = 'callOperation(categoryRepositoryList, { workspace_id: params.id }, options)';
  const baseline = `  const [result, definitions] = await Promise.all([
    ${primary},
    ${secondary},
  ]);`;
  const definitions = 'definitions: definitions.ok ? definitions.data : null,';
  if (!source.includes(baseline) || !source.includes(definitions))
    throw new Error('エピック詳細の load が変わりました。計測器を見直してください');
  if (variant === 'A') return source;
  const reads =
    variant === 'B'
      ? `  const primaryRead = ${primary};\n  const definitions = ${secondary};\n  const result = await primaryRead;`
      : `  const result = await ${primary};`;
  const transformed = source.replace(baseline, reads);
  if (variant === 'B') return transformed.replace(definitions, 'definitions,');
  return transformed.replace(definitions, '').replace(/import \{ categoryRepositoryList \}[^\n]*\n/, '');
}

export function epicLoadingPlugin(variant: EpicVariant): Plugin {
  return {
    name: 'epic-loading-benchmark-only',
    enforce: 'pre',
    transform(source, id) {
      if (id.endsWith('/src/routes/[slug]/w/[id]/epics/[epicId]/+page.ts')) return epicLoadingSource(source, variant);
    },
  };
}
