import { access } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { chamarIaJson, quemAtende } from './livre.js';

const LIMITE_PLANO_MS = 300000;

const SCHEMA = {
  type: 'object',
  properties: {
    resumo: { type: 'string' },
    entendimento: { type: 'string' },
    arquivos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          acao: { type: 'string', enum: ['create', 'modify'] },
          oQueMuda: { type: 'string' },
        },
        required: ['path', 'acao', 'oQueMuda'],
      },
    },
    passos: { type: 'array', items: { type: 'string' } },
    riscos: { type: 'array', items: { type: 'string' } },
    foraDoEscopo: { type: 'array', items: { type: 'string' } },
  },
  required: ['resumo', 'entendimento', 'arquivos', 'passos', 'riscos', 'foraDoEscopo'],
};

function montarPrompt(request, contexto) {
  return [
    contexto ?? '',
    'Monte o PLANO de implementação do pedido abaixo neste repositório. NÃO escreva código: só o plano.',
    'Você só tem ferramentas de LEITURA. Leia os CLAUDE.md (raiz, api/, web/, .claude/, db/), um recurso parecido já existente e os arquivos onde ele é registrado; não varra o repositório.',
    'Devolva: "resumo" (uma frase), "entendimento" (2 a 4 frases do que o pedido quer, em pt-BR),',
    '"arquivos" (cada arquivo a criar ou alterar, caminho relativo à raiz, e em "oQueMuda" o que muda nele, em uma ou duas frases),',
    '"passos" (a ordem de implementação), "riscos" (regras do projeto ou efeitos colaterais a cuidar) e "foraDoEscopo" (o que o pedido não cobre ou precisa de confirmação).',
    'Mexa só no necessário para o pedido funcionar.',
    '',
    'PEDIDO:',
    request,
  ].join('\n');
}

export async function criarPlanoGenerico({ projectDir, config, request }) {
  const claude = config.ai.ollama.claude ?? {};
  console.log(chalk.magenta(`▸ Plano genérico: ${quemAtende(config.ai.ollama)} está lendo o projeto e montando o plano (sem escrever código)…`));

  return chamarIaJson({
    ollama: config.ai.ollama,
    projectDir,
    prompt: montarPrompt(request, config.ai.ollama.projectContext),
    schema: SCHEMA,
    tools: ['Read', 'Grep', 'Glob'],
    claude: { ...claude, timeoutMs: Math.min(claude.timeoutMs ?? LIMITE_PLANO_MS, LIMITE_PLANO_MS) },
    esforco: 'low',
  });
}

async function existe(arquivo) {
  return access(arquivo).then(() => true, () => false);
}

export async function validarPlanoGenerico(projectDir, plano) {
  const errors = [];
  const warnings = [];

  if (plano.arquivos.length === 0) {
    errors.push('O plano não lista nenhum arquivo. Use detro plan --ajustar para dizer o que criar ou alterar.');
  }

  for (const arquivo of plano.arquivos) {
    const relativo = path.normalize(arquivo.path);

    if (path.isAbsolute(relativo) || relativo.startsWith('..')) {
      errors.push(`${arquivo.path}: o caminho precisa ser relativo à raiz do projeto.`);
      continue;
    }

    const presente = await existe(path.join(projectDir, relativo));

    if (arquivo.acao === 'modify' && !presente) {
      errors.push(`${arquivo.path}: o plano altera um arquivo que não existe. Troque para "create" ou corrija o caminho.`);
    }
    if (arquivo.acao === 'create' && presente) {
      errors.push(`${arquivo.path}: o plano cria um arquivo que já existe. Troque para "modify" ou escolha outro nome.`);
    }
  }

  if (plano.foraDoEscopo.length > 0) {
    warnings.push(`${plano.foraDoEscopo.length} item(ns) fora do escopo ou a confirmar (listados acima).`);
  }

  return { errors, warnings };
}

export function mostrarPlanoGenerico(plano, { errors, warnings }) {
  console.log();
  console.log(chalk.cyan.bold('Plano genérico:'));
  console.log(`  ${chalk.white.bold(plano.resumo)}`);
  console.log(chalk.dim(`  ${plano.entendimento}`));

  console.log();
  console.log(chalk.cyan.bold('Arquivos:'));
  for (const arquivo of plano.arquivos) {
    console.log(`  ${arquivo.acao === 'create' ? chalk.green('+') : chalk.cyan('~')} ${arquivo.path} ${chalk.dim(`— ${arquivo.oQueMuda}`)}`);
  }

  const secoes = [['Passos:', plano.passos, chalk.white], ['Riscos:', plano.riscos, chalk.yellow], ['Fora do escopo / a confirmar:', plano.foraDoEscopo, chalk.yellow]];
  for (const [titulo, itens, cor] of secoes) {
    if (itens.length === 0) continue;
    console.log();
    console.log(chalk.cyan.bold(titulo));
    itens.forEach((item, i) => console.log(cor(`  ${i + 1}. ${item}`)));
  }

  for (const [titulo, itens, cor, marca] of [['Avisos:', warnings, chalk.yellow, '!'], ['Problemas que impedem o apply:', errors, chalk.red, '✗']]) {
    if (itens.length === 0) continue;
    console.log();
    console.log(cor.bold(titulo));
    itens.forEach((item) => console.log(cor(`    ${marca} ${item}`)));
  }
}

export function pedidoComPlano(request, plano) {
  return [
    request,
    '',
    'PLANO APROVADO PELO USUÁRIO (siga exatamente: crie e altere só estes arquivos, do jeito descrito):',
    JSON.stringify(plano, null, 2),
  ].join('\n');
}
