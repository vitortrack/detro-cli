import { builtinModules } from 'node:module';

import { loadTypeScript, workspaceOf } from './typescript.js';

const SQL_DML = /\b(SELECT|UPDATE|DELETE\s+FROM|INSERT\s+INTO)\b/i;
const SQL_DDL = /^\s*(CREATE|ALTER|DROP|COMMENT)\b/i;
const TABLE_REFERENCE = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
const DISTANCE_FUNCTIONS = /\bST_(Distance|DWithin|Length|Perimeter|Area)\s*\(/i;
const DISTANCE_CALLS = /\bST_(Distance|DWithin|Length|Perimeter|Area)\s*\(/gi;
const GEOMETRY_EVIDENCE = /::\s*geometry\b|\bST_(MakePoint|SetSRID|GeomFromText|GeomFromGeoJSON|Transform|MakeLine)\s*\(/i;
const GEOGRAPHY_EVIDENCE = /geography|\bgeog|ST_GeogFrom/i;
const SCHEDULE_TABLES = /\b(schedules|schedule_[a-z_]+|departure_time|arrival_time)\b/i;
const TIMESTAMPS = /\b(recorded_at|received_at|started_at|ended_at|NOW\(\)|CURRENT_TIMESTAMP)\b/i;
const HTTP_EXCEPTION = /new\s+(BadRequest|NotFound|Conflict|Forbidden|Unauthorized|UnprocessableEntity)Exception\(\s*(['"`])([^'"`]+)\2/g;
const ENGLISH_MESSAGE = /\b(not found|invalid|required|already exists|must be|is missing|failed|forbidden|unauthorized|cannot)\b/i;

function lineOf(content, index) {
  let line = 1;

  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }

  return line;
}

function finding(file, line, severity, rule, message) {
  return { file, line, severity, rule, message, source: 'regra' };
}

function packageName(importPath) {
  return importPath.startsWith('@')
    ? importPath.split('/').slice(0, 2).join('/')
    : importPath.split('/')[0];
}

function sqlLiterals(ts, sourceFile) {
  const literals = [];

  function enclosingFunction(node) {
    let current = node.parent;
    let nearest = null;

    while (current) {
      if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isConstructorDeclaration(current)) {
        return current;
      }

      if (!nearest && (ts.isArrowFunction(current) || ts.isFunctionExpression(current))) {
        nearest = current;
      }

      current = current.parent;
    }

    return nearest ?? sourceFile;
  }

  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(sourceFile);

      if (SQL_DML.test(text) || DISTANCE_FUNCTIONS.test(text)) {
        literals.push({
          text,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          scope: enclosingFunction(node).getText(sourceFile),
        });
      }

      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}

function sqlStatements(content) {
  const statements = [];
  let start = 0;

  for (const part of content.split(';')) {
    statements.push({ text: part, line: lineOf(content, start + (part.length - part.trimStart().length)) });
    start += part.length + 1;
  }

  return statements;
}

function callArguments(text, openIndex) {
  let depth = 0;

  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1;
    } else if (text[index] === ')') {
      depth -= 1;

      if (depth === 0) {
        return text.slice(openIndex + 1, index);
      }
    }
  }

  return text.slice(openIndex + 1);
}

function checkSqlBlock({ file, block, tenantTables, tenantScoped, isNew, tenantSeverity = 'aviso', findings }) {
  const { text, line, scope } = block;

  for (const match of text.matchAll(DISTANCE_CALLS)) {
    const args = callArguments(text, match.index + match[0].length - 1);

    if (GEOMETRY_EVIDENCE.test(args) && !GEOGRAPHY_EVIDENCE.test(args)) {
      findings.push(finding(file, line, 'erro', 'st-distance-geography',
        `ST_${match[1]} com argumentos geometry mede em graus. Converta com ::geography para obter metros.`));
    }
  }

  if (SQL_DDL.test(text) || !SQL_DML.test(text)) {
    return;
  }

  const tables = [...text.matchAll(TABLE_REFERENCE)]
    .map((match) => match[1].toLowerCase())
    .filter((table) => tenantTables.has(table));

  if (tenantScoped && isNew(line) && tables.length > 0 && !/operator_id/i.test(text) && !/operator_id|operatorId/.test(scope ?? '')) {
    findings.push(finding(file, line, tenantSeverity, 'tenant-sql',
      `Query em ${[...new Set(tables)].join(', ')} sem filtro por operator_id. Filtre pela operadora ou confirme que o escopo vem de um ID já validado.`));
  }

  if (SCHEDULE_TABLES.test(text) && TIMESTAMPS.test(text) && !/AT\s+TIME\s+ZONE/i.test(text)) {
    findings.push(finding(file, line, 'aviso', 'schedule-timezone',
      "Grade (horário local) comparada com timestamp UTC sem conversão. Use AT TIME ZONE 'America/Sao_Paulo'."));
  }

  const coalesce = text.match(/\b([a-z_][a-z0-9_]*)\s*=\s*COALESCE\(\s*\$\d+\s*,\s*\1\s*\)/i);

  if (/\bUPDATE\b/i.test(text) && coalesce) {
    findings.push(finding(file, line, 'aviso', 'coalesce-update',
      `UPDATE com ${coalesce[1]} = COALESCE($n, ${coalesce[1]}) não deixa limpar o campo (null vira "manter"). Monte o SET só com os campos enviados.`));
  }
}

function decoratorNames(ts, node) {
  return (ts.canHaveDecorators?.(node) ? ts.getDecorators(node) ?? [] : node.decorators ?? [])
    .map((decorator) => {
      const expression = decorator.expression;
      return ts.isCallExpression(expression) ? expression.expression.getText() : expression.getText();
    });
}

function checkController({ ts, file, sourceFile, findings }) {
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement)) {
      continue;
    }

    const classDecorators = decoratorNames(ts, statement);

    if (!classDecorators.includes('Controller')) {
      continue;
    }

    const classProtected = classDecorators.includes('RequirePermission') || classDecorators.some((name) => /Require|Roles/.test(name));

    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member)) {
        continue;
      }

      const decorators = decoratorNames(ts, member);
      const line = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1;
      const isMutation = decorators.some((name) => ['Post', 'Put', 'Patch', 'Delete'].includes(name));
      const isPublic = decorators.includes('Public');

      if (isPublic) {
        findings.push(finding(file, line, 'info', 'public-endpoint',
          '@Public(): confirme que este acesso é anônimo por definição.'));
      }

      if (isMutation && !isPublic && !classProtected && !decorators.some((name) => /RequirePermission|Roles|RequireGlobalAdmin/.test(name))) {
        findings.push(finding(file, line, 'aviso', 'mutation-without-permission',
          `Endpoint de escrita "${member.name.getText(sourceFile)}" sem @RequirePermission(tela, 'edit').`));
      }
    }
  }
}

export function addedLines(diffText) {
  const lines = new Set();

  for (const match of diffText.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);

    for (let line = start; line < start + count; line += 1) {
      lines.add(line);
    }
  }

  return lines;
}

function returnedJsx(ts, callback) {
  let body = callback.body;

  if (ts.isBlock(body)) {
    const statement = body.statements.find((item) => ts.isReturnStatement(item));
    body = statement?.expression;
  }

  while (body && ts.isParenthesizedExpression(body)) {
    body = body.expression;
  }

  if (!body) {
    return null;
  }

  if (ts.isJsxElement(body)) {
    return body.openingElement;
  }

  return ts.isJsxSelfClosingElement(body) ? body : null;
}

function checkCodePatterns({ ts, file, sourceFile, isNew, findings }) {
  const line = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  function visit(node) {
    if (ts.isCatchClause(node) && node.block.statements.length === 0 && isNew(line(node))) {
      findings.push(finding(file, line(node), 'aviso', 'empty-catch',
        'catch vazio engole o erro: o usuário não fica sabendo que falhou. Mostre a mensagem ou relance o erro.'));
    }

    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.SlashToken
      && ts.isPropertyAccessExpression(node.right)
      && node.right.name.text === 'length'
      && isNew(line(node))
    ) {
      findings.push(finding(file, line(node), 'aviso', 'divide-by-length',
        `Divisão por ${node.right.getText(sourceFile)}: com lista vazia o resultado é NaN. Trate o caso de lista vazia antes.`));
    }

    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'map'
      && node.arguments[0]
      && (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
    ) {
      const element = returnedJsx(ts, node.arguments[0]);

      if (element && !element.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'key') && isNew(line(element))) {
        findings.push(finding(file, line(element), 'aviso', 'jsx-key',
          'Item de lista (.map) sem key: o React pode trocar o estado entre linhas. Use key={item.id}.'));
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

export const DEFAULT_TENANT_EXCLUDE = ['/workers/'];

export function runRules({ projectDir, file, content, tenantTables, dependencies, changedLines, tenantExclude = DEFAULT_TENANT_EXCLUDE, installed = () => false }) {
  const findings = [];
  const workspace = workspaceOf(file);
  const isNew = (line) => !changedLines || changedLines.has(line);
  const tenantScoped = !tenantExclude.some((fragment) => file.includes(fragment));

  if (file.endsWith('.sql')) {
    for (const block of sqlStatements(content)) {
      checkSqlBlock({ file, block, tenantTables: new Set(), tenantScoped: false, isNew, findings });
    }

    return findings;
  }

  if (!/\.(ts|tsx)$/.test(file) || !workspace) {
    return findings;
  }

  const ts = loadTypeScript(projectDir, workspace);

  if (!ts) {
    return findings;
  }

  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const backend = !file.endsWith('.tsx') && !/(^|\/)(web|frontend|client|app)\//.test(file);

  if (backend && !/bootstrap|migration/i.test(file)) {
    for (const block of sqlLiterals(ts, sourceFile)) {
      checkSqlBlock({ file, block, tenantTables, tenantScoped, isNew, tenantSeverity: changedLines ? 'aviso' : 'info', findings });
    }
  }

  if (file.endsWith('.controller.ts')) {
    checkController({ ts, file, sourceFile, findings });
  }

  checkCodePatterns({ ts, file, sourceFile, isNew, findings });

  for (const match of content.matchAll(/synchronize\s*:\s*true/g)) {
    findings.push(finding(file, lineOf(content, match.index), 'erro', 'synchronize',
      'synchronize: true deixa o TypeORM alterar o schema. Use false e escreva a migration em db/init.'));
  }

  for (const match of content.matchAll(/console\.(log|info|debug|warn|error)\([^;]*process\.env/g)) {
    findings.push(finding(file, lineOf(content, match.index), 'erro', 'secret-log',
      'Não imprima variáveis de ambiente no log: podem conter segredos.'));
  }

  for (const match of content.matchAll(/:\s*any\b|\bas\s+any\b|<any>/g)) {
    const line = lineOf(content, match.index);

    if (isNew(line)) {
      findings.push(finding(file, line, 'aviso', 'no-any', 'Sem any novo: declare o tipo.'));
    }
  }

  if (/@nestjs\//.test(content)) {
    for (const match of content.matchAll(HTTP_EXCEPTION)) {
      if (ENGLISH_MESSAGE.test(match[3]) && !/[áéíóúãõç]/i.test(match[3])) {
        findings.push(finding(file, lineOf(content, match.index), 'aviso', 'error-message-ptbr',
          `Mensagem de erro em inglês ("${match[3]}"). Escreva em pt-BR dizendo o que o usuário deve fazer.`));
      }
    }
  }

  for (const imported of ts.preProcessFile(content, true, true).importedFiles) {
    const importPath = imported.fileName;

    if (importPath.startsWith('.') || importPath.startsWith('@/') || importPath.startsWith('/')) {
      continue;
    }

    const name = packageName(importPath.replace(/^node:/, ''));

    if (importPath.startsWith('node:') || builtinModules.includes(name) || dependencies.has(name)) {
      continue;
    }

    findings.push(installed(workspace, name)
      ? finding(file, lineOf(content, imported.pos), 'aviso', 'undeclared-dependency',
        `Pacote "${name}" só está instalado como dependência de outro pacote. Declare-o em ${workspace}/package.json (cd ${workspace} && npm install ${name}) para não quebrar numa atualização.`)
      : finding(file, lineOf(content, imported.pos), 'erro', 'undeclared-dependency',
        `Pacote "${name}" não está instalado nem declarado em ${workspace}/package.json. Rode: cd ${workspace} && npm install ${name}`));
  }

  return findings;
}
