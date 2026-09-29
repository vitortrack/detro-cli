import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { requireOllama } from './config.js';
import { prepareEdit } from './editor.js';
import { applyRename, buildRenameMap, cloneRegistrationLines } from './example.js';
import { sha256 } from './generator.js';
import { ollamaChat } from './ollama.js';
import { autoFix, syntaxCheck, typeCheck, workspaceOf } from './typescript.js';
import { cleanGeneratedCode, formatDiagnostic } from './validator.js';

const SYSTEM = `
Você adapta um arquivo que foi COPIADO de outra feature do MESMO projeto (os nomes da entidade já foram trocados) para a nova entidade.

Responda SOMENTE com o conteúdo completo do arquivo. Sem markdown, sem explicação.

- Mantenha a estrutura, os imports, o estilo e os padrões do arquivo: é o jeito deste projeto fazer as coisas.
- Troque só o que é do domínio: os campos da entidade antiga pelos CAMPOS NOVOS (tipos, validações, inputs, colunas, colunas de banco), textos visíveis, rótulos e rotas.
- Textos visíveis no idioma que o arquivo já usa.
- Não invente dependências nem imports que não existam; os outros arquivos da nova feature estão listados.
- Não use any. Não deixe variável ou import sem uso.
`.trim();

async function exists(projectDir, file) {
  try {
    await access(path.join(projectDir, file));
    return true;
  } catch {
    return false;
  }
}

function describeFields(spec) {
  return spec.fields.map((field) => {
    const extra = [
      field.required ? 'obrigatório' : 'opcional',
      field.maxLength ? `máx. ${field.maxLength}` : null,
      field.min !== undefined ? `mín. ${field.min}` : null,
      field.max !== undefined ? `máx. ${field.max}` : null,
      field.options ? `opções: ${field.options.map((option) => `${option.value}="${option.label}"`).join(', ')}` : null,
    ].filter(Boolean).join(', ');
    return `- ${field.name}: ${field.type} — "${field.label}" (${extra})`;
  }).join('\n');
}

function slug(value) {
  return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function planExampleFiles(projectDir, example, spec) {
  const map = buildRenameMap(example.stem, spec);
  const files = [];
  const errors = [];

  for (const from of example.files) {
    const to = applyRename(from, map);

    if (to === from) {
      errors.push(`Não consegui derivar um nome novo para ${from}; renomeie a entidade no plano.`);
      continue;
    }

    if (await exists(projectDir, to)) {
      errors.push(`Já existe ${to}. Troque "entity"/"entityPlural" no plano.`);
    }

    files.push({ from, to });
  }

  return { map, files, errors };
}

function validateContent(projectDir, file, content, virtualFiles, allowed) {
  if (workspaceOf(file)) {
    const { diagnostics } = typeCheck(projectDir, { virtualFiles, targets: [file] });
    const key = (item) => item.replace(/^linha \d+ /, '');
    const permitted = allowed.map(key);
    return (diagnostics.get(file) ?? []).map(formatDiagnostic).filter((item) => !permitted.includes(key(item)));
  }

  if (/\.(js|jsx|mjs|cjs)$/.test(file)) {
    return (syntaxCheck(projectDir, file, content) ?? []).map(formatDiagnostic);
  }

  if (/\.json$/.test(file)) {
    try {
      JSON.parse(content);
      return [];
    } catch (error) {
      return [`JSON inválido: ${error.message}`];
    }
  }

  return [];
}

function importsOf(content) {
  return [...content.matchAll(/(?:from|require\(|import\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

export async function generateByExample({ projectDir, config, plan, onEvent = () => {} }) {
  const ollama = requireOllama(config);
  const { spec, example } = plan;
  const { map, files: planned, errors } = await planExampleFiles(projectDir, example, spec);

  if (errors.length > 0) {
    throw new Error(`O plano tem problemas:\n- ${errors.join('\n- ')}`);
  }

  const virtualFiles = new Map();
  const drafts = [];

  for (const item of planned) {
    const original = await readFile(path.join(projectDir, item.from), 'utf8');
    const draft = applyRename(original, map);
    const baseline = workspaceOf(item.from)
      ? (typeCheck(projectDir, { targets: [item.from] }).diagnostics.get(item.from) ?? []).map(formatDiagnostic)
      : [];
    virtualFiles.set(item.to, draft);
    drafts.push({ ...item, draft, baseline });
  }

  const newPaths = drafts.map((item) => item.to);
  const weight = (item) => importsOf(item.draft).filter((spec) => newPaths.some((other) => other !== item.to && spec.includes(path.posix.basename(other).replace(/\.[^.]+$/, '')))).length;
  drafts.sort((a, b) => weight(a) - weight(b));

  const route = `/${slug(spec.labelPlural)}`;
  const context = [
    `NOVA ENTIDADE: ${spec.entity} / ${spec.entityPlural} — em português: ${spec.labelSingular} / ${spec.labelPlural}; título: ${spec.title}; rota sugerida: ${route}`,
    `CAMPOS NOVOS (substituem TODOS os campos da entidade antiga; id e datas de controle continuam como estavam):\n${describeFields(spec)}`,
    `ARQUIVOS DA NOVA FEATURE:\n${newPaths.map((file) => `- ${file}`).join('\n')}`,
  ].join('\n\n');

  const output = [];
  const maxAttempts = (config.ai.generation.maxRepairs ?? 2) + 1;

  onEvent({ type: 'stage', message: `Criando ${drafts.length} arquivo(s) a partir de "${example.stem}"` });

  for (const item of drafts) {
    const base = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${context}\n\nARQUIVO: ${item.to} (copiado de ${item.from})\n${item.draft}\n\nDevolva o arquivo ${item.to} completo, adaptado.` },
    ];

    let messages = base;
    let result = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      onEvent({ type: 'generating', path: item.to, attempt });
      const { content: raw } = await ollamaChat({ ollama, attempt, messages, onProgress: (tokens) => onEvent({ type: 'progress', path: item.to, tokens }) });
      let content = cleanGeneratedCode(raw);
      virtualFiles.set(item.to, content);

      if (workspaceOf(item.to)) {
        content = autoFix(projectDir, { virtualFiles, target: item.to, codes: [6133, 6192, 2304] }).content;
        virtualFiles.set(item.to, content);
      }

      const problems = validateContent(projectDir, item.to, content, virtualFiles, item.baseline);
      result = { content, problems, attempt };
      onEvent({ type: 'fix-attempt', path: item.to, attempt, remaining: problems.length });

      if (problems.length === 0) {
        break;
      }

      messages = [...base, { role: 'assistant', content }, { role: 'user', content: `O arquivo tem problemas:\n${problems.slice(0, 20).map((problem) => `- ${problem}`).join('\n')}\n\nDevolva o arquivo COMPLETO corrigido.` }];
    }

    output.push({ action: 'create', kind: 'ai', path: item.to, content: result.content, attempts: result.attempt, validation: { valid: result.problems.length === 0, errors: result.problems, warnings: [], imports: [] } });
    onEvent({ type: 'validated', path: item.to, validation: output.at(-1).validation });

    if (result.problems.length > 0) {
      return { spec, files: output, valid: false };
    }
  }

  const symbolsOld = [...new Set(example.registrations.flatMap((item) => item.symbols ?? []))];
  const symbolsNew = symbolsOld.map((name) => applyRename(name, map));

  for (const registration of example.registrations) {
    onEvent({ type: 'stage', message: `Registrando a nova feature em ${registration.file}` });

    const mentions = [...(registration.symbols ?? []), ...(registration.routes ?? [])].join(', ');
    const instructions = [
      `Registre a nova feature "${spec.labelPlural}" (${spec.entity}) neste arquivo DA MESMA FORMA que a feature existente está registrada.`,
      `Para cada trecho que registra ${mentions}, adicione logo depois um trecho equivalente para a nova feature, sem remover nem alterar o existente.`,
      symbolsNew.length > 0 ? `Nomes novos correspondentes: ${symbolsOld.map((name, index) => `${name} → ${symbolsNew[index]}`).join(', ')}.` : null,
      `Rota da nova feature: ${route}. Rótulo/título: "${spec.title}".`,
      `Arquivos novos (para os imports): ${newPaths.join(', ')}.`,
    ].filter(Boolean).join('\n');

    const current = await readFile(path.join(projectDir, registration.file), 'utf8');
    const cloned = cloneRegistrationLines(current, { symbols: registration.symbols, routes: registration.routes, map, newRoute: route, newTitle: spec.title });
    let edit = null;

    if (cloned.cloned > 0) {
      const baseline = validateContent(projectDir, registration.file, current, virtualFiles, []);
      const problems = validateContent(projectDir, registration.file, cloned.content, new Map([...virtualFiles, [registration.file, cloned.content]]), baseline);

      if (problems.length === 0) {
        edit = { ok: true, original: current, content: cloned.content, summary: `${cloned.cloned} linha(s) de registro copiadas para a nova feature (sem IA).`, problems: [] };
        onEvent({ type: 'fix-attempt', path: registration.file, attempt: 0, remaining: 0 });
      }
    }

    if (!edit) {
      edit = await prepareEdit({ projectDir, config, file: registration.file, instructions, virtualFiles, onEvent });
    }

    output.push({
      action: 'modify',
      kind: 'edit',
      path: registration.file,
      content: edit.content,
      originalHash: sha256(edit.original),
      original: edit.original,
      summary: edit.summary,
      validation: { valid: edit.ok, errors: edit.problems, warnings: [], imports: [] },
    });

    onEvent({ type: 'validated', path: registration.file, validation: output.at(-1).validation });

    if (!edit.ok) {
      return { spec, files: output, valid: false };
    }

    virtualFiles.set(registration.file, edit.content);
  }

  return { spec, files: output, valid: output.every((file) => file.validation.valid) };
}
