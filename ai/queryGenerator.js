import { buildComponentCatalog, extractMainReturn, listRoutes, listScreens, listTables, readOptionalProjectFile, readProjectFile, renderComponentCatalog } from './catalog.js';
import { requireOllama } from './config.js';
import { sha256 } from './generator.js';
import { insertMenuItem, readMenu } from './menu.js';
import { ollamaChat } from './ollama.js';
import { CODE_SYSTEM, repairPrompt } from './prompts.js';
import { queryPagePrompt } from './queryPrompt.js';
import { checkQueryConflicts, deriveQueryNames, normalizeQuerySpec } from './querySpec.js';
import { patchAppModule, patchAppRoutes } from './templates/patches.js';
import {
  buildQueryApiClient,
  buildQueryController,
  buildQueryDto,
  buildQueryModule,
  buildQueryService,
  buildQueryWebTypes,
  listQueryFunctionName,
  queryFilterParams,
} from './templates/query.js';
import { autoFix, loadTypeScript } from './typescript.js';
import { cleanGeneratedCode, validateFile } from './validator.js';

const ALLOWED_WEB_PACKAGES = ['react', 'lucide-react', 'clsx', '@tanstack/react-query'];

export async function prepareQuerySpec(projectDir, rawSpec) {
  const tables = await listTables(projectDir);
  const tableInfo = tables.get(rawSpec.table);

  if (!tableInfo) {
    return { spec: rawSpec, names: deriveQueryNames(rawSpec), errors: [`A tabela ${rawSpec.table} não existe mais nas migrations.`], warnings: [] };
  }

  const menu = await readMenu(projectDir);
  const raw = {
    ...rawSpec,
    columns: rawSpec.columns,
    filters: rawSpec.filters.map((filter) => ({ ...filter, kind: filter.kind })),
    conditions: rawSpec.conditions.map((condition) => ({ ...condition, value: condition.value === null ? '' : String(condition.value) })),
  };
  const { spec, errors, warnings } = normalizeQuerySpec(raw, { table: rawSpec.table, tableInfo, menu });
  const screens = (await listScreens(projectDir)).map((screen) => screen.key);

  if (!screens.includes(spec.screen)) {
    errors.push(`A permissão "${spec.screen}" não existe. Opções: ${screens.join(', ')}.`);
  }

  const names = deriveQueryNames(spec);
  errors.push(...await checkQueryConflicts({ projectDir, spec, names, routes: await listRoutes(projectDir) }));
  return { spec, names, errors, warnings };
}

function pageRules({ spec, names }) {
  const params = queryFilterParams(spec);

  return {
    allowedPackages: ALLOWED_WEB_PACKAGES,
    forbiddenImports: [{ pattern: /compan/i, reason: 'pertence à tela usada como referência.' }],
    requiredExports: [`${names.entity}Page`],
    mustContain: [
      { pattern: new RegExp(`\\b${listQueryFunctionName(names)}\\(`), message: `Busque os dados com ${listQueryFunctionName(names)}(page, pageSize, filters).` },
      { pattern: /enabled:\s*Boolean\(operatorId\)/, message: 'A query precisa de enabled: Boolean(operatorId).' },
      { pattern: /<DataTable[\s>]/, message: 'Mostre os registros com <DataTable>.' },
      { pattern: /<TablePagination[\s>]/, message: 'Inclua a paginação com <TablePagination>.' },
      ...spec.columns.map((column) => ({ pattern: new RegExp(`\\.${column.key}\\b`), message: `A tabela não mostra a coluna "${column.label}" (${column.key}).` })),
      ...params.map((param) => ({ pattern: new RegExp(`draft\\.${param.name}\\b`), message: `Falta o filtro "${param.label}" ligado a draft.${param.name}.` })),
    ],
    mustNotContain: [
      { pattern: /\b(create|update|delete)[A-Z]\w*\(|<\w+FormModal[\s>]|<ConfirmDialog[\s>]/, message: 'É uma tela só de consulta: remova cadastro, edição e exclusão.' },
      { pattern: /\bapi\.(get|post|put|patch|delete)\s*[<(]/, message: `Não chame a API direto: use ${listQueryFunctionName(names)}.` },
    ],
  };
}

export async function generateQuery({ projectDir, config, spec: rawSpec, onEvent = () => {} }) {
  const ollama = requireOllama(config);
  const { spec, names, errors } = await prepareQuerySpec(projectDir, rawSpec);

  if (errors.length > 0) {
    throw new Error(`O plano tem problemas:\n- ${errors.join('\n- ')}`);
  }

  const ts = loadTypeScript(projectDir, 'web');
  const virtualFiles = new Map();
  const files = [];

  function add(file) {
    virtualFiles.set(file.path, file.content);
    files.push(file);
    return file;
  }

  async function validate(file, rules, mode = 'full') {
    file.validation = await validateFile({ projectDir, relativePath: file.path, content: file.content, virtualFiles, rules, mode, lint: file.kind !== 'patch' });
    onEvent({ type: 'validated', path: file.path, validation: file.validation });
    return file.validation.valid;
  }

  onEvent({ type: 'stage', message: 'Gerando endpoint de consulta, tipos e cliente de API por template' });

  const context = { spec, names };
  const templates = [
    add({ action: 'create', kind: 'template', path: names.files.dto, content: buildQueryDto(context) }),
    add({ action: 'create', kind: 'template', path: names.files.service, content: buildQueryService(context) }),
    add({ action: 'create', kind: 'template', path: names.files.controller, content: buildQueryController(context) }),
    add({ action: 'create', kind: 'template', path: names.files.module, content: buildQueryModule(context) }),
    add({ action: 'create', kind: 'template', path: names.files.type, content: buildQueryWebTypes(context) }),
    add({ action: 'create', kind: 'template', path: names.files.apiClient, content: buildQueryApiClient(context) }),
  ];

  for (const file of templates) {
    await validate(file, {});
  }

  const appModuleOriginal = await readProjectFile(projectDir, names.files.appModule);
  const appModule = add({
    action: 'modify',
    kind: 'patch',
    path: names.files.appModule,
    content: patchAppModule({ ts, content: appModuleOriginal, names: { entityPlural: names.entity, kebabPlural: names.kebab } }).content,
    originalHash: sha256(appModuleOriginal),
  });

  await validate(appModule, {}, 'syntax');

  const appOriginal = await readProjectFile(projectDir, names.files.app);
  const appPatch = patchAppRoutes({ ts, content: appOriginal, spec: { route: spec.route }, names: { entityPlural: names.entity, kebabPlural: names.kebab, permission: names.permission } });
  const sidebarOriginal = await readProjectFile(projectDir, names.files.sidebar);
  const sidebarContent = insertMenuItem({ ts, content: sidebarOriginal, placement: spec.menu, entry: { to: spec.route, icon: spec.menuIcon, label: spec.title, screen: names.permission } });

  if (!files.every((file) => file.validation.valid)) {
    return { spec, names, files, valid: false };
  }

  const catalogEntries = await buildComponentCatalog(projectDir, config.ai.catalog.exclude);
  const catalog = renderComponentCatalog(catalogEntries.filter((entry) => ['PageHeader', 'DataTable', 'EmptyState', 'TablePagination'].includes(entry.name)));
  const referenceFile = await readOptionalProjectFile(projectDir, config.ai.references.page);
  const reference = referenceFile ? extractMainReturn(projectDir, config.ai.references.page, referenceFile) : '(sem referência)';

  onEvent({ type: 'stage', message: 'Gerando a página de consulta com a IA' });

  const prompt = queryPagePrompt({ spec, names, catalog, reference });
  const base = [{ role: 'system', content: CODE_SYSTEM }, { role: 'user', content: prompt }];
  const rules = pageRules({ spec, names });
  let messages = base;
  let page = null;

  for (let attempt = 1; attempt <= (config.ai.generation.maxRepairs ?? 2) + 1; attempt += 1) {
    onEvent({ type: 'generating', path: names.files.page, attempt });
    const { content: raw } = await ollamaChat({ ollama, attempt, messages, onProgress: (tokens) => onEvent({ type: 'progress', path: names.files.page, tokens }) });
    virtualFiles.set(names.files.page, cleanGeneratedCode(raw));
    const fixed = autoFix(projectDir, { virtualFiles, target: names.files.page });

    if (fixed.applied.length > 0) {
      onEvent({ type: 'autofix', path: names.files.page, applied: fixed.applied });
    }

    if (page) {
      page.content = fixed.content;
      virtualFiles.set(page.path, fixed.content);
    } else {
      page = add({ action: 'create', kind: 'ai', path: names.files.page, content: fixed.content });
    }

    page.attempts = attempt;

    if (await validate(page, rules)) {
      break;
    }

    messages = [...base, { role: 'assistant', content: page.content }, { role: 'user', content: repairPrompt({ relativePath: page.path, errors: page.validation.errors.slice(0, 25) }) }];
  }

  if (!page.validation.valid) {
    return { spec, names, files, valid: false };
  }

  onEvent({ type: 'stage', message: 'Registrando a rota e o item de menu' });

  const app = add({ action: 'modify', kind: 'patch', path: names.files.app, content: appPatch.content, originalHash: sha256(appOriginal), added: appPatch.added });
  await validate(app, {});

  const sidebar = add({ action: 'modify', kind: 'patch', path: names.files.sidebar, content: sidebarContent, originalHash: sha256(sidebarOriginal), added: [`menu ${spec.menu.parent ? `${spec.menu.group} › ${spec.menu.parent}` : spec.menu.group}${spec.menu.after ? ` depois de "${spec.menu.after}"` : ''} → ${spec.title}`] });
  await validate(sidebar, {});

  return { spec, names, files, valid: files.every((file) => file.validation.valid) };
}
