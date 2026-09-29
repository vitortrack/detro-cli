import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { toCamel, toKebab, toPascal, toSnake } from './spec.js';

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|sql|prisma|py|rb|php|java|kt|cs|go)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.detro', '.next', 'out', 'vendor', '__pycache__', 'target', 'bin', 'obj']);
const GENERIC_STEMS = new Set(['index', 'app', 'main', 'util', 'utils', 'helper', 'helpers', 'type', 'types', 'api', 'config', 'constant', 'constants', 'layout', 'router', 'route', 'routes', 'store', 'test', 'spec', 'mock', 'common', 'shared', 'base', 'style', 'styles', 'server', 'client', 'env', 'setup', 'auth', 'error', 'errors']);
const SUFFIXES = /(\.|-|_)?(controller|service|module|dto|entity|routes?|router|model|schema|repository|repo|store|api|types?|component|page|view|screen|form|modal|list|table|query|queries|mutations?|hooks?|schemas?|validators?|handlers?|resolvers?)$/i;
const PASCAL_SUFFIXES = /(FormModal|Modal|Form|Page|List|Table|View|Screen|Component|Service|Controller|Store|Api|Types?|Card|Dialog|Details?|Create|Edit)$/;

function singular(word) {
  if (/ies$/.test(word)) {
    return `${word.slice(0, -3)}y`;
  }

  if (/(ss|us)$/.test(word)) {
    return word;
  }

  if (/(ches|shes|xes|zes|sses)$/.test(word)) {
    return word.slice(0, -2);
  }

  return word.replace(/s$/, '');
}

function plural(word) {
  if (/[^aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }

  if (/(s|x|z|ch|sh)$/i.test(word)) {
    return `${word}es`;
  }

  return `${word}s`;
}

function stemOf(file) {
  let base = path.basename(file).replace(/\.[^.]+$/, '').replace(/\.(spec|test|d)$/, '');
  base = base.replace(PASCAL_SUFFIXES, '');

  for (let index = 0; index < 3; index += 1) {
    base = base.replace(SUFFIXES, '');
  }

  const stem = singular(toSnake(base).replace(/_/g, ''));
  return stem.length >= 3 && !GENERIC_STEMS.has(stem) ? stem : null;
}

async function walk(projectDir, dir = '.', output = []) {
  let entries = [];

  try {
    entries = await readdir(path.join(projectDir, dir), { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    const relative = path.posix.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await walk(projectDir, relative, output);
      }
    } else if (SOURCE.test(entry.name) && !/\.(spec|test)\.[^.]+$/.test(entry.name)) {
      output.push(relative.replace(/^\.\//, ''));
    }
  }

  return output;
}

function stemsFromPath(file) {
  const stems = new Set();
  const own = stemOf(file);

  if (own) {
    stems.add(own);
  }

  for (const part of path.posix.dirname(file).split('/')) {
    const stem = singular(toSnake(part).replace(/_/g, ''));

    if (stem.length >= 3 && !GENERIC_STEMS.has(stem) && !/^(src|lib|pages|components|modules|features|views|screens|services|controllers|routes|app|web|api|client|server|backend|frontend|db|init|migrations)$/.test(part)) {
      stems.add(stem);
    }
  }

  return stems;
}

export async function listFeatures(projectDir) {
  const files = await walk(projectDir);
  const groups = new Map();

  for (const file of files) {
    for (const stem of stemsFromPath(file)) {
      if (!groups.has(stem)) {
        groups.set(stem, new Set());
      }

      groups.get(stem).add(file);
    }
  }

  return [...groups]
    .map(([stem, set]) => {
      const list = [...set];
      const dirs = new Set(list.map((file) => path.posix.dirname(file).split('/').slice(0, 2).join('/')));
      return { stem, files: list, layers: dirs.size };
    })
    .filter((feature) => feature.files.length >= 2 && feature.files.length <= 12 && feature.layers >= 1)
    .sort((a, b) => b.layers - a.layers || b.files.length - a.files.length || a.stem.localeCompare(b.stem));
}

function exportedNames(content) {
  return [...new Set([...content.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]))];
}

export async function findRegistrations(projectDir, featureFiles) {
  const files = await walk(projectDir);
  const names = new Set();
  const importTargets = featureFiles.map((file) => file.replace(/\.[^.]+$/, ''));

  for (const file of featureFiles) {
    for (const name of exportedNames(await readFile(path.join(projectDir, file), 'utf8'))) {
      if (name.length >= 5) {
        names.add(name);
      }
    }
  }

  const registrations = [];

  for (const file of files) {
    if (featureFiles.includes(file)) {
      continue;
    }

    const content = await readFile(path.join(projectDir, file), 'utf8');
    const symbols = [...names].filter((name) => new RegExp(`\\b${name}\\b`).test(content));
    const imports = importTargets.filter((target) => content.includes(path.posix.basename(target)) && /import|require|from/.test(content));

    if (symbols.length > 0 || imports.length > 0) {
      registrations.push({ file, symbols });
    }
  }

  const routes = new Set();

  for (const registration of registrations) {
    const content = await readFile(path.join(projectDir, registration.file), 'utf8');

    for (const line of content.split('\n').filter((entry) => registration.symbols.some((name) => entry.includes(name)))) {
      for (const match of line.matchAll(/['"`](\/[a-z0-9][\w/-]*)['"`]/gi)) {
        routes.add(match[1]);
      }
    }
  }

  for (const file of files) {
    if (featureFiles.includes(file) || registrations.some((item) => item.file === file)) {
      continue;
    }

    const content = await readFile(path.join(projectDir, file), 'utf8');
    const found = [...routes].filter((route) => content.includes(`'${route}'`) || content.includes(`"${route}"`));

    if (found.length > 0) {
      registrations.push({ file, symbols: [], routes: found });
    }
  }

  return registrations.sort((a, b) => b.symbols.length - a.symbols.length).slice(0, 6);
}

function variants(singularPascal, pluralPascal) {
  return [
    [pluralPascal, 'pascalPlural'],
    [singularPascal, 'pascal'],
    [toCamel(pluralPascal), 'camelPlural'],
    [toCamel(singularPascal), 'camel'],
    [toKebab(pluralPascal), 'kebabPlural'],
    [toKebab(singularPascal), 'kebab'],
    [toSnake(pluralPascal), 'snakePlural'],
    [toSnake(singularPascal), 'snake'],
    [toSnake(pluralPascal).toUpperCase(), 'upperPlural'],
    [toSnake(singularPascal).toUpperCase(), 'upper'],
  ];
}

export function buildRenameMap(referenceStem, spec) {
  const refSingular = toPascal(referenceStem);
  const refPlural = toPascal(plural(referenceStem));
  const from = variants(refSingular, refPlural);
  const to = Object.fromEntries(variants(spec.entity, spec.entityPlural).map(([value, key]) => [key, value]));
  const pairs = from.map(([value, key]) => [value, to[key]]).filter(([source, target]) => source && target && source !== target);
  const unique = [...new Map(pairs.map((pair) => [pair[0], pair])).values()];
  return unique.sort((a, b) => b[0].length - a[0].length);
}

export function applyRename(text, map) {
  if (map.length === 0) {
    return text;
  }

  const pattern = new RegExp(map.map(([source]) => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const lookup = new Map(map);
  return text.replace(pattern, (match) => lookup.get(match) ?? match);
}

function balanced(line) {
  const count = (open, close) => (line.split(open).length - 1) - (line.split(close).length - 1);
  return count('(', ')') === 0 && count('{', '}') === 0 && count('[', ']') === 0;
}

export function cloneRegistrationLines(content, { symbols = [], routes = [], map, newRoute, newTitle }) {
  const lines = content.split('\n');
  const output = [];
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentions = (line) => symbols.some((name) => new RegExp(`\\b${escape(name)}\\b`).test(line)) || routes.some((route) => line.includes(`'${route}'`) || line.includes(`"${route}"`));
  let cloned = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output.push(line);

    if (!line.trim() || !mentions(line) || !balanced(line)) {
      continue;
    }

    let copy = applyRename(line, map);

    for (const route of routes.length > 0 ? routes : [...line.matchAll(/['"`](\/[a-z0-9][\w/-]*)['"`]/gi)].map((match) => match[1])) {
      const segment = route.split('/').filter(Boolean).pop();
      copy = copy.replaceAll(route, newRoute);

      if (segment) {
        copy = copy.replace(new RegExp(`(['"\`>])${escape(segment[0].toUpperCase() + segment.slice(1))}(['"\`<])`, 'g'), `$1${newTitle}$2`);
      }
    }

    if (copy === line || lines.includes(copy)) {
      continue;
    }

    const next = lines.slice(index + 1).find((entry) => entry.trim());

    if (!/,\s*$/.test(line) && next && /^\s*[\]})]/.test(next) && /[\]})],?\s*$|^\s*[\w'"`]/.test(line.trim()) && !/^\s*(import|export|const|let|var)\b/.test(line)) {
      output[output.length - 1] = `${line},`;
    }

    output.push(copy);
    cloned += 1;
  }

  return { content: output.join('\n'), cloned };
}
