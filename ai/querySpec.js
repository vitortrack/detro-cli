import { access } from 'node:fs/promises';
import path from 'node:path';

import { toCamel, toKebab, toPascal } from './spec.js';

export const CONDITION_OPERATORS = ['<', '<=', '>', '>=', '=', '!=', 'contains', 'is_null', 'not_null'];
export const FILTER_KINDS = ['search', 'range', 'boolean'];

export function columnKind(sqlType, column) {
  const type = String(sqlType ?? '').toUpperCase();

  if (column === 'id' || /UUID/.test(type) || (/^BIG/.test(type) && /(^id$|_id$)/.test(column))) {
    return 'id';
  }

  if (/BOOL/.test(type)) {
    return 'boolean';
  }

  if (/INT|NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT|SERIAL/.test(type)) {
    return 'number';
  }

  if (/TIMESTAMP/.test(type)) {
    return 'datetime';
  }

  if (/DATE/.test(type)) {
    return 'date';
  }

  return 'text';
}

export function querySchema({ columns, groups, items }) {
  return {
    type: 'object',
    properties: {
      entity: { type: 'string' },
      title: { type: 'string' },
      subtitle: { type: 'string' },
      route: { type: 'string' },
      menuIcon: { type: 'string' },
      menu: {
        type: 'object',
        properties: {
          group: { type: 'string', enum: groups },
          parent: { type: 'string', enum: ['', ...items] },
          after: { type: 'string', enum: ['', ...items] },
        },
        required: ['group', 'parent', 'after'],
      },
      columns: {
        type: 'array',
        items: {
          type: 'object',
          properties: { column: { type: 'string', enum: columns }, label: { type: 'string' } },
          required: ['column', 'label'],
        },
      },
      conditions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', enum: columns },
            operator: { type: 'string', enum: CONDITION_OPERATORS },
            value: { type: 'string' },
          },
          required: ['column', 'operator', 'value'],
        },
      },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          properties: { column: { type: 'string', enum: columns }, kind: { type: 'string', enum: FILTER_KINDS }, label: { type: 'string' } },
          required: ['column', 'kind', 'label'],
        },
      },
      orderBy: {
        type: 'object',
        properties: { column: { type: 'string', enum: columns }, direction: { type: 'string', enum: ['asc', 'desc'] } },
        required: ['column', 'direction'],
      },
      unsupported: { type: 'array', items: { type: 'string' } },
    },
    required: ['entity', 'title', 'subtitle', 'route', 'menuIcon', 'menu', 'columns', 'conditions', 'filters', 'orderBy', 'unsupported'],
  };
}

function cleanText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function ascii(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeRoute(value, fallback) {
  const route = ascii(value || fallback)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9/-]/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/\/$/, '');

  return route.startsWith('/') ? route : `/${route}`;
}

function sentenceCase(value) {
  return value
    .split(' ')
    .map((word, index) => (index > 0 && /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(word) ? word.toLowerCase() : word))
    .join(' ');
}

function parseValue(kind, operator, raw) {
  if (operator === 'is_null' || operator === 'not_null') {
    return { ok: true, value: null };
  }

  const text = String(raw ?? '').trim();

  if (kind === 'number') {
    const number = Number(text.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(number) && text !== '' ? { ok: true, value: number } : { ok: false };
  }

  if (kind === 'boolean') {
    const value = /^(true|sim|verdadeiro|1|ativo)$/i.test(text) ? true : /^(false|nao|não|falso|0|inativo)$/i.test(text) ? false : null;
    return value === null ? { ok: false } : { ok: true, value };
  }

  if (kind === 'date' || kind === 'datetime') {
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? { ok: true, value: text.slice(0, 10) } : { ok: false };
  }

  return text ? { ok: true, value: text } : { ok: false };
}

function operatorAllowed(kind, operator) {
  if (['is_null', 'not_null'].includes(operator)) {
    return true;
  }

  if (operator === 'contains') {
    return kind === 'text';
  }

  if (['<', '<=', '>', '>='].includes(operator)) {
    return ['number', 'date', 'datetime'].includes(kind);
  }

  return true;
}

export function normalizeQuerySpec(raw, { table, tableInfo, menu, analysis = null }) {
  const errors = [];
  const warnings = [];
  const unsupported = (Array.isArray(raw?.unsupported) ? raw.unsupported : []).map((item) => cleanText(item)).filter(Boolean);
  const columnTypes = tableInfo.columns;
  const kindOf = (column) => columnKind(columnTypes.get(column), column);

  let entity = toPascal(raw?.entity);

  if (!/^[A-Z][A-Za-z0-9]*$/.test(entity)) {
    entity = `${toPascal(table)}Report`;
  }

  const title = sentenceCase(cleanText(analysis?.title ?? raw?.title, 'Consulta'));
  const route = normalizeRoute(raw?.route, title);

  const columns = [];
  const seen = new Set();

  for (const item of Array.isArray(raw?.columns) ? raw.columns : []) {
    const column = String(item?.column ?? '').toLowerCase();

    if (!columnTypes.has(column) || column === 'operator_id' || seen.has(column)) {
      continue;
    }

    seen.add(column);
    columns.push({ column, key: toCamel(column), label: cleanText(item?.label, column), kind: kindOf(column) });
  }

  if (columns.length === 0) {
    errors.push(`Escolha ao menos uma coluna existente de ${table}.`);
  }

  const conditions = [];

  for (const item of Array.isArray(raw?.conditions) ? raw.conditions : []) {
    const column = String(item?.column ?? '').toLowerCase();
    const operator = String(item?.operator ?? '');

    if (!columnTypes.has(column) || !CONDITION_OPERATORS.includes(operator)) {
      continue;
    }

    const kind = kindOf(column);
    const parsed = parseValue(kind, operator, item?.value);

    if (!operatorAllowed(kind, operator) || !parsed.ok) {
      warnings.push(`Condição "${column} ${operator} ${item?.value ?? ''}" ignorada: não combina com o tipo da coluna.`);
      continue;
    }

    conditions.push({ column, operator, value: parsed.value, kind });
  }

  const filters = [];

  for (const item of Array.isArray(raw?.filters) ? raw.filters : []) {
    const column = String(item?.column ?? '').toLowerCase();

    if (!columnTypes.has(column) || column === 'operator_id') {
      continue;
    }

    const kind = kindOf(column);
    const wanted = String(item?.kind ?? '');
    const filterKind = kind === 'boolean' ? 'boolean' : ['number', 'date', 'datetime'].includes(kind) ? 'range' : kind === 'text' ? 'search' : null;

    if (!filterKind || (wanted && wanted !== filterKind)) {
      if (filterKind) {
        warnings.push(`Filtro de "${column}" ajustado para ${filterKind} (combina com o tipo da coluna).`);
      } else {
        continue;
      }
    }

    if (!filters.some((filter) => filter.column === column)) {
      filters.push({ column, key: toCamel(column), kind: filterKind, label: cleanText(item?.label, columns.find((entry) => entry.column === column)?.label ?? column), valueKind: kind });
    }
  }

  const orderColumn = String(raw?.orderBy?.column ?? '').toLowerCase();
  const orderBy = columnTypes.has(orderColumn)
    ? { column: orderColumn, direction: raw.orderBy.direction === 'desc' ? 'desc' : 'asc' }
    : { column: columns[0]?.column ?? 'id', direction: 'asc' };

  const group = menu.groups.find((entry) => entry.label === raw?.menu?.group);
  const parent = menu.items.find((entry) => entry.label === raw?.menu?.parent && !entry.parent);
  const after = menu.items.find((entry) => entry.label === raw?.menu?.after);
  const menuPlacement = {
    group: parent?.group ?? group?.label ?? menu.groups[0]?.label,
    parent: parent?.label ?? null,
    after: after && (parent ? after.parent === parent.label : after.group === (group?.label ?? after.group) && !after.parent) ? after.label : null,
  };

  if (!group && !parent) {
    warnings.push(`Grupo de menu não reconhecido; usando "${menuPlacement.group}".`);
  }

  const screenItem = menu.items.find((entry) => entry.label === menuPlacement.parent) ?? menu.items.find((entry) => entry.group === menuPlacement.group && entry.screen);

  return {
    spec: {
      kind: 'query',
      table,
      tenant: tableInfo.tenant,
      entity,
      title,
      subtitle: cleanText(raw?.subtitle, ''),
      route,
      menuIcon: toPascal(raw?.menuIcon) || 'List',
      menu: menuPlacement,
      screen: raw?.screen ?? screenItem?.screen ?? 'dashboard',
      columns,
      conditions,
      filters,
      orderBy,
      unsupported,
    },
    errors,
    warnings,
  };
}

export function deriveQueryNames(spec) {
  const kebab = toKebab(spec.entity);
  const moduleDir = `api/src/modules/${kebab}`;

  return {
    entity: spec.entity,
    camel: toCamel(spec.entity),
    kebab,
    apiPath: kebab,
    permission: spec.screen,
    files: {
      dto: `${moduleDir}/dto/${kebab}-query.dto.ts`,
      service: `${moduleDir}/${kebab}.service.ts`,
      controller: `${moduleDir}/${kebab}.controller.ts`,
      module: `${moduleDir}/${kebab}.module.ts`,
      appModule: 'api/src/app.module.ts',
      type: `web/src/types/${kebab}.ts`,
      apiClient: `web/src/lib/${kebab}-api.ts`,
      page: `web/src/pages/${kebab}/${spec.entity}Page.tsx`,
      app: 'web/src/App.tsx',
      sidebar: 'web/src/components/Sidebar.tsx',
    },
  };
}

async function exists(projectDir, relativePath) {
  try {
    await access(path.join(projectDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function checkQueryConflicts({ projectDir, spec, names, routes }) {
  const errors = [];

  for (const key of ['dto', 'service', 'controller', 'module', 'type', 'apiClient', 'page']) {
    if (await exists(projectDir, names.files[key])) {
      errors.push(`Já existe ${names.files[key]}. Troque "entity" em .detro/last-plan.json e rode detro plan --revalidar.`);
    }
  }

  if (routes.includes(spec.route)) {
    errors.push(`A rota ${spec.route} já existe em web/src/App.tsx. Troque "route" em .detro/last-plan.json.`);
  }

  return errors;
}

function describeCondition(condition) {
  const words = { '<': 'menor que', '<=': 'até', '>': 'maior que', '>=': 'a partir de', '=': 'igual a', '!=': 'diferente de', contains: 'contém', is_null: 'vazio', not_null: 'preenchido' };
  return `${condition.column} ${words[condition.operator]}${condition.value === null ? '' : ` ${condition.value}`}`;
}

export function describeQuerySpec(spec) {
  return [
    `Consulta: ${spec.title} (somente leitura, sobre a tabela ${spec.table}${spec.tenant ? ', filtrada pela operadora' : ''})`,
    `Rota: ${spec.route}`,
    `Menu: ${spec.menu.parent ? `${spec.menu.group} › ${spec.menu.parent}` : spec.menu.group}${spec.menu.after ? `, logo depois de "${spec.menu.after}"` : ', no fim'} — ícone ${spec.menuIcon}`,
    `Permissão: reaproveita a tela "${spec.screen}"`,
    `Colunas: ${spec.columns.map((column) => `${column.label} (${column.column})`).join(', ')}`,
    `Condição fixa: ${spec.conditions.length > 0 ? spec.conditions.map(describeCondition).join(' e ') : 'nenhuma'}`,
    `Filtros na tela: ${spec.filters.length > 0 ? spec.filters.map((filter) => `${filter.label} (${filter.kind === 'search' ? 'busca' : filter.kind === 'range' ? 'de/até' : 'sim/não'})`).join(', ') : 'nenhum'}`,
    `Ordenação: ${spec.orderBy.column} ${spec.orderBy.direction === 'desc' ? 'decrescente' : 'crescente'}`,
  ].join('\n');
}
