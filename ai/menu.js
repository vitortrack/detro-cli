import { listScreens, readProjectFile } from './catalog.js';
import { sha256 } from './generator.js';
import { ensureIconImport, findVariable, lineIndentation, propertyText } from './templates/patches.js';
import { autoFix, loadTypeScript, typeCheck } from './typescript.js';

export const SIDEBAR_FILE = 'web/src/components/Sidebar.tsx';
export const APP_FILE = 'web/src/App.tsx';
export const MENU_OPERATIONS = ['move', 'rename', 'icon', 'permission'];

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function property(ts, sourceFile, object, name) {
  return object.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(sourceFile) === name) ?? null;
}

function parse(ts, content) {
  const sourceFile = ts.createSourceFile('Sidebar.tsx', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = findVariable(ts, sourceFile, 'NAV_GROUPS');

  if (!declaration?.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) {
    throw new Error('Não encontrei NAV_GROUPS em web/src/components/Sidebar.tsx.');
  }

  const groups = [];
  const items = [];

  function collect(array, group, parent) {
    for (const element of array.elements) {
      if (!ts.isObjectLiteralExpression(element)) {
        continue;
      }

      const item = {
        label: propertyText(ts, sourceFile, element, 'label'),
        to: propertyText(ts, sourceFile, element, 'to') ?? null,
        screen: propertyText(ts, sourceFile, element, 'screen') ?? null,
        icon: propertyText(ts, sourceFile, element, 'icon') ?? null,
        group: group.label,
        parent: parent?.label ?? null,
        node: element,
        array,
      };

      items.push(item);

      const children = property(ts, sourceFile, element, 'children');

      if (children && ts.isArrayLiteralExpression(children.initializer)) {
        collect(children.initializer, group, item);
      }
    }
  }

  for (const element of declaration.initializer.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      continue;
    }

    const itemsProperty = property(ts, sourceFile, element, 'items');
    const group = {
      id: propertyText(ts, sourceFile, element, 'id'),
      label: propertyText(ts, sourceFile, element, 'label'),
      array: itemsProperty && ts.isArrayLiteralExpression(itemsProperty.initializer) ? itemsProperty.initializer : null,
    };

    groups.push(group);

    if (group.array) {
      collect(group.array, group, null);
    }
  }

  return { sourceFile, groups, items };
}

export async function readMenu(projectDir) {
  const ts = loadTypeScript(projectDir, 'web');

  if (!ts) {
    throw new Error('TypeScript não encontrado em web/node_modules. Rode "cd web && npm install".');
  }

  const content = await readProjectFile(projectDir, SIDEBAR_FILE);
  const { groups, items } = parse(ts, content);

  return {
    groups: groups.map(({ id, label }) => ({ id, label })),
    items: items.map(({ label, to, screen, icon, group, parent }) => ({ label, to, screen, icon, group, parent })),
  };
}

function findOne(list, wanted, describe, kind) {
  const target = normalize(wanted);
  const exact = list.filter((entry) => normalize(describe(entry)) === target);

  if (exact.length === 1) {
    return exact[0];
  }

  const partial = list.filter((entry) => normalize(describe(entry)).includes(target) || target.includes(normalize(describe(entry))));

  if (partial.length === 1) {
    return partial[0];
  }

  const options = list.map(describe).join(', ');

  throw new Error(partial.length > 1
    ? `"${wanted}" é ambíguo entre: ${partial.map(describe).join(', ')}. Use o nome completo.`
    : `Não encontrei ${kind} "${wanted}". Opções: ${options}.`);
}

function removeElement(content, array, element) {
  const index = array.elements.indexOf(element);
  const start = element.getFullStart();
  let end = element.getEnd();
  const after = content.slice(end).match(/^\s*,/);

  if (after) {
    end += after[0].length;
    return content.slice(0, start) + content.slice(end);
  }

  if (index > 0) {
    const previous = array.elements[index - 1];
    return content.slice(0, previous.getEnd()) + content.slice(end);
  }

  return content.slice(0, start) + content.slice(end);
}

function reindent(text, from, to) {
  return text.split('\n').map((line, index) => (index === 0 ? line : line.startsWith(from) ? to + line.slice(from.length) : line)).join('\n');
}

function appendToArray(ts, content, sourceFile, array, text, sampleIndent) {
  const last = array.elements.at(-1);

  if (!last) {
    const open = array.getStart(sourceFile) + 1;
    return `${content.slice(0, open)}\n${sampleIndent}${text},\n${content.slice(open)}`;
  }

  const indent = lineIndentation(content, last.getStart(sourceFile));
  const end = last.getEnd();
  const comma = content.slice(end).match(/^\s*,/)?.[0].length ?? 0;
  const insertAt = end + comma;
  const insertion = comma > 0 ? `\n${indent}${text},` : `,\n${indent}${text}`;
  return `${content.slice(0, insertAt)}${insertion}${content.slice(insertAt)}`;
}

function setStringProperty(ts, content, sourceFile, element, name, value) {
  const prop = property(ts, sourceFile, element, name);

  if (!prop) {
    const last = element.properties.at(-1);
    const indent = lineIndentation(content, last.getStart(sourceFile));
    const end = last.getEnd();
    const comma = content.slice(end).match(/^\s*,/)?.[0].length ?? 0;
    const insertAt = end + comma;
    return `${content.slice(0, insertAt)}${comma > 0 ? '' : ','}\n${indent}${name}: ${value},${content.slice(insertAt)}`;
  }

  return content.slice(0, prop.initializer.getStart(sourceFile)) + value + content.slice(prop.initializer.getEnd());
}

function quote(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function patchRoutePermission(ts, content, path, screen) {
  const marker = new RegExp(`<Route\\s+path=["']${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`);
  const match = content.match(marker);

  if (!match) {
    return { content, changed: false, reason: `Não achei <Route path="${path}"> em ${APP_FILE}; a rota ficou com a permissão antiga.` };
  }

  const guardStart = content.lastIndexOf('<RequireScreen screen=', match.index);

  if (guardStart < 0) {
    return { content, changed: false, reason: `A rota ${path} não está dentro de <RequireScreen>; ajuste a permissão dela à mão.` };
  }

  const blockStart = content.lastIndexOf('<Route element={', guardStart);
  const indent = lineIndentation(content, blockStart);
  const closing = content.indexOf(`\n${indent}</Route>`, guardStart);
  const block = content.slice(blockStart, closing);
  const routesInBlock = (block.match(/<Route\s+path=/g) ?? []).length;

  if (routesInBlock !== 1) {
    return { content, changed: false, reason: `A rota ${path} divide a permissão com outras ${routesInBlock - 1} rota(s) em ${APP_FILE}; separe o bloco à mão para não mudar a permissão delas.` };
  }

  const next = content.slice(0, guardStart) + content.slice(guardStart).replace(/<RequireScreen screen=["'][^"']+["']/, `<RequireScreen screen="${screen}"`);
  return { content: next, changed: true };
}

export async function planMenuOperation({ projectDir, operation }) {
  const ts = loadTypeScript(projectDir, 'web');
  const original = await readProjectFile(projectDir, SIDEBAR_FILE);
  const menu = parse(ts, original);
  const item = findOne(menu.items, operation.item, (entry) => entry.label, 'o item de menu');
  const screens = (await listScreens(projectDir)).map((screen) => screen.key);
  const summary = [];
  const notes = [];
  let content = original;
  let appOriginal = null;
  let appContent = null;

  if (operation.type === 'move') {
    const group = findOne(menu.groups, operation.group, (entry) => entry.label, 'o grupo de menu');

    if (item.group === group.label && !item.parent) {
      throw new Error(`"${item.label}" já está no grupo "${group.label}".`);
    }

    if (!group.array) {
      throw new Error(`O grupo "${group.label}" não tem lista de itens.`);
    }

    const itemIndent = lineIndentation(original, item.node.getStart(menu.sourceFile));
    const targetIndent = group.array.elements.length > 0 ? lineIndentation(original, group.array.elements[0].getStart(menu.sourceFile)) : `${itemIndent}`;
    const text = reindent(item.node.getText(menu.sourceFile), itemIndent, targetIndent);
    const removed = removeElement(original, item.array, item.node);
    const reparsed = parse(ts, removed);
    const targetGroup = reparsed.groups.find((entry) => entry.label === group.label);
    content = appendToArray(ts, removed, reparsed.sourceFile, targetGroup.array, text, targetIndent);
    summary.push(`"${item.label}" sai de "${item.parent ?? item.group}" e vai para o fim de "${group.label}".`);
  }

  if (operation.type === 'rename') {
    const label = String(operation.label ?? '').trim();

    if (!label) {
      throw new Error('Informe o novo nome do item. Ex.: detro menu renomear "Tipos de ocorrência" "Tipos de incidente"');
    }

    content = setStringProperty(ts, content, menu.sourceFile, item.node, 'label', quote(label));
    summary.push(`"${item.label}" passa a se chamar "${label}" no menu (o título da página não muda).`);
  }

  if (operation.type === 'icon') {
    const icon = String(operation.icon ?? '').trim();

    if (!/^[A-Z][A-Za-z0-9]*$/.test(icon)) {
      throw new Error('Informe o ícone do lucide-react em PascalCase. Ex.: detro menu icone "Tipos de ocorrência" TriangleAlert');
    }

    const imported = ensureIconImport(ts, content, icon);
    const reparsed = parse(ts, imported.content);
    const again = reparsed.items.find((entry) => entry.label === item.label);
    content = setStringProperty(ts, imported.content, reparsed.sourceFile, again.node, 'icon', imported.local);
    summary.push(`Ícone de "${item.label}" trocado de ${item.icon ?? '(nenhum)'} para ${imported.local}.`);
  }

  if (operation.permission || operation.type === 'permission') {
    const screen = String(operation.permission ?? '').trim();

    if (!screens.includes(screen)) {
      throw new Error(`Permissão "${screen}" não existe. Opções: ${screens.join(', ')}.`);
    }

    const reparsed = parse(ts, content);
    const again = reparsed.items.find((entry) => entry.label === item.label);
    content = setStringProperty(ts, content, reparsed.sourceFile, again.node, 'screen', quote(screen));
    summary.push(`Permissão de "${item.label}" no menu: ${item.screen ?? '(nenhuma)'} → ${screen}.`);

    if (item.to && item.to.startsWith('/')) {
      appOriginal = await readProjectFile(projectDir, APP_FILE);
      const route = patchRoutePermission(ts, appOriginal, item.to, screen);

      if (route.changed) {
        appContent = route.content;
        summary.push(`Rota ${item.to} no App.tsx passa a exigir a permissão ${screen}.`);
      } else {
        notes.push(route.reason);
      }
    }
  }

  if (content !== original) {
    content = autoFix(projectDir, { virtualFiles: new Map([[SIDEBAR_FILE, content]]), target: SIDEBAR_FILE, codes: [6133, 6192] }).content;
  }

  if (content === original && !appContent) {
    throw new Error('Nada a alterar.');
  }

  const files = [];

  if (content !== original) {
    files.push({ action: 'modify', kind: 'menu', path: SIDEBAR_FILE, content, originalHash: sha256(original), original });
  }

  if (appContent) {
    files.push({ action: 'modify', kind: 'menu', path: APP_FILE, content: appContent, originalHash: sha256(appOriginal), original: appOriginal });
  }

  const virtualFiles = new Map(files.map((file) => [file.path, file.content]));
  const { diagnostics } = typeCheck(projectDir, { virtualFiles, targets: files.map((file) => file.path) });
  const errors = [...diagnostics].flatMap(([file, items]) => items.map((entry) => `${file} linha ${entry.line}: ${entry.message}`));

  return { item, summary, notes, errors, files };
}

export function insertMenuItem({ ts, content, placement, entry }) {
  const imported = ensureIconImport(ts, content, entry.icon);
  const menu = parse(ts, imported.content);
  let array;
  let anchor = null;

  if (placement.parent) {
    const parent = menu.items.find((item) => item.label === placement.parent && !item.parent);

    if (!parent) {
      throw new Error(`Não encontrei o item "${placement.parent}" no menu.`);
    }

    const children = property(ts, menu.sourceFile, parent.node, 'children');

    if (!children || !ts.isArrayLiteralExpression(children.initializer)) {
      throw new Error(`"${placement.parent}" não tem submenu (children); escolha um grupo ou um item com submenu.`);
    }

    array = children.initializer;
  } else {
    const group = menu.groups.find((item) => item.label === placement.group);

    if (!group?.array) {
      throw new Error(`Não encontrei o grupo "${placement.group}" no menu.`);
    }

    array = group.array;
  }

  if (placement.after) {
    anchor = array.elements.find((element) => ts.isObjectLiteralExpression(element) && propertyText(ts, menu.sourceFile, element, 'label') === placement.after) ?? null;
  }

  const reference = anchor ?? array.elements.at(-1);
  const indent = reference ? lineIndentation(imported.content, reference.getStart(menu.sourceFile)) : '      ';
  const inner = `${indent}  `;
  const text = [
    '{',
    `${inner}to: ${quote(entry.to)},`,
    `${inner}icon: ${imported.local},`,
    `${inner}label: ${quote(entry.label)},`,
    `${inner}screen: ${quote(entry.screen)},`,
    `${indent}}`,
  ].join('\n');

  if (!reference) {
    const open = array.getStart(menu.sourceFile) + 1;
    return `${imported.content.slice(0, open)}\n${indent}${text},\n${imported.content.slice(open)}`;
  }

  const end = reference.getEnd();
  const comma = imported.content.slice(end).match(/^\s*,/)?.[0].length ?? 0;
  const insertAt = end + comma;
  const insertion = comma > 0 ? `\n${indent}${text},` : `,\n${indent}${text}`;
  return `${imported.content.slice(0, insertAt)}${insertion}${imported.content.slice(insertAt)}`;
}
