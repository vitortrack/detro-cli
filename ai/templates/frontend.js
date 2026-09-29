function pascal(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function quote(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export function enumTypeName(names, field) {
  return `${names.entity}${pascal(field.name)}`;
}

export function enumOptionsName(names, field) {
  return `${names.camel}${pascal(field.name)}Options`;
}

export function optionsFunctionName(names, field) {
  return `list${names.entity}${pascal(field.name.replace(/Id$/, ''))}Options`;
}

export function optionsRoute(field) {
  return field.name.replace(/Id$/, '').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function labelKey(field) {
  return `${field.name.replace(/Id$/, '')}Label`;
}

function formType(names, field) {
  if (field.type === 'integer' || field.type === 'decimal') {
    return 'number | null';
  }

  if (field.type === 'boolean') {
    return 'boolean';
  }

  if (field.type === 'enum') {
    return field.required ? enumTypeName(names, field) : `${enumTypeName(names, field)} | ''`;
  }

  return 'string';
}

function viewType(names, field) {
  const base = field.type === 'integer' || field.type === 'decimal'
    ? 'number'
    : field.type === 'boolean'
      ? 'boolean'
      : field.type === 'enum'
        ? enumTypeName(names, field)
        : 'string';

  return field.required || field.type === 'boolean' ? base : `${base} | null`;
}

const TRUE_BY_DEFAULT = ['active', 'ativo', 'enabled', 'habilitado', 'visible', 'isactive'];

export function emptyFormName(names) {
  return `empty${names.entity}Form`;
}

export function toFormDataName(names) {
  return `to${names.entity}FormData`;
}

export function buildEntityName(names) {
  return `build${names.entity}`;
}

function emptyValue(field) {
  if (field.type === 'enum' && field.required) {
    return quote(field.options[0].value);
  }

  if (field.type === 'integer' || field.type === 'decimal') {
    return 'null';
  }

  if (field.type === 'boolean') {
    return TRUE_BY_DEFAULT.includes(field.name.toLowerCase()) ? 'true' : 'false';
  }

  return "''";
}

function toFormValue(field) {
  const optional = !field.required && ['string', 'text', 'date', 'reference', 'enum'].includes(field.type);
  return optional ? `item.${field.name} ?? ''` : `item.${field.name}`;
}

function fromFormValue(field) {
  if (['string', 'text', 'date'].includes(field.type)) {
    return field.required ? `form.${field.name}.trim()` : `form.${field.name}.trim() || null`;
  }

  if (field.type === 'enum' && !field.required) {
    return `form.${field.name} || null`;
  }

  if ((field.type === 'integer' || field.type === 'decimal') && field.required) {
    return `form.${field.name} ?? 0`;
  }

  return `form.${field.name}`;
}

export function buildWebTypes({ spec, names }) {
  const enums = spec.fields.filter((field) => field.type === 'enum');
  const references = spec.fields.filter((field) => field.type === 'reference');

  const enumDeclarations = enums.map((field) => `export type ${enumTypeName(names, field)} = ${field.options.map((option) => quote(option.value)).join(' | ')};

export const ${enumOptionsName(names, field)}: Array<{ value: ${enumTypeName(names, field)}; label: string }> = [
${field.options.map((option) => `  { value: ${quote(option.value)}, label: ${quote(option.label)} },`).join('\n')}
];
`).join('\n');

  return `${enumDeclarations ? `${enumDeclarations}\n` : ''}export interface ${names.entity} {
  id: string;
${spec.fields.map((field) => `  ${field.name}: ${viewType(names, field)};${field.type === 'reference' ? `\n  ${labelKey(field)}: string | null;` : ''}`).join('\n')}
  createdAt: string;
  updatedAt: string;
}

export interface ${names.entity}FormData {
${spec.fields.map((field) => `  ${field.name}: ${formType(names, field)};`).join('\n')}
}
${references.length > 0 ? `
export interface ${names.entity}Option {
  id: string;
  label: string;
}
` : ''}
${spec.scope === 'frontend' ? '' : `export interface ${names.entity}ListResponse {
  items: ${names.entity}[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

`}export const ${emptyFormName(names)}: ${names.entity}FormData = {
${spec.fields.map((field) => `  ${field.name}: ${emptyValue(field)},`).join('\n')}
};

export function ${toFormDataName(names)}(item: ${names.entity}): ${names.entity}FormData {
  return {
${spec.fields.map((field) => `    ${field.name}: ${toFormValue(field)},`).join('\n')}
  };
}
${spec.scope === 'frontend' ? `
export function ${buildEntityName(names)}(form: ${names.entity}FormData, current: ${names.entity} | null): ${names.entity} {
  const now = new Date().toISOString();

  return {
    id: current?.id ?? crypto.randomUUID(),
${spec.fields.map((field) => `    ${field.name}: ${fromFormValue(field)},`).join('\n')}
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
}
` : ''}`;
}

function payloadValue(field) {
  if (['string', 'text', 'date', 'reference'].includes(field.type)) {
    return field.required
      ? `form.${field.name}.trim()`
      : `form.${field.name}.trim() || null`;
  }

  if (field.type === 'enum' && !field.required) {
    return `form.${field.name} || null`;
  }

  return `form.${field.name}`;
}

export function buildApiClient({ spec, names }) {
  const { entity, entityPlural, apiPath } = names;
  const references = spec.fields.filter((field) => field.type === 'reference');

  const optionFunctions = references.map((field) => `
export async function ${optionsFunctionName(names, field)}(): Promise<${entity}Option[]> {
  const { data } = await api.get<${entity}Option[]>('/${apiPath}/options/${optionsRoute(field)}');
  return data;
}
`).join('');

  return `import { api } from '@/lib/api';
import type {
  ${entity},
  ${entity}FormData,
  ${entity}ListResponse,
${references.length > 0 ? `  ${entity}Option,\n` : ''}} from '@/types/${names.kebab}';

export interface ${entity}ListParams {
  page: number;
  limit: number;
  search?: string;
}

function toPayload(form: ${entity}FormData) {
  return {
${spec.fields.map((field) => `    ${field.name}: ${payloadValue(field)},`).join('\n')}
  };
}

export async function list${entityPlural}(
  params: ${entity}ListParams,
): Promise<${entity}ListResponse> {
  const { data } = await api.get<${entity}ListResponse>('/${apiPath}', {
    params: {
      page: params.page,
      limit: params.limit,
      search: params.search?.trim() || undefined,
    },
  });

  return data;
}
${optionFunctions}
export async function create${entity}(
  form: ${entity}FormData,
): Promise<${entity}> {
  const { data } = await api.post<${entity}>('/${apiPath}', toPayload(form));
  return data;
}

export async function update${entity}(
  id: string,
  form: ${entity}FormData,
): Promise<${entity}> {
  const { data } = await api.patch<${entity}>(\`/${apiPath}/\${id}\`, toPayload(form));
  return data;
}

export async function delete${entity}(id: string): Promise<void> {
  await api.delete(\`/${apiPath}/\${id}\`);
}
`;
}
