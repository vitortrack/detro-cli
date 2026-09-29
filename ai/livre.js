import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { sha256 } from './generator.js';
import { saveImplementation } from './implementationStore.js';
import { validateFile } from './validator.js';
import { workspaceOf } from './typescript.js';

const SCHEMA = {
  type: 'object',
  properties: {
    resumo: { type: 'string' },
    arquivos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          acao: { type: 'string', enum: ['create', 'modify'] },
          conteudo: { type: 'string' },
        },
        required: ['path', 'acao', 'conteudo'],
      },
    },
    sugestoes: { type: 'array', items: { type: 'string' } },
  },
  required: ['resumo', 'arquivos', 'sugestoes'],
};

function montarPedido(request) {
  return [
    'Você está implementando um pedido neste repositório. Você só tem ferramentas de LEITURA: explore o código com Read/Grep/Glob e siga os CLAUDE.md (raiz, api/, web/, .claude/).',
    'Não escreva arquivos. Devolva a mudança como proposta: para cada arquivo criado ou alterado, o conteúdo COMPLETO final em "conteudo" e o caminho relativo à raiz em "path".',
    'Mexa só no necessário para o pedido funcionar. Em "resumo", uma frase do que muda; em "sugestoes", até 5 observações curtas em pt-BR (vazio se não houver).',
    '',
    'PEDIDO:',
    request,
  ].join('\n');
}

function chamarClaude({ projectDir, request, claude }) {
  const args = [
    '-p',
    '--tools', 'Read', 'Grep', 'Glob',
    '--allowedTools', 'Read', 'Grep', 'Glob',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(SCHEMA),
    '--no-session-persistence',
    '--setting-sources', 'project',
  ];
  if (claude.model) args.push('--model', claude.model);

  const env = { ...process.env };
  if (!claude.usarApiKey) delete env.ANTHROPIC_API_KEY;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: projectDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), claude.timeoutMs ?? 600000);

    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Não foi possível executar o Claude Code (${error.message}).`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(out);
        if (data.is_error) throw new Error(String(data.result ?? ''));
        resolve(data.structured_output ?? JSON.parse(data.result));
      } catch (error) {
        reject(new Error(`O Claude Code não devolveu uma proposta válida (código ${code}). ${(error.message || err).slice(0, 300)}`));
      }
    });

    child.stdin.end(montarPedido(request));
  });
}

export async function planejarLivre({ projectDir, config, request, motivo, printDiff }) {
  if (motivo) {
    console.log(chalk.yellow(`  O pipeline do Ollama não encaixou o pedido (${motivo})`));
  }
  console.log(chalk.magenta('▸ Modo livre: o Claude está lendo o projeto e preparando a mudança…'));

  const proposta = await chamarClaude({ projectDir, request, claude: config.ai.ollama.claude ?? {} });
  const files = [];
  let comProblema = 0;

  console.log();
  console.log(chalk.cyan.bold(proposta.resumo));

  for (const arquivo of proposta.arquivos) {
    const relativo = path.normalize(arquivo.path).replace(/^(\.\.[/\\])+/, '');
    const absoluto = path.join(projectDir, relativo);
    const original = arquivo.acao === 'modify' ? await readFile(absoluto, 'utf8').catch(() => null) : null;

    if (arquivo.acao === 'modify' && original === null) {
      console.log(chalk.red(`  ✗ ${relativo}: o Claude propôs alterar um arquivo que não existe.`));
      comProblema += 1;
      continue;
    }

    const validacao = /\.(ts|tsx)$/.test(relativo)
      ? await validateFile({ projectDir, relativePath: relativo, content: arquivo.conteudo })
      : { valid: true, errors: [] };

    console.log();
    console.log(chalk.white.bold(`${arquivo.acao === 'create' ? '+' : '~'} ${relativo}`) + (validacao.valid ? chalk.green('  ✓ tipos ok') : chalk.red('  ✗ com problemas')));
    for (const erro of validacao.errors ?? []) {
      console.log(chalk.red(`    ${erro}`));
    }
    if (original !== null) {
      printDiff(original, arquivo.conteudo);
    }

    if (!validacao.valid) comProblema += 1;
    files.push({
      action: arquivo.acao,
      kind: 'ai',
      path: relativo,
      content: arquivo.conteudo,
      originalHash: original !== null ? sha256(original) : undefined,
    });
  }

  for (const sugestao of proposta.sugestoes) {
    console.log(chalk.magenta(`  ✎ claude: ${sugestao}`));
  }

  if (files.length === 0) {
    console.log(chalk.yellow('Nenhum arquivo proposto. Reescreva o pedido com mais detalhes.'));
    return 1;
  }

  const services = [...new Set(files.map((file) => workspaceOf(file.path)).filter(Boolean))];
  const filePath = await saveImplementation({
    projectDir,
    implementation: { kind: 'livre', createdAt: new Date().toISOString(), request, files, migration: null, services },
  });

  console.log();
  console.log(chalk.dim(`Proposta salva em: ${filePath}`));
  console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));
  console.log(comProblema > 0
    ? chalk.red(`${comProblema} arquivo(s) com problema. Revise antes de aplicar ou peça de novo com mais detalhes.`)
    : chalk.cyan('Próximo passo: detro apply'));
  return comProblema > 0 ? 1 : 0;
}
