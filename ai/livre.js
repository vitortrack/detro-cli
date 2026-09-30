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

function montarPedido(request, contexto) {
  return [
    contexto ?? '',
    'Você está implementando um pedido neste repositório. Você só tem ferramentas de LEITURA: explore o código com Read/Grep/Glob e siga os CLAUDE.md (raiz, api/, web/, .claude/).',
    'Não escreva arquivos. Devolva a mudança como proposta: para cada arquivo criado ou alterado, o conteúdo COMPLETO final em "conteudo" e o caminho relativo à raiz em "path".',
    'Mexa só no necessário para o pedido funcionar. Em "resumo", uma frase do que muda; em "sugestoes", até 5 observações curtas em pt-BR (vazio se não houver).',
    '',
    'PEDIDO:',
    request,
  ].join('\n');
}

const SCHEMA_CORRECAO = {
  type: 'object',
  properties: { conteudo: { type: 'string' } },
  required: ['conteudo'],
};

function montarCorrecao(request, relativo, conteudo, erros) {
  return [
    `Você propôs o arquivo ${relativo} para o pedido abaixo, mas ele não passou na validação do projeto.`,
    'Você só tem ferramentas de LEITURA. Corrija SOMENTE os problemas listados, sem mudar o resto, e devolva o conteúdo COMPLETO final em "conteudo".',
    '',
    'PROBLEMAS:',
    ...erros.map((erro) => `- ${erro}`),
    '',
    'CONTEÚDO ATUAL:',
    conteudo,
    '',
    'PEDIDO ORIGINAL:',
    request,
  ].join('\n');
}

export function chamarClaudeJson({ projectDir, prompt, schema, tools = [], claude }) {
  const args = [
    '-p',
    ...(tools.length > 0 ? ['--tools', ...tools, '--allowedTools', ...tools] : ['--tools', '']),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
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

    child.stdin.end(prompt);
  });
}

export async function planejarLivre({ projectDir, config, request, motivo, printDiff }) {
  if (motivo) {
    console.log(chalk.yellow(`  O pipeline do Ollama não encaixou o pedido (${motivo})`));
  }
  console.log(chalk.magenta('▸ Modo livre: o Claude está lendo o projeto e preparando a mudança…'));
  const claude = config.ai.ollama.claude ?? {};

  const proposta = await chamarClaudeJson({
    projectDir,
    prompt: montarPedido(request, config.ai.ollama.projectContext),
    schema: SCHEMA,
    tools: ['Read', 'Grep', 'Glob'],
    claude,
  });
  const files = [];
  let comProblema = 0;
  const maxRepairs = config.ai.generation.maxRepairs ?? 2;
  const normalizar = (caminho) => path.normalize(caminho).replace(/^(\.\.[/\\])+/, '');
  const virtualFiles = new Map(proposta.arquivos.map((arquivo) => [normalizar(arquivo.path), arquivo.conteudo]));

  console.log();
  console.log(chalk.cyan.bold(proposta.resumo));

  for (const arquivo of proposta.arquivos) {
    const relativo = normalizar(arquivo.path);
    const absoluto = path.join(projectDir, relativo);
    const original = arquivo.acao === 'modify' ? await readFile(absoluto, 'utf8').catch(() => null) : null;

    if (arquivo.acao === 'modify' && original === null) {
      console.log(chalk.red(`  ✗ ${relativo}: o Claude propôs alterar um arquivo que não existe.`));
      comProblema += 1;
      continue;
    }

    const tipado = /\.(ts|tsx)$/.test(relativo);
    const validar = () => (tipado
      ? validateFile({ projectDir, relativePath: relativo, content: arquivo.conteudo, original, virtualFiles })
      : { valid: true, errors: [] });
    let validacao = await validar();

    for (let tentativa = 1; !validacao.valid && tentativa <= maxRepairs; tentativa += 1) {
      console.log(chalk.magenta(`  ▸ ${relativo}: ${validacao.errors.length} problema(s), o Claude está corrigindo (tentativa ${tentativa}/${maxRepairs})…`));
      const correcao = await chamarClaudeJson({
        projectDir,
        prompt: montarCorrecao(request, relativo, arquivo.conteudo, validacao.errors),
        schema: SCHEMA_CORRECAO,
        tools: ['Read', 'Grep', 'Glob'],
        claude,
      }).catch((error) => {
        console.log(chalk.yellow(`    A correção falhou: ${error.message}`));
        return null;
      });
      if (!correcao) break;
      arquivo.conteudo = correcao.conteudo;
      virtualFiles.set(relativo, arquivo.conteudo);
      validacao = await validar();
    }

    console.log();
    console.log(chalk.white.bold(`${arquivo.acao === 'create' ? '+' : '~'} ${relativo}`) + (!tipado ? chalk.dim('  (sem checagem de tipos — revise o diff)') : validacao.valid ? chalk.green('  ✓ tipos ok') : chalk.red('  ✗ com problemas')));
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
