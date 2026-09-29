import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadTypeScript } from './typescript.js';

export async function readProjectFile(projectDir, relativePath) {
  return readFile(path.join(projectDir, relativePath), 'utf8');
}

export async function readOptionalProjectFile(projectDir, relativePath) {
  try {
    return await readProjectFile(projectDir, relativePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function loadDependencies(projectDir, workspace) {
  let dir = workspace || '.';
  let raw = null;

  while (raw === null) {
    raw = await readOptionalProjectFile(projectDir, path.posix.join(dir, 'package.json'));

    if (raw !== null || dir === '.' || dir === '') {
      break;
    }

    dir = path.posix.dirname(dir);
  }

  if (!raw) {
    return new Set();
  }

  const pkg = JSON.parse(raw);

  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

export function isInstalled(projectDir, workspace, name) {
  try {
    createRequire(path.join(projectDir, workspace || '.', 'index.js')).resolve(`${name}/package.json`);
    return true;
  } catch {
    return existsSync(path.join(projectDir, workspace || '.', 'node_modules', name));
  }
}

function parseScreenKeys(content) {
  const union = content?.match(/export\s+type\s+ScreenKey\s*=([^;]+);/);
  return union ? [...union[1].matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]) : null;
}

export async function listScreens(projectDir) {
  const webContent = await readOptionalProjectFile(projectDir, 'web/src/lib/screens.ts');
  const apiContent = await readOptionalProjectFile(projectDir, 'api/src/modules/permissions/screens.ts');
  const webKeys = parseScreenKeys(webContent) ?? [];
  const apiKeys = parseScreenKeys(apiContent);
  const keys = apiKeys ? webKeys.filter((key) => apiKeys.includes(key)) : webKeys;
  const labels = new Map(
    [...(webContent ?? '').matchAll(/key:\s*'([a-z0-9_]+)',\s*label:\s*'([^']+)',\s*group:\s*'([^']+)'/g)]
      .map((match) => [match[1], `${match[3]} › ${match[2]}`]),
  );

  return keys.map((key) => ({ key, label: labels.get(key) ?? key }));
}

export async function listRoutes(projectDir) {
  const content = await readOptionalProjectFile(projectDir, 'web/src/App.tsx');
  return [...(content ?? '').matchAll(/path=\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

async function walkFiles(dir, predicate, output = []) {
  let entries = [];

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        await walkFiles(absolute, predicate, output);
      }
    } else if (predicate(entry.name)) {
      output.push(absolute);
    }
  }

  return output;
}

const LABEL_COLUMNS = ['name', 'nome', 'title', 'titulo', 'plate', 'placa', 'fleet_number', 'code', 'codigo', 'legal_name', 'description', 'descricao', 'email'];

function parseColumns(body) {
  const columns = new Map();

  for (const line of body.split('\n')) {
    const match = line.match(/^\s*"?([a-z_][a-z0-9_]*)"?\s+([A-Za-z]+(?:\s*\([^)]*\))?)/);

    if (match && !/^(constraint|primary|unique|check|foreign|exclude)$/i.test(match[1])) {
      columns.set(match[1].toLowerCase(), match[2].toUpperCase());
    }
  }

  return columns;
}

function idTypeOf(columns) {
  const type = columns.get('id') ?? '';

  if (/UUID/.test(type)) {
    return 'uuid';
  }

  if (/BIGSERIAL|BIGINT|INT8/.test(type)) {
    return 'bigint';
  }

  if (/SERIAL|INT/.test(type)) {
    return 'integer';
  }

  return null;
}

export async function listTables(projectDir) {
  const tables = new Map();
  const migrations = (await walkFiles(path.join(projectDir, 'db', 'init'), (name) => name.endsWith('.sql'))).sort();
  const bootstraps = await walkFiles(path.join(projectDir, 'api', 'src'), (name) => /bootstrap.*\.ts$/.test(name));

  for (const absolute of [...migrations, ...bootstraps]) {
    const file = path.relative(projectDir, absolute).replaceAll('\\', '/');
    const sql = await readFile(absolute, 'utf8');

    for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\s*\);/gi)) {
      const name = match[1].toLowerCase();
      const previous = tables.get(name);
      const columns = new Map([...(previous?.columns ?? []), ...parseColumns(match[2])]);

      tables.set(name, {
        file: previous?.file ?? file,
        tenant: columns.has('operator_id') || previous?.tenant === true,
        columns,
      });
    }

    for (const match of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?([^;]*);/gi)) {
      const name = match[1].toLowerCase();
      const added = [...match[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s+([A-Za-z]+(?:\s*\([^)]*\))?)/gi)];

      if (added.length === 0) {
        continue;
      }

      const previous = tables.get(name) ?? { file, tenant: false, columns: new Map() };

      for (const column of added) {
        previous.columns.set(column[1].toLowerCase(), column[2].toUpperCase());
        previous.tenant = previous.tenant || column[1].toLowerCase() === 'operator_id';
      }

      tables.set(name, previous);
    }
  }

  for (const table of tables.values()) {
    table.idType = idTypeOf(table.columns);
    table.labelColumn = LABEL_COLUMNS.find((column) => table.columns.has(column)) ?? null;
  }

  return tables;
}

export function referenceableTables(tables) {
  return [...tables]
    .filter(([name, table]) => table.idType && table.labelColumn && !/^(users|operators|permission_profiles|user_operators|worker_cursors)$/.test(name))
    .map(([name, table]) => ({ name, idType: table.idType, labelColumn: table.labelColumn, tenant: table.tenant }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function nextMigrationNumber(projectDir) {
  let files = [];

  try {
    files = await readdir(path.join(projectDir, 'db', 'init'));
  } catch {
    return '001';
  }

  const max = files.reduce((current, file) => {
    const number = Number(file.match(/^(\d+)-/)?.[1] ?? 0);
    return Math.max(current, number);
  }, 0);

  return String(max + 1).padStart(3, '0');
}

export async function listCssClasses(projectDir) {
  const css = await readOptionalProjectFile(projectDir, 'web/src/index.css');
  const names = [...(css ?? '').matchAll(/^\s*\.((?:btn|input|label|card|badge|table|chip|select|textarea)[a-z0-9-]*)\s*[{,]/gm)]
    .map((match) => match[1]);

  return [...new Set(names)];
}

function compact(text, limit = 480) {
  const value = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function describePropsType(ts, sourceFile, parameter) {
  const type = parameter?.type;

  if (!type) {
    return '';
  }

  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText(sourceFile);

    for (const statement of sourceFile.statements) {
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === name) {
        const body = ts.isInterfaceDeclaration(statement)
          ? `{ ${statement.members.map((member) => member.getText(sourceFile)).join(' ')} }`
          : statement.type.getText(sourceFile);

        return compact(body);
      }
    }
  }

  return compact(type.getText(sourceFile));
}

function exportedComponents(ts, sourceFile) {
  const components = [];
  const isExported = (node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement) && /^[A-Z]/.test(statement.name.text)) {
      const generics = statement.typeParameters
        ? `<${statement.typeParameters.map((parameter) => parameter.getText(sourceFile)).join(', ')}>`
        : '';

      components.push({
        name: statement.name.text,
        generics,
        props: describePropsType(ts, sourceFile, statement.parameters[0]),
      });
    }

    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;

        if (
          ts.isIdentifier(declaration.name)
          && /^[A-Z]/.test(declaration.name.text)
          && initializer
          && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          components.push({
            name: declaration.name.text,
            generics: '',
            props: describePropsType(ts, sourceFile, initializer.parameters[0]),
          });
        }
      }
    }
  }

  return components;
}

export async function buildComponentCatalog(projectDir, exclude = []) {
  const ts = loadTypeScript(projectDir, 'web');
  const dir = path.join(projectDir, 'web', 'src', 'components');
  const excluded = new Set(exclude);
  const entries = [];
  let files = [];

  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.tsx')).sort();
  } catch {
    return entries;
  }

  for (const file of files) {
    const moduleName = file.replace(/\.tsx$/, '');

    if (excluded.has(moduleName)) {
      continue;
    }

    const content = await readFile(path.join(dir, file), 'utf8');
    const importPath = `@/components/${moduleName}`;

    if (!ts) {
      for (const match of content.matchAll(/export\s+function\s+([A-Z]\w*)/g)) {
        entries.push({ name: match[1], importPath, generics: '', props: '' });
      }

      continue;
    }

    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    for (const component of exportedComponents(ts, sourceFile)) {
      entries.push({ ...component, importPath });
    }
  }

  return entries;
}

export function renderComponentCatalog(entries) {
  return entries
    .map((entry) => `- import { ${entry.name} } from '${entry.importPath}';${entry.generics ? ` genérico ${entry.generics}` : ''}${entry.props ? `\n  props: ${entry.props}` : ''}`)
    .join('\n');
}

export function extractMainReturn(projectDir, fileName, content) {
  const ts = loadTypeScript(projectDir, 'web');

  if (!ts) {
    const index = content.lastIndexOf('\n    return (');
    return index >= 0 ? content.slice(index) : content;
  }

  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && /^[A-Z]/.test(statement.name?.text ?? '')) {
      const returns = statement.body.statements.filter((item) => ts.isReturnStatement(item));
      const last = returns.at(-1);

      if (last) {
        return last.getText(sourceFile);
      }
    }
  }

  return content;
}

export async function columnHints(projectDir, table, columns) {
  const hints = new Map([...columns].map((column) => [column, { notes: [], aliases: new Map() }]));
  const migrations = await walkFiles(path.join(projectDir, 'db', 'init'), (name) => name.endsWith('.sql'));

  for (const absolute of migrations) {
    const sql = await readFile(absolute, 'utf8');

    if (!new RegExp(`\\b${table}\\b`, 'i').test(sql)) {
      continue;
    }

    for (const line of sql.split('\n')) {
      const comment = line.match(/--\s*(.+)$/)?.[1]?.trim();

      if (!comment) {
        continue;
      }

      for (const column of hints.keys()) {
        if (column.length > 3 && new RegExp(`\\b${column}\\b`).test(comment) && hints.get(column).notes.length < 3) {
          hints.get(column).notes.push(comment.slice(0, 160));
        }
      }
    }
  }

  const sources = await walkFiles(path.join(projectDir, 'api', 'src'), (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'));

  for (const absolute of sources) {
    const code = await readFile(absolute, 'utf8');

    if (!new RegExp(`\\b${table}\\b`).test(code)) {
      continue;
    }

    for (const match of code.matchAll(/(?:\b[a-z_]+\.)?\b([a-z_][a-z0-9_]*)\b(?:::[a-z0-9]+)?\s+AS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/g)) {
      const entry = hints.get(match[1]);

      if (entry && match[2] !== match[1]) {
        entry.aliases.set(match[2], (entry.aliases.get(match[2]) ?? 0) + 1);
      }
    }
  }

  return new Map([...hints].map(([column, entry]) => [column, {
    notes: entry.notes,
    aliases: [...entry.aliases].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([alias]) => alias),
  }]));
}
