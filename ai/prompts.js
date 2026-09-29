import {
  buildEntityName,
  emptyFormName,
  enumOptionsName,
  enumTypeName,
  labelKey,
  optionsFunctionName,
  toFormDataName,
} from './templates/frontend.js';

const FIELD_INPUTS = {
  enum: (field, names) => `lista fechada → <select className="input h-9">${field.required ? '' : ' com uma primeira <option value="">Selecione</option>'} e {${enumOptionsName(names, field)}.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}; no form é ${field.required ? enumTypeName(names, field) : `${enumTypeName(names, field)} | ''`} (no onChange use event.target.value as ${enumTypeName(names, field)}${field.required ? '' : " | ''"})`,
  reference: (field, names) => `item de outra tabela → <select className="input h-9"> com <option value="">Selecione</option> e as opções de const { data: ${field.name.replace(/Id$/, '')}Options = [] } = useQuery({ queryKey: ['${names.camelPlural}', 'options', '${field.name}'], queryFn: ${optionsFunctionName(names, field)}, enabled: open }); → {${field.name.replace(/Id$/, '')}Options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}; no form é string com o id ('' quando vazio)`,
  string: (field) => `texto curto → <input className="input h-9" maxLength={${field.maxLength}}>; no form é string`,
  text: () => 'texto longo → <textarea className="input min-h-[88px]">; no form é string',
  integer: () => 'número inteiro → <input type="number" step="1" className="input h-9">; no form é number | null (campo vazio = null, senão Number(valor))',
  decimal: () => 'número decimal → <input type="number" step="0.01" className="input h-9">; no form é number | null (campo vazio = null, senão Number(valor))',
  boolean: () => 'sim/não → <input type="checkbox" className="h-4 w-4"> com checked/onChange; no form é boolean',
  date: () => 'data → <input type="date" className="input h-9">; no form é string AAAA-MM-DD ("" quando vazio)',
};

const STATUS_BADGE = (row, field) => `<span className={clsx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1', ${row}.${field.name} ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-slate-100 text-slate-600 ring-slate-200')}>{${row}.${field.name} ? 'Ativo' : 'Inativo'}</span>`;

const COLUMN_FORMATS = {
  enum: (field, row, names) => `${enumOptionsName(names, field)}.find((option) => option.value === ${row}.${field.name})?.label ?? ${field.required ? `${row}.${field.name}` : "'—'"}`,
  reference: (field, row) => `${row}.${labelKey(field)} ?? '—'`,
  string: (field, row) => `${row}.${field.name}${field.required ? '' : " ?? '—'"}`,
  text: (field, row) => `<span className="block max-w-xs truncate">{${row}.${field.name} ?? '—'}</span>`,
  integer: (field, row) => field.required
    ? `${row}.${field.name}.toLocaleString('pt-BR')`
    : `${row}.${field.name} === null ? '—' : ${row}.${field.name}.toLocaleString('pt-BR')`,
  decimal: (field, row) => field.required
    ? `${row}.${field.name}.toLocaleString('pt-BR', { maximumFractionDigits: 2 })`
    : `${row}.${field.name} === null ? '—' : ${row}.${field.name}.toLocaleString('pt-BR', { maximumFractionDigits: 2 })`,
  boolean: (field, row) => `${row}.${field.name} ? 'Sim' : 'Não'`,
  date: (field, row) => field.required
    ? `${row}.${field.name}.split('-').reverse().join('/')`
    : `${row}.${field.name} ? ${row}.${field.name}.split('-').reverse().join('/') : '—'`,
};

export const CODE_SYSTEM = `
Você gera UM arquivo React + TypeScript para o painel web do projeto.

Responda SOMENTE com o conteúdo completo do arquivo. Sem markdown, sem \`\`\`, sem explicação antes ou depois.

Regras do projeto:
- React 18 + TypeScript strict. Estilo só com classes Tailwind e as classes do projeto: btn-primary, btn-secondary, btn-ghost, btn-danger, input, label, card.
- Pacotes permitidos: react, lucide-react, clsx, @tanstack/react-query. Módulos internos: só os listados em IMPORTS, CONTRATOS e CATÁLOGO, sempre com o alias "@/".
- Todo identificador usado precisa estar importado. Todo import, variável e parâmetro declarado precisa ser usado: variável não usada quebra o build.
- Use os componentes do CATÁLOGO com as props exatamente como estão descritas.
- Textos visíveis em português do Brasil. Mensagens de erro dizem o que o usuário deve fazer ("Preencha o nome.").
- Não use any. Não use export default. Não escreva comentários.
- Faça SÓ o que está em COMPORTAMENTO OBRIGATÓRIO: nada de ações, colunas ou chamadas extras.
- A REFERÊNCIA é código real de outra tela: copie o visual e a organização, nunca os campos, nomes ou imports dela.
`.trim();

function gendered(spec, masculine, feminine) {
  return spec.gender === 'f' ? feminine : masculine;
}

function describeValidation(field) {
  const rules = [];

  if (field.required && field.type === 'enum') {
    return '';
  }

  if (field.required && field.type === 'reference') {
    rules.push(`obrigatório ('' é erro: "Selecione ${field.label.toLowerCase()}.")`);
  } else if (field.required) {
    rules.push(field.type === 'integer' || field.type === 'decimal'
      ? `obrigatório (null é erro: "Preencha ${field.label.toLowerCase()}.")`
      : `obrigatório (vazio após trim é erro: "Preencha ${field.label.toLowerCase()}.")`);
  }

  if (field.min !== undefined) {
    rules.push(`se preenchido, >= ${field.min}`);
  }

  if (field.max !== undefined) {
    rules.push(`se preenchido, <= ${field.max}`);
  }

  return rules.length > 0 ? ` Validação: ${rules.join('; ')}.` : '';
}

export function activeField(spec) {
  return spec.fields.find((field) => field.type === 'boolean' && /^(active|ativo|enabled|isActive)$/i.test(field.name)) ?? null;
}

function modalImports(spec, names) {
  const enums = spec.fields.filter((field) => field.type === 'enum');
  const references = spec.fields.filter((field) => field.type === 'reference');
  const typeNames = [names.entity, `${names.entity}FormData`, ...enums.map((field) => enumTypeName(names, field))];
  const values = [emptyFormName(names), toFormDataName(names), ...enums.map((field) => enumOptionsName(names, field))];

  return [
    "import { type FormEvent, useEffect, useState } from 'react';",
    references.length > 0 ? "import { useQuery } from '@tanstack/react-query';" : null,
    `import { ${spec.menuIcon}, LoaderCircle } from 'lucide-react';`,
    "import { Field } from '@/components/Field';",
    "import { Modal } from '@/components/Modal';",
    `import type { ${typeNames.join(', ')} } from '@/types/${names.kebab}';`,
    `import { ${values.join(', ')} } from '@/types/${names.kebab}';`,
    references.length > 0 ? `import { ${references.map((field) => optionsFunctionName(names, field)).join(', ')} } from '@/lib/${names.kebab}-api';` : null,
  ].filter(Boolean).join('\n');
}

function section(title, body) {
  return `=== ${title} ===\n${body.trim()}`;
}

export function formModalPrompt({ spec, names, typesContent, catalog, reference }) {
  const { entity, camel } = names;
  const formId = `${names.kebab}-form`;

  const fields = spec.fields.map((field, index) =>
    `${index + 1}. ${field.name} — "${field.label}": ${FIELD_INPUTS[field.type](field, names)}.${describeValidation(field)}`).join('\n');

  const contract = `
interface ${entity}FormModalProps {
  open: boolean;
  ${camel}: ${entity} | null;
  loading: boolean;
  onClose: () => void;
  onSubmit: (form: ${entity}FormData) => Promise<void>;
}

export function ${entity}FormModal({ open, ${camel}, loading, onClose, onSubmit }: ${entity}FormModalProps)
`;

  const compareRules = (spec.rules ?? []).filter((item) => item.type === 'compare');

  const behavior = `
1. Estados: const [form, setForm] = useState<${entity}FormData>(${emptyFormName(names)}); error (string) e fieldErrors (Partial<Record<keyof ${entity}FormData, string>>).
2. useEffect com dependências [${camel}, open]: se !open, retorna; limpa error e fieldErrors; setForm(${camel} ? ${toFormDataName(names)}(${camel}) : ${emptyFormName(names)});
3. handleClose(): se loading, ignora; senão limpa os erros e chama onClose().
4. async handleSubmit(event: FormEvent<HTMLFormElement>): event.preventDefault(); valida TODOS os campos com as regras acima montando const nextErrors: Partial<Record<keyof ${entity}FormData, string>> = {}; salva em fieldErrors; se houver erro, retorna sem enviar; senão faz await onSubmit(form) dentro de try/catch e, no catch, setError(cause instanceof Error ? cause.message : 'Não foi possível salvar ${gendered(spec, 'o', 'a')} ${spec.labelSingular}.').
5. <Modal open={open} title={${camel} ? 'Editar ${spec.labelSingular}' : '${spec.page?.createLabel ?? `${gendered(spec, 'Novo', 'Nova')} ${spec.labelSingular}`}'} onClose={handleClose} icon={<${spec.menuIcon} size={20} />} size="md" footer={...}>, com footer contendo botão Cancelar (type="button", className="btn-secondary", disabled={loading}) e botão salvar (type="submit", form="${formId}", className="btn-primary inline-flex items-center gap-2", disabled={loading}) que mostra <LoaderCircle size={16} className="animate-spin" /> e 'Salvando...' enquanto loading.
6. <form id="${formId}" onSubmit={handleSubmit} className="space-y-4 py-4"> com um <Field compact label="..." htmlFor="${names.kebab}-<campo>" error={fieldErrors.<campo>}> em volta de cada input (id igual ao htmlFor). Ao editar um campo, atualize o form com setForm((current) => ({ ...current, <campo>: valor })).
7. Se error estiver preenchido, mostre-o no fim do form em <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">.
${compareRules.map((rule, index) => `${8 + index}. Regra entre campos, também no handleSubmit: if (form.${rule.left} ${spec.fields.find((field) => field.name === rule.left)?.type === 'date' ? '' : '!== null '}&& form.${rule.right} ${spec.fields.find((field) => field.name === rule.right)?.type === 'date' ? '' : '!== null '}&& !(form.${rule.left} ${rule.operator} form.${rule.right})) { nextErrors.${rule.left} = '${rule.message.replaceAll("'", "\\'")}'; }`).join('\n')}
`;

  return [
    `ARQUIVO: ${names.files.formModal}`,
    `OBJETIVO: modal de cadastro e edição de ${spec.labelSingular}.`,
    section('IMPORTS (comece o arquivo exatamente com estas linhas; não importe de nenhum outro lugar)', modalImports(spec, names)),
    section('CAMPOS (todos, nesta ordem)', fields),
    section('CONTRATO (copie a interface de props e a assinatura exatamente)', contract),
    section(`TIPOS JÁ EXISTENTES (${names.files.type})`, typesContent),
    section('COMPORTAMENTO OBRIGATÓRIO', behavior),
    section('CATÁLOGO (componentes reais do projeto)', `${catalog}\n- ${spec.menuIcon} no cabeçalho do Modal; LoaderCircle só no spinner do botão`),
    section('REFERÊNCIA (visual de outro modal real; não copie campos, nomes nem imports de lá)', reference),
    `Devolva SOMENTE o conteúdo completo de ${names.files.formModal}.`,
  ].join('\n\n');
}

function columnsFor(spec, names, row) {
  const status = spec.page?.statusBadge ? activeField(spec) : null;

  return spec.fields.map((field) => (field === status
    ? `- header 'Status': cell: (${row}) => ${STATUS_BADGE(row, field)}`
    : `- header '${field.label}': cell: (${row}) => ${COLUMN_FORMATS[field.type](field, row, names)}`)).join('\n');
}

function actionButtons(spec, names, row, { toggleCall, deleteCall }) {
  const active = activeField(spec);
  const buttons = [`<button type="button" className="btn-ghost p-2" onClick={() => setEditing(${row})} title="Editar"><Pencil size={14} /></button>`];

  if (spec.page?.toggleActive && active) {
    buttons.push(`<button type="button" className="btn-ghost p-2" onClick={() => ${toggleCall}} title={${row}.${active.name} ? 'Desativar' : 'Ativar'}><Power size={14} /></button>`);
  }

  if (spec.page?.delete) {
    buttons.push(`<button type="button" className="btn-ghost p-2 text-red-700 hover:bg-red-50" onClick={() => ${deleteCall}} title="Excluir"><Trash2 size={14} /></button>`);
  }

  return `<div className="inline-flex gap-1">${buttons.join('')}</div>`;
}

function pageIcons(spec, names) {
  return [
    'Pencil',
    'Plus',
    spec.page?.toggleActive && activeField(spec) ? 'Power' : null,
    spec.page?.search && names.searchField ? 'Search' : null,
    spec.page?.delete ? 'Trash2' : null,
  ].filter(Boolean).sort();
}

function searchBar(spec, names, countExpression) {
  const field = spec.page?.search ? names.searchField : null;

  return field
    ? `<div className="border-b border-slate-200 bg-slate-50 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="relative w-full max-w-sm"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} className="input pl-9" placeholder="Buscar por ${field.label.toLowerCase()}" autoComplete="off" /></div><span className="text-xs text-slate-500">{${countExpression}} ${spec.labelSingular}(s)</span></div></div>`
    : `<div className="border-b border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">{${countExpression}} ${spec.labelSingular}(s)</div>`;
}

function emptyState(spec) {
  return `<EmptyState title="Nenhum${spec.gender === 'f' ? 'a' : ''} ${spec.labelSingular} cadastrad${spec.gender === 'f' ? 'a' : 'o'}" message="Clique em ${spec.page?.createLabel ?? 'Novo'} para começar." />`;
}

function confirmDialog(spec, names, onConfirm, loading) {
  const display = names.searchField ? names.searchField.name : 'id';
  return `<ConfirmDialog open={confirmDelete !== null} message={\`Excluir ${gendered(spec, 'o', 'a')} ${spec.labelSingular} "\${confirmDelete?.${display} ?? ''}"? Esta ação não pode ser desfeita.\`}${loading ? ` loading={${loading}}` : ''} onConfirm={() => { if (confirmDelete) ${onConfirm}; }} onCancel={() => setConfirmDelete(null)} />`;
}

function pageImportsApi(spec, names) {
  const enums = spec.fields.filter((field) => field.type === 'enum');
  const functions = [`create${names.entity}`, spec.page?.delete ? `delete${names.entity}` : null, `list${names.entityPlural}`, `update${names.entity}`].filter(Boolean);
  const needsClsx = spec.page?.statusBadge && activeField(spec);
  const typeValues = [...enums.map((field) => enumOptionsName(names, field)), spec.page?.toggleActive && activeField(spec) ? toFormDataName(names) : null].filter(Boolean);

  return [
    `import { ${spec.page?.search && names.searchField ? 'useEffect, ' : ''}useState } from 'react';`,
    "import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';",
    needsClsx ? "import clsx from 'clsx';" : null,
    `import { ${pageIcons(spec, names).join(', ')} } from 'lucide-react';`,
    spec.page?.delete ? "import { ConfirmDialog } from '@/components/ConfirmDialog';" : null,
    "import { DataTable } from '@/components/DataTable';",
    "import { EmptyState } from '@/components/EmptyState';",
    "import { PageHeader } from '@/components/PageHeader';",
    "import { TablePagination, type TablePageSize } from '@/components/TablePagination';",
    `import { ${names.entity}FormModal } from '@/components/${names.kebabPlural}/${names.entity}FormModal';`,
    "import { extractApiErrorMessage } from '@/lib/api';",
    `import { ${functions.join(', ')} } from '@/lib/${names.kebab}-api';`,
    "import { useAuthStore } from '@/store/auth';",
    `import type { ${names.entity}, ${names.entity}FormData } from '@/types/${names.kebab}';`,
    typeValues.length > 0 ? `import { ${typeValues.join(', ')} } from '@/types/${names.kebab}';` : null,
  ].filter(Boolean).join('\n');
}

function pageImportsLocal(spec, names) {
  const enums = spec.fields.filter((field) => field.type === 'enum');
  const needsClsx = spec.page?.statusBadge && activeField(spec);
  const hasSearch = spec.page?.search && names.searchField;

  return [
    `import { ${hasSearch ? 'useMemo, ' : ''}useState } from 'react';`,
    needsClsx ? "import clsx from 'clsx';" : null,
    `import { ${pageIcons(spec, names).join(', ')} } from 'lucide-react';`,
    spec.page?.delete ? "import { ConfirmDialog } from '@/components/ConfirmDialog';" : null,
    "import { DataTable } from '@/components/DataTable';",
    "import { EmptyState } from '@/components/EmptyState';",
    "import { PageHeader } from '@/components/PageHeader';",
    `import { ${names.entity}FormModal } from '@/components/${names.kebabPlural}/${names.entity}FormModal';`,
    "import { useAuthStore } from '@/store/auth';",
    `import type { ${names.entity}, ${names.entity}FormData } from '@/types/${names.kebab}';`,
    `import { ${[buildEntityName(names), ...enums.map((field) => enumOptionsName(names, field))].join(', ')} } from '@/types/${names.kebab}';`,
  ].filter(Boolean).join('\n');
}

function apiBehavior(spec, names) {
  const { entity, entityPlural, camel, camelPlural } = names;
  const searchField = spec.page?.search ? names.searchField : null;
  const active = activeField(spec);
  const toggle = spec.page?.toggleActive && active;
  const steps = [];

  steps.push(`export function ${entityPlural}Page().`);
  steps.push(`Estados: ${searchField ? "search (''), debouncedSearch (''), " : ''}page (1), pageSize (25), editing (${entity} | 'new' | null), ${spec.page?.delete ? `confirmDelete (${entity} | null), ` : ''}saving (false). const queryClient = useQueryClient(); const operatorId = useAuthStore((state) => state.selectedOperatorId); const canEdit = useAuthStore((state) => state.canEdit);`);

  if (searchField) {
    steps.push('useEffect em [search]: const timeout = window.setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 400); return () => window.clearTimeout(timeout);');
  }

  steps.push(`const { data, isLoading, isFetching, error } = useQuery({ queryKey: ['${camelPlural}', operatorId, page, pageSize${searchField ? ', debouncedSearch' : ''}], queryFn: () => list${entityPlural}({ page, limit: pageSize${searchField ? ', search: debouncedSearch' : ''} }), enabled: Boolean(operatorId), placeholderData: (previous) => previous }); const ${camelPlural} = data?.items ?? []; const meta = data?.meta ?? { page, limit: pageSize, total: 0, totalPages: 0 };`);
  steps.push(`async function handleSave(form: ${entity}FormData): Promise<void> { setSaving(true); try { if (editing && editing !== 'new') await update${entity}(editing.id, form); else await create${entity}(form); await queryClient.invalidateQueries({ queryKey: ['${camelPlural}'] }); setEditing(null); } catch (requestError) { throw new Error(extractApiErrorMessage(requestError)); } finally { setSaving(false); } }`);

  if (spec.page?.delete) {
    steps.push(`const removeMutation = useMutation({ mutationFn: (id: string) => delete${entity}(id), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['${camelPlural}'] }); setConfirmDelete(null); }, onError: () => setConfirmDelete(null) });`);
  }

  if (toggle) {
    steps.push(`const toggleMutation = useMutation({ mutationFn: (item: ${entity}) => update${entity}(item.id, { ...${toFormDataName(names)}(item), ${active.name}: !item.${active.name} }), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['${camelPlural}'] }); } });`);
  }

  steps.push(`<PageHeader title="${spec.title}" subtitle="${spec.labelPlural[0].toUpperCase()}${spec.labelPlural.slice(1)} ${spec.gender === 'f' ? 'cadastradas' : 'cadastrados'} na operadora atual" actions={canEdit('${names.permission}') && (<button type="button" className="btn-primary" onClick={() => setEditing('new')} disabled={!operatorId}><Plus size={14} className="mr-1" />${spec.page?.createLabel}</button>)} />`);
  steps.push(`<div className="px-6 pb-6"><div className="card"> contendo, nesta ordem:
   - ${searchBar(spec, names, 'meta.total')}
${spec.page?.delete ? '   - {removeMutation.error && (<div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{extractApiErrorMessage(removeMutation.error)}</div>)}\n' : ''}${toggle ? '   - {toggleMutation.error && (<div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{extractApiErrorMessage(toggleMutation.error)}</div>)}\n' : ''}   - isLoading → <div className="p-6 text-center text-sm text-slate-500">Carregando…</div>; error → <div className="p-6 text-center text-sm text-red-700">{extractApiErrorMessage(error)}</div>;
   - senão <DataTable rows={${camelPlural}} columns={[...]} empty={${emptyState(spec)}} /> seguido de <TablePagination page={meta.page} limit={meta.limit} total={meta.total} totalPages={meta.totalPages} emptyLabel="Nenhum${spec.gender === 'f' ? 'a' : ''} ${spec.labelSingular}" isFetching={isFetching} onPageChange={setPage} onLimitChange={(nextLimit: TablePageSize) => { setPageSize(nextLimit); setPage(1); }} />`);
  steps.push(`Coluna de ações (header '', className 'text-right'): cell: (${camel}) => canEdit('${names.permission}') ? ${actionButtons(spec, names, camel, { toggleCall: `toggleMutation.mutate(${camel})`, deleteCall: `setConfirmDelete(${camel})` })} : null`);
  steps.push(`<${entity}FormModal open={editing !== null} ${camel}={editing === 'new' ? null : editing} loading={saving} onClose={() => { if (!saving) setEditing(null); }} onSubmit={handleSave} />`);

  if (spec.page?.delete) {
    steps.push(confirmDialog(spec, names, 'removeMutation.mutate(confirmDelete.id)', 'removeMutation.isPending'));
  }

  return steps;
}

function localBehavior(spec, names) {
  const { entity, entityPlural, camel, camelPlural } = names;
  const searchField = spec.page?.search ? names.searchField : null;
  const active = activeField(spec);
  const toggle = spec.page?.toggleActive && active;
  const blockDelete = (spec.rules ?? []).filter((rule) => rule.type === 'blockDelete');
  const steps = [];

  steps.push(`export function ${entityPlural}Page(). Os dados ficam SÓ no estado local da página: nada de API, useQuery ou fetch.`);
  steps.push(`Estados: const [${camelPlural}, set${entityPlural}] = useState<${entity}[]>([]); editing (${entity} | 'new' | null)${spec.page?.delete ? `, confirmDelete (${entity} | null)` : ''}${blockDelete.length > 0 ? ', deleteError (string)' : ''}${searchField ? ", search ('')" : ''}. const canEdit = useAuthStore((state) => state.canEdit);`);

  if (searchField) {
    steps.push(`const visible = useMemo(() => { const term = search.trim().toLowerCase(); return term ? ${camelPlural}.filter((item) => item.${searchField.name}.toLowerCase().includes(term)) : ${camelPlural}; }, [${camelPlural}, search]);`);
  }

  steps.push(`async function handleSave(form: ${entity}FormData): Promise<void> { if (editing && editing !== 'new') { const current = editing; set${entityPlural}((items) => items.map((item) => (item.id === current.id ? ${buildEntityName(names)}(form, item) : item))); } else { set${entityPlural}((items) => [${buildEntityName(names)}(form, null), ...items]); } setEditing(null); }`);

  if (toggle) {
    steps.push(`function handleToggle(target: ${entity}): void { set${entityPlural}((items) => items.map((item) => (item.id === target.id ? { ...item, ${active.name}: !item.${active.name}, updatedAt: new Date().toISOString() } : item))); }`);
  }

  if (spec.page?.delete) {
    const guards = blockDelete.map((rule) => `if ((${JSON.stringify(rule.values).replaceAll('"', "'")} as unknown[]).includes(target.${rule.field})) { setDeleteError('${rule.message.replaceAll("'", "\\'")}'); setConfirmDelete(null); return; }`).join(' ');
    steps.push(`function handleDelete(target: ${entity}): void { ${guards} set${entityPlural}((items) => items.filter((item) => item.id !== target.id)); setConfirmDelete(null); }`);
  }

  steps.push(`<PageHeader title="${spec.title}" subtitle="${spec.labelPlural[0].toUpperCase()}${spec.labelPlural.slice(1)} ${spec.gender === 'f' ? 'cadastradas' : 'cadastrados'} nesta sessão" actions={canEdit('${names.permission}') && (<button type="button" className="btn-primary" onClick={() => setEditing('new')}><Plus size={14} className="mr-1" />${spec.page?.createLabel}</button>)} />`);
  steps.push(`<div className="px-6 pb-6"><div className="card"> contendo, nesta ordem:
   - ${searchBar(spec, names, searchField ? 'visible.length' : `${camelPlural}.length`)}
${blockDelete.length > 0 ? '   - {deleteError && (<div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{deleteError}</div>)}\n' : ''}   - <DataTable rows={${searchField ? 'visible' : camelPlural}} columns={[...]} empty={${emptyState(spec)}} />`);
  steps.push(`Coluna de ações (header 'Ações', className 'text-right'): cell: (${camel}) => canEdit('${names.permission}') ? ${actionButtons(spec, names, camel, { toggleCall: `handleToggle(${camel})`, deleteCall: `setConfirmDelete(${camel})` })} : null`);
  steps.push(`<${entity}FormModal open={editing !== null} ${camel}={editing === 'new' ? null : editing} loading={false} onClose={() => setEditing(null)} onSubmit={handleSave} />`);

  if (spec.page?.delete) {
    steps.push(confirmDialog(spec, names, 'handleDelete(confirmDelete)', null));
  }

  return steps;
}

export function pagePrompt({ spec, names, catalog, reference }) {
  const local = spec.scope === 'frontend';
  const steps = local ? localBehavior(spec, names) : apiBehavior(spec, names);
  const actions = ['editar', spec.page?.toggleActive && activeField(spec) ? 'ativar/desativar' : null, spec.page?.delete ? 'excluir' : null].filter(Boolean);

  return [
    `ARQUIVO: ${names.files.page}`,
    `OBJETIVO: tela de ${spec.labelPlural} com listagem${local ? ' (dados só em memória)' : ' paginada'}, cadastro e ${actions.join(', ')}.${spec.page?.delete ? '' : ' NÃO há exclusão.'}`,
    section('IMPORTS (comece o arquivo exatamente com estas linhas; não importe de nenhum outro lugar)', local ? pageImportsLocal(spec, names) : pageImportsApi(spec, names)),
    section(`CONTRATO DO MODAL (@/components/${names.kebabPlural}/${names.entity}FormModal)`, `props: { open: boolean; ${names.camel}: ${names.entity} | null; loading: boolean; onClose: () => void; onSubmit: (form: ${names.entity}FormData) => Promise<void> }${local ? `\n${buildEntityName(names)}(form: ${names.entity}FormData, current: ${names.entity} | null): ${names.entity}  (monta o registro com id, datas e valores limpos)` : ''}`),
    section('COLUNAS DA TABELA (uma por campo, nesta ordem, mais a coluna de ações)', columnsFor(spec, names, names.camel)),
    section('COMPORTAMENTO OBRIGATÓRIO', steps.map((step, index) => `${index + 1}. ${step}`).join('\n')),
    section('CATÁLOGO (componentes reais do projeto)', catalog),
    section('REFERÊNCIA (JSX real de outra tela; copie o visual, não os filtros, imports, CompanyImportModal, tooltips nem DeleteWithDependenciesDialog)', reference),
    `Devolva SOMENTE o conteúdo completo de ${names.files.page}.`,
  ].join('\n\n');
}

export function repairPrompt({ relativePath, errors }) {
  return [
    `O arquivo ${relativePath} que você devolveu tem estes problemas, encontrados pelo compilador TypeScript e pelas regras do projeto:`,
    errors.map((error) => `- ${error}`).join('\n'),
    'Corrija TODOS e devolva o arquivo COMPLETO de novo, só o código, sem markdown e sem explicação.',
  ].join('\n\n');
}
