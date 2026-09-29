import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { columnHints, listScreens, listTables } from './catalog.js';
import { requireOllama } from './config.js';
import { readMenu } from './menu.js';
import { ollamaJson } from './ollama.js';
import { columnKind, FILTER_KINDS, normalizeQuerySpec, querySchema } from './querySpec.js';
import { prepareQuerySpec } from './queryGenerator.js';
import { listScreensWithFiles } from './targets.js';

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function walk(dir, predicate, output = []) {
  let entries = [];

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!['node_modules', 'dist'].includes(entry.name)) {
        await walk(absolute, predicate, output);
      }
    } else if (predicate(entry.name)) {
      output.push(absolute);
    }
  }

  return output;
}

async function filesUsingTable(projectDir, table) {
  const files = await walk(path.join(projectDir, 'api', 'src'), (name) => name.endsWith('.service.ts'));
  const found = [];

  for (const file of files) {
    const code = await readFile(file, 'utf8');
    const count = (code.match(new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+${table}\\b`, 'gi')) ?? []).length;

    if (count > 0) {
      found.push({ file: path.relative(projectDir, file).replaceAll('\\', '/'), count });
    }
  }

  return found.sort((a, b) => b.count - a.count).slice(0, 3);
}

async function research(projectDir, request) {
  const tables = await listTables(projectDir);
  const menu = await readMenu(projectDir);
  const screens = await listScreens(projectDir);
  const pages = await listScreensWithFiles(projectDir).catch(() => []);
  const text = normalize(request);

  const tenantTables = [...tables]
    .filter(([name, table]) => table.columns.size >= 3 && !/^(worker_cursors|audit|tracking_logs|schema_migrations)/.test(name))
    .map(([name, table]) => ({ name, tenant: table.tenant, columns: table.columns }));

  const candidates = [];

  for (const item of menu.items) {
    const words = normalize(item.label).split(/\s+/).filter((word) => word.length >= 4);

    if (item.screen && words.some((word) => text.includes(word.replace(/s$/, ''))) && tables.has(item.screen)) {
      candidates.push({ table: item.screen, reason: `o menu tem "${item.label}" (tela ${item.screen}), que corresponde à tabela ${item.screen}` });
    }
  }

  const unique = [...new Map(candidates.map((item) => [item.table, item])).values()];

  return { tables, tenantTables, menu, screens, pages, candidates: unique };
}

const TABLE_SYSTEM = `
Você escolhe a tabela do banco do projeto que tem os dados pedidos. Responda SOMENTE com JSON {"table": "...", "reason": "..."}.
Escolha a tabela cujos REGISTROS são o que o pedido quer listar (ex.: "listar veículos com ..." → a tabela de veículos).
reason: uma frase em português explicando a escolha.
`.trim();

const QUERY_SYSTEM = `
Você monta uma CONSULTA (tela só de leitura com filtros) sobre uma tabela que já existe no projeto. Responda SOMENTE com JSON.

- entity: nome em inglês, PascalCase, que descreva a consulta (ex.: LowMileageVehicles).
- title: título curto em português, só a primeira letra maiúscula. subtitle: uma frase curta do que a tela mostra.
- route: rota em português, minúsculo, sem acento, com hífen; se a consulta for de um cadastro existente, comece pela rota dele (ex.: /veiculos/baixa-quilometragem).
- menuIcon: ícone do lucide-react em PascalCase.
- menu: onde colocar. group = grupo do menu; parent = item com submenu onde entrar ("" se for direto no grupo); after = item depois do qual entrar ("" = no fim).
- columns: as informações pedidas, na ordem pedida, usando SÓ colunas da lista COLUNAS. Use as PISTAS (comentários das migrations e apelidos usados nas consultas do projeto) para achar a coluna certa. label em português.
- conditions: condições FIXAS do pedido (ex.: "inferior a 20000" → operator "<", value "20000"). value sempre como texto.
- filters: filtros que o usuário mexe na tela. kind: search (texto), range (número/data, de/até) ou boolean (sim/não). Se o pedido só disser "filtros", sugira filtros úteis entre as colunas escolhidas.
- orderBy: coluna e direção que façam sentido para a consulta.
- unsupported: o que o pedido pede e não cabe (gráfico, exportação, cálculo entre tabelas, agrupamento).
`.trim();

function tableList(research) {
  return research.tenantTables
    .map((table) => {
      const pt = research.menu.items.filter((item) => item.screen === table.name).map((item) => item.label);
      return `- ${table.name}${pt.length > 0 ? ` (no menu: ${pt.join(', ')})` : ''}: ${[...table.columns.keys()].slice(0, 10).join(', ')}${table.columns.size > 10 ? ', …' : ''}`;
    })
    .join('\n');
}

function menuTree(menu) {
  return menu.groups
    .map((group) => {
      const items = menu.items.filter((item) => item.group === group.label);
      return `${group.label}\n${items.map((item) => `  ${item.parent ? '  ' : ''}- ${item.label}${item.parent ? '' : menu.items.some((child) => child.parent === item.label) ? ' (tem submenu)' : ''}`).join('\n')}`;
    })
    .join('\n');
}

function columnBlock(table, hints) {
  return [...table.columns]
    .filter(([name]) => name !== 'operator_id')
    .map(([name, type]) => {
      const hint = hints.get(name);
      const parts = [
        `${name} ${type} (${columnKind(type, name)})`,
        hint?.aliases.length ? `apelidos no projeto: ${hint.aliases.join(', ')}` : null,
        hint?.notes.length ? `migration: "${hint.notes[0]}"` : null,
      ].filter(Boolean);
      return `- ${parts.join(' — ')}`;
    })
    .join('\n');
}

export async function createQueryPlan({ projectDir, config, request, analysis, onProgress, onStage = () => {} }) {
  const ollama = requireOllama(config);

  onStage('Pesquisando tabelas, menu e consultas existentes no projeto');
  const found = await research(projectDir, request);

  onStage('Escolhendo a tabela com os dados pedidos');
  const tableNames = found.tenantTables.map((table) => table.name);
  const tableChoice = await ollamaJson({
    ollama,
    schema: {
      type: 'object',
      properties: { table: { type: 'string', enum: tableNames }, reason: { type: 'string' } },
      required: ['table', 'reason'],
    },
    onProgress,
    messages: [
      { role: 'system', content: TABLE_SYSTEM },
      {
        role: 'user',
        content: `TABELAS:\n${tableList(found)}\n\n${found.candidates.length > 0 ? `CANDIDATAS PELA PESQUISA NO MENU:\n${found.candidates.map((item) => `- ${item.table}: ${item.reason}`).join('\n')}\n\n` : ''}PEDIDO:\n${request}`,
      },
    ],
  });

  const table = found.tables.get(tableChoice.table);

  if (!table) {
    throw new Error('Não consegui identificar de qual tabela vêm os dados. Diga o cadastro, ex.: "listar veículos com ...".');
  }

  const hints = await columnHints(projectDir, tableChoice.table, table.columns.keys());
  const usedBy = await filesUsingTable(projectDir, tableChoice.table);
  const similarPage = found.pages.find((page) => found.menu.items.some((item) => item.to === page.path && item.screen === tableChoice.table));

  onStage(`Montando a consulta sobre ${tableChoice.table}`);

  const columns = [...table.columns.keys()].filter((name) => name !== 'operator_id');
  const raw = await ollamaJson({
    ollama,
    schema: querySchema({
      columns,
      groups: found.menu.groups.map((group) => group.label),
      items: found.menu.items.map((item) => item.label),
    }),
    onProgress,
    messages: [
      { role: 'system', content: QUERY_SYSTEM },
      {
        role: 'user',
        content: [
          `TABELA: ${tableChoice.table}${table.tenant ? ' (dados por operadora)' : ''}`,
          `COLUNAS (com PISTAS encontradas no projeto):\n${columnBlock(table, hints)}`,
          `MENU ATUAL:\n${menuTree(found.menu)}`,
          `TIPOS DE FILTRO: ${FILTER_KINDS.join(', ')}`,
          `PEDIDO:\n${request}`,
        ].join('\n\n'),
      },
    ],
  });

  const { spec, errors, warnings } = normalizeQuerySpec(raw, { table: tableChoice.table, tableInfo: table, menu: found.menu, analysis });
  const requestWords = new Set(normalize(request).split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
  spec.unsupported = spec.unsupported.filter((item) => normalize(item).split(/[^a-z0-9]+/).some((word) => word.length >= 4 && requestWords.has(word)));

  if (spec.menu.parent) {
    const siblings = found.menu.items.filter((item) => item.parent === spec.menu.parent && item.to?.startsWith('/'));
    const prefix = siblings[0]?.to.split('/').filter(Boolean)[0];
    const slug = spec.route.split('/').filter(Boolean).pop();

    if (prefix && slug && !spec.route.startsWith(`/${prefix}/`)) {
      spec.route = `/${prefix}/${slug}`;
      warnings.push(`Rota ajustada para ${spec.route}, no padrão dos outros itens de "${spec.menu.parent}".`);
    }
  }

  if (spec.filters.length === 0 && /\bfiltr/i.test(request)) {
    for (const column of spec.columns.filter((entry) => entry.kind !== 'id')) {
      spec.filters.push({
        column: column.column,
        key: column.key,
        kind: column.kind === 'boolean' ? 'boolean' : ['number', 'date', 'datetime'].includes(column.kind) ? 'range' : 'search',
        label: column.label,
        valueKind: column.kind,
      });
    }

    warnings.push('O pedido pede filtros sem dizer quais; sugeri um filtro para cada coluna mostrada.');
  }

  const evidence = [
    `Tabela ${tableChoice.table} (${table.file}): ${tableChoice.reason}`,
    ...found.candidates.filter((item) => item.table === tableChoice.table).map((item) => `Menu: ${item.reason}`),
    ...spec.columns.map((column) => {
      const hint = hints.get(column.column);
      const extra = [hint?.notes[0] ? `migration: "${hint.notes[0]}"` : null, hint?.aliases.length && column.kind !== 'id' ? `usado como ${hint.aliases.join(', ')}` : null].filter(Boolean).join('; ');
      return `"${column.label}" → ${column.column}${extra ? ` (${extra})` : ''}`;
    }),
    ...usedBy.map((item) => `Já consultam ${tableChoice.table}: ${item.file}`),
    similarPage ? `Tela parecida que já existe: ${similarPage.file} (${similarPage.path}) — a nova consulta segue o mesmo visual` : null,
  ].filter(Boolean);

  const prepared = await prepareQuerySpec(projectDir, spec);

  return {
    kind: 'query',
    spec: prepared.spec,
    errors: [...errors, ...prepared.errors],
    warnings: [...warnings, ...prepared.warnings.filter((item) => !warnings.includes(item))],
    evidence,
    screens: found.screens,
  };
}
