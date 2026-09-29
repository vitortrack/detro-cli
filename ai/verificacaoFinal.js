import { readFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { unifiedDiff } from './diff.js';
import { chamarClaudeJson } from './livre.js';
import { validateFile } from './validator.js';

const SCHEMA = {
  type: 'object',
  properties: {
    arquivos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          conteudo: { type: 'string' },
          motivo: { type: 'string' },
        },
        required: ['path', 'conteudo', 'motivo'],
      },
    },
    sugestoes: { type: 'array', items: { type: 'string' } },
  },
  required: ['arquivos', 'sugestoes'],
};

function diffEmTexto(antes, depois) {
  const hunks = unifiedDiff(antes, depois);
  if (hunks === null) return '(diff grande demais)';
  return hunks.map((hunk) => [hunk.header, ...hunk.lines.map((line) => `${line.type}${line.text}`)].join('\n')).join('\n');
}

async function blocoDoArquivo(projectDir, file) {
  if (file.action !== 'modify') {
    return `===== ${file.path} (arquivo novo da feature) =====\n${file.content}`;
  }
  const antes = await readFile(path.join(projectDir, file.path), 'utf8').catch(() => null);
  const alteracoes = antes === null ? '(original indisponível)' : diffEmTexto(antes, file.content);
  return `===== ${file.path} (arquivo existente) =====\nO QUE A FEATURE ALTEROU:\n${alteracoes}\n\nCONTEÚDO FINAL:\n${file.content}`;
}

function montarPedido({ contexto, request, blocos }) {
  return [
    contexto ?? '',
    'Você faz a verificação final de uma feature gerada automaticamente, ANTES de ela ser escrita no projeto.',
    'Cada arquivo abaixo já passou sozinho na checagem de tipos. Seu foco é a COERÊNCIA ENTRE ELES e com o pedido:',
    'nomes de campos e rotas iguais entre api e web, tipos compartilhados, registro em módulo/rota/menu, permissões, mensagens em pt-BR, algo pedido que ficou de fora.',
    'Em "arquivos", devolva SOMENTE os arquivos que precisam mudar, com o conteúdo COMPLETO corrigido e, em "motivo", uma frase do que corrigiu.',
    'Se estiver tudo certo, devolva "arquivos" vazio. Em "sugestoes", até 5 observações curtas em pt-BR (vazio se não houver).',
    'Em arquivo existente, corrija SÓ o que a feature alterou (veja "O QUE A FEATURE ALTEROU"). Problema que já existia antes da feature não se corrige aqui: descreva em "sugestoes", começando por "Já existia:".',
    '',
    'PEDIDO ORIGINAL:',
    request || '(não disponível)',
    '',
    ...blocos,
  ].join('\n');
}

export async function verificarFeature({ projectDir, config, request, files, printDiff }) {
  const claude = config.ai.ollama.claude ?? {};

  if (claude.enabled === false || claude.verificarFeature === false || files.length === 0) {
    return files;
  }

  console.log();
  console.log(chalk.magenta.bold('VERIFICAÇÃO FINAL (Claude)'));
  console.log(chalk.dim(`Conferindo a coerência entre os ${files.length} arquivo(s) da feature…`));

  let resposta;
  try {
    resposta = await chamarClaudeJson({
      projectDir,
      prompt: montarPedido({
        contexto: config.ai.ollama.projectContext,
        request,
        blocos: await Promise.all(files.map((file) => blocoDoArquivo(projectDir, file))),
      }),
      schema: SCHEMA,
      claude,
    });
  } catch (error) {
    console.log(chalk.yellow(`  A verificação final não rodou (${error.message}). Seguindo com a versão já validada.`));
    return files;
  }

  const porCaminho = new Map(files.map((file) => [file.path, file]));
  const virtualFiles = new Map(files.map((file) => [file.path, file.content]));
  const aceitas = [];

  for (const correcao of resposta.arquivos) {
    const original = porCaminho.get(correcao.path);

    if (!original) {
      console.log(chalk.yellow(`  ~ ${correcao.path}: não faz parte da feature; ignorado.`));
      continue;
    }

    if (correcao.conteudo === original.content) {
      continue;
    }

    virtualFiles.set(correcao.path, correcao.conteudo);
    aceitas.push({ original, correcao });
  }

  const reprovadas = [];

  for (const item of aceitas) {
    item.validacao = /\.(ts|tsx)$/.test(item.correcao.path)
      ? await validateFile({ projectDir, relativePath: item.correcao.path, content: item.correcao.conteudo, virtualFiles })
      : { valid: true, errors: [] };
    if (!item.validacao.valid) reprovadas.push(item);
  }

  let final = files;

  if (aceitas.length === 0) {
    console.log(chalk.green('  ✓ Nada a corrigir: os arquivos estão coerentes entre si.'));
  } else if (reprovadas.length > 0) {
    console.log(chalk.yellow(`  ✗ ${reprovadas.length} correção(ões) do Claude não passaram nos tipos; mantida a versão anterior da feature inteira.`));
    for (const { correcao, validacao } of reprovadas) {
      console.log(chalk.dim(`    ${correcao.path}`));
      for (const erro of validacao.errors) console.log(chalk.dim(`      ${erro}`));
    }
  } else {
    const corrigidos = new Map(aceitas.map(({ correcao, validacao }) => [correcao.path, { content: correcao.conteudo, validation: validacao }]));
    for (const { original, correcao } of aceitas) {
      console.log();
      console.log(chalk.green(`  ✓ ${correcao.path}: ${correcao.motivo}`));
      printDiff(original.content, correcao.conteudo);
    }
    final = files.map((file) => (corrigidos.has(file.path) ? { ...file, ...corrigidos.get(file.path) } : file));
  }

  for (const sugestao of resposta.sugestoes) {
    console.log(chalk.magenta(`  ✎ claude: ${sugestao}`));
  }

  return final;
}
