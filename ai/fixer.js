import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isInstalled, listTables, loadDependencies } from './catalog.js';
import { requireOllama } from './config.js';
import { sha256 } from './generator.js';
import { ollamaChat } from './ollama.js';
import { runRules } from './rules.js';
import { autoFix, resolveProjectPath, typeCheckIsolated, workspaceOf } from './typescript.js';
import { cleanGeneratedCode, formatDiagnostic } from './validator.js';

const MAX_LINES = 700;

const FIX_SYSTEM = `
Você corrige um arquivo TypeScript do projeto.

Responda SOMENTE com o conteúdo COMPLETO do arquivo corrigido. Sem markdown, sem \`\`\`, sem explicação.

Regras:
- Corrija só os problemas listados. Não reorganize, não renomeie, não mude formatação nem comportamento do resto.
- Preserve todas as linhas que não precisam mudar, inclusive comentários.
- Não adicione dependências novas nem imports de módulos que não existem.
- Não use any.
`.trim();

async function collectProblems({ projectDir, file, content, context }) {
  const { diagnostics, unavailable } = await typeCheckIsolated(projectDir, {
    virtualFiles: new Map([[file, content]]),
    targets: [file],
  });

  if (unavailable.length > 0) {
    throw new Error(`TypeScript não encontrado em ${unavailable[0]}/node_modules. Rode "cd ${unavailable[0]} && npm install".`);
  }

  const typeErrors = (diagnostics.get(file) ?? []).map(formatDiagnostic);
  const ruleErrors = runRules({ projectDir, file, content, ...context })
    .filter((item) => item.severity === 'erro')
    .map((item) => `linha ${item.line} (${item.rule}): ${item.message}`);

  return [...typeErrors, ...ruleErrors];
}

export async function prepareFix({ projectDir, config, input, cwd = process.cwd(), onEvent = () => {} }) {
  const ollama = requireOllama(config);
  const file = resolveProjectPath(projectDir, input, cwd);
  const workspace = workspaceOf(file);

  if (!workspace || !/\.(ts|tsx)$/.test(file) || file.startsWith('..')) {
    throw new Error('O fix funciona com arquivos .ts/.tsx que tenham um tsconfig.json acima deles. Ex.: detro fix src/pages/Home.tsx');
  }

  const original = await readFile(path.join(projectDir, file), 'utf8');
  const lineCount = original.split('\n').length;

  if (lineCount > MAX_LINES) {
    throw new Error(`O arquivo tem ${lineCount} linhas; acima de ${MAX_LINES} o modelo local tende a cortar conteúdo. Corrija por partes ou use "detro check ${file}" para ver os erros.`);
  }

  const tenantTables = new Set([...(await listTables(projectDir))].filter(([, table]) => table.tenant).map(([name]) => name));
  const context = {
    tenantTables,
    dependencies: await loadDependencies(projectDir, workspace),
    changedLines: null,
    tenantExclude: config.ai.review.tenantExclude,
    installed: (target, name) => isInstalled(projectDir, target, name),
  };

  onEvent({ type: 'stage', message: 'Coletando erros de tipo e das regras do projeto' });
  const initialProblems = await collectProblems({ projectDir, file, content: original, context });

  if (initialProblems.length === 0) {
    return { file, nothingToFix: true, initialProblems };
  }

  let best = null;
  const quick = workspace ? autoFix(projectDir, { virtualFiles: new Map([[file, original]]), target: file }) : { content: original, applied: [] };

  if (quick.applied.length > 0) {
    const problems = await collectProblems({ projectDir, file, content: quick.content, context });
    onEvent({ type: 'autofix', path: file, applied: quick.applied });

    if (problems.length < initialProblems.length) {
      best = { content: quick.content, problems, attempt: 0 };
    }
  }

  const start = best?.content ?? original;
  const startProblems = best?.problems ?? initialProblems;

  const base = [
    { role: 'system', content: FIX_SYSTEM },
    {
      role: 'user',
      content: `ARQUIVO: ${file}\n\nPROBLEMAS:\n${startProblems.map((problem) => `- ${problem}`).join('\n')}\n\nCONTEÚDO ATUAL:\n${start}`,
    },
  ];

  let messages = base;
  const maxAttempts = startProblems.length === 0 ? 0 : (config.ai.generation.maxRepairs ?? 2) + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    onEvent({ type: 'generating', path: file, attempt });

    const { content: raw } = await ollamaChat({ attempt,
      ollama,
      messages,
      temperature: 0,
      onProgress: (tokens) => onEvent({ type: 'progress', path: file, tokens }),
    });

    const content = cleanGeneratedCode(raw);
    const ratio = content.length / original.length;
    let problems;

    if (ratio < 0.85 || ratio > 1.3) {
      problems = [`O arquivo devolvido mudou demais de tamanho (${Math.round(ratio * 100)}% do original): devolva o arquivo COMPLETO, mudando só as linhas com problema.`];
    } else {
      problems = await collectProblems({ projectDir, file, content, context });
    }

    onEvent({ type: 'fix-attempt', path: file, attempt, remaining: problems.length });

    if (ratio >= 0.85 && ratio <= 1.3 && (!best || problems.length < best.problems.length)) {
      best = { content, problems, attempt };
    }

    if (problems.length === 0) {
      break;
    }

    messages = [
      ...base,
      { role: 'assistant', content },
      { role: 'user', content: `Ainda há problemas:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n\nDevolva o arquivo COMPLETO corrigido.` },
    ];
  }

  if (!best || best.problems.length >= initialProblems.length) {
    return { file, improved: false, initialProblems, remaining: best?.problems ?? initialProblems };
  }

  return {
    file,
    improved: true,
    original,
    content: best.content,
    initialProblems,
    remaining: best.problems,
    implementation: {
      version: 2,
      kind: 'fix',
      createdAt: new Date().toISOString(),
      request: `detro fix ${file}`,
      files: [{
        action: 'modify',
        kind: 'ai',
        path: file,
        content: best.content,
        originalHash: sha256(original),
      }],
    },
  };
}
