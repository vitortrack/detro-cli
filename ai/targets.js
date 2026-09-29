import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { readProjectFile } from './catalog.js';
import { readMenu } from './menu.js';

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveImport(projectDir, importPath) {
  const base = path.join(projectDir, 'web', 'src', importPath.replace(/^@\//, ''));

  for (const candidate of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (await exists(candidate)) {
      return path.relative(projectDir, candidate).replaceAll('\\', '/');
    }
  }

  return null;
}

export async function listScreensWithFiles(projectDir) {
  const app = await readProjectFile(projectDir, 'web/src/App.tsx');
  const imports = new Map();

  for (const match of app.matchAll(/import\s*\{\s*([^}]+)\}\s*from\s*['"](@\/pages\/[^'"]+)['"]/g)) {
    for (const name of match[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop()).filter(Boolean)) {
      imports.set(name, match[2]);
    }
  }

  const routes = [];

  for (const match of app.matchAll(/<Route\s+path=\s*["']([^"']+)["']\s+element=\{<(\w+)/g)) {
    const importPath = imports.get(match[2]);
    const file = importPath ? await resolveImport(projectDir, importPath) : null;

    if (file) {
      routes.push({ path: match[1], component: match[2], file });
    }
  }

  const menu = await readMenu(projectDir).catch(() => ({ items: [] }));

  return routes.map((route) => ({
    ...route,
    label: menu.items.find((item) => item.to === route.path)?.label ?? null,
  }));
}

function keywordsOf(screen) {
  const words = new Set();

  if (screen.label) {
    words.add(normalize(screen.label));
  }

  const lastSegment = screen.path.split('/').filter((part) => part && !part.startsWith(':')).pop();

  if (lastSegment) {
    words.add(normalize(lastSegment.replaceAll('-', ' ')));
  }

  words.add(normalize(screen.component.replace(/Page$/, '').replace(/([a-z])([A-Z])/g, '$1 $2')));
  return [...words].filter((word) => word.length >= 4);
}

export async function resolveTargets(projectDir, request) {
  const text = normalize(request);
  const explicit = [...String(request).matchAll(/\b((?:web|api)\/src\/[\w./-]+\.(?:tsx|ts))\b/g)].map((match) => match[1]);
  const found = [];

  for (const file of explicit) {
    try {
      if ((await stat(path.join(projectDir, file))).isFile()) {
        found.push({ file, reason: 'citado no pedido' });
      }
    } catch {
      continue;
    }
  }

  if (found.length > 0) {
    return found;
  }

  const screens = await listScreensWithFiles(projectDir).catch(() => null);

  if (!screens) {
    return resolveByFileName(projectDir, text);
  }

  const scored = [];

  for (const screen of screens) {
    if (screen.path.includes(':')) {
      continue;
    }

    const hits = keywordsOf(screen).filter((word) => text.includes(word));

    if (hits.length > 0) {
      scored.push({ screen, score: Math.max(...hits.map((word) => word.length)) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored.filter((entry) => entry.score === scored[0]?.score);

  return best.map(({ screen }) => ({
    file: screen.file,
    reason: `tela ${screen.label ? `"${screen.label}"` : screen.component} (${screen.path})`,
  }));
}

async function sourceFiles(projectDir, dir = '.', output = []) {
  let entries = [];

  try {
    entries = await readdir(path.join(projectDir, dir), { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    const relative = path.posix.join(dir, entry.name).replace(/^\.\//, '');

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) {
        await sourceFiles(projectDir, relative, output);
      }
    } else if (/\.(tsx?|jsx?|vue|svelte)$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
      output.push(relative);
    }
  }

  return output;
}

async function resolveByFileName(projectDir, text) {
  const words = text.split(/[^a-z0-9]+/).filter((word) => word.length >= 4).map((word) => word.replace(/(oes|aes|es|s)$/, ''));
  const scored = [];

  for (const file of await sourceFiles(projectDir)) {
    const name = normalize(path.basename(file).replace(/\.[^.]+$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'));
    const hits = words.filter((word) => word.length >= 4 && name.includes(word));
    const content = normalize(await readFile(path.join(projectDir, file), 'utf8').catch(() => ''));
    const visible = [...content.matchAll(/>([^<>{}\n]{3,80})</g), ...content.matchAll(/(?:label|title|placeholder)\s*[:=]\s*['"`]([^'"`]{3,80})['"`]/g)].map((match) => match[1]).join(' ');
    const contentHits = words.filter((word) => word.length >= 5 && visible.includes(word));
    const score = hits.reduce((total, word) => total + word.length * 2, 0) + contentHits.reduce((total, word) => total + word.length, 0);

    if (score > 0) {
      scored.push({ file, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((entry) => entry.score === scored[0]?.score).slice(0, 3).map((entry) => ({ file: entry.file, reason: 'nome do arquivo parecido com o pedido' }));
}
