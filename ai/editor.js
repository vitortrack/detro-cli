import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { requireOllama } from './config.js';
import { sha256 } from './generator.js';
import { ollamaJson } from './ollama.js';
import { autoFix, typeCheck, workspaceOf } from './typescript.js';
import { formatDiagnostic } from './validator.js';

const MAX_CHARS = 60000;

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          find: { type: 'string' },
          replace: { type: 'string' },
        },
        required: ['find', 'replace'],
      },
    },
  },
  required: ['summary', 'edits'],
};

const EDIT_SYSTEM = `
Você altera um arquivo existente do projeto (React + TypeScript no web/, NestJS no api/) conforme o PEDIDO.

Responda SOMENTE com JSON: {"summary": "...", "edits": [{"find": "...", "replace": "..."}]}.

- find: trecho copiado EXATAMENTE do arquivo (mesmos espaços e quebras de linha), de 1 a 8 linhas, que apareça UMA única vez.
- replace: o mesmo trecho já alterado. Para inserir algo, use como find a linha vizinha e repita-a no replace junto com o novo código.
- Se o PEDIDO trouxer pares "Trecho atual" / "Trecho novo", cada par é uma edição: copie o "Trecho atual" como find e o "Trecho novo" como replace, literalmente.
- Faça a MENOR mudança que atende ao pedido. Não reescreva o arquivo, não mude formatação nem o que não foi pedido.
- Se precisar de um import novo, faça uma edição a mais sobre um import existente.
- Siga o padrão do arquivo: textos em português do Brasil, classes Tailwind do projeto, sem any, sem comentários.
- summary: em português, uma frase dizendo o que foi mudado.
`.trim();

function occurrences(content, find) {
  let count = 0;
  let index = content.indexOf(find);

  while (index >= 0) {
    count += 1;
    index = content.indexOf(find, index + find.length);
  }

  return count;
}

function trimmedLines(value) {
  return value.split('\n').map((line) => line.trim()).join('\n').trim();
}

function locate(content, find) {
  const exact = find ? occurrences(content, find) : 0;

  if (exact === 1) {
    return { start: content.indexOf(find), end: content.indexOf(find) + find.length };
  }

  if (exact > 1) {
    return { error: `aparece ${exact} vezes` };
  }

  const wanted = trimmedLines(find);
  const lines = content.split('\n');
  const size = find.split('\n').length;
  const matches = [];

  for (let index = 0; index + size <= lines.length; index += 1) {
    if (trimmedLines(lines.slice(index, index + size).join('\n')) === wanted) {
      matches.push(index);
    }
  }

  if (matches.length !== 1 || !wanted) {
    return { error: matches.length === 0 ? 'não foi encontrado no arquivo' : `aparece ${matches.length} vezes` };
  }

  const start = lines.slice(0, matches[0]).join('\n').length + (matches[0] > 0 ? 1 : 0);
  const end = start + lines.slice(matches[0], matches[0] + size).join('\n').length;
  return { start, end };
}

function indentOf(line) {
  return line.match(/^\s*/)[0];
}

function reindentReplacement(originalBlock, replacement) {
  const originalLines = originalBlock.split('\n');
  const replacementLines = replacement.split('\n');
  const originalIndented = originalLines.some((line) => line.trim() && indentOf(line).length > 0);
  const replacementFlat = replacementLines.every((line) => !line.trim() || indentOf(line).length === 0);

  if (!originalIndented || !replacementFlat) {
    return replacement;
  }

  const fallback = indentOf(originalLines.find((line) => line.trim()) ?? '');

  return replacementLines
    .map((line, index) => {
      if (!line.trim()) {
        return line;
      }

      const source = originalLines.length === replacementLines.length ? originalLines[index] : null;
      return `${source && source.trim() ? indentOf(source) : fallback}${line}`;
    })
    .join('\n');
}

function expandToLineStart(content, start) {
  const lineStart = content.lastIndexOf('\n', start - 1) + 1;
  return content.slice(lineStart, start).trim() === '' ? lineStart : start;
}

export function applyEdits(content, edits) {
  const problems = [];
  let next = content;

  for (const [index, edit] of edits.entries()) {
    const place = locate(next, edit.find ?? '');

    if (place.error) {
      problems.push(`Edição ${index + 1}: o "find" ${place.error}. Copie o trecho exatamente como está no arquivo e maior, para ser único.`);
      continue;
    }

    const start = expandToLineStart(next, place.start);
    const originalBlock = next.slice(start, place.end);
    const leading = next.slice(start, place.start);
    const continued = (edit.replace ?? '').split('\n').map((line, lineIndex) => (lineIndex > 0 && leading && line.trim() && !/^\s/.test(line) ? `${leading}${line}` : line)).join('\n');
    const replacement = reindentReplacement(originalBlock, `${leading}${continued}`);
    next = next.slice(0, start) + replacement + next.slice(place.end);
  }

  return { content: next, problems };
}

function diagnosticsOf(projectDir, file, content, extra = new Map()) {
  const { diagnostics } = typeCheck(projectDir, { virtualFiles: new Map([...extra, [file, content]]), targets: [file] });
  return (diagnostics.get(file) ?? []).map(formatDiagnostic);
}

function introducedProblems(before, after) {
  const key = (item) => item.replace(/^linha \d+ /, '');
  const remaining = before.map(key);

  return after
    .filter((item) => {
      const index = remaining.indexOf(key(item));

      if (index >= 0) {
        remaining.splice(index, 1);
        return false;
      }

      return true;
    })
    .map((item) => `Depois das edições o compilador acusa: ${item}`);
}

export function literalEdits(instructions) {
  const pairs = String(instructions).matchAll(/Trecho atual:?\s*```\w*\n([\s\S]*?)\n```\s*Trecho novo:?\s*```\w*\n([\s\S]*?)\n```/g);
  return [...pairs].map((match) => ({ find: match[1], replace: match[2] }));
}

export async function prepareLiteralEdit({ projectDir, file, instructions, virtualFiles = new Map() }) {
  const edits = literalEdits(instructions);

  if (edits.length === 0) {
    return null;
  }

  const original = virtualFiles.has(file) ? virtualFiles.get(file) : await readFile(path.join(projectDir, file), 'utf8');
  const applied = applyEdits(original, edits);
  const problems = [...applied.problems];

  if (problems.length === 0 && workspaceOf(file)) {
    const before = diagnosticsOf(projectDir, file, original, virtualFiles);
    problems.push(...introducedProblems(before, diagnosticsOf(projectDir, file, applied.content, virtualFiles)));
  }

  return {
    file,
    original,
    content: applied.content,
    summary: `${edits.length} trecho(s) do pedido aplicados literalmente`,
    problems,
    ok: problems.length === 0,
  };
}

export async function prepareEdit({ projectDir, config, file, instructions, virtualFiles = new Map(), onEvent = () => {} }) {
  const ollama = requireOllama(config);
  const original = virtualFiles.has(file) ? virtualFiles.get(file) : await readFile(path.join(projectDir, file), 'utf8');

  if (original.length > MAX_CHARS) {
    throw new Error(`${file} tem ${original.length} caracteres; acima de ${MAX_CHARS} o modelo local não consegue ler o arquivo inteiro. Divida o pedido indicando o componente específico.`);
  }

  onEvent({ type: 'stage', message: `Checando ${file} antes da mudança` });
  const before = workspaceOf(file) ? diagnosticsOf(projectDir, file, original, virtualFiles) : [];

  const base = [
    { role: 'system', content: EDIT_SYSTEM },
    {
      role: 'user',
      content: [
        `PEDIDO:\n${instructions}`,
        before.length > 0 ? `PROBLEMAS QUE O COMPILADOR JÁ APONTA NO ARQUIVO:\n${before.map((item) => `- ${item}`).join('\n')}` : null,
        `ARQUIVO: ${file}\n${original}`,
      ].filter(Boolean).join('\n\n'),
    },
  ];

  let messages = base;
  const maxAttempts = (config.ai.generation.maxRepairs ?? 2) + 1;
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    onEvent({ type: 'generating', path: file, attempt });
    const result = await ollamaJson({ attempt,
      ollama,
      schema: EDIT_SCHEMA,
      onProgress: (tokens) => onEvent({ type: 'progress', path: file, tokens }),
      messages,
    });

    const edits = Array.isArray(result.edits) ? result.edits : [];
    const applied = applyEdits(original, edits);
    let content = applied.content;
    const problems = [...applied.problems];

    if (edits.length === 0 || content === original) {
      problems.push('Nenhuma alteração foi feita. Devolva as edições que atendem ao pedido.');
    }

    if (problems.length === 0 && workspaceOf(file)) {
      content = autoFix(projectDir, { virtualFiles: new Map([...virtualFiles, [file, content]]), target: file, codes: [6133, 6192, 2304] }).content;
    }

    let after = [];

    if (problems.length === 0 && workspaceOf(file)) {
      after = diagnosticsOf(projectDir, file, content, virtualFiles);
      problems.push(...introducedProblems(before, after));
    }

    last = { content, summary: String(result.summary ?? '').trim(), problems, after, attempt };
    onEvent({ type: 'fix-attempt', path: file, attempt, remaining: problems.length, problems });

    if (problems.length === 0) {
      break;
    }

    messages = [
      ...base,
      { role: 'assistant', content: JSON.stringify(result) },
      { role: 'user', content: `As edições têm problemas:\n${problems.map((item) => `- ${item}`).join('\n')}\n\nDevolva o JSON completo de novo, com todas as edições corrigidas (sempre a partir do arquivo ORIGINAL).` },
    ];
  }

  return {
    file,
    original,
    content: last.content,
    summary: last.summary,
    before,
    problems: last.problems,
    ok: last.problems.length === 0,
    implementationFile: { action: 'modify', kind: 'edit', path: file, content: last.content, originalHash: sha256(original) },
  };
}
