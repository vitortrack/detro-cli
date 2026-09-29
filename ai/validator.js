import { access } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';

import { loadDependencies } from './catalog.js';
import { loadTypeScript, syntaxCheck, typeCheck, workspaceOf } from './typescript.js';

const CODE_START = /^(import|export|interface|type|const|let|function|class|enum|declare|@|\/\/|\/\*|'use|"use|--|CREATE|ALTER|BEGIN)/;

const DIAGNOSTIC_HINTS = {
  2307: 'o módulo importado não existe; use só os imports do CATÁLOGO/CONTRATOS',
  2305: 'esse nome não é exportado pelo módulo; confira o CATÁLOGO/CONTRATOS',
  2724: 'esse nome não é exportado pelo módulo; confira o CATÁLOGO/CONTRATOS',
  6133: 'remova o import/variável não usado (quebra o build)',
  6192: 'remova os imports não usados (quebra o build)',
  2304: 'identificador não declarado: importe ou declare antes de usar',
  2741: 'faltou uma prop obrigatória',
  2322: 'tipo incompatível',
  2345: 'argumento com tipo incompatível',
  7006: 'parâmetro sem tipo: declare o tipo explicitamente',
};

export function formatDiagnostic(diagnostic) {
  if (diagnostic.rule) {
    return `linha ${diagnostic.line} (${diagnostic.rule}): ${diagnostic.message}`;
  }

  const hint = DIAGNOSTIC_HINTS[diagnostic.code];
  return `linha ${diagnostic.line} (TS${diagnostic.code}): ${diagnostic.message}${hint ? ` — ${hint}` : ''}`;
}

export function cleanGeneratedCode(value) {
  let content = String(value ?? '').trim();
  const fenced = content.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);

  if (fenced) {
    content = fenced[1];
  }

  return content.trim();
}

function extractImports(projectDir, relativePath, content) {
  const ts = loadTypeScript(projectDir, workspaceOf(relativePath) ?? '.');

  if (ts) {
    return [...new Set(ts.preProcessFile(content, true, true).importedFiles.map((item) => item.fileName))];
  }

  const regex = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  return [...new Set([...content.matchAll(regex)].map((match) => match[1]))];
}

function packageName(importPath) {
  if (importPath.startsWith('@')) {
    return importPath.split('/').slice(0, 2).join('/');
  }

  return importPath.split('/')[0];
}

function isPackageImport(importPath) {
  return !importPath.startsWith('.') && !importPath.startsWith('@/') && !importPath.startsWith('/');
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveLocalImport(projectDir, relativePath, importPath, virtualFiles) {
  const base = importPath.startsWith('@/')
    ? `web/src/${importPath.slice(2)}`
    : path.posix.join(path.posix.dirname(relativePath), importPath);

  const candidates = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx'].map((suffix) => `${base}${suffix}`);

  for (const candidate of candidates) {
    if (virtualFiles.has(candidate) || await exists(path.join(projectDir, candidate))) {
      return true;
    }
  }

  return false;
}

function validateShape(content) {
  const errors = [];

  if (!content.trim()) {
    return ['O conteúdo gerado está vazio.'];
  }

  if (content.includes('```')) {
    errors.push('A resposta contém markdown (```). Devolva só o código do arquivo.');
  }

  const firstLine = content.split('\n').find((line) => line.trim())?.trim() ?? '';

  if (!CODE_START.test(firstLine)) {
    errors.push(`A resposta começa com texto em vez de código ("${firstLine.slice(0, 60)}"). Devolva só o código do arquivo.`);
  }

  if (/:\s*any\b|<any>|as any\b/.test(content)) {
    errors.push('Não use "any": declare o tipo correto.');
  }

  return errors;
}

export async function validateFile({ projectDir, relativePath, content, virtualFiles, rules = {}, mode = 'full', lint = true }) {
  const errors = validateShape(content);
  const warnings = [];
  const workspace = workspaceOf(relativePath);
  const importPaths = extractImports(projectDir, relativePath, content);
  const dependencies = workspace ? await loadDependencies(projectDir, workspace) : new Set();
  const typesAvailable = Boolean(loadTypeScript(projectDir, workspace ?? '.'));

  for (const importPath of importPaths) {
    for (const forbidden of rules.forbiddenImports ?? []) {
      if (forbidden.pattern.test(importPath)) {
        errors.push(`Import proibido "${importPath}": ${forbidden.reason}`);
      }
    }

    if (isPackageImport(importPath)) {
      const name = packageName(importPath.replace(/^node:/, ''));
      const builtin = importPath.startsWith('node:') || builtinModules.includes(name);

      if (rules.allowedPackages && !rules.allowedPackages.includes(name)) {
        errors.push(`Pacote "${name}" não é permitido aqui. Use só: ${rules.allowedPackages.join(', ')}.`);
      } else if (!builtin && !dependencies.has(name)) {
        errors.push(`Pacote "${name}" não está declarado em ${workspace}/package.json. Use outro já instalado ou rode: cd ${workspace} && npm install ${name}`);
      }

      continue;
    }

    if (!typesAvailable && !(await resolveLocalImport(projectDir, relativePath, importPath, virtualFiles))) {
      errors.push(`Import não encontrado: ${importPath}`);
    }
  }

  for (const name of rules.requiredExports ?? []) {
    if (!new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class|interface|type)\\s+${name}\\b`).test(content)) {
      errors.push(`O arquivo precisa exportar "${name}" (export nomeado, sem default).`);
    }
  }

  for (const check of rules.mustContain ?? []) {
    if (!check.pattern.test(content)) {
      errors.push(check.message);
    }
  }

  for (const check of rules.mustNotContain ?? []) {
    if (check.pattern.test(content)) {
      errors.push(check.message);
    }
  }

  let diagnostics = [];

  if (mode === 'syntax') {
    diagnostics = syntaxCheck(projectDir, relativePath, content) ?? [];
  } else if (workspace) {
    const result = typeCheck(projectDir, { virtualFiles, targets: [relativePath], lint });

    if (result.unavailable.length > 0) {
      warnings.push(`TypeScript não encontrado em ${workspace}/node_modules: rode "cd ${workspace} && npm install" para validar os tipos.`);
    }

    diagnostics = result.diagnostics.get(relativePath) ?? [];
  }

  errors.push(...diagnostics.map(formatDiagnostic));

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    imports: importPaths,
  };
}
