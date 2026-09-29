const TRUE_BY_DEFAULT = new Set(['active', 'ativo', 'enabled', 'habilitado', 'visible']);

function identifier(value) {
  return value.length > 63 ? value.slice(0, 63) : value;
}

export function uniqueIndexName(names, field) {
  return identifier(`uq_${names.table}_operator_${names.columns[field.name]}`);
}

function sqlType(field) {
  switch (field.type) {
    case 'string':
      return `VARCHAR(${field.maxLength})`;
    case 'text':
      return 'TEXT';
    case 'integer':
      return 'INTEGER';
    case 'decimal':
      return 'NUMERIC(14,2)';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'enum':
      return 'VARCHAR(40)';
    case 'reference':
      return { uuid: 'UUID', bigint: 'BIGINT', integer: 'INTEGER' }[field.references.idType] ?? 'BIGINT';
    default:
      throw new Error(`Tipo de campo não suportado: ${field.type}`);
  }
}

function columnDefinition(field, column) {
  if (field.type === 'boolean') {
    return `${column} BOOLEAN NOT NULL DEFAULT ${TRUE_BY_DEFAULT.has(field.name.toLowerCase()) ? 'TRUE' : 'FALSE'}`;
  }

  const reference = field.type === 'reference'
    ? ` REFERENCES ${field.references.name}(id) ON DELETE RESTRICT`
    : '';

  return `${column} ${sqlType(field)}${field.required ? ' NOT NULL' : ''}${reference}`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function constraintsFor(names, field, column) {
  const constraints = [];
  const prefix = `ck_${names.table}_${column}`;

  if (field.type === 'string' || field.type === 'text') {
    constraints.push(
      field.required
        ? `CONSTRAINT ${identifier(`${prefix}_not_blank`)} CHECK (btrim(${column}) <> '')`
        : `CONSTRAINT ${identifier(`${prefix}_not_blank`)} CHECK (${column} IS NULL OR btrim(${column}) <> '')`,
    );
  }

  if (field.type === 'enum') {
    constraints.push(`CONSTRAINT ${identifier(`${prefix}_in`)} CHECK (${column} IN (${field.options.map((option) => sqlLiteral(option.value)).join(', ')}))`);
  }

  if (field.min !== undefined) {
    constraints.push(`CONSTRAINT ${identifier(`${prefix}_min`)} CHECK (${column} >= ${field.min})`);
  }

  if (field.max !== undefined) {
    constraints.push(`CONSTRAINT ${identifier(`${prefix}_max`)} CHECK (${column} <= ${field.max})`);
  }

  return constraints;
}

export function buildMigration({ spec, names, number }) {
  const rows = [
    ['id', 'BIGSERIAL PRIMARY KEY'],
    ['operator_id', 'BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE'],
  ];

  const constraints = [];

  for (const field of spec.fields) {
    const column = names.columns[field.name];
    const [, ...rest] = columnDefinition(field, column).split(' ');
    rows.push([column, rest.join(' ')]);
    constraints.push(...constraintsFor(names, field, column));
  }

  for (const rule of (spec.rules ?? []).filter((item) => item.type === 'compare')) {
    const left = names.columns[rule.left];
    const right = names.columns[rule.right];
    constraints.push(`CONSTRAINT ${identifier(`ck_${names.table}_${left}_${right}`)} CHECK (${left} IS NULL OR ${right} IS NULL OR ${left} ${rule.operator} ${right})`);
  }

  rows.push(['created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()']);
  rows.push(['updated_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()']);

  const width = Math.max(...rows.map(([column]) => column.length)) + 1;
  const body = [
    ...rows.map(([column, definition]) => `  ${column.padEnd(width)}${definition}`),
    ...constraints.map((constraint) => `  ${constraint}`),
  ].join(',\n');

  const indexes = [
    `CREATE INDEX IF NOT EXISTS ${identifier(`ix_${names.table}_operator`)} ON ${names.table} (operator_id);`,
  ];

  for (const field of spec.fields.filter((item) => item.type === 'reference')) {
    const column = names.columns[field.name];
    indexes.push(`CREATE INDEX IF NOT EXISTS ${identifier(`ix_${names.table}_${column}`)} ON ${names.table} (${column});`);
  }

  for (const field of spec.fields.filter((item) => item.unique)) {
    const column = names.columns[field.name];
    const expression = field.type === 'string' ? `lower(${column})` : column;
    indexes.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueIndexName(names, field)} ON ${names.table} (operator_id, ${expression});`);
  }

  const grant = spec.permissionMode === 'existente'
    ? ''
    : `
UPDATE permission_profiles
   SET permissions = permissions || jsonb_build_object('${names.permission}', jsonb_build_object('view', true, 'edit', true)),
       updated_at  = NOW()
 WHERE is_system
   AND name = 'Administrador'
   AND NOT permissions ? '${names.permission}';
`;

  return `-- ${number} — Cadastro de ${spec.labelPlural} (gerado pelo detro: db/init só roda em volume vazio; o detro apply oferece aplicar no banco de dev)

CREATE TABLE IF NOT EXISTS ${names.table} (
${body}
);

${indexes.join('\n')}
${grant}`;
}
