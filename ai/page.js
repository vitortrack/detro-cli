import { access } from 'node:fs/promises';
import path from 'node:path';

import { buildComponentCatalog, extractMainReturn, listRoutes, listScreens, readOptionalProjectFile, readProjectFile, renderComponentCatalog } from './catalog.js';
import { requireOllama } from './config.js';
import { prepareEdit } from './editor.js';
import { sha256 } from './generator.js';
import { insertMenuItem, readMenu } from './menu.js';
import { ollamaChat, ollamaJson } from './ollama.js';
import { CODE_SYSTEM, repairPrompt } from './prompts.js';
import { toKebab, toPascal } from './spec.js';
import { patchAppRoutes } from './templates/patches.js';
import { autoFix, loadTypeScript } from './typescript.js';
import { cleanGeneratedCode, validateFile } from './validator.js';

const ALLOWED = ['react', 'lucide-react', 'clsx'];
const FORBIDDEN = [
  { pattern: /^@tanstack\/react-query$/, reason: 'a tela é só frontend, com estado local.' },
  { pattern: /-api$|^@\/lib\/api$|^axios$/, reason: 'a tela é só frontend: nada de HTTP.' },
  { pattern: /compan/i, reason: 'pertence à tela usada como referência.' },
];
const NO_HTTP = { pattern: /\bfetch\(|\bapi\.(get|post|put|patch|delete)\b|\buseQuery\(|\bnew WebSocket\(|\bEventSource\(/, message: 'A tela é só frontend: remova chamadas HTTP, websocket ou SSE.' };

export function acceptanceCriteria(request) {
  const lines = String(request).split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s+.*(resultado esperado|crit[ée]rios de aceite|aceite|checklist|deve ser poss[íi]vel)/i.test(line) || /^\s*ao finalizar deve ser poss[íi]vel/i.test(line));

  if (start < 0) {
    return [];
  }

  const items = [];

  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line) && items.length > 0) {
      break;
    }

    const match = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*;?\s*$/);

    if (match) {
      items.push(match[1].replace(/\*\*/g, '').replace(/[;.]$/, ''));
    }
  }

  return items.slice(0, 25);
}

const CODE_EVIDENCE = [
  { when: /\benter\b/i, need: [/['"]Enter['"]/, /onKeyDown=/], hint: "trate onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); enviar(); } }} no campo de texto" },
  { when: /(topo|ordena|mais recente|recentes? primeiro)/i, need: [/\.(sort|toSorted)\(/], hint: 'derive a lista ordenada com useMemo e [...lista].sort((a, b) => ...) pela data da última mensagem' },
  { when: /(diferenci|enviadas e recebidas|alinhamento)/i, need: [/justify-end|ml-auto|self-end|items-end|flex-row-reverse|text-right/], hint: "alinhe as mensagens do usuário atual à direita (ex.: clsx('flex', minha ? 'justify-end' : 'justify-start')) com cor diferente" },
  { when: /(estados? vazios?|nenhum[a]? .* encontrad|selecione uma)/i, need: [/<EmptyState[\s>]/], hint: 'use <EmptyState> para lista vazia e para nenhuma seleção' },
  { when: /(impedir|evitar|n[ãa]o permitir).*(vazi|espa[çc]os)/i, need: [/\.trim\(\)/], hint: 'recuse o envio quando o texto.trim() estiver vazio' },
  { when: /(n[ãa]o lid|contador)/i, need: [/unread|naoLid|contador|count/i], hint: 'mostre o contador de não lidas e zere-o no handler que abre a conversa' },
  { when: /\bbusca|\bbuscar|\bfiltr/i, need: [/toLowerCase\(\)|toLocaleLowerCase\(\)/], hint: 'filtre com useMemo comparando texto.trim().toLowerCase()' },
];

function deterministicMisses(code, criteria) {
  const misses = new Map();

  criteria.forEach((text, index) => {
    for (const rule of CODE_EVIDENCE) {
      if (rule.when.test(text) && !rule.need.every((pattern) => pattern.test(code))) {
        misses.set(index + 1, rule.hint);
      }
    }
  });

  return misses;
}

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'array', items: { type: 'string' } },
    derived: { type: 'array', items: { type: 'string' } },
    handlers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, trigger: { type: 'string' }, does: { type: 'string' }, criteria: { type: 'array', items: { type: 'integer' } } },
        required: ['name', 'trigger', 'does', 'criteria'],
      },
    },
    layout: { type: 'string' },
  },
  required: ['state', 'derived', 'handlers', 'layout'],
};

async function designPage({ ollama, request, types, criteria, onProgress }) {
  const design = await ollamaJson({
    ollama,
    onProgress,
    schema: DESIGN_SCHEMA,
    messages: [
      {
        role: 'system',
        content: 'Você planeja um componente React ANTES de escrevê-lo. Responda SOMENTE com JSON. state: cada useState no formato "nome: Tipo — para quê" (só a fonte da verdade; nada que dê para calcular). derived: cada valor calculado com useMemo, no formato "nome = de onde vem (filtro/ordenação)". handlers: cada função de evento com name, trigger (elemento e evento, ex.: "textarea onKeyDown"), does (o que muda no estado, passo a passo, sem mutar) e criteria (números dos critérios que ela atende). layout: as regiões da tela em uma frase. Todo critério precisa aparecer em algum handler ou em derived.',
      },
      { role: 'user', content: `TIPOS E DADOS:\n${types}\n\nCRITÉRIOS:\n${criteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\nPEDIDO:\n${request.slice(0, 6000)}` },
    ],
  });

  const handlers = Array.isArray(design.handlers) ? design.handlers : [];
  const lines = [
    `Estado: ${(design.state ?? []).join('; ')}`,
    `Derivados (useMemo): ${(design.derived ?? []).join('; ')}`,
    ...handlers.map((item) => `- ${item.name} (${item.trigger}): ${item.does}${item.criteria?.length ? ` [critérios ${item.criteria.join(', ')}]` : ''}`),
    `Layout: ${design.layout ?? ''}`,
  ];

  return lines.join('\n');
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, ok: { type: 'boolean' }, evidence: { type: 'string' } },
        required: ['id', 'ok', 'evidence'],
      },
    },
  },
  required: ['results'],
};

async function verifyCriteria({ ollama, code, criteria, onProgress }) {
  const result = await ollamaJson({
    ollama,
    onProgress,
    schema: VERIFY_SCHEMA,
    messages: [
      {
        role: 'system',
        content: 'Você confere se um componente React atende a cada critério de aceite. Responda SOMENTE com JSON {"results": [{"id", "ok", "evidence"}]}. ok=true SÓ se houver código que implementa o critério de verdade (um handler ligado ao elemento, um estado que muda, uma ordenação aplicada); evidence = o trecho exato do código que prova. Sem trecho que prove, ok=false e evidence diz o que falta. Um estado sem setter, um handler que nunca é chamado ou um elemento sem onClick NÃO contam.',
      },
      { role: 'user', content: `CRITÉRIOS:\n${criteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\nCÓDIGO:\n${code}` },
    ],
  });

  const misses = deterministicMisses(code, criteria);

  return criteria.map((text, index) => {
    if (misses.has(index + 1)) {
      return { id: index + 1, text, ok: false, hard: true, evidence: `falta no código: ${misses.get(index + 1)}` };
    }

    const found = (result.results ?? []).find((item) => Number(item.id) === index + 1);
    const evidence = String(found?.evidence ?? '').trim();
    const proven = Boolean(found?.ok) && evidence.length >= 8 && code.includes(evidence.replace(/\s+/g, ' ').slice(0, 20).trim().split(' ')[0]);
    return { id: index + 1, text, ok: proven, hard: false, evidence };
  });
}

function slug(value) {
  return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function exists(projectDir, file) {
  try {
    await access(path.join(projectDir, file));
    return true;
  } catch {
    return false;
  }
}

function menuTree(menu) {
  return menu.groups.map((group) => `${group.label}: ${menu.items.filter((item) => item.group === group.label && !item.parent).map((item) => `${item.label}${item.screen ? ` [${item.screen}]` : ''}`).join(', ')}`).join('\n');
}

export async function preparePageSpec(projectDir, spec) {
  const errors = [];
  const routes = await listRoutes(projectDir);
  const screens = (await listScreens(projectDir)).map((screen) => screen.key);
  const menu = await readMenu(projectDir);

  for (const file of [spec.files.page, spec.files.types]) {
    if (await exists(projectDir, file)) {
      errors.push(`Já existe ${file}. Troque o nome da página no plano.`);
    }
  }

  if (routes.includes(spec.route)) {
    errors.push(`A rota ${spec.route} já existe em web/src/App.tsx.`);
  }

  if (!screens.includes(spec.screen)) {
    errors.push(`A permissão "${spec.screen}" não existe. Opções: ${screens.join(', ')}.`);
  }

  if (menu.items.some((item) => item.group === spec.menu.group && item.label === spec.menuLabel)) {
    errors.push(`Já existe o item "${spec.menuLabel}" em ${spec.menu.group}.`);
  }

  return { spec, errors };
}

export async function createPagePlan({ projectDir, config, request, analysis, onProgress, onStage = () => {} }) {
  const ollama = requireOllama(config);
  onStage('Lendo menu, rotas e permissões do projeto');
  const menu = await readMenu(projectDir);
  const screens = await listScreens(projectDir);

  onStage('Decidindo onde a tela entra no sistema');
  const raw = await ollamaJson({
    ollama,
    onProgress,
    schema: {
      type: 'object',
      properties: {
        menuGroup: { type: 'string', enum: menu.groups.map((group) => group.label) },
        menuAfter: { type: 'string', enum: ['', ...menu.items.map((item) => item.label)] },
        menuLabel: { type: 'string' },
        menuIcon: { type: 'string' },
        screen: { type: 'string', enum: screens.map((screen) => screen.key) },
        reason: { type: 'string' },
      },
      required: ['menuGroup', 'menuAfter', 'menuLabel', 'menuIcon', 'screen', 'reason'],
    },
    messages: [
      {
        role: 'system',
        content: 'Você decide onde uma nova tela entra no menu do projeto. Responda SOMENTE com JSON. menuGroup: o grupo que o pedido cita. menuAfter: o item depois do qual entrar ("" = no fim). menuLabel: nome do item, no estilo dos vizinhos. menuIcon: ícone do lucide-react em PascalCase. screen: a permissão existente mais adequada (o pedido não pode criar permissão nova). reason: uma frase em português.',
      },
      { role: 'user', content: `MENU ATUAL (grupo: itens [permissão]):\n${menuTree(menu)}\n\nPERMISSÕES: ${screens.map((screen) => `${screen.key} (${screen.label})`).join(', ')}\n\nPEDIDO:\n${request.slice(0, 6000)}` },
    ],
  });

  const siblings = menu.items.filter((item) => item.group === raw.menuGroup && item.to?.startsWith('/'));
  const groupScreens = [...new Set(siblings.map((item) => item.screen).filter(Boolean))];

  if (groupScreens.length > 0 && !groupScreens.includes(raw.screen)) {
    onStage('Escolhendo a permissão entre as usadas no grupo');
    const choice = await ollamaJson({
      ollama,
      onProgress,
      schema: { type: 'object', properties: { screen: { type: 'string', enum: groupScreens }, reason: { type: 'string' } }, required: ['screen', 'reason'] },
      messages: [
        { role: 'system', content: 'Escolha, entre as permissões usadas no grupo do menu, a que melhor controla quem pode ver a nova tela. Responda SOMENTE com JSON {"screen", "reason"}; reason em português.' },
        { role: 'user', content: `PERMISSÕES DO GRUPO: ${groupScreens.map((key) => `${key} (${screens.find((screen) => screen.key === key)?.label ?? key}; usada em ${siblings.filter((item) => item.screen === key).map((item) => item.label).join(', ')})`).join('; ')}\n\nPEDIDO:\n${request.slice(0, 3000)}` },
      ],
    });

    raw.screen = choice.screen;
    raw.reason = choice.reason;
  }

  const prefixes = siblings.map((item) => item.to.split('/').filter(Boolean)[0]).filter(Boolean);
  const prefix = prefixes.sort((a, b) => prefixes.filter((item) => item === b).length - prefixes.filter((item) => item === a).length)[0];
  const component = analysis.names.page ?? `${toPascal(raw.menuLabel)}Page`;
  const base = component.replace(/Page$/, '') || component;
  const menuLabel = String(raw.menuLabel ?? '').trim() || analysis.title || base;
  const title = analysis.title ?? menuLabel;
  const route = `/${[prefix, slug(menuLabel)].filter(Boolean).join('/')}`;

  const spec = {
    kind: 'page',
    component,
    title,
    route,
    screen: raw.screen,
    menuLabel,
    menuIcon: toPascal(raw.menuIcon) || 'LayoutList',
    menu: { group: raw.menuGroup, parent: null, after: raw.menuAfter || null },
    files: { page: `web/src/pages/${base}.tsx`, types: `web/src/types/${toKebab(base)}.ts` },
  };

  const { errors } = await preparePageSpec(projectDir, spec);
  const evidence = [
    `Menu "${raw.menuGroup}": ${siblings.map((item) => `${item.label} (${item.to})`).join(', ')}`,
    prefix ? `As rotas desse grupo começam com /${prefix}; a nova segue o mesmo padrão.` : null,
    `Permissão ${raw.screen}: ${raw.reason}`,
    'Tela só frontend: dados em memória, sem HTTP, sem dependência nova (o detro valida isso).',
  ].filter(Boolean);

  return { kind: 'page', spec, request, evidence, errors, warnings: [] };
}

export async function generatePage({ projectDir, config, plan, onEvent = () => {} }) {
  const ollama = requireOllama(config);
  const { spec, errors } = await preparePageSpec(projectDir, plan.spec);

  if (errors.length > 0) {
    throw new Error(`O plano tem problemas:\n- ${errors.join('\n- ')}`);
  }

  const ts = loadTypeScript(projectDir, 'web');
  const virtualFiles = new Map();
  const files = [];
  const maxAttempts = (config.ai.generation.maxRepairs ?? 2) + 3;
  const request = plan.request;
  const catalogEntries = await buildComponentCatalog(projectDir, config.ai.catalog.exclude);
  const catalog = renderComponentCatalog(catalogEntries.filter((entry) => ['PageHeader', 'EmptyState', 'Field'].includes(entry.name)));
  const referenceFile = await readOptionalProjectFile(projectDir, config.ai.references.page);
  const reference = referenceFile ? extractMainReturn(projectDir, config.ai.references.page, referenceFile).slice(0, 5000) : '';
  const typesImport = `@/types/${path.posix.basename(spec.files.types, '.ts')}`;

  async function generate(relativePath, prompt, rules) {
    const base = [{ role: 'system', content: CODE_SYSTEM }, { role: 'user', content: prompt }];
    let messages = base;
    let file = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      onEvent({ type: 'generating', path: relativePath, attempt });
      const { content: raw } = await ollamaChat({ ollama, attempt, messages, onProgress: (tokens) => onEvent({ type: 'progress', path: relativePath, tokens }) });
      virtualFiles.set(relativePath, cleanGeneratedCode(raw));
      const fixed = autoFix(projectDir, { virtualFiles, target: relativePath });
      virtualFiles.set(relativePath, fixed.content);

      if (fixed.applied.length > 0) {
        onEvent({ type: 'autofix', path: relativePath, applied: fixed.applied });
      }

      file = file ?? { action: 'create', kind: 'ai', path: relativePath };
      file.content = fixed.content;
      file.attempts = attempt;
      file.validation = await validateFile({ projectDir, relativePath, content: fixed.content, virtualFiles, rules });
      onEvent({ type: 'validated', path: relativePath, validation: file.validation });

      if (file.validation.valid) {
        break;
      }

      messages = [...base, { role: 'assistant', content: fixed.content }, { role: 'user', content: repairPrompt({ relativePath, errors: file.validation.errors.slice(0, 25) }) }];
    }

    files.push(file);
    return file;
  }

  onEvent({ type: 'stage', message: 'Gerando tipos e dados iniciais com a IA' });

  const types = await generate(spec.files.types, [
    `ARQUIVO: ${spec.files.types}`,
    'OBJETIVO: SOMENTE os tipos TypeScript e os dados iniciais (mock) descritos no PEDIDO, exportados. Sem React, sem componentes, sem funções de tela.',
    `PEDIDO:\n${request}`,
    `Devolva SOMENTE o conteúdo completo de ${spec.files.types}.`,
  ].join('\n\n'), {
    allowedPackages: [],
    forbiddenImports: FORBIDDEN,
    mustContain: [{ pattern: /export\s+(interface|type|const)/, message: 'Exporte os tipos e os dados iniciais.' }],
    mustNotContain: [NO_HTTP],
  });

  if (!types.validation.valid) {
    return { spec, files, valid: false };
  }

  onEvent({ type: 'stage', message: `Gerando a tela ${spec.component} com a IA` });

  const typeNames = [...new Set([...types.content.matchAll(/export\s+(?:interface|type|const|function|enum)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]))];
  const imports = [
    "import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';",
    "import clsx from 'clsx';",
    `import { ${[...new Set([spec.menuIcon, 'Plus', 'Search'])].join(', ')} } from 'lucide-react';`,
    "import { EmptyState } from '@/components/EmptyState';",
    "import { PageHeader } from '@/components/PageHeader';",
    typeNames.length > 0 ? `import { ${typeNames.join(', ')} } from '${typesImport}';` : null,
  ].filter(Boolean).join('\n');

  const allCriteria = acceptanceCriteria(request);
  let design = '';

  if (allCriteria.length > 0) {
    onEvent({ type: 'stage', message: 'Planejando estado, derivados e handlers antes de escrever a tela' });
    design = await designPage({ ollama, request, types: types.content, criteria: allCriteria, onProgress: (tokens) => onEvent({ type: 'progress', path: spec.files.page, tokens }) });
    onEvent({ type: 'stage', message: `Plano da tela:\n${design}` });
  }

  const pagePromptText = [
    `ARQUIVO: ${spec.files.page}`,
    `OBJETIVO: a tela descrita no PEDIDO, exportada como: export function ${spec.component}().`,
    `TÍTULO: <PageHeader title="${spec.title}" subtitle="..." /> no topo, e o conteúdo dentro de <div className="px-6 pb-6">.`,
    `TIPOS E DADOS INICIAIS (import de '${typesImport}'):\n${types.content}`,
    `IMPORTS (comece o arquivo com estas linhas; pode trocar os ícones do lucide-react; não importe de nenhum outro lugar, e nunca de '@/components' sem o nome do arquivo):\n${imports}`,
    'Nada de HTTP, websocket, SSE ou bibliotecas novas; tudo em estado local. Tipe os parâmetros dos handlers (ex.: event: KeyboardEvent<HTMLTextAreaElement>).',
    'Boas práticas obrigatórias: listas filtradas/ordenadas são derivadas com useMemo (nunca guardadas em outro estado); toda mudança de estado acontece nos handlers de evento (onClick, onKeyDown, onSubmit), não em useEffect; atualize arrays/objetos sem mutar (map/filter/spread). Use só classes Tailwind e as do projeto (card, input, btn-primary, btn-secondary, btn-ghost).',
    `CATÁLOGO (componentes reais do projeto):\n${catalog}`,
    `PEDIDO:\n${request}`,
    allCriteria.length > 0 ? `CRITÉRIOS DE ACEITE (TODOS obrigatórios; cada um precisa de código que funcione de verdade: estado com setter, handler ligado ao elemento):\n${allCriteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : null,
    design ? `PLANO DE IMPLEMENTAÇÃO (siga à risca: mesmos estados, derivados e handlers):\n${design}` : null,
    reference ? `REFERÊNCIA (JSX real de outra tela, só para copiar o visual: card, input, btn-primary, btn-ghost, espaçamentos):\n${reference}` : null,
    `Devolva SOMENTE o conteúdo completo de ${spec.files.page}.`,
  ].filter(Boolean).join('\n\n');

  const pageRules = {
    allowedPackages: ALLOWED,
    forbiddenImports: FORBIDDEN,
    requiredExports: [spec.component],
    mustContain: [
      { pattern: /<PageHeader[\s>]/, message: `Use <PageHeader title="${spec.title}" /> no topo.` },
      { pattern: new RegExp(`['"]${typesImport.replace(/[/.]/g, '\\$&')}['"]`), message: `Importe os tipos e dados de '${typesImport}'.` },
    ],
    mustNotContain: [NO_HTTP],
  };

  const page = await generate(spec.files.page, pagePromptText, pageRules);

  if (!page.validation.valid) {
    return { spec, files, valid: false };
  }

  async function repairByEdit(previous, missing) {
    virtualFiles.set(previous.path, previous.content);
    const instructions = `Faça o componente atender a estes critérios de aceite sem mexer no que já funciona:\n${missing.map((item) => `- ${item.text}${item.evidence ? ` — ${item.evidence}` : ''}`).join('\n')}`;
    const edit = await prepareEdit({ projectDir, config, file: previous.path, instructions, virtualFiles, onEvent });

    if (!edit.ok) {
      return null;
    }

    const validation = await validateFile({ projectDir, relativePath: previous.path, content: edit.content, virtualFiles: new Map([...virtualFiles, [previous.path, edit.content]]), rules: pageRules });
    onEvent({ type: 'validated', path: previous.path, validation });

    if (!validation.valid) {
      return null;
    }

    virtualFiles.set(previous.path, edit.content);
    const file = { ...previous, content: edit.content, validation };
    files.push(file);
    return file;
  }

  const criteria = allCriteria.filter((item) => !/(abrir o menu|acessar a op|visualizar a nova p[áa]gina)/i.test(item));
  let current = page;

  for (let round = 1; criteria.length > 0 && round <= maxAttempts; round += 1) {
    onEvent({ type: 'stage', message: `Conferindo ${criteria.length} critérios de aceite do pedido (rodada ${round})` });
    const verdict = await verifyCriteria({ ollama, code: current.content, criteria, onProgress: (tokens) => onEvent({ type: 'progress', path: current.path, tokens }) });
    const missing = verdict.filter((item) => !item.ok);
    onEvent({ type: 'fix-attempt', path: current.path, attempt: round, remaining: missing.length });
    current.criteria = verdict;

    if (missing.length === 0) {
      break;
    }

    if (round === maxAttempts) {
      const hard = missing.filter((item) => item.hard);
      current.validation.warnings.push(...missing.filter((item) => !item.hard).map((item) => `Critério não confirmado pela verificação automática — confira no diff: ${item.text}`));

      if (hard.length > 0) {
        current.validation.valid = false;
        current.validation.errors.push(...hard.map((item) => `Critério não atendido: ${item.text} (${item.evidence})`));
      }

      onEvent({ type: 'validated', path: current.path, validation: current.validation });

      if (hard.length > 0) {
        return { spec, files, valid: false };
      }

      break;
    }

    files.splice(files.indexOf(current), 1);
    onEvent({ type: 'stage', message: `Corrigindo só o que falta (${missing.length} critério(s))` });
    const edited = await repairByEdit(current, missing);

    if (edited) {
      current = edited;
      continue;
    }

    current = await generate(spec.files.page, [
      pagePromptText,
      `VERSÃO ANTERIOR (compila, mas NÃO atende a estes critérios):\n${missing.map((item) => `- ${item.text}${item.evidence ? ` — ${item.evidence}` : ''}`).join('\n')}\n\n${current.content}`,
      'Reescreva o arquivo COMPLETO atendendo a TODOS os critérios, mantendo o que já funciona.',
    ].join('\n\n'), pageRules);

    if (!current.validation.valid) {
      return { spec, files, valid: false };
    }
  }

  onEvent({ type: 'stage', message: 'Registrando a rota e o item de menu' });

  const appOriginal = await readProjectFile(projectDir, 'web/src/App.tsx');
  const appPatch = patchAppRoutes({ ts, content: appOriginal, spec: { route: spec.route }, names: { pageComponent: spec.component, pageImport: `@/pages/${path.posix.basename(spec.files.page, '.tsx')}`, permission: spec.screen } });
  const app = { action: 'modify', kind: 'patch', path: 'web/src/App.tsx', content: appPatch.content, originalHash: sha256(appOriginal), added: appPatch.added };
  virtualFiles.set(app.path, app.content);
  app.validation = await validateFile({ projectDir, relativePath: app.path, content: app.content, virtualFiles, rules: {}, lint: false });
  onEvent({ type: 'validated', path: app.path, validation: app.validation });
  files.push(app);

  const sidebarOriginal = await readProjectFile(projectDir, 'web/src/components/Sidebar.tsx');
  const sidebarContent = insertMenuItem({ ts, content: sidebarOriginal, placement: spec.menu, entry: { to: spec.route, icon: spec.menuIcon, label: spec.menuLabel, screen: spec.screen } });
  const sidebar = { action: 'modify', kind: 'patch', path: 'web/src/components/Sidebar.tsx', content: sidebarContent, originalHash: sha256(sidebarOriginal), added: [`menu ${spec.menu.group}${spec.menu.after ? ` depois de "${spec.menu.after}"` : ''} → ${spec.menuLabel}`] };
  sidebar.validation = await validateFile({ projectDir, relativePath: sidebar.path, content: sidebarContent, virtualFiles, rules: {}, lint: false });
  onEvent({ type: 'validated', path: sidebar.path, validation: sidebar.validation });
  files.push(sidebar);

  return { spec, files, valid: files.every((file) => file.validation.valid) };
}
