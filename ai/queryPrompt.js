import { emptyQueryFiltersName, listQueryFunctionName, queryFilterParams, queryFiltersTypeName } from './templates/query.js';

function section(title, body) {
  return `=== ${title} ===\n${body.trim()}`;
}

function cellFor(column, row) {
  const value = `${row}.${column.key}`;

  switch (column.kind) {
    case 'number':
      return `${value} === null ? '—' : ${value}.toLocaleString('pt-BR', { maximumFractionDigits: 1 })`;
    case 'boolean':
      return `${value} === null ? '—' : ${value} ? 'Sim' : 'Não'`;
    case 'date':
      return `${value} ? ${value}.split('-').reverse().join('/') : '—'`;
    case 'datetime':
      return `${value} ? \`\${${value}.slice(8, 10)}/\${${value}.slice(5, 7)}/\${${value}.slice(0, 4)} \${${value}.slice(11, 16)}\` : '—'`;
    default:
      return `${value} ?? '—'`;
  }
}

function filterInput(param) {
  const id = `filtro-${param.name}`;
  const bind = `value={draft.${param.name}} onChange={(event) => setDraft((current) => ({ ...current, ${param.name}: event.target.value${param.kind === 'boolean' ? " as '' | 'true' | 'false'" : ''} }))}`;

  if (param.kind === 'boolean') {
    return `<div><label htmlFor="${id}" className="mb-1 block text-xs font-medium text-slate-600">${param.label}</label><select id="${id}" className="input" ${bind}><option value="">Todos</option><option value="true">Sim</option><option value="false">Não</option></select></div>`;
  }

  if (param.kind === 'search') {
    return `<div><label htmlFor="${id}" className="mb-1 block text-xs font-medium text-slate-600">${param.label}</label><input id="${id}" type="search" className="input" placeholder="Buscar por ${param.label.toLowerCase()}" autoComplete="off" ${bind} /></div>`;
  }

  const type = param.valueKind === 'number' ? 'number' : 'date';
  return `<div><label htmlFor="${id}" className="mb-1 block text-xs font-medium text-slate-600">${param.label} (${param.bound === 'min' ? 'de' : 'até'})</label><input id="${id}" type="${type}" className="input" ${bind} /></div>`;
}

export function queryPageImports(spec, names) {
  return [
    "import { useEffect, useState } from 'react';",
    "import { useQuery } from '@tanstack/react-query';",
    `import { ${spec.menuIcon}, X } from 'lucide-react';`,
    "import { DataTable } from '@/components/DataTable';",
    "import { EmptyState } from '@/components/EmptyState';",
    "import { PageHeader } from '@/components/PageHeader';",
    "import { TablePagination, type TablePageSize } from '@/components/TablePagination';",
    "import { extractApiErrorMessage } from '@/lib/api';",
    `import { ${listQueryFunctionName(names)} } from '@/lib/${names.kebab}-api';`,
    "import { useAuthStore } from '@/store/auth';",
    `import { ${emptyQueryFiltersName(names)}, type ${queryFiltersTypeName(names)} } from '@/types/${names.kebab}';`,
  ].join('\n');
}

export function queryPagePrompt({ spec, names, catalog, reference }) {
  const params = queryFilterParams(spec);
  const filtersType = queryFiltersTypeName(names);
  const empty = emptyQueryFiltersName(names);
  const row = 'row';
  const hasFilters = params.length > 0;

  const steps = [
    `export function ${names.entity}Page(). Tela SÓ de leitura: nada de cadastrar, editar ou excluir.`,
    `const operatorId = useAuthStore((state) => state.selectedOperatorId); estados: page (1), pageSize (25)${hasFilters ? `, draft (${filtersType}, começa com ${empty}) e filters (${filtersType}, começa com ${empty})` : ''}.`,
    hasFilters ? `useEffect em [draft]: const timeout = window.setTimeout(() => { setFilters(draft); setPage(1); }, 400); return () => window.clearTimeout(timeout);` : null,
    `const { data, isLoading, isFetching, error } = useQuery({ queryKey: ['${names.camel}', operatorId, page, pageSize${hasFilters ? ', filters' : ''}], queryFn: () => ${listQueryFunctionName(names)}(page, pageSize, ${hasFilters ? 'filters' : empty}), enabled: Boolean(operatorId), placeholderData: (previous) => previous }); const rows = data?.items ?? []; const meta = data?.meta ?? { page, limit: pageSize, total: 0, totalPages: 0 };`,
    `<PageHeader title="${spec.title}"${spec.subtitle ? ` subtitle="${spec.subtitle}"` : ''} />`,
    `<div className="px-6 pb-6"><div className="card"> contendo, nesta ordem:
${hasFilters ? `   - barra de filtros: <div className="border-b border-slate-200 bg-slate-50 p-4"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 xl:items-end"> com, nesta ordem:
${params.map((param) => `       ${filterInput(param)}`).join('\n')}
       <div><button type="button" className="btn-secondary inline-flex w-full items-center justify-center gap-1.5 xl:w-auto" onClick={() => setDraft(${empty})}><X size={14} />Limpar</button></div>
     </div><div className="mt-3 text-xs text-slate-500">{meta.total} registro(s)</div></div>` : '   - <div className="border-b border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">{meta.total} registro(s)</div>'}
   - isLoading → <div className="p-6 text-center text-sm text-slate-500">Carregando…</div>; error → <div className="p-6 text-center text-sm text-red-700">{extractApiErrorMessage(error)}</div>;
   - senão <DataTable rows={rows.map((item, index) => ({ ...item, id: ${spec.columns.some((column) => column.key === 'id') ? 'item.id ?? String(index)' : 'String(index)'} }))} columns={[...]} empty={<EmptyState icon={<${spec.menuIcon} size={32} />} title="Nenhum registro encontrado" message="${hasFilters ? 'Ajuste os filtros para ver outros resultados.' : 'Não há registros para mostrar.'}" />} /> seguido de <TablePagination page={meta.page} limit={meta.limit} total={meta.total} totalPages={meta.totalPages} emptyLabel="Nenhum registro" isFetching={isFetching} onPageChange={setPage} onLimitChange={(nextLimit: TablePageSize) => { setPageSize(nextLimit); setPage(1); }} />`,
  ].filter(Boolean);

  return [
    `ARQUIVO: ${names.files.page}`,
    `OBJETIVO: ${spec.title}. ${spec.subtitle}`.trim(),
    section('IMPORTS (comece o arquivo exatamente com estas linhas; não importe de nenhum outro lugar)', queryPageImports(spec, names)),
    section('COLUNAS DA TABELA (nesta ordem)', spec.columns.map((column) => `- header '${column.label}': cell: (${row}) => ${cellFor(column, row)}`).join('\n')),
    section('COMPORTAMENTO OBRIGATÓRIO', steps.map((step, index) => `${index + 1}. ${step}`).join('\n')),
    section('CATÁLOGO (componentes reais do projeto)', catalog),
    section('REFERÊNCIA (JSX real de outra tela; copie o visual, não os filtros nem os imports de lá)', reference),
    `Devolva SOMENTE o conteúdo completo de ${names.files.page}.`,
  ].join('\n\n');
}
