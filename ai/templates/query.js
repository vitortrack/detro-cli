function quote(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function pascal(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function tsType(kind) {
  return kind === 'number' ? 'number' : kind === 'boolean' ? 'boolean' : 'string';
}

function selectExpression(column) {
  if (column.kind === 'id') {
    return `t.${column.column}::text AS "${column.key}"`;
  }

  if (column.kind === 'number') {
    return `t.${column.column}::float8 AS "${column.key}"`;
  }

  if (column.kind === 'date') {
    return `to_char(t.${column.column}, 'YYYY-MM-DD') AS "${column.key}"`;
  }

  if (column.kind === 'datetime') {
    return `to_char(t.${column.column} AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') AS "${column.key}"`;
  }

  return `t.${column.column} AS "${column.key}"`;
}

function conditionCode(condition) {
  const column = `t.${condition.column}`;

  if (condition.operator === 'is_null' || condition.operator === 'not_null') {
    return `    conditions.push('${column} IS ${condition.operator === 'is_null' ? '' : 'NOT '}NULL');`;
  }

  if (condition.operator === 'contains') {
    return `    params.push(${JSON.stringify(`%${condition.value}%`)});
    conditions.push(\`${column} ILIKE $\${params.length}\`);`;
  }

  const operator = condition.operator === '!=' ? '<>' : condition.operator;
  const cast = condition.kind === 'date' || condition.kind === 'datetime' ? '::date' : '';
  const target = condition.kind === 'datetime' ? `(${column} AT TIME ZONE 'America/Sao_Paulo')::date` : column;
  return `    params.push(${JSON.stringify(condition.value)});
    conditions.push(\`${target} ${operator} $\${params.length}${cast}\`);`;
}

function filterParams(spec) {
  return spec.filters.flatMap((filter) => (filter.kind === 'range'
    ? [{ name: `${filter.key}Min`, filter, bound: 'min' }, { name: `${filter.key}Max`, filter, bound: 'max' }]
    : [{ name: filter.key, filter }]));
}

export function buildQueryDto({ spec, names }) {
  const params = filterParams(spec);
  const decorators = new Set(['IsInt', 'IsOptional', 'Max', 'Min']);
  const lines = [];

  for (const param of params) {
    const { filter } = param;
    lines.push('  @IsOptional()');

    if (filter.kind === 'search') {
      decorators.add('IsString');
      decorators.add('MaxLength');
      lines.push('  @IsString()', '  @MaxLength(100)', `  ${param.name}?: string;`, '');
    } else if (filter.kind === 'boolean') {
      decorators.add('IsBoolean');
      lines.push("  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))", `  @IsBoolean({ message: ${quote(`O filtro "${filter.label}" deve ser sim ou não.`)} })`, `  ${param.name}?: boolean;`, '');
    } else if (filter.valueKind === 'number') {
      decorators.add('IsNumber');
      lines.push('  @Type(() => Number)', `  @IsNumber({}, { message: ${quote(`O filtro "${filter.label}" (${param.bound === 'min' ? 'de' : 'até'}) deve ser um número.`)} })`, `  ${param.name}?: number;`, '');
    } else {
      decorators.add('IsDateString');
      lines.push(`  @IsDateString({}, { message: ${quote(`O filtro "${filter.label}" (${param.bound === 'min' ? 'de' : 'até'}) deve ser uma data (AAAA-MM-DD).`)} })`, `  ${param.name}?: string;`, '');
    }
  }

  const usesTransform = params.some((param) => param.filter.kind === 'boolean');

  return `import { ${usesTransform ? 'Transform, ' : ''}Type } from 'class-transformer';
import {
${[...decorators].sort().map((name) => `  ${name},`).join('\n')}
} from 'class-validator';

export class ${names.entity}QueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
${lines.length > 0 ? `\n${lines.join('\n').trimEnd()}\n` : ''}}
`;
}

export function buildQueryService({ spec, names }) {
  const { entity } = names;
  const params = filterParams(spec);
  const fixed = spec.conditions.map(conditionCode).join('\n');

  const dynamic = params.map((param) => {
    const { filter } = param;
    const column = `t.${filter.column}`;

    if (filter.kind === 'search') {
      return `    if (query.${param.name}?.trim()) {
      params.push(\`%\${query.${param.name}.trim()}%\`);
      conditions.push(\`${column} ILIKE $\${params.length}\`);
    }`;
    }

    if (filter.kind === 'boolean') {
      return `    if (query.${param.name} !== undefined) {
      params.push(query.${param.name});
      conditions.push(\`${column} = $\${params.length}\`);
    }`;
    }

    const cast = filter.valueKind === 'number' ? '' : '::date';
    const target = filter.valueKind === 'datetime' ? `(${column} AT TIME ZONE 'America/Sao_Paulo')::date` : column;

    return `    if (query.${param.name} !== undefined) {
      params.push(query.${param.name});
      conditions.push(\`${target} ${param.bound === 'min' ? '>=' : '<='} $\${params.length}${cast}\`);
    }`;
  }).join('\n\n');

  return `import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ${entity}QueryDto } from './dto/${names.kebab}-query.dto';

export interface ${entity}Row {
${spec.columns.map((column) => `  ${column.key}: ${tsType(column.kind)} | null;`).join('\n')}
}

export interface ${entity}Result {
  items: ${entity}Row[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

const COLUMNS = \`
  ${spec.columns.map(selectExpression).join(',\n  ')}
\`;

@Injectable()
export class ${entity}Service {
  constructor(private readonly dataSource: DataSource) {}

  async list(${spec.tenant ? 'operatorId: string, ' : ''}query: ${entity}QueryDto): Promise<${entity}Result> {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const params: unknown[] = [${spec.tenant ? 'operatorId' : ''}];
    const conditions: string[] = [${spec.tenant ? "'t.operator_id = $1'" : ''}];
${fixed ? `\n${fixed}\n` : ''}${dynamic ? `\n${dynamic}\n` : ''}
    const where = conditions.length > 0 ? \`WHERE \${conditions.join(' AND ')}\` : '';

    const [countRow] = await this.dataSource.query<{ total: number }[]>(
      \`SELECT COUNT(*)::int AS total FROM ${spec.table} t \${where}\`,
      params,
    );
    const total = Number(countRow?.total ?? 0);

    const items = await this.dataSource.query<${entity}Row[]>(
      \`
      SELECT \${COLUMNS}
        FROM ${spec.table} t
       \${where}
       ORDER BY t.${spec.orderBy.column} ${spec.orderBy.direction.toUpperCase()} NULLS LAST, t.id ASC
       LIMIT $\${params.length + 1} OFFSET $\${params.length + 2}
      \`,
      [...params, limit, (page - 1) * limit],
    );

    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }
}
`;
}

export function buildQueryController({ spec, names }) {
  const { entity } = names;

  return `import { Controller, Get, Query } from '@nestjs/common';

${spec.tenant ? "import { CurrentOperator } from '../auth/decorators/current-operator.decorator';\n" : ''}import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { ${entity}QueryDto } from './dto/${names.kebab}-query.dto';
import { ${entity}Result, ${entity}Service } from './${names.kebab}.service';

@Controller('${names.apiPath}')
export class ${entity}Controller {
  constructor(private readonly service: ${entity}Service) {}

  @Get()
  @RequirePermission('${names.permission}', 'view')
  list(
${spec.tenant ? '    @CurrentOperator() operatorId: string,\n' : ''}    @Query() query: ${entity}QueryDto,
  ): Promise<${entity}Result> {
    return this.service.list(${spec.tenant ? 'operatorId, ' : ''}query);
  }
}
`;
}

export function buildQueryModule({ names }) {
  return `import { Module } from '@nestjs/common';

import { ${names.entity}Controller } from './${names.kebab}.controller';
import { ${names.entity}Service } from './${names.kebab}.service';

@Module({
  controllers: [${names.entity}Controller],
  providers: [${names.entity}Service],
})
export class ${names.entity}Module {}
`;
}

export function queryFiltersTypeName(names) {
  return `${names.entity}Filters`;
}

export function emptyQueryFiltersName(names) {
  return `empty${names.entity}Filters`;
}

export function listQueryFunctionName(names) {
  return `list${names.entity}`;
}

export function buildQueryWebTypes({ spec, names }) {
  const params = filterParams(spec);

  return `export interface ${names.entity}Row {
${spec.columns.map((column) => `  ${column.key}: ${tsType(column.kind)} | null;`).join('\n')}
}

export interface ${names.entity}Result {
  items: ${names.entity}Row[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ${queryFiltersTypeName(names)} {
${params.map((param) => `  ${param.name}: ${param.filter.kind === 'boolean' ? "'' | 'true' | 'false'" : 'string'};`).join('\n')}
}

export const ${emptyQueryFiltersName(names)}: ${queryFiltersTypeName(names)} = {
${params.map((param) => `  ${param.name}: '',`).join('\n')}
};
`;
}

export function buildQueryApiClient({ spec, names }) {
  const params = filterParams(spec);

  return `import { api } from '@/lib/api';
import type { ${queryFiltersTypeName(names)}, ${names.entity}Result } from '@/types/${names.kebab}';

export async function ${listQueryFunctionName(names)}(
  page: number,
  limit: number,
  filters: ${queryFiltersTypeName(names)},
): Promise<${names.entity}Result> {
  const { data } = await api.get<${names.entity}Result>('/${names.apiPath}', {
    params: {
      page,
      limit,
${params.map((param) => `      ${param.name}: filters.${param.name}${param.filter.kind === 'search' ? '.trim()' : ''} || undefined,`).join('\n')}
    },
  });

  return data;
}
`;
}

export function queryFilterParams(spec) {
  return filterParams(spec).map((param) => ({ name: param.name, label: param.filter.label, kind: param.filter.kind, valueKind: param.filter.valueKind, bound: param.bound }));
}

export { pascal as capitalizeQueryName };
