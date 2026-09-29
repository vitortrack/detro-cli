import { uniqueIndexName } from './database.js';

const TEXTUAL = ['string', 'text', 'date', 'enum', 'reference'];

function article(spec) {
  return spec.gender === 'f' ? 'a' : 'o';
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function quote(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function pascal(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export function labelKey(field) {
  return `${field.name.replace(/Id$/, '')}Label`;
}

function viewType(field) {
  const base = field.type === 'integer' || field.type === 'decimal'
    ? 'number'
    : field.type === 'boolean'
      ? 'boolean'
      : 'string';

  return field.required || field.type === 'boolean' ? base : `${base} | null`;
}

function dtoProperty(field, decorators) {
  const label = field.label;
  const message = (text) => `{ message: ${quote(text)} }`;
  const lines = [];
  const optional = !field.required;

  if (TEXTUAL.includes(field.type)) {
    lines.push(optional ? '@Transform(emptyToNull)' : '@Transform(trim)');
  }

  if (optional) {
    decorators.add('IsOptional');
    lines.push('@IsOptional()');
  }

  if (field.type === 'string' || field.type === 'text') {
    decorators.add('IsString');
    lines.push(`@IsString(${message(`O campo "${label}" deve ser um texto.`)})`);

    if (field.required) {
      decorators.add('IsNotEmpty');
      lines.push(`@IsNotEmpty(${message(`Preencha o campo "${label}".`)})`);
    }

    const maxLength = field.type === 'string' ? field.maxLength : 5000;
    decorators.add('MaxLength');
    lines.push(`@MaxLength(${maxLength}, ${message(`O campo "${label}" aceita no máximo ${maxLength} caracteres.`)})`);
  }

  if (field.type === 'integer') {
    decorators.add('IsInt');
    lines.push(`@IsInt(${message(field.required ? `Preencha o campo "${label}" com um número inteiro.` : `O campo "${label}" deve ser um número inteiro.`)})`);
  }

  if (field.type === 'decimal') {
    decorators.add('IsNumber');
    lines.push(`@IsNumber({ maxDecimalPlaces: 2 }, ${message(field.required ? `Preencha o campo "${label}" com um número de até 2 casas decimais.` : `O campo "${label}" deve ser um número com até 2 casas decimais.`)})`);
  }

  if (field.min !== undefined) {
    decorators.add('Min');
    lines.push(`@Min(${field.min}, ${message(`O campo "${label}" deve ser maior ou igual a ${field.min}.`)})`);
  }

  if (field.max !== undefined) {
    decorators.add('Max');
    lines.push(`@Max(${field.max}, ${message(`O campo "${label}" deve ser menor ou igual a ${field.max}.`)})`);
  }

  if (field.type === 'boolean') {
    decorators.add('IsBoolean');
    lines.push(`@IsBoolean(${message(`O campo "${label}" deve ser verdadeiro ou falso.`)})`);
  }

  if (field.type === 'date') {
    decorators.add('IsDateString');
    lines.push(`@IsDateString({}, ${message(field.required ? `Preencha o campo "${label}" com uma data (AAAA-MM-DD).` : `O campo "${label}" deve ser uma data no formato AAAA-MM-DD.`)})`);
  }

  if (field.type === 'enum') {
    decorators.add('IsIn');
    const values = field.options.map((option) => quote(option.value)).join(', ');
    const labels = field.options.map((option) => option.label).join(', ');
    lines.push(`@IsIn([${values}], ${message(`Escolha "${label}" entre: ${labels}.`)})`);
  }

  if (field.type === 'reference') {
    if (field.references.idType === 'uuid') {
      decorators.add('IsUUID');
      lines.push(`@IsUUID('all', ${message(`"${label}": selecione um item da lista.`)})`);
    } else {
      decorators.add('Matches');
      lines.push(`@Matches(/^\\d+$/, ${message(`"${label}": selecione um item da lista.`)})`);
    }
  }

  const declaration = field.type === 'boolean'
    ? `${field.name}?: boolean;`
    : field.required
      ? `${field.name}!: ${viewType(field)};`
      : `${field.name}?: ${viewType(field)};`;

  return [...lines, declaration].map((line) => `  ${line}`).join('\n');
}

export function buildDto({ spec, names }) {
  const decorators = new Set(['IsInt', 'IsOptional', 'IsString', 'Max', 'MaxLength', 'Min']);
  const properties = spec.fields.map((field) => dtoProperty(field, decorators)).join('\n\n');
  const usesTransform = spec.fields.some((field) => TEXTUAL.includes(field.type));
  const usesTrim = spec.fields.some((field) => field.required && TEXTUAL.includes(field.type));
  const usesEmptyToNull = spec.fields.some((field) => !field.required && TEXTUAL.includes(field.type));

  const helpers = [
    usesTrim ? 'const trim = ({ value }: { value: unknown }) =>\n  typeof value === \'string\' ? value.trim() : value;' : null,
    usesEmptyToNull ? 'const emptyToNull = ({ value }: { value: unknown }) => {\n  if (typeof value !== \'string\') {\n    return value;\n  }\n\n  const trimmed = value.trim();\n  return trimmed === \'\' ? null : trimmed;\n};' : null,
  ].filter(Boolean).join('\n\n');

  return `import { PartialType } from '@nestjs/mapped-types';
import { ${usesTransform ? 'Transform, ' : ''}Type } from 'class-transformer';
import {
${[...decorators].sort().map((name) => `  ${name},`).join('\n')}
} from 'class-validator';
${helpers ? `\n${helpers}\n` : ''}
export class ${names.entity}ListQueryDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class Create${names.entity}Dto {
${properties}
}

export class Update${names.entity}Dto extends PartialType(Create${names.entity}Dto) {}
`;
}

function referenceAlias(field) {
  return `r_${field.name.replace(/Id$/, '').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`;
}

function selectExpression(field, column) {
  if (field.type === 'decimal') {
    return `t.${column}::float8 AS "${field.name}"`;
  }

  if (field.type === 'date') {
    return `to_char(t.${column}, 'YYYY-MM-DD') AS "${field.name}"`;
  }

  if (field.type === 'reference') {
    return `t.${column}::text AS "${field.name}",\n  ${referenceAlias(field)}.${field.references.labelColumn} AS "${labelKey(field)}"`;
  }

  return `t.${column} AS "${field.name}"`;
}

function referenceChecks(spec, names) {
  return spec.fields
    .filter((field) => field.type === 'reference' && field.references.tenant)
    .map((field) => `    if (input.${field.name} !== undefined && input.${field.name} !== null) {
      const [found] = await this.dataSource.query<{ id: string }[]>(
        'SELECT id::text AS id FROM ${field.references.name} WHERE id = $1 AND operator_id = $2',
        [input.${field.name}, operatorId],
      );

      if (!found) {
        throw new BadRequestException(${quote(`"${field.label}": o item escolhido não pertence a esta operadora. Selecione outro na lista.`)});
      }
    }`)
    .join('\n\n');
}

function ruleChecks(spec) {
  return (spec.rules ?? [])
    .filter((rule) => rule.type === 'compare')
    .map((rule) => `    if (merged.${rule.left} != null && merged.${rule.right} != null && !(merged.${rule.left} ${rule.operator} merged.${rule.right})) {
      throw new BadRequestException(${quote(rule.message)});
    }`)
    .join('\n\n');
}

export function buildService({ spec, names }) {
  const { entity, entityPlural, table } = names;
  const a = article(spec);
  const notFound = `${capitalize(spec.labelSingular)} não encontrad${a} nesta operadora. Atualize a lista e tente novamente.`;
  const references = spec.fields.filter((field) => field.type === 'reference');

  const columns = [
    't.id::text AS "id"',
    ...spec.fields.map((field) => selectExpression(field, names.columns[field.name])),
    't.created_at AS "createdAt"',
    't.updated_at AS "updatedAt"',
  ];

  const joins = references
    .map((field) => `  LEFT JOIN ${field.references.name} ${referenceAlias(field)} ON ${referenceAlias(field)}.id = t.${names.columns[field.name]}`)
    .join('\n');

  const uniqueMessages = spec.fields
    .filter((field) => field.unique)
    .map((field) => `  ${uniqueIndexName(names, field)}:\n    ${quote(`Já existe ${spec.gender === 'f' ? 'uma' : 'um'} ${spec.labelSingular} com este valor em "${field.label}". Informe outro valor.`)},`);

  const search = names.searchField
    ? `
    const search = query.search?.trim();

    if (search) {
      params.push(\`%\${search}%\`);
      conditions.push(\`t.${names.columns[names.searchField.name]} ILIKE $\${params.length}\`);
    }
`
    : '';

  const orderBy = names.searchField
    ? `t.${names.columns[names.searchField.name]} ASC, t.id ASC`
    : 't.id DESC';

  const optionTypes = references.length > 0
    ? `
export interface ${entity}Option {
  id: string;
  label: string;
}
`
    : '';

  const optionMethods = references.map((field) => `
  listOptions${pascal(field.name.replace(/Id$/, ''))}(${field.references.tenant ? 'operatorId: string' : ''}): Promise<${entity}Option[]> {
    return this.dataSource.query<${entity}Option[]>(
      \`SELECT id::text AS id, ${field.references.labelColumn} AS label
         FROM ${field.references.name}
        ${field.references.tenant ? 'WHERE operator_id = $1\n        ' : ''}ORDER BY ${field.references.labelColumn} ASC
        LIMIT 1000\`,
      ${field.references.tenant ? '[operatorId]' : '[]'},
    );
  }
`).join('');

  const deleteGuards = (spec.rules ?? [])
    .filter((rule) => rule.type === 'blockDelete')
    .map((rule) => `
    if ((${JSON.stringify(rule.values).replaceAll('"', "'")} as unknown[]).includes(current.${rule.field})) {
      throw new ConflictException(${quote(rule.message)});
    }
`)
    .join('');
  const checks = referenceChecks(spec, names);
  const rules = ruleChecks(spec);
  const needsValidation = Boolean(checks || rules);

  const validateMethod = needsValidation
    ? `
  private async validateInput(
    operatorId: string,
    input: Update${entity}Dto,
    current: ${entity}View | null,
  ): Promise<void> {
${rules ? `    const merged = { ...(current ?? {}), ...input } as Record<string, unknown> & Partial<${entity}View>;\n\n${rules}${checks ? '\n\n' : ''}` : ''}${checks}
  }
`
    : '';


  return `import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  Create${entity}Dto,
  ${entity}ListQueryDto,
  Update${entity}Dto,
} from './dto/${names.kebab}.dto';

export interface ${entity}View {
  id: string;
${spec.fields.map((field) => `  ${field.name}: ${viewType(field)};${field.type === 'reference' ? `\n  ${labelKey(field)}: string | null;` : ''}`).join('\n')}
  createdAt: string;
  updatedAt: string;
}

export interface ${entity}ListResult {
  items: ${entity}View[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
${optionTypes}
const COLUMNS = \`
  ${columns.join(',\n  ')}
\`;

const FROM = \`
  FROM ${table} t
${joins ? `${joins}\n` : ''}\`;

const WRITABLE_COLUMNS: Record<string, string> = {
${spec.fields.map((field) => `  ${field.name}: '${names.columns[field.name]}',`).join('\n')}
};

const UNIQUE_MESSAGES: Record<string, string> = {
${uniqueMessages.join('\n')}
};

@Injectable()
export class ${entityPlural}Service {
  constructor(private readonly dataSource: DataSource) {}

  async list(
    operatorId: string,
    query: ${entity}ListQueryDto,
  ): Promise<${entity}ListResult> {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const params: unknown[] = [operatorId];
    const conditions: string[] = ['t.operator_id = $1'];
${search}
    const where = conditions.join(' AND ');

    const [countRow] = await this.dataSource.query<{ total: number }[]>(
      \`SELECT COUNT(*)::int AS total FROM ${table} t WHERE \${where}\`,
      params,
    );
    const total = Number(countRow?.total ?? 0);

    const items = await this.dataSource.query<${entity}View[]>(
      \`
      SELECT \${COLUMNS}
      \${FROM}
       WHERE \${where}
       ORDER BY ${orderBy}
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

  async findOne(operatorId: string, id: string): Promise<${entity}View> {
    this.assertId(id);

    const [row] = await this.dataSource.query<${entity}View[]>(
      \`SELECT \${COLUMNS} \${FROM} WHERE t.id = $1 AND t.operator_id = $2\`,
      [id, operatorId],
    );

    if (!row) {
      throw new NotFoundException(${quote(notFound)});
    }

    return row;
  }
${optionMethods}
  async create(
    operatorId: string,
    dto: Create${entity}Dto,
  ): Promise<${entity}View> {
${needsValidation ? '    await this.validateInput(operatorId, dto, null);\n\n' : ''}    const values = this.writableValues(dto);
    const columns = ['operator_id', ...values.map(([column]) => column)];
    const params = [operatorId, ...values.map(([, value]) => value)];
    const placeholders = params.map((_, index) => \`$\${index + 1}\`);

    const rows = await this.translateErrors('write', () =>
      this.dataSource.query<{ id: string }[]>(
        \`INSERT INTO ${table} (\${columns.join(', ')}) VALUES (\${placeholders.join(', ')}) RETURNING id::text AS id\`,
        params,
      ),
    );

    return this.findOne(operatorId, rows[0].id);
  }

  async update(
    operatorId: string,
    id: string,
    dto: Update${entity}Dto,
  ): Promise<${entity}View> {
    ${needsValidation ? 'const current = ' : ''}await this.findOne(operatorId, id);
${needsValidation ? '    await this.validateInput(operatorId, dto, current);\n' : ''}
    const values = this.writableValues(dto);

    if (values.length > 0) {
      const params: unknown[] = [id, operatorId];
      const assignments = values.map(([column, value]) => {
        params.push(value);
        return \`\${column} = $\${params.length}\`;
      });

      await this.translateErrors('write', () =>
        this.dataSource.query(
          \`UPDATE ${table} SET \${assignments.join(', ')}, updated_at = NOW() WHERE id = $1 AND operator_id = $2\`,
          params,
        ),
      );
    }

    return this.findOne(operatorId, id);
  }

  async remove(operatorId: string, id: string): Promise<void> {
    ${deleteGuards ? 'const current = ' : ''}await this.findOne(operatorId, id);
${deleteGuards}
    await this.translateErrors('delete', () =>
      this.dataSource.query(
        'DELETE FROM ${table} WHERE id = $1 AND operator_id = $2',
        [id, operatorId],
      ),
    );
  }
${validateMethod}
  private writableValues(dto: Update${entity}Dto): Array<[string, unknown]> {
    const input = dto as Record<string, unknown>;

    return Object.entries(WRITABLE_COLUMNS)
      .filter(([field]) => input[field] !== undefined)
      .map(([field, column]) => [column, input[field]]);
  }

  private assertId(id: string): void {
    if (!/^\\d+$/.test(id)) {
      throw new NotFoundException(${quote(notFound)});
    }
  }

  private async translateErrors<T>(
    context: 'write' | 'delete',
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const { code, constraint } = error as { code?: string; constraint?: string };

      if (code === '23505') {
        throw new ConflictException(
          UNIQUE_MESSAGES[constraint ?? ''] ?? ${quote(`Já existe ${spec.gender === 'f' ? 'uma' : 'um'} ${spec.labelSingular} com estes dados. Revise os campos únicos.`)},
        );
      }

      if (code === '23502') {
        throw new BadRequestException('Preencha todos os campos obrigatórios.');
      }

      if (code === '23514') {
        throw new BadRequestException('Algum valor está fora do permitido. Revise os campos e tente novamente.');
      }

      if (code === '23503') {
        throw context === 'delete'
          ? new ConflictException(${quote(`Não é possível excluir: existem registros vinculados a est${spec.gender === 'f' ? 'a' : 'e'} ${spec.labelSingular}. Remova os vínculos primeiro.`)})
          : new BadRequestException('Um dos itens selecionados não existe mais. Atualize a tela e selecione de novo.');
      }

      throw error;
    }
  }
}
`;
}

export function buildController({ spec, names }) {
  const { entity, entityPlural } = names;
  const screen = names.permission;
  const references = spec.fields.filter((field) => field.type === 'reference');

  const optionRoutes = references.map((field) => {
    const suffix = field.name.replace(/Id$/, '');
    const route = suffix.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const usesOperator = field.references.tenant;

    return `
  @Get('options/${route}')
  @RequirePermission('${screen}', 'view')
  listOptions${pascal(suffix)}(${usesOperator ? '@CurrentOperator() operatorId: string' : ''}): Promise<${entity}Option[]> {
    return this.service.listOptions${pascal(suffix)}(${usesOperator ? 'operatorId' : ''});
  }
`;
  }).join('');

  return `import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentOperator } from '../auth/decorators/current-operator.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import {
  Create${entity}Dto,
  ${entity}ListQueryDto,
  Update${entity}Dto,
} from './dto/${names.kebab}.dto';
import {
  ${entity}ListResult,
${references.length > 0 ? `  ${entity}Option,\n` : ''}  ${entity}View,
  ${entityPlural}Service,
} from './${names.kebabPlural}.service';

@Controller('${names.apiPath}')
export class ${entityPlural}Controller {
  constructor(private readonly service: ${entityPlural}Service) {}

  @Get()
  @RequirePermission('${screen}', 'view')
  list(
    @CurrentOperator() operatorId: string,
    @Query() query: ${entity}ListQueryDto,
  ): Promise<${entity}ListResult> {
    return this.service.list(operatorId, query);
  }
${optionRoutes}
  @Get(':id')
  @RequirePermission('${screen}', 'view')
  findOne(
    @CurrentOperator() operatorId: string,
    @Param('id') id: string,
  ): Promise<${entity}View> {
    return this.service.findOne(operatorId, id);
  }

  @Post()
  @RequirePermission('${screen}', 'edit')
  create(
    @CurrentOperator() operatorId: string,
    @Body() dto: Create${entity}Dto,
  ): Promise<${entity}View> {
    return this.service.create(operatorId, dto);
  }

  @Patch(':id')
  @RequirePermission('${screen}', 'edit')
  update(
    @CurrentOperator() operatorId: string,
    @Param('id') id: string,
    @Body() dto: Update${entity}Dto,
  ): Promise<${entity}View> {
    return this.service.update(operatorId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('${screen}', 'edit')
  remove(
    @CurrentOperator() operatorId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.service.remove(operatorId, id);
  }
}
`;
}

export function buildModule({ names }) {
  return `import { Module } from '@nestjs/common';

import { ${names.entityPlural}Controller } from './${names.kebabPlural}.controller';
import { ${names.entityPlural}Service } from './${names.kebabPlural}.service';

@Module({
  controllers: [${names.entityPlural}Controller],
  providers: [${names.entityPlural}Service],
})
export class ${names.entityPlural}Module {}
`;
}
