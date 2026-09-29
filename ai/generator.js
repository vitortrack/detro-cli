import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  buildComponentCatalog,
  extractMainReturn,
  listRoutes,
  listScreens,
  listTables,
  nextMigrationNumber,
  readOptionalProjectFile,
  readProjectFile,
  referenceableTables,
  renderComponentCatalog,
} from './catalog.js';
import { requireOllama } from './config.js';
import { ollamaChat } from './ollama.js';
import { activeField, CODE_SYSTEM, formModalPrompt, pagePrompt, repairPrompt } from './prompts.js';
import { checkConflicts, deriveNames, normalizeSpec } from './spec.js';
import { buildController, buildDto, buildModule, buildService } from './templates/backend.js';
import { buildMigration } from './templates/database.js';
import { buildApiClient, buildEntityName, buildWebTypes, emptyFormName, enumOptionsName, labelKey, optionsFunctionName, toFormDataName } from './templates/frontend.js';
import { patchAppModule, patchAppRoutes, patchScreens, patchSidebar } from './templates/patches.js';
import { autoFix, loadTypeScript } from './typescript.js';
import { cleanGeneratedCode, validateFile } from './validator.js';

const ALLOWED_WEB_PACKAGES = ['react', 'lucide-react', 'clsx', '@tanstack/react-query'];
const DIRECT_API_CALL = /\bapi\.(get|post|put|patch|delete)\s*[<(]/;
const PLACEHOLDER_TEXT = { pattern: /=\s*["'](\.\.\.|…|TODO|Lorem ipsum)["']|>\s*(\.\.\.|TODO)\s*</i, message: 'Há texto de exemplo ("...", "TODO") na tela. Escreva o texto real em português.' };

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function referencePattern(references) {
  const terms = new Set();

  for (const file of [references.formModal, references.page].filter(Boolean)) {
    const base = path.basename(file).replace(/\.(tsx|ts)$/, '').replace(/(FormModal|Page)$/, '');
    const dir = path.basename(path.dirname(file));

    if (base.length >= 4) {
      terms.add(base.toLowerCase());
    }

    if (!['components', 'pages', 'src'].includes(dir) && dir.length >= 4) {
      terms.add(dir.toLowerCase());
    }
  }

  return terms.size > 0 ? new RegExp([...terms].map(escapeRegex).join('|'), 'i') : null;
}

function requireTypeScript(projectDir) {
  for (const workspace of ['web', 'api']) {
    if (!loadTypeScript(projectDir, workspace)) {
      throw new Error(`TypeScript não encontrado em ${workspace}/node_modules. Rode "cd ${workspace} && npm install": o detro precisa dele para validar o código gerado.`);
    }
  }
}

function lucideIcons(projectDir) {
  try {
    return new Set(Object.keys(createRequire(path.join(projectDir, 'web', 'package.json'))('lucide-react')));
  } catch {
    return null;
  }
}

export async function prepareSpec(projectDir, rawSpec, requirements = [], analysis = null) {
  const screens = (await listScreens(projectDir)).map((screen) => screen.key);
  const tables = await listTables(projectDir);
  const references = referenceableTables(tables);
  const { spec, errors, warnings } = normalizeSpec(rawSpec, { screens, references, requirements, analysis });
  const names = deriveNames(spec, await nextMigrationNumber(projectDir));
  const icons = lucideIcons(projectDir);

  if (icons && !icons.has(spec.menuIcon)) {
    warnings.push(`Ícone "${spec.menuIcon}" não existe no lucide-react; usando "List".`);
    spec.menuIcon = 'List';
  }

  if (spec.entity) {
    errors.push(...await checkConflicts({
      projectDir,
      spec,
      names,
      screens,
      routes: await listRoutes(projectDir),
      tables,
    }));
  }

  return { spec, names, errors, warnings };
}

function validationChecks(field) {
  const name = escapeRegex(field.name);
  const checks = [];
  const label = field.label.toLowerCase();

  if (field.required && (field.type === 'string' || field.type === 'text')) {
    checks.push({
      pattern: new RegExp(`!\\s*form\\.${name}\\.trim\\(\\)|form\\.${name}\\.trim\\(\\)\\s*={2,3}\\s*(''|"")|form\\.${name}\\.trim\\(\\)\\.length\\s*(={2,3}\\s*0|<\\s*1)`),
      message: `O campo obrigatório "${field.label}" não é validado quando vazio. No handleSubmit, adicione: if (!form.${field.name}.trim()) { nextErrors.${field.name} = 'Preencha ${label}.'; }`,
    });
  }

  if (field.required && (field.type === 'integer' || field.type === 'decimal')) {
    checks.push({
      pattern: new RegExp(`form\\.${name}\\s*={2,3}\\s*(null|undefined)|(null|undefined)\\s*={2,3}\\s*form\\.${name}\\b`),
      message: `O campo obrigatório "${field.label}" não é validado quando vazio (null). No handleSubmit, adicione: if (form.${field.name} === null) { nextErrors.${field.name} = 'Preencha ${label}.'; }`,
    });
  }

  if (field.required && field.type === 'reference') {
    checks.push({
      pattern: new RegExp(`!\\s*form\\.${name}\\b|form\\.${name}\\s*={2,3}\\s*(''|"")|!\\s*form\\.${name}\\.trim\\(\\)`),
      message: `O campo obrigatório "${field.label}" não é validado quando vazio. No handleSubmit, adicione: if (!form.${field.name}) { nextErrors.${field.name} = 'Selecione ${label}.'; }`,
    });
  }

  if (field.required && field.type === 'date') {
    checks.push({
      pattern: new RegExp(`!\\s*form\\.${name}\\b|form\\.${name}\\s*={2,3}\\s*(''|"")`),
      message: `O campo obrigatório "${field.label}" não é validado quando vazio. No handleSubmit, adicione: if (!form.${field.name}) { nextErrors.${field.name} = 'Preencha ${label}.'; }`,
    });
  }

  if (field.min !== undefined) {
    checks.push({
      pattern: new RegExp(`form\\.${name}\\s*<\\s*${escapeRegex(String(field.min))}\\b|${escapeRegex(String(field.min))}\\s*>\\s*form\\.${name}\\b`),
      message: `Falta validar o mínimo de "${field.label}": if (form.${field.name} !== null && form.${field.name} < ${field.min}) { ... }`,
    });
  }

  if (field.max !== undefined) {
    checks.push({
      pattern: new RegExp(`form\\.${name}\\s*>\\s*${escapeRegex(String(field.max))}\\b|${escapeRegex(String(field.max))}\\s*<\\s*form\\.${name}\\b`),
      message: `Falta validar o máximo de "${field.label}": if (form.${field.name} !== null && form.${field.name} > ${field.max}) { ... }`,
    });
  }

  return checks;
}

function structureChecks(spec, names) {
  const checks = [];

  for (const field of spec.fields) {
    if (field.type === 'enum') {
      checks.push({
        pattern: new RegExp(`${enumOptionsName(names, field)}\\.map\\(`),
        message: `O select de "${field.label}" precisa listar as opções com ${enumOptionsName(names, field)}.map(...), importado de '@/types/${names.kebab}'.`,
      });
    }

    if (field.type === 'reference') {
      checks.push({
        pattern: new RegExp(`queryFn:\\s*${optionsFunctionName(names, field)}\\b`),
        message: `O select de "${field.label}" precisa carregar as opções com useQuery({ queryKey: [...], queryFn: ${optionsFunctionName(names, field)}, enabled: open }).`,
      });
    }
  }

  for (const rule of (spec.rules ?? []).filter((item) => item.type === 'compare')) {
    const left = escapeRegex(rule.left);
    const right = escapeRegex(rule.right);
    checks.push({
      pattern: new RegExp(`form\\.${left}[^;\\n]*[<>]=?[^;\\n]*form\\.${right}|form\\.${right}[^;\\n]*[<>]=?[^;\\n]*form\\.${left}`),
      message: `Falta a regra entre campos no handleSubmit: if (form.${rule.left} && form.${rule.right} && !(form.${rule.left} ${rule.operator} form.${rule.right})) { nextErrors.${rule.left} = '${rule.message}'; }`,
    });
  }

  return checks;
}

const LOCAL_FORBIDDEN = [
  { pattern: /^@tanstack\/react-query$/, reason: 'no modo só frontend os dados ficam no estado local, sem consultas.' },
  { pattern: /-api$|^@\/lib\/api$|^axios$/, reason: 'no modo só frontend não há chamadas HTTP.' },
];

function formRules({ spec, names, forbidden }) {
  return {
    allowedPackages: ALLOWED_WEB_PACKAGES,
    forbiddenImports: spec.scope === 'frontend' ? [...forbidden, ...LOCAL_FORBIDDEN] : forbidden,
    requiredExports: [`${names.entity}FormModal`],
    mustContain: [
      { pattern: new RegExp(`\\b${toFormDataName(names)}\\(`), message: `Ao abrir para edição, preencha o form com ${toFormDataName(names)}(${names.camel}) (já existe em '@/types/${names.kebab}').` },
      { pattern: new RegExp(`\\b${emptyFormName(names)}\\b`), message: `Use ${emptyFormName(names)} (de '@/types/${names.kebab}') como form vazio.` },
      { pattern: /preventDefault\(\)/, message: 'handleSubmit precisa chamar event.preventDefault().' },
      { pattern: /await\s+onSubmit\(/, message: 'O modal precisa chamar await onSubmit(form) dentro de try/catch.' },
      { pattern: new RegExp(`['"]@/types/${escapeRegex(names.kebab)}['"]`), message: `Importe os tipos de '@/types/${names.kebab}'.` },
      { pattern: /<Modal[\s>]/, message: 'Use o componente <Modal> do projeto.' },
      ...spec.fields.map((field) => ({
        pattern: new RegExp(`form\\.${field.name}\\b`),
        message: `O campo "${field.label}" não está ligado ao formulário: use form.${field.name} no input e na validação.`,
      })),
      ...spec.fields.flatMap((field) => validationChecks(field)),
      ...structureChecks(spec, names),
    ],
    mustNotContain: [
      { pattern: DIRECT_API_CALL, message: 'O modal não chama a API: quem salva é a página, via onSubmit.' },
      { pattern: /\bwindow\.alert\(|\balert\(/, message: 'Não use alert(); mostre o erro no próprio modal.' },
      PLACEHOLDER_TEXT,
    ],
  };
}

function pageRules({ spec, names, forbidden }) {
  const { entity, entityPlural } = names;
  const local = spec.scope === 'frontend';
  const active = activeField(spec);
  const conditional = [];
  const forbiddenContent = [];

  if (local) {
    conditional.push(
      { pattern: new RegExp(`\\b${buildEntityName(names)}\\(`), message: `Monte o registro com ${buildEntityName(names)}(form, atual) de '@/types/${names.kebab}' ao criar e ao editar.` },
      { pattern: new RegExp(`\\bset${entityPlural}\\(`), message: `Guarde a lista no estado local com set${entityPlural}(...).` },
    );
  } else {
    conditional.push(
      ...[`list${entityPlural}`, `create${entity}`, `update${entity}`, ...(spec.page?.delete ? [`delete${entity}`] : [])].map((fn) => ({
        pattern: new RegExp(`\\b${fn}\\(`),
        message: `A página precisa chamar ${fn}(...) de '@/lib/${names.kebab}-api'.`,
      })),
      { pattern: /invalidateQueries\(/, message: 'Depois de salvar, atualize a lista com queryClient.invalidateQueries({ queryKey: [...] }).' },
      { pattern: /enabled:\s*Boolean\(operatorId\)/, message: 'A query precisa de enabled: Boolean(operatorId) para não buscar sem operadora selecionada.' },
    );
  }

  if (spec.page?.delete) {
    conditional.push({ pattern: /<ConfirmDialog[\s>]/, message: 'Peça confirmação antes de excluir com <ConfirmDialog>.' });

    if (!local) {
      conditional.push({ pattern: /removeMutation\.error[\s\S]*<DataTable/, message: 'O erro de exclusão (removeMutation.error) deve ficar dentro do card, antes da tabela.' });
    }
  } else {
    forbiddenContent.push({ pattern: /<ConfirmDialog[\s>]|\bTrash2\b|\bdelete[A-Z]\w*\(/, message: 'O pedido não inclui excluir: remova a ação de exclusão (Trash2, ConfirmDialog, delete...).' });
  }

  if (spec.page?.toggleActive && active) {
    conditional.push({ pattern: new RegExp(`${active.name}:\\s*!\\s*\\w+\\.${active.name}\\b`), message: `Falta a ação de ativar/desativar: inverta ${active.name} (ex.: { ...item, ${active.name}: !item.${active.name} }).` });
  }

  if (spec.page?.statusBadge && active) {
    conditional.push({ pattern: /['"]Inativo['"]/, message: "A coluna Status precisa mostrar 'Ativo' ou 'Inativo' com destaque visual (badge)." });
  }

  return {
    allowedPackages: ALLOWED_WEB_PACKAGES,
    forbiddenImports: [...forbidden, { pattern: /^axios$/, reason: 'use as funções de @/lib/' + names.kebab + '-api.' }, ...(local ? LOCAL_FORBIDDEN : [])],
    requiredExports: [`${entityPlural}Page`],
    mustContain: [
      ...conditional,
      { pattern: new RegExp(`<${entity}FormModal[\\s>]`), message: `Use <${entity}FormModal> para cadastrar e editar.` },
      { pattern: new RegExp(`canEdit\\(\\s*['"]${names.permission}['"]\\s*\\)`), message: `Mostre os botões de criar/editar só quando canEdit('${names.permission}') for verdadeiro.` },
      ...spec.fields.map((field) => {
        const shown = field.type === 'reference' ? labelKey(field) : field.name;

        return {
          pattern: new RegExp(`\\.${shown}\\b`),
          message: field.type === 'reference'
            ? `A tabela deve mostrar o nome de "${field.label}" com ${names.camel}.${shown}, não o id.`
            : `A tabela não mostra o campo "${field.label}" (${field.name}).`,
        };
      }),
      ...spec.fields.filter((field) => field.type === 'enum').map((field) => ({
        pattern: new RegExp(`${enumOptionsName(names, field)}\\.find\\(`),
        message: `A coluna "${field.label}" deve mostrar o rótulo: ${enumOptionsName(names, field)}.find((option) => option.value === ${names.camel}.${field.name})?.label.`,
      })),
    ],
    mustNotContain: [
      ...forbiddenContent,
      { pattern: DIRECT_API_CALL, message: `Não chame a API direto: use as funções de '@/lib/${names.kebab}-api'.` },
      { pattern: /\bwindow\.confirm\(|\bconfirm\(|\balert\(/, message: 'Não use confirm()/alert() do navegador: use <ConfirmDialog>.' },
      PLACEHOLDER_TEXT,
    ],
  };
}

export async function generateCrud({ projectDir, config, spec: rawSpec, onEvent = () => {} }) {
  const ollama = requireOllama(config);
  requireTypeScript(projectDir);

  const { spec, names, errors } = await prepareSpec(projectDir, rawSpec);

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
    file.validation = await validateFile({
      projectDir,
      relativePath: file.path,
      content: file.content,
      virtualFiles,
      rules,
      mode,
      lint: file.kind !== 'patch',
    });

    onEvent({ type: 'validated', path: file.path, validation: file.validation });
    return file.validation.valid;
  }

  const local = spec.scope === 'frontend';
  const context = { spec, names };

  onEvent({ type: 'stage', message: local ? 'Gerando os tipos do front por template (modo só frontend)' : 'Gerando banco, backend e cliente de API por template' });

  if (!local) {
    const migration = add({ action: 'create', kind: 'template', path: names.files.migration, content: buildMigration({ ...context, number: names.files.migration.match(/(\d+)-/)[1] }) });
    migration.validation = {
      valid: true,
      errors: [],
      warnings: ['Revise a migration: o detro apply oferece aplicá-la no banco de dev (db/init só roda em volume vazio).'],
      imports: [],
    };
  }

  const permissionFiles = [];

  if (!local && spec.permissionMode === 'nova') {
    for (const key of ['webScreens', 'apiScreens']) {
      const original = await readProjectFile(projectDir, names.files[key]);
      const patch = patchScreens({
        ts,
        content: original,
        fileName: names.files[key],
        relatedKey: spec.screen,
        key: names.permission,
        label: spec.title,
      });

      permissionFiles.push(add({
        action: 'modify',
        kind: 'patch',
        path: names.files[key],
        content: patch.content,
        originalHash: sha256(original),
        added: patch.added,
      }));
    }
  }

  const templateFiles = local
    ? [add({ action: 'create', kind: 'template', path: names.files.type, content: buildWebTypes(context) })]
    : [
      add({ action: 'create', kind: 'template', path: names.files.dto, content: buildDto(context) }),
      add({ action: 'create', kind: 'template', path: names.files.service, content: buildService(context) }),
      add({ action: 'create', kind: 'template', path: names.files.controller, content: buildController(context) }),
      add({ action: 'create', kind: 'template', path: names.files.module, content: buildModule(context) }),
      add({ action: 'create', kind: 'template', path: names.files.type, content: buildWebTypes(context) }),
      add({ action: 'create', kind: 'template', path: names.files.apiClient, content: buildApiClient(context) }),
    ];

  for (const file of [...permissionFiles, ...templateFiles]) {
    await validate(file, {});
  }

  if (!local) {
    const appModuleOriginal = await readProjectFile(projectDir, names.files.appModule);
    const appModulePatch = patchAppModule({ ts, content: appModuleOriginal, names });
    const appModule = add({
      action: 'modify',
      kind: 'patch',
      path: names.files.appModule,
      content: appModulePatch.content,
      originalHash: sha256(appModuleOriginal),
      added: appModulePatch.added,
    });

    await validate(appModule, {}, 'syntax');
  }

  if (!files.every((file) => file.validation.valid)) {
    return { spec, names, files, valid: false };
  }

  const appOriginal = await readProjectFile(projectDir, names.files.app);
  const appPatch = patchAppRoutes({ ts, content: appOriginal, spec, names });
  const sidebarOriginal = await readProjectFile(projectDir, names.files.sidebar);
  const sidebarPatch = patchSidebar({ ts, content: sidebarOriginal, spec, names });

  const catalogEntries = await buildComponentCatalog(projectDir, config.ai.catalog.exclude);
  const pick = (wanted) => renderComponentCatalog(catalogEntries.filter((entry) => wanted.includes(entry.name)));
  const pattern = referencePattern(config.ai.references);
  const forbidden = pattern ? [{ pattern, reason: 'pertence à tela usada como referência, não à nova feature.' }] : [];

  const formReference = await readOptionalProjectFile(projectDir, config.ai.references.formModal);
  const pageReferenceFile = await readOptionalProjectFile(projectDir, config.ai.references.page);

  if (!formReference || !pageReferenceFile) {
    onEvent({ type: 'warning', message: 'Referência de modal/página não encontrada; ajuste ai.references em .detro/config.json para gerar no padrão visual do projeto.' });
  }

  async function aiStep({ relativePath, prompt, rules }) {
    const base = [
      { role: 'system', content: CODE_SYSTEM },
      { role: 'user', content: prompt },
    ];

    let messages = base;
    let file = null;
    const maxRepairs = config.ai.generation.maxRepairs ?? 2;

    for (let attempt = 1; attempt <= maxRepairs + 1; attempt += 1) {
      onEvent({ type: 'generating', path: relativePath, attempt });

      const { content: raw } = await ollamaChat({ attempt,
        ollama,
        messages,
        onProgress: (tokens) => onEvent({ type: 'progress', path: relativePath, tokens }),
      });

      virtualFiles.set(relativePath, cleanGeneratedCode(raw));
      const fixed = autoFix(projectDir, { virtualFiles, target: relativePath });
      const content = fixed.content;

      if (fixed.applied.length > 0) {
        onEvent({ type: 'autofix', path: relativePath, applied: fixed.applied });
      }

      if (file) {
        file.content = content;
        virtualFiles.set(relativePath, content);
      } else {
        file = add({ action: 'create', kind: 'ai', path: relativePath, content });
      }

      file.attempts = attempt;

      if (await validate(file, rules)) {
        break;
      }

      messages = [
        ...base,
        { role: 'assistant', content },
        { role: 'user', content: repairPrompt({ relativePath, errors: file.validation.errors.slice(0, 25) }) },
      ];
    }

    return file;
  }

  onEvent({ type: 'stage', message: 'Gerando o modal com a IA' });

  const formModal = await aiStep({
    relativePath: names.files.formModal,
    prompt: formModalPrompt({
      ...context,
      typesContent: virtualFiles.get(names.files.type),
      catalog: pick(['Modal', 'Field']),
      reference: formReference ?? '(sem referência)',
    }),
    rules: formRules({ ...context, forbidden }),
  });

  if (!formModal.validation.valid) {
    return { spec, names, files, valid: false };
  }

  onEvent({ type: 'stage', message: 'Gerando a página com a IA' });

  const page = await aiStep({
    relativePath: names.files.page,
    prompt: pagePrompt({
      ...context,
      catalog: pick(['PageHeader', 'DataTable', 'EmptyState', ...(local ? [] : ['TablePagination']), ...(spec.page?.delete ? ['ConfirmDialog'] : [])]),
      reference: pageReferenceFile ? extractMainReturn(projectDir, config.ai.references.page, pageReferenceFile) : '(sem referência)',
    }),
    rules: pageRules({ ...context, forbidden }),
  });

  if (!page.validation.valid) {
    return { spec, names, files, valid: false };
  }

  onEvent({ type: 'stage', message: 'Registrando a rota no App.tsx' });

  const app = add({
    action: 'modify',
    kind: 'patch',
    path: names.files.app,
    content: appPatch.content,
    originalHash: sha256(appOriginal),
    added: appPatch.added,
  });

  await validate(app, {});

  onEvent({ type: 'stage', message: 'Adicionando o item no menu lateral' });

  const sidebar = add({
    action: 'modify',
    kind: 'patch',
    path: names.files.sidebar,
    content: sidebarPatch.content,
    originalHash: sha256(sidebarOriginal),
    added: sidebarPatch.added,
  });

  await validate(sidebar, {});

  return {
    spec,
    names,
    files,
    valid: files.every((file) => file.validation.valid),
  };
}
