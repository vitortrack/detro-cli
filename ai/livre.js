import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { sha256 } from './generator.js';
import { saveImplementation } from './implementationStore.js';
import { validateFile } from './validator.js';
import { applyEdits } from './editor.js';
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
          edicoes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { find: { type: 'string' }, replace: { type: 'string' } },
              required: ['find', 'replace'],
            },
          },
        },
        required: ['path', 'acao', 'conteudo', 'edicoes'],
      },
    },
    sugestoes: { type: 'array', items: { type: 'string' } },
  },
  required: ['resumo', 'arquivos', 'sugestoes'],
};

const FOCO_NORMAL = 'Seja objetivo na leitura: os CLAUDE.md, um recurso parecido já existente como modelo e os arquivos onde ele é registrado (rotas, menu, módulos). Não varra o repositório.';
const FOCO_ENXUTO = 'A tentativa anterior demorou demais. Leia no máximo 5 arquivos (um modelo parecido e onde ele é registrado) e entregue a versão MÍNIMA que atende o pedido: prefira criar arquivos novos e altere arquivos existentes só para registrar a tela (rota, menu). O que ficar de fora vai em "sugestoes".';

const REGRA_EDICOES = 'Cada "find" é um trecho copiado EXATAMENTE do arquivo (mesmos espaços e quebras de linha), de 1 a 8 linhas, que apareça UMA única vez; "replace" é o mesmo trecho já alterado. Para inserir, use como "find" a linha vizinha e repita-a no "replace" junto com o código novo.';

function montarPedido(request, contexto, foco = FOCO_NORMAL) {
  return [
    contexto ?? '',
    'Você está implementando um pedido neste repositório. Você só tem ferramentas de LEITURA: explore o código com Read/Grep/Glob e siga os CLAUDE.md (raiz, api/, web/, .claude/).',
    foco,
    'Não escreva arquivos. Devolva a mudança como proposta, com o caminho relativo à raiz em "path":',
    '- arquivo NOVO (acao "create"): o conteúdo completo em "conteudo" e "edicoes" vazio;',
    `- arquivo EXISTENTE (acao "modify"): "conteudo" vazio e, em "edicoes", só os trechos alterados. ${REGRA_EDICOES} NUNCA devolva o arquivo existente inteiro.`,
    'Mexa só no necessário para o pedido funcionar. Em "resumo", uma frase do que muda; em "sugestoes", até 5 observações curtas em pt-BR (vazio se não houver).',
    '',
    'PEDIDO:',
    request,
  ].join('\n');
}

const SCHEMA_CORRECAO = {
  type: 'object',
  properties: { conteudo: { type: 'string' }, edicoes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { find: { type: 'string' }, replace: { type: 'string' } },
          required: ['find', 'replace'],
        },
      } },
  required: ['conteudo', 'edicoes'],
};

function montarCorrecao(request, relativo, conteudo, erros, novo) {
  return [
    `Você propôs o arquivo ${relativo} para o pedido abaixo, mas ele não passou na validação do projeto.`,
    'Você só tem ferramentas de LEITURA. Corrija SOMENTE os problemas listados, sem mudar o resto.',
    novo
      ? 'Devolva o conteúdo COMPLETO final em "conteudo" e "edicoes" vazio.'
      : `Devolva "conteudo" vazio e, em "edicoes", só as trocas necessárias sobre o CONTEÚDO ATUAL abaixo. ${REGRA_EDICOES}`,
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

export const quemAtende = (ollama) => (ollama?.agente ? `o agente (${ollama.model})` : 'o Claude');

export async function chamarIaJson({ ollama, ...pedido }) {
  if (ollama?.agente) {
    process.stderr.write(`  ▸ agente ${ollama.model} lendo o projeto…\n`);
    try {
      return await chamarClaudeJson({ ...pedido, claude: { ...pedido.claude, model: ollama.model }, ollamaUrl: ollama.baseUrl });
    } catch (error) {
      if (pedido.claude?.enabled === false) throw error;
      process.stderr.write(`\n  ↑ agente: ${error.message} — chamando o Claude…\n`);
    }
  }
  return chamarClaudeJson(pedido);
}

function chamarClaudeJson({ projectDir, prompt, schema, tools = [], claude, esforco, ollamaUrl }) {
  const args = [
    '-p',
    ...(tools.length > 0 ? ['--tools', ...tools, '--allowedTools', ...tools] : ['--tools', '']),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--no-session-persistence',
    '--setting-sources', 'project',
  ];
  if (claude.model) args.push('--model', claude.model);
  if (esforco) args.push('--effort', esforco);

  const env = { ...process.env };
  if (!claude.usarApiKey) delete env.ANTHROPIC_API_KEY;
  if (ollamaUrl) Object.assign(env, { ANTHROPIC_BASE_URL: ollamaUrl.replace(/\/$/, ''), ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '' });

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: projectDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const limiteMs = claude.timeoutMs ?? 600000;
    const inicio = Date.now();
    let estourou = false;
    const timer = setTimeout(() => {
      estourou = true;
      parar();
      child.kill('SIGTERM');
      child.stdout.destroy();
      child.stderr.destroy();
      reject(Object.assign(new Error(`O Claude passou de ${Math.round(limiteMs / 60000)} min sem terminar (ajuste ai.ollama.claude.timeoutMs em .detro/config.json se precisar de mais tempo).`), { code: 'CLAUDE_TIMEOUT' }));
    }, limiteMs);
    const aviso = process.stdout.isTTY
      ? setInterval(() => console.log(chalk.dim(`  … o Claude está trabalhando há ${Math.round((Date.now() - inicio) / 60000)} min (limite ${Math.round(limiteMs / 60000)} min)`)), 60000)
      : null;
    const parar = () => {
      clearTimeout(timer);
      if (aviso) clearInterval(aviso);
    };

    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      parar();
      if (estourou) return;
      reject(new Error(`Não foi possível executar o Claude Code (${error.message}).`));
    });
    child.on('close', (code) => {
      parar();
      if (estourou) return;
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

export async function planejarLivre({ projectDir, config, request, motivo, printDiff, planHash }) {
  if (motivo) {
    console.log(chalk.yellow(`  O pipeline do Ollama não encaixou o pedido (${motivo})`));
  }
  console.log(chalk.magenta(`▸ Modo livre: ${quemAtende(config.ai.ollama)} está lendo o projeto e preparando a mudança…`));
  const claude = config.ai.ollama.claude ?? {};

  const pedir = (foco) => chamarIaJson({
    ollama: config.ai.ollama,
    projectDir,
    prompt: montarPedido(request, config.ai.ollama.projectContext, foco),
    schema: SCHEMA,
    tools: ['Read', 'Grep', 'Glob'],
    claude,
  });
  const proposta = await pedir(FOCO_NORMAL).catch((error) => {
    console.log(chalk.yellow(`  ${error.message}`));
    console.log(chalk.magenta('▸ Tentando de novo com uma versão mínima do pedido…'));
    return pedir(FOCO_ENXUTO);
  });
  const files = [];
  let comProblema = 0;
  const maxRepairs = config.ai.generation.maxRepairs ?? 2;
  const normalizar = (caminho) => path.normalize(caminho).replace(/^(\.\.[/\\])+/, '');
  const originais = new Map();

  for (const arquivo of proposta.arquivos) {
    if (arquivo.acao !== 'modify') continue;
    const relativo = normalizar(arquivo.path);
    const original = await readFile(path.join(projectDir, relativo), 'utf8').catch(() => null);
    originais.set(relativo, original);
    if (original === null || ((arquivo.edicoes ?? []).length === 0 && arquivo.conteudo)) continue;
    const aplicado = applyEdits(original, arquivo.edicoes ?? []);
    arquivo.conteudo = aplicado.content;
    arquivo.problemasEdicao = aplicado.problems;
  }

  const virtualFiles = new Map(proposta.arquivos.map((arquivo) => [normalizar(arquivo.path), arquivo.conteudo]));

  console.log();
  console.log(chalk.cyan.bold(proposta.resumo));

  for (const arquivo of proposta.arquivos) {
    const relativo = normalizar(arquivo.path);
    const original = arquivo.acao === 'modify' ? originais.get(relativo) ?? null : null;

    if (arquivo.acao === 'modify' && original === null) {
      console.log(chalk.red(`  ✗ ${relativo}: a proposta altera um arquivo que não existe.`));
      comProblema += 1;
      continue;
    }

    const tipado = /\.(ts|tsx)$/.test(relativo);
    const validar = async () => {
      const tipos = tipado
        ? await validateFile({ projectDir, relativePath: relativo, content: arquivo.conteudo, original, virtualFiles })
        : { valid: true, errors: [] };
      const edicao = arquivo.problemasEdicao ?? [];
      return edicao.length > 0 ? { valid: false, errors: [...edicao, ...tipos.errors] } : tipos;
    };
    let validacao = await validar();

    for (let tentativa = 1; !validacao.valid && tentativa <= maxRepairs; tentativa += 1) {
      console.log(chalk.magenta(`  ▸ ${relativo}: ${validacao.errors.length} problema(s), ${quemAtende(config.ai.ollama)} está corrigindo (tentativa ${tentativa}/${maxRepairs})…`));
      const correcao = await chamarIaJson({
        ollama: config.ai.ollama,
        projectDir,
        prompt: montarCorrecao(request, relativo, arquivo.conteudo, validacao.errors, arquivo.acao === 'create'),
        schema: SCHEMA_CORRECAO,
        tools: ['Read', 'Grep', 'Glob'],
        claude,
      }).catch((error) => {
        console.log(chalk.yellow(`    A correção falhou: ${error.message}`));
        return null;
      });
      if (!correcao) break;
      if (arquivo.acao === 'modify' && (correcao.edicoes ?? []).length > 0) {
        const aplicado = applyEdits(arquivo.conteudo, correcao.edicoes);
        arquivo.conteudo = aplicado.content;
        arquivo.problemasEdicao = aplicado.problems;
      } else if (correcao.conteudo) {
        arquivo.conteudo = correcao.conteudo;
        arquivo.problemasEdicao = [];
      }
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
    implementation: { kind: 'livre', createdAt: new Date().toISOString(), request, files, migration: null, services, ...(planHash ? { planHash } : {}) },
  });

  console.log();
  console.log(chalk.dim(`Proposta salva em: ${filePath}`));
  console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));
  console.log(comProblema > 0
    ? chalk.red(`${comProblema} arquivo(s) com problema. Revise antes de aplicar ou peça de novo com mais detalhes.`)
    : chalk.cyan('Próximo passo: detro apply'));
  return comProblema > 0 ? 1 : 0;
}
