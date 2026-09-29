function insertAfterLastImport(ts, fileName, content, importLine) {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const imports = sourceFile.statements.filter((statement) => ts.isImportDeclaration(statement));
  const last = imports.at(-1);

  if (!last) {
    return `${importLine}\n${content}`;
  }

  const end = last.getEnd();
  return `${content.slice(0, end)}\n${importLine}${content.slice(end)}`;
}

function findModuleImportsArray(ts, sourceFile) {
  let found = null;

  function visit(node) {
    if (found) {
      return;
    }

    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'Module'
      && node.arguments[0]
      && ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const property = node.arguments[0].properties.find((item) =>
        ts.isPropertyAssignment(item) && item.name.getText(sourceFile) === 'imports');

      if (property && ts.isArrayLiteralExpression(property.initializer)) {
        found = property.initializer;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

export function lineIndentation(content, position) {
  const lineStart = content.lastIndexOf('\n', position - 1) + 1;
  return content.slice(lineStart).match(/^\s*/)[0];
}

export function patchAppModule({ ts, content, names }) {
  const moduleName = `${names.entityPlural}Module`;
  const importLine = `import { ${moduleName} } from './modules/${names.kebabPlural}/${names.kebabPlural}.module';`;

  if (content.includes(importLine)) {
    throw new Error(`${moduleName} já está registrado em api/src/app.module.ts.`);
  }

  const withImport = insertAfterLastImport(ts, 'app.module.ts', content, importLine);
  const sourceFile = ts.createSourceFile('app.module.ts', withImport, ts.ScriptTarget.Latest, true);
  const array = findModuleImportsArray(ts, sourceFile);

  if (!array || array.elements.length === 0) {
    throw new Error('Não encontrei o array "imports" do @Module em api/src/app.module.ts. Registre o módulo à mão.');
  }

  const lastElement = array.elements.at(-1);
  const indent = lineIndentation(withImport, lastElement.getStart(sourceFile));
  const closing = array.getEnd() - 1;
  let cursor = closing - 1;

  while (cursor > lastElement.getEnd() && /\s/.test(withImport[cursor])) {
    cursor -= 1;
  }

  const hasTrailingComma = withImport[cursor] === ',';
  const insertAt = hasTrailingComma ? cursor + 1 : lastElement.getEnd();
  const insertion = hasTrailingComma ? `\n${indent}${moduleName},` : `,\n${indent}${moduleName}`;

  return {
    content: `${withImport.slice(0, insertAt)}${insertion}${withImport.slice(insertAt)}`,
    added: [importLine, `${moduleName},`],
  };
}

export function patchAppRoutes({ ts, content, spec, names }) {
  const pageName = names.pageComponent ?? `${names.entityPlural}Page`;
  const importLine = `import { ${pageName} } from '${names.pageImport ?? `@/pages/${names.kebabPlural}/${pageName}`}';`;

  if (content.includes(`<${pageName} />`)) {
    throw new Error(`${pageName} já está registrada em web/src/App.tsx.`);
  }

  const withImport = insertAfterLastImport(ts, 'App.tsx', content, importLine);
  const marker = '<RequireScreen screen=';
  const lastGuard = withImport.lastIndexOf(marker);

  if (lastGuard < 0) {
    throw new Error('Não encontrei rotas com <RequireScreen> em web/src/App.tsx. Registre a rota à mão.');
  }

  const openingStart = withImport.lastIndexOf('\n', lastGuard) + 1;
  const indent = withImport.slice(openingStart).match(/^\s*/)[0];
  const closingTag = `\n${indent}</Route>`;
  const closingIndex = withImport.indexOf(closingTag, lastGuard);

  if (closingIndex < 0) {
    throw new Error('Não consegui localizar o fechamento do último bloco <RequireScreen> em web/src/App.tsx. Registre a rota à mão.');
  }

  const insertAt = closingIndex + closingTag.length;
  const block = [
    `${indent}<Route element={<RequireScreen screen="${names.permission}" />}>`,
    `${indent}  <Route path="${spec.route}" element={<${pageName} />} />`,
    `${indent}</Route>`,
  ];

  return {
    content: `${withImport.slice(0, insertAt)}\n${block.join('\n')}${withImport.slice(insertAt)}`,
    added: [importLine, ...block.map((line) => line.trim())],
  };
}

export function findVariable(ts, sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          return declaration;
        }
      }
    }
  }

  return null;
}

export function propertyText(ts, sourceFile, object, name) {
  const property = object.properties.find((item) =>
    ts.isPropertyAssignment(item) && item.name.getText(sourceFile) === name);

  if (!property) {
    return undefined;
  }

  const initializer = property.initializer;
  return ts.isStringLiteral(initializer) ? initializer.text : initializer.getText(sourceFile);
}

function quoteLike(sample, value) {
  const quote = sample.includes('"') && !sample.includes("'") ? '"' : "'";
  return `${quote}${value.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`)}${quote}`;
}

function replaceProperty(text, name, value) {
  return text.replace(new RegExp(`(\\b${name}\\s*:\\s*)(['"])(?:\\\\.|(?!\\2).)*\\2`), (_, prefix, quote) => `${prefix}${quote}${value.replaceAll(quote, `\\${quote}`)}${quote}`);
}

export function patchScreens({ ts, content, fileName, relatedKey, key, label }) {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const alias = sourceFile.statements.find((statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ScreenKey');

  if (!alias || !ts.isUnionTypeNode(alias.type)) {
    throw new Error(`Não encontrei "type ScreenKey = ..." em ${fileName}. Registre a tela à mão.`);
  }

  const members = alias.type.types;
  const lastMember = members.at(-1);

  if (members.some((member) => member.getText(sourceFile).slice(1, -1) === key)) {
    throw new Error(`A tela "${key}" já existe em ${fileName}.`);
  }

  const declaration = findVariable(ts, sourceFile, 'SCREENS');
  const array = declaration?.initializer;

  if (!array || !ts.isArrayLiteralExpression(array)) {
    throw new Error(`Não encontrei o array SCREENS em ${fileName}. Registre a tela à mão.`);
  }

  const elements = array.elements.filter((element) => ts.isObjectLiteralExpression(element));
  const related = elements.find((element) => propertyText(ts, sourceFile, element, 'key') === relatedKey);

  if (!related) {
    throw new Error(`A tela "${relatedKey}" não está em SCREENS de ${fileName}.`);
  }

  const group = propertyText(ts, sourceFile, related, 'group');
  const sameGroup = elements.filter((element) => propertyText(ts, sourceFile, element, 'group') === group);
  const anchor = sameGroup.at(-1) ?? related;

  let entry = related.getText(sourceFile);
  entry = replaceProperty(entry, 'key', key);
  entry = replaceProperty(entry, 'label', label);
  entry = entry.replace(/(\bhasEdit\s*:\s*)(true|false)/, '$1true');

  const indent = lineIndentation(content, anchor.getStart(sourceFile));
  const anchorEnd = anchor.getEnd();
  const afterAnchor = content.slice(anchorEnd);
  const commaOffset = afterAnchor.match(/^\s*,/)?.[0].length ?? 0;
  const entryInsertAt = anchorEnd + commaOffset;
  const entryText = commaOffset > 0 ? `\n${indent}${entry},` : `,\n${indent}${entry}`;

  const memberText = `\n${lineIndentation(content, lastMember.getStart(sourceFile))}| ${quoteLike(lastMember.getText(sourceFile), key)}`;
  const memberInsertAt = lastMember.getEnd();

  const next = `${content.slice(0, memberInsertAt)}${memberText}${content.slice(memberInsertAt, entryInsertAt)}${entryText}${content.slice(entryInsertAt)}`;

  return {
    content: next,
    added: [`| '${key}'`, `{ key: '${key}', label: '${label}', group: '${group}', hasEdit: true }`],
  };
}

function containsScreen(ts, sourceFile, node, screen) {
  let found = false;

  function visit(child) {
    if (found) {
      return;
    }

    if (ts.isPropertyAssignment(child) && child.name.getText(sourceFile) === 'screen' && ts.isStringLiteral(child.initializer) && child.initializer.text === screen) {
      found = true;
      return;
    }

    ts.forEachChild(child, visit);
  }

  visit(node);
  return found;
}

export function ensureIconImport(ts, content, icon) {
  const sourceFile = ts.createSourceFile('Sidebar.tsx', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = sourceFile.statements.find((statement) =>
    ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'lucide-react');

  const bindings = declaration?.importClause?.namedBindings;

  if (!bindings || !ts.isNamedImports(bindings)) {
    throw new Error('Não encontrei o import de lucide-react no Sidebar.tsx. Adicione o item de menu à mão.');
  }

  const existing = bindings.elements.find((element) => (element.propertyName ?? element.name).text === icon);

  if (existing) {
    return { content, local: existing.name.text };
  }

  const collides = new RegExp(`\\b${icon}\\b`).test(content);
  const local = collides ? `${icon}Icon` : icon;
  const specifier = collides ? `${icon} as ${local}` : icon;
  const values = bindings.elements.filter((element) => !element.isTypeOnly);
  const before = values.find((element) => (element.propertyName ?? element.name).text.localeCompare(icon) > 0) ?? bindings.elements.find((element) => element.isTypeOnly);

  if (before) {
    const start = before.getStart(sourceFile);
    const indent = lineIndentation(content, start);
    const separator = content.slice(content.lastIndexOf('\n', start - 1), start).trim() === '' ? `,\n${indent}` : ', ';
    return { content: `${content.slice(0, start)}${specifier}${separator}${content.slice(start)}`, local };
  }

  const last = bindings.elements.at(-1);
  return { content: `${content.slice(0, last.getEnd())}, ${specifier}${content.slice(last.getEnd())}`, local };
}

export function patchSidebar({ ts, content, spec, names }) {
  const imported = ensureIconImport(ts, content, spec.menuIcon);
  const withIcon = imported.content;
  const sourceFile = ts.createSourceFile('Sidebar.tsx', withIcon, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = findVariable(ts, sourceFile, 'NAV_GROUPS');

  if (!declaration?.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) {
    throw new Error('Não encontrei NAV_GROUPS no Sidebar.tsx. Adicione o item de menu à mão.');
  }

  const groups = declaration.initializer.elements.filter((element) => ts.isObjectLiteralExpression(element));
  const group = groups.find((element) => containsScreen(ts, sourceFile, element, spec.screen));

  if (!group) {
    throw new Error(`Nenhum grupo do menu tem a tela "${spec.screen}". Adicione o item de menu à mão.`);
  }

  const itemsProperty = group.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(sourceFile) === 'items');

  if (!itemsProperty || !ts.isArrayLiteralExpression(itemsProperty.initializer) || itemsProperty.initializer.elements.length === 0) {
    throw new Error('O grupo do menu não tem "items". Adicione o item de menu à mão.');
  }

  const lastItem = itemsProperty.initializer.elements.at(-1);
  const indent = lineIndentation(withIcon, lastItem.getStart(sourceFile));
  const inner = `${indent}  `;
  const item = [
    '{',
    `${inner}to: '${spec.route}',`,
    `${inner}icon: ${imported.local},`,
    `${inner}label: ${quoteLike("'", spec.title)},`,
    `${inner}screen: '${names.permission}',`,
    `${indent}}`,
  ].join('\n');

  const end = lastItem.getEnd();
  const commaOffset = withIcon.slice(end).match(/^\s*,/)?.[0].length ?? 0;
  const insertAt = end + commaOffset;
  const insertion = commaOffset > 0 ? `\n${indent}${item},` : `,\n${indent}${item}`;
  const groupLabel = propertyText(ts, sourceFile, group, 'label');

  return {
    content: `${withIcon.slice(0, insertAt)}${insertion}${withIcon.slice(insertAt)}`,
    added: [`menu "${groupLabel}" → ${spec.title} (${spec.route}, ícone ${imported.local})`],
  };
}
