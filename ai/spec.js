import { access } from 'node:fs/promises';
import path from 'node:path';

export const FIELD_TYPES = ['string', 'text', 'integer', 'decimal', 'boolean', 'date', 'enum', 'reference'];
export const COMPARE_OPERATORS = ['>=', '>', '<=', '<'];

const TYPE_ALIASES = {
  str: 'string',
  varchar: 'string',
  textarea: 'text',
  longtext: 'text',
  int: 'integer',
  number: 'decimal',
  numeric: 'decimal',
  float: 'decimal',
  double: 'decimal',
  money: 'decimal',
  bool: 'boolean',
  datetime: 'date',
  timestamp: 'date',
  select: 'enum',
  status: 'enum',
  options: 'enum',
  relation: 'reference',
  foreign: 'reference',
  fk: 'reference',
};

const RESERVED_FIELDS = new Set(['id', 'operatorId', 'createdAt', 'updatedAt']);

export function specSchema(screens, referenceTables = []) {
  return {
    type: 'object',
    properties: {
      entity: { type: 'string' },
      entityPlural: { type: 'string' },
      labelSingular: { type: 'string' },
      labelPlural: { type: 'string' },
      gender: { type: 'string', enum: ['m', 'f'] },
      title: { type: 'string' },
      route: { type: 'string' },
      screen: screens.length > 0 ? { type: 'string', enum: screens } : { type: 'string' },
      permissionMode: { type: 'string', enum: ['nova', 'existente'] },
      menuIcon: { type: 'string' },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            label: { type: 'string' },
            type: { type: 'string', enum: FIELD_TYPES },
            required: { type: 'boolean' },
            unique: { type: 'boolean' },
            maxLength: { type: 'integer' },
            min: { type: 'number' },
            max: { type: 'number' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: { value: { type: 'string' }, label: { type: 'string' } },
                required: ['value', 'label'],
              },
            },
            references: referenceTables.length > 0 ? { type: 'string', enum: referenceTables } : { type: 'string' },
            source: { type: 'integer' },
          },
          required: ['source', 'name', 'label', 'type', 'required'],
        },
      },
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['compare', 'blockDelete'] },
            left: { type: 'string' },
            operator: { type: 'string', enum: COMPARE_OPERATORS },
            right: { type: 'string' },
            field: { type: 'string' },
            values: { type: 'array', items: { type: 'string' } },
            message: { type: 'string' },
            source: { type: 'integer' },
          },
          required: ['source', 'type'],
        },
      },
      unsupported: {
        type: 'array',
        items: {
          type: 'object',
          properties: { source: { type: 'integer' }, text: { type: 'string' } },
          required: ['source', 'text'],
        },
      },
    },
    required: ['entity', 'entityPlural', 'labelSingular', 'labelPlural', 'gender', 'title', 'route', 'screen', 'permissionMode', 'menuIcon', 'fields', 'rules', 'unsupported'],
  };
}

function ascii(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function words(value) {
  return ascii(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function toPascal(value) {
  return words(value).map((word) => word[0].toUpperCase() + word.slice(1)).join('');
}

export function toCamel(value) {
  const pascal = toPascal(value);
  return pascal ? pascal[0].toLowerCase() + pascal.slice(1) : '';
}

export function toKebab(value) {
  return words(value).map((word) => word.toLowerCase()).join('-');
}

export function toSnake(value) {
  return words(value).map((word) => word.toLowerCase()).join('_');
}

function pluralize(pascal) {
  if (/[^aeiou]y$/i.test(pascal)) {
    return `${pascal.slice(0, -1)}ies`;
  }

  if (/(s|x|z|ch|sh)$/i.test(pascal)) {
    return `${pascal}es`;
  }

  return `${pascal}s`;
}

function cleanText(value, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function guessGender(label) {
  const word = ascii(label.split(' ')[0]).toLowerCase();

  if (/(cao|sao|dade|gem|tude)$/.test(word) || (/a$/.test(word) && !/(ma|ista)$/.test(word))) {
    return 'f';
  }

  if (/o$/.test(word) && !/ao$/.test(word)) {
    return 'm';
  }

  return null;
}

function sentenceCase(value) {
  return value
    .split(' ')
    .map((word, index) => (index > 0 && /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(word) ? word.toLowerCase() : word))
    .join(' ');
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

const FILE_WORDS = /\b(anexo|anexos|foto|fotos|imagem|imagens|arquivo|arquivos|pdf|upload|documento digitalizado|attachment|file|photo|image)\b/i;

function cleanLabel(label) {
  const cleaned = label
    .replace(/\s*\((obrigat[óo]ri[oa]|opcional)\)\s*/gi, ' ')
    .replace(/,?\s*(se houver|quando houver|se tiver|opcional)\s*$/i, '')
    .replace(/\s+(obrigat[óo]ri[oa])\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return capitalize(cleaned || label);
}

const HANDLED_BY_GENERATOR = [
  /^\s*(o\s+)?(id|identificador)\b/,
  /(somente|apenas|so)\s+(com\s+)?espacos|em branco|campo vazio|nao pode ficar vazio/,
  /(iniciar|comecar|vir|nascer)\s+(como\s+)?(ativo|marcado|habilitado)|padrao\s+(ativo|marcado)/,
  /^\s*[^:]*:\s*(obrigatori[oa]|opcional)\.?\s*$/,
];

function sourceOf(raw) {
  const value = Number(raw?.source);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeField(raw, warnings, errors, references, unsupported, requirements) {
  let name = toCamel(raw?.name);
  const source = sourceOf(raw);
  const requirement = requirements.find((item) => item.id === source);

  if (requirement?.kind === 'calculo' && /calcul|automatic|\bsoma\b|\bm[ée]dia\b|somat[óo]rio/i.test(requirement.text)) {
    unsupported.push({ source, text: `${cleanText(raw?.label, raw?.name)}: campo calculado automaticamente não é gerado pelo detro.` });
    warnings.push(`Campo "${cleanText(raw?.label, raw?.name)}" é calculado (requisito #${source}) e foi movido para "não coberto".`);
    return null;
  }

  if ((requirement?.kind === 'arquivo' && FILE_WORDS.test(requirement.text)) || FILE_WORDS.test(`${raw?.name ?? ''} ${raw?.label ?? ''}`.replace(/([a-z])([A-Z])/g, '$1 $2'))) {
    unsupported.push({ source, text: `${cleanText(raw?.label, raw?.name)}: upload de arquivo não é gerado pelo detro.` });
    warnings.push(`Campo "${cleanText(raw?.label, raw?.name)}" parece arquivo/foto e foi movido para "não coberto" (o detro não gera upload).`);
    return null;
  }

  if (!name || !/^[a-z][A-Za-z0-9]*$/.test(name)) {
    warnings.push(`Campo ignorado: nome inválido "${raw?.name}".`);
    return null;
  }

  if (RESERVED_FIELDS.has(name)) {
    warnings.push(`Campo "${name}" ignorado: é gerado automaticamente.`);
    return null;
  }

  const rawType = String(raw?.type ?? '').toLowerCase();
  let type = FIELD_TYPES.includes(rawType) ? rawType : TYPE_ALIASES[rawType];

  if (!type) {
    warnings.push(`Campo "${name}": tipo "${raw?.type}" desconhecido, usando "string".`);
    type = 'string';
  }

  const optionLabels = (Array.isArray(raw?.options) ? raw.options : []).map((option) => ascii(option?.label ?? option?.value ?? '').toLowerCase().trim());

  if (type === 'enum' && optionLabels.length === 2 && optionLabels.every((label) => /^(sim|nao|yes|no|true|false|ativo|inativo|verdadeiro|falso)$/.test(label))) {
    warnings.push(`Campo "${name}" com opções só sim/não virou campo sim/não (boolean).`);
    type = 'boolean';
  }

  if (requirement?.options.length >= 2 && ['string', 'text'].includes(type)) {
    warnings.push(`Campo "${name}" virou lista de opções (${requirement.options.join(', ')}), como está no pedido.`);
    type = 'enum';
  }

  const technical = requirement?.field ? toCamel(requirement.field) : '';

  if (technical && technical !== name && !RESERVED_FIELDS.has(technical)) {
    warnings.push(`Campo "${name}" renomeado para "${technical}", como está no pedido.`);
    name = technical;
  }

  if (type === 'reference' && !/Id$/.test(name)) {
    name = `${name}Id`;
  }

  let required = type === 'boolean' ? false : Boolean(raw?.required);

  if (type !== 'boolean' && requirement?.required !== undefined && requirement.required !== required) {
    warnings.push(`Campo "${name}" marcado como ${requirement.required ? 'obrigatório' : 'opcional'}, como está no pedido.`);
    required = requirement.required;
  }

  const field = {
    name,
    label: cleanLabel(cleanText(raw?.label, capitalize(words(name.replace(/Id$/, '')).join(' ').toLowerCase())).replace(/^se\s+(est[áa]|é)\s+/i, '')),
    type,
    required,
    unique: ['string', 'integer'].includes(type) ? Boolean(raw?.unique) : false,
  };

  if (source) {
    field.source = source;
  }

  if (type === 'string') {
    const maxLength = Number.isInteger(raw?.maxLength) ? raw.maxLength : 150;
    field.maxLength = Math.min(Math.max(maxLength, 1), 500);
  }

  if (type === 'integer' || type === 'decimal') {
    if (Number.isFinite(raw?.min)) {
      field.min = raw.min;
    }

    if (Number.isFinite(raw?.max)) {
      field.max = raw.max;
    }

    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      warnings.push(`Campo "${name}": mínimo maior que o máximo; limites removidos.`);
      delete field.min;
      delete field.max;
    }
  }

  if (type === 'enum') {
    const options = [];
    const values = new Set();

    for (const option of Array.isArray(raw?.options) ? raw.options : []) {
      const value = toSnake(option?.value || option?.label).slice(0, 40);
      const label = cleanText(option?.label, capitalize(words(value).join(' ').toLowerCase()));

      if (value && !values.has(value)) {
        values.add(value);
        options.push({ value, label });
      }
    }

    const written = requirement?.options ?? [];
    const sameLabels = written.length === options.length
      && written.every((label, index) => normalizeWord(label) === normalizeWord(options[index].label));

    const aliases = new Map();

    const sameValues = !requirement?.values || requirement.values.every((value, index) => toSnake(value) === options[index]?.value);

    if (written.length >= 2 && (!sameLabels || !sameValues)) {
      const similar = (a, b) => {
        const left = normalizeWord(a);
        const right = normalizeWord(b);
        return left === right || left.includes(right) || right.includes(left) || (left.length >= 5 && right.length >= 5 && left.slice(0, 5) === right.slice(0, 5));
      };

      const used = new Set();
      const aligned = written.map((label, index) => {
        const match = options.find((option) => !used.has(option.value) && similar(option.label, label));
        const value = requirement.values?.[index] ? toSnake(requirement.values[index]).slice(0, 40) : match?.value ?? toSnake(label).slice(0, 40);

        if (match) {
          used.add(match.value);
        }

        return { value, label: capitalize(label) };
      });

      for (const option of options) {
        const target = aligned.find((item) => similar(item.label, option.label));

        if (target) {
          aliases.set(normalizeWord(option.value), target.value);
          aliases.set(normalizeWord(option.label), target.value);
        }
      }

      warnings.push(`Opções de "${field.label}" ajustadas para as do pedido: ${written.join(', ')}.`);
      options.splice(0, options.length, ...aligned);
    }

    Object.defineProperty(field, 'aliases', { value: aliases, enumerable: false });

    if (options.length < 2) {
      errors.push(`Campo "${name}": uma lista de opções precisa de pelo menos 2 opções em "options".`);
    }

    field.options = options;
  }

  if (type === 'reference') {
    const table = String((typeof raw?.references === 'object' ? raw.references?.name : raw?.references) ?? '').toLowerCase();
    const target = references.find((item) => item.name === table);

    if (!target) {
      errors.push(`Campo "${name}": "references" precisa ser uma tabela existente com coluna de nome. Opções: ${references.map((item) => item.name).join(', ')}.`);
    }

    field.references = target ?? { name: table, idType: 'bigint', labelColumn: 'name', tenant: false };
  }

  return field;
}

function normalizeBlockDelete(raw, fields, spec) {
  const field = fields.find((item) => item.name === toCamel(raw.field));

  if (!field || !['enum', 'boolean'].includes(field.type)) {
    return null;
  }

  const wanted = (Array.isArray(raw.values) ? raw.values : []).map((value) => normalizeWord(value));
  let values;
  let labels;

  if (field.type === 'enum') {
    const translated = wanted.map((value) => field.aliases?.get(value) ?? value).map((value) => normalizeWord(value));
    const matched = field.options.filter((option) => translated.includes(normalizeWord(option.value)) || translated.includes(normalizeWord(option.label)));
    values = matched.map((option) => option.value);
    labels = matched.map((option) => option.label);
  } else {
    values = wanted.filter((value) => ['true', 'false', 'sim', 'nao'].includes(value)).map((value) => (value === 'true' || value === 'sim'));
    labels = values.map((value) => (value ? 'Sim' : 'Não'));
  }

  if (values.length === 0) {
    return null;
  }

  return {
    type: 'blockDelete',
    source: sourceOf(raw),
    field: field.name,
    values,
    message: cleanText(raw.message, `Não é possível excluir ${spec.gender === 'f' ? 'uma' : 'um'} ${spec.labelSingular} com ${field.label.toLowerCase()} "${labels.join('" ou "')}". Altere ${field.label.toLowerCase()} antes de excluir.`),
  };
}

function normalizeWord(value) {
  return ascii(value).toLowerCase().trim().replace(/[\s-]+/g, '_');
}

function describeRawRule(raw) {
  return raw?.type === 'blockDelete'
    ? `bloquear exclusão quando ${raw.field} = ${(raw.values ?? []).join('/')}`
    : `${raw?.left} ${raw?.operator} ${raw?.right}`;
}

function normalizeRules(rawRules, fields, warnings, unsupported, spec) {
  const comparable = new Map(fields.filter((field) => ['integer', 'decimal', 'date'].includes(field.type)).map((field) => [field.name, field]));
  const rules = [];

  for (const raw of Array.isArray(rawRules) ? rawRules : []) {
    if (raw?.type === 'blockDelete') {
      const rule = normalizeBlockDelete(raw, fields, spec);

      if (rule) {
        rules.push(rule);
        continue;
      }
    }

    const left = comparable.get(toCamel(raw?.left));
    const right = comparable.get(toCamel(raw?.right));

    if (raw?.type !== 'compare' || !left || !right || left.type !== right.type || !COMPARE_OPERATORS.includes(raw.operator)) {
      const text = cleanText(raw?.message, describeRawRule(raw));
      unsupported.push({ source: sourceOf(raw), text: `Regra "${text}": não coube em "compare" (duas datas ou dois números) nem em "blockDelete" (campo de opções ou sim/não).` });
      warnings.push(`A regra "${describeRawRule(raw)}" não pôde ser gerada e foi para "não coberto".`);
      continue;
    }

    const numberWords = { '>=': 'maior ou igual a', '>': 'maior que', '<=': 'menor ou igual a', '<': 'menor que' };
    const dateWords = { '>=': 'igual ou posterior a', '>': 'posterior a', '<=': 'igual ou anterior a', '<': 'anterior a' };
    const relation = left.type === 'date' ? dateWords[raw.operator] : numberWords[raw.operator];

    rules.push({
      type: 'compare',
      source: sourceOf(raw),
      left: left.name,
      operator: raw.operator,
      right: right.name,
      message: cleanText(raw.message, `"${left.label}" deve ser ${relation} "${right.label}".`),
    });
  }

  return rules;
}

export function normalizeSpec(raw, { screens = [], references = [], requirements = [], analysis = null } = {}) {
  const errors = [];
  const warnings = [];

  let entity = toPascal(raw?.entity);
  const modalEntity = analysis?.names?.modal?.replace(/FormModal$/, '');

  if (modalEntity && modalEntity !== entity) {
    if (entity) {
      warnings.push(`Entidade "${entity}" trocada por "${modalEntity}", para o modal se chamar ${analysis.names.modal} como no pedido.`);
    }

    entity = modalEntity;
  }

  if (!/^[A-Z][A-Za-z0-9]*$/.test(entity)) {
    errors.push(`"entity" precisa ser um nome em inglês, no singular (ex.: Reservoir). Recebido: "${raw?.entity ?? ''}".`);
  }

  let entityPlural = toPascal(raw?.entityPlural);
  const pageEntity = analysis?.names?.page?.replace(/Page$/, '');

  if (pageEntity && pageEntity !== entityPlural) {
    entityPlural = pageEntity;
  } else if (!entityPlural || entityPlural === entity) {
    entityPlural = pluralize(entity);
  }

  const labelSingular = cleanText(raw?.labelSingular, words(entity).join(' ').toLowerCase()).toLowerCase();
  const labelPlural = cleanText(raw?.labelPlural, `${labelSingular}s`).toLowerCase();
  let gender = raw?.gender === 'f' ? 'f' : 'm';
  const guessed = guessGender(labelSingular);

  if (guessed && guessed !== gender) {
    warnings.push(`Gênero de "${labelSingular}" corrigido para ${guessed === 'f' ? 'feminino' : 'masculino'}.`);
    gender = guessed;
  }
  const title = analysis?.title ?? capitalize(sentenceCase(cleanText(raw?.title, capitalize(labelPlural)).replace(/^(cadastro|gest[aã]o|gerenciamento|listagem|controle)\s+de\s+/i, '')));
  let route = normalizeRoute(raw?.route, labelPlural);
  const englishRoute = `/${toKebab(entityPlural)}`;

  if (route === englishRoute && normalizeRoute('', labelPlural) !== englishRoute) {
    route = normalizeRoute('', labelPlural);
    warnings.push(`Rota em inglês trocada por ${route} (rotas do painel são em português).`);
  }

  let screen = String(raw?.screen ?? '');

  if (screens.length > 0 && !screens.includes(screen)) {
    errors.push(`"screen" precisa ser uma tela que exista em web/src/lib/screens.ts e em api/src/modules/permissions/screens.ts: ${screens.join(', ')}.`);
    screen = '';
  }

  const fields = [];
  const seen = new Set();
  const unsupported = [
    ...(Array.isArray(raw?.unsupportedItems) ? raw.unsupportedItems : []),
    ...(Array.isArray(raw?.unsupported) && !Array.isArray(raw?.unsupportedItems) ? raw.unsupported : []),
  ]
    .map((item) => (typeof item === 'string' ? { text: item } : { source: sourceOf(item), text: item?.text }))
    .map((item) => ({ ...item, text: cleanText(item.text, '') }))
    .filter((item) => item.text);

  for (const item of Array.isArray(raw?.fields) ? raw.fields : []) {
    const field = normalizeField(item, warnings, errors, references, unsupported, requirements);

    if (!field) {
      continue;
    }

    if (seen.has(field.name)) {
      warnings.push(`Campo "${field.name}" repetido; mantida a primeira ocorrência.`);
      continue;
    }

    seen.add(field.name);
    fields.push(field);
  }

  if (fields.length === 0) {
    errors.push('Informe ao menos um campo em "fields".');
  }

  if (!fields.some((field) => field.type === 'string')) {
    warnings.push('Nenhum campo de texto curto: a busca da listagem ficará desativada.');
  }

  const scope = (analysis?.scope ?? raw?.scope) === 'frontend' ? 'frontend' : 'fullstack';

  if (scope === 'frontend') {
    for (const field of fields.filter((item) => item.type === 'reference')) {
      unsupported.push({ source: field.source, text: `${field.label}: vínculo com ${field.references.name} precisa de API; no modo só frontend ele não é gerado.` });
      warnings.push(`Campo "${field.label}" (vínculo) removido: no modo só frontend não há API para carregar as opções.`);
    }

    for (let index = fields.length - 1; index >= 0; index -= 1) {
      if (fields[index].type === 'reference') {
        fields.splice(index, 1);
      }
    }

    for (const field of fields.filter((item) => item.unique)) {
      warnings.push(`Campo "${field.label}": "único" só é garantido pelo banco; no modo só frontend a repetição não é bloqueada.`);
      field.unique = false;
    }
  }

  for (const field of fields) {
    const candidate = (analysis?.labels ?? []).find((label) => {
      const wanted = normalizeWord(label);
      const current = normalizeWord(field.label);
      return wanted !== current && (current.startsWith(`${wanted}_`) || current === wanted);
    });

    if (candidate) {
      field.label = capitalize(candidate);
    }
  }

  const activeField = fields.find((field) => field.type === 'boolean' && /^(active|ativo|enabled|isActive)$/i.test(field.name));
  const rawPage = { ...(raw?.page ?? {}), ...(analysis?.actions ?? {}) };
  const page = {
    createLabel: cleanText(analysis?.createLabel ?? raw?.page?.createLabel, `${gender === 'f' ? 'Nova' : 'Novo'} ${labelSingular}`),
    delete: rawPage.delete !== false,
    toggleActive: Boolean(rawPage.toggleActive && activeField),
    statusBadge: Boolean(rawPage.statusBadge && activeField),
    search: rawPage.search !== false,
  };

  if (rawPage.toggleActive && !activeField) {
    warnings.push('O pedido fala em ativar/desativar, mas não há campo sim/não "active" (ativo): a ação não será gerada.');
  }

  const permissionMode = scope === 'frontend' || raw?.permissionMode === 'existente' ? 'existente' : 'nova';
  const menuIcon = toPascal(raw?.menuIcon) || 'List';
  const rules = normalizeRules(raw?.rules, fields, warnings, unsupported, { gender, labelSingular });
  const unsupportedItems = [...new Map(unsupported.map((item) => [normalizeWord(item.text), item])).values()]
    .filter((item) => !HANDLED_BY_GENERATOR.some((pattern) => pattern.test(ascii(item.text).toLowerCase())));

  return {
    spec: {
      entity,
      entityPlural,
      labelSingular,
      labelPlural,
      gender,
      title,
      route,
      screen,
      permissionMode,
      menuIcon,
      fields,
      rules,
      scope,
      page,
      unsupported: unsupportedItems.map((item) => item.text),
      unsupportedItems,
    },
    errors,
    warnings,
  };
}

export function deriveNames(spec, migrationNumber = '000') {
  const kebab = toKebab(spec.entity);
  const kebabPlural = toKebab(spec.entityPlural);
  const table = toSnake(spec.entityPlural);
  const moduleDir = `api/src/modules/${kebabPlural}`;

  return {
    entity: spec.entity,
    entityPlural: spec.entityPlural,
    camel: toCamel(spec.entity),
    camelPlural: toCamel(spec.entityPlural),
    kebab,
    kebabPlural,
    table,
    apiPath: kebabPlural,
    permission: spec.permissionMode === 'existente' ? spec.screen : table,
    searchField: spec.fields.find((field) => field.type === 'string') ?? null,
    columns: Object.fromEntries(spec.fields.map((field) => [field.name, toSnake(field.name)])),
    files: {
      migration: `db/init/${migrationNumber}-create-${kebabPlural}.sql`,
      dto: `${moduleDir}/dto/${kebab}.dto.ts`,
      service: `${moduleDir}/${kebabPlural}.service.ts`,
      controller: `${moduleDir}/${kebabPlural}.controller.ts`,
      module: `${moduleDir}/${kebabPlural}.module.ts`,
      appModule: 'api/src/app.module.ts',
      type: `web/src/types/${kebab}.ts`,
      apiClient: `web/src/lib/${kebab}-api.ts`,
      formModal: `web/src/components/${kebabPlural}/${spec.entity}FormModal.tsx`,
      page: `web/src/pages/${kebabPlural}/${spec.entityPlural}Page.tsx`,
      app: 'web/src/App.tsx',
      sidebar: 'web/src/components/Sidebar.tsx',
      webScreens: 'web/src/lib/screens.ts',
      apiScreens: 'api/src/modules/permissions/screens.ts',
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

export async function checkConflicts({ projectDir, spec, names, routes, tables, screens = [] }) {
  const errors = [];

  if (spec.permissionMode === 'nova' && screens.includes(names.permission)) {
    errors.push(`A tela de permissão "${names.permission}" já existe. Use "permissionMode": "existente" com "screen": "${names.permission}" ou troque "entityPlural".`);
  }

  const keys = spec.scope === 'frontend' ? ['type', 'formModal', 'page'] : ['dto', 'service', 'controller', 'module', 'type', 'apiClient', 'formModal', 'page'];

  for (const key of keys) {
    if (await exists(projectDir, names.files[key])) {
      errors.push(`Já existe ${names.files[key]}. Escolha outro nome de entidade em .detro/last-plan.json.`);
    }
  }

  if (routes.includes(spec.route)) {
    errors.push(`A rota ${spec.route} já está registrada em web/src/App.tsx. Troque "route" em .detro/last-plan.json.`);
  }

  if (spec.scope !== 'frontend' && tables.has(names.table)) {
    errors.push(`A tabela ${names.table} já existe (${tables.get(names.table).file}): talvez esse cadastro já exista no projeto. Se for outro, troque "entity"/"entityPlural" em .detro/last-plan.json e rode detro plan --revalidar.`);
  }

  return errors;
}

export function describeSpec(spec) {
  const lines = [
    `Entidade: ${spec.entity} / ${spec.entityPlural}`,
    `Rótulos: ${spec.labelSingular} / ${spec.labelPlural} (${spec.gender === 'f' ? 'feminino' : 'masculino'})`,
    `Título: ${spec.title}`,
    `Rota: ${spec.route}`,
    spec.scope === 'frontend'
      ? 'Escopo: só frontend (dados em memória, sem backend, API, migration nem banco)'
      : 'Escopo: completo (banco, backend, API e tela)',
    `Tela: ${[
      `botão "${spec.page.createLabel}"`,
      'editar',
      spec.page.delete ? 'excluir' : null,
      spec.page.toggleActive ? 'ativar/desativar' : null,
      spec.page.statusBadge ? 'status com destaque visual' : null,
      spec.page.search ? 'busca' : null,
    ].filter(Boolean).join(', ')}`,
    spec.permissionMode === 'existente'
      ? `Permissão: reaproveita a tela "${spec.screen}"`
      : `Permissão: tela própria "${toSnake(spec.entityPlural)}" (grupo de "${spec.screen}"; o perfil Administrador recebe acesso na migration)`,
    `Menu: "${spec.title}" no grupo onde está "${spec.screen}", ícone ${spec.menuIcon}`,
    'Campos:',
  ];

  for (const field of spec.fields) {
    const flags = [
      field.required ? 'obrigatório' : 'opcional',
      field.unique ? 'único' : null,
      field.maxLength ? `máx. ${field.maxLength}` : null,
      field.min !== undefined ? `mín. ${field.min}` : null,
      field.max !== undefined ? `máx. ${field.max}` : null,
    ].filter(Boolean).join(', ');

    const detail = field.type === 'enum'
      ? ` [${field.options.map((option) => `${option.value}="${option.label}"`).join(', ')}]`
      : field.type === 'reference'
        ? ` → ${field.references.name}.${field.references.labelColumn}${field.references.tenant ? ' (da mesma operadora)' : ''}`
        : '';

    lines.push(`  - ${field.name} (${field.type}) "${field.label}" — ${flags}${detail}`);
  }

  if (spec.rules?.length > 0) {
    lines.push('Regras:');

    for (const rule of spec.rules) {
      lines.push(rule.type === 'blockDelete'
        ? `  - bloqueia exclusão quando ${rule.field} = ${rule.values.join(' ou ')}: ${rule.message}`
        : `  - ${rule.left} ${rule.operator} ${rule.right}: ${rule.message}`);
    }
  }

  return lines.join('\n');
}
