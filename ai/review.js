import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { isInstalled, listTables, loadDependencies } from './catalog.js';
import { requireOllama } from './config.js';
import { ollamaJson } from './ollama.js';
import { addedLines, runRules } from './rules.js';
import { getChecker, resolveProjectPath, typeCheckIsolated, workspaceOf } from './typescript.js';

const run = promisify(execFile);
const REVIEWABLE = /\.(ts|tsx|mts|cts|sql)$/;
const SKIPPED = /(^|\/)(node_modules|dist|build|coverage|\.git|\.detro|\.next|out)\//;

export async function findTsProjects(projectDir, dir = '.', depth = 0, found = []) {
  if (depth > 4 || SKIPPED.test(`${dir}/`)) {
    return found;
  }

  let entries = [];

  try {
    entries = await readdir(path.join(projectDir, dir), { withFileTypes: true });
  } catch {
    return found;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === 'tsconfig.json')) {
    found.push(dir);
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      await findTsProjects(projectDir, path.posix.join(dir, entry.name), depth + 1, found);
    }
  }

  return found;
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['erro', 'aviso'] },
          message: { type: 'string' },
        },
        required: ['line', 'severity', 'message'],
      },
    },
  },
  required: ['findings'],
};

const REVIEW_SYSTEM = `
Você revisa código do projeto (NestJS + PostgreSQL/PostGIS + React) procurando FALHAS DE LÓGICA reais.

Responda SOMENTE com JSON no formato {"findings": [{"line": n, "severity": "erro"|"aviso", "message": "..."}]}.

Procure:
- condição invertida ou incompleta, off-by-one, paginação/offset errado, divisão por zero;
- Promise sem await, erro engolido em catch vazio, retorno faltando;
- null/undefined não tratado antes de usar;
- React: dependência faltando no useEffect/useMemo, estado lido de closure velha, setState em componente desmontado, lista sem key estável;
- SQL: filtro por operator_id faltando em dado de operadora; ST_Distance em metros sem ::geography; comparação de grade (horário local) com timestamp UTC sem AT TIME ZONE 'America/Sao_Paulo'; UPDATE/DELETE sem WHERE;
- transporte escolar: students.active (visível) não é students.transport_active (recebe transporte); pickup_lat/lon (residência) não é boarding_lat/lon (embarque); consulta pública de protocolo exige protocolo + CPF e a mesma mensagem de "não encontrado" nos dois casos.

NÃO reporte: estilo, formatação, nomes, falta de comentários, sugestões de melhoria, nem o que já está em ACHADOS JÁ CONHECIDOS.
severity "erro" = bug certo; "aviso" = provável bug que precisa de confirmação.
message: em português, curta, dizendo o problema e como corrigir.
Se não houver falha clara, devolva {"findings": []}.
`.trim();

async function git(projectDir, args) {
  try {
    const { stdout } = await run('git', args, { cwd: projectDir, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

export async function changedFiles(projectDir) {
  const tracked = await git(projectDir, ['diff', '--name-only', 'HEAD']);
  const untracked = await git(projectDir, ['ls-files', '--others', '--exclude-standard']);

  if (tracked === null) {
    throw new Error('Não consegui listar as mudanças com git. Informe os arquivos: detro check <arquivo...>');
  }

  return [...new Set(`${tracked}\n${untracked ?? ''}`.split('\n').map((line) => line.trim()).filter(Boolean))];
}

async function changedLinesOf(projectDir, file) {
  const tracked = await git(projectDir, ['ls-files', '--error-unmatch', file]);

  if (tracked === null) {
    return null;
  }

  const diff = await git(projectDir, ['diff', '-U0', 'HEAD', '--', file]);
  return diff ? addedLines(diff) : null;
}

export async function resolveTargets(projectDir, inputs, { all = false, cwd = process.cwd() } = {}) {
  let files;

  if (inputs.length > 0) {
    files = inputs.map((input) => resolveProjectPath(projectDir, input, cwd));
  } else if (all) {
    files = [];

    for (const workspace of await findTsProjects(projectDir)) {
      const checker = getChecker(projectDir, workspace);

      if (checker) {
        files.push(...checker.projectFiles);
      }
    }
  } else {
    files = await changedFiles(projectDir);
  }

  const existing = [];

  for (const file of files) {
    if (file.startsWith('..')) {
      throw new Error(`Arquivo fora do projeto: ${file}`);
    }

    try {
      if (!SKIPPED.test(file) && REVIEWABLE.test(file) && (await stat(path.join(projectDir, file))).isFile()) {
        existing.push(file);
      }
    } catch {
      continue;
    }
  }

  return existing;
}

function numbered(content, startLine = 1) {
  return content
    .split('\n')
    .map((line, index) => `${String(startLine + index).padStart(4)}| ${line}`)
    .join('\n');
}

function chunks(content, maxChars) {
  const lines = content.split('\n');
  const result = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let size = 0;

    while (end < lines.length && size + lines[end].length + 7 < maxChars) {
      size += lines[end].length + 7;
      end += 1;
    }

    end = Math.max(end, start + 1);
    result.push({ startLine: start + 1, text: lines.slice(start, end).join('\n') });

    if (end >= lines.length) {
      break;
    }

    start = Math.max(end - 15, start + 1);
  }

  return result;
}

async function reviewWithAi({ ollama, file, content, known, maxChars, onEvent }) {
  const totalLines = content.split('\n').length;
  const findings = [];

  for (const part of chunks(content, maxChars)) {
    onEvent({ type: 'reviewing', file, startLine: part.startLine });

    const knownText = known.length > 0
      ? known.map((item) => `- linha ${item.line}: ${item.message}`).join('\n')
      : '(nenhum)';

    const result = await ollamaJson({
      ollama,
      schema: REVIEW_SCHEMA,
      onProgress: (tokens) => onEvent({ type: 'progress', file, tokens }),
      messages: [
        { role: 'system', content: REVIEW_SYSTEM },
        {
          role: 'user',
          content: `ARQUIVO: ${file}\n\nACHADOS JÁ CONHECIDOS:\n${knownText}\n\nCÓDIGO (número da linha | código):\n${numbered(part.text, part.startLine)}`,
        },
      ],
    });

    for (const item of result.findings ?? []) {
      const line = Number(item.line);

      if (!Number.isInteger(line) || line < 1 || line > totalLines || !item.message?.trim()) {
        continue;
      }

      findings.push({
        file,
        line,
        severity: item.severity === 'erro' ? 'erro' : 'aviso',
        rule: 'ia',
        message: item.message.trim(),
        source: 'ia',
      });
    }
  }

  const seen = new Set();

  return findings
    .filter((item) => {
      const key = `${item.line}:${item.message.toLowerCase()}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .slice(0, 10);
}

export async function runCheck({ projectDir, config, files, useAi = false, onEvent = () => {} }) {
  const tenantTables = new Set([...(await listTables(projectDir))].filter(([, table]) => table.tenant).map(([name]) => name));
  const dependencyCache = new Map();
  const dependenciesOf = async (workspace) => {
    if (!dependencyCache.has(workspace)) {
      dependencyCache.set(workspace, await loadDependencies(projectDir, workspace ?? '.'));
    }

    return dependencyCache.get(workspace);
  };

  const findings = [];
  const warnings = [];
  const tsTargets = files.filter((file) => /\.(ts|tsx)$/.test(file));

  if (tsTargets.length > 0) {
    onEvent({ type: 'stage', message: `Checando tipos de ${tsTargets.length} arquivo(s)` });
    const { diagnostics, unavailable } = await typeCheckIsolated(projectDir, { targets: tsTargets, lint: true });

    for (const workspace of unavailable) {
      warnings.push(`TypeScript não encontrado em ${workspace}/node_modules: rode "cd ${workspace} && npm install" para checar os tipos.`);
    }

    for (const [file, items] of diagnostics) {
      const changed = await changedLinesOf(projectDir, file);

      for (const item of items) {
        if (item.rule && changed && !changed.has(item.line)) {
          continue;
        }

        findings.push({
          file,
          line: item.line,
          severity: item.severity ?? 'erro',
          rule: item.rule ?? `TS${item.code}`,
          message: item.message,
          source: item.rule ? 'regra' : 'typescript',
        });
      }
    }
  }

  onEvent({ type: 'stage', message: 'Aplicando as regras do projeto' });

  const contents = new Map();

  for (const file of files) {
    const content = await readFile(path.join(projectDir, file), 'utf8');
    contents.set(file, content);

    findings.push(...runRules({
      projectDir,
      file,
      content,
      tenantTables,
      dependencies: await dependenciesOf(workspaceOf(file)),
      changedLines: await changedLinesOf(projectDir, file),
      tenantExclude: config.ai.review.tenantExclude,
      installed: (workspace, name) => isInstalled(projectDir, workspace, name),
    }));
  }

  if (useAi) {
    const ollama = requireOllama(config);
    const maxChars = config.ai.review.maxFileChars ?? 24000;

    for (const file of files) {
      const known = findings.filter((item) => item.file === file);
      onEvent({ type: 'stage', message: `Revisando ${file} com a IA` });
      findings.push(...await reviewWithAi({ ollama, file, content: contents.get(file), known, maxChars, onEvent }));
    }
  }

  const order = { erro: 0, aviso: 1, info: 2 };
  findings.sort((a, b) => a.file.localeCompare(b.file) || order[a.severity] - order[b.severity] || a.line - b.line);

  return { findings, warnings };
}
