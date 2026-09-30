import { checkbox, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { chamarClaudeJson } from './livre.js';
import { saveLastPlan } from './planStore.js';

const SCHEMA = {
  type: 'object',
  properties: {
    analise: { type: 'string' },
    manter: { type: 'array', items: { type: 'string' } },
    mudancas: {
      type: 'array',
      items: {
        type: 'object',
        properties: { descricao: { type: 'string' }, motivo: { type: 'string' } },
        required: ['descricao', 'motivo'],
      },
    },
    specJson: { type: 'string' },
  },
  required: ['analise', 'manter', 'mudancas', 'specJson'],
};

function montarPrompt({ plan, errors, warnings, unsupported, contexto, orientacao }) {
  return [
    contexto ?? '',
    'O gerador "detro" montou o plano de um cadastro CRUD neste repositório e a validação apontou os itens abaixo.',
    'Você só tem ferramentas de LEITURA: explore o código com Read/Grep/Glob e siga os CLAUDE.md (raiz, api/, web/, .claude/, db/). Leia só o necessário para decidir.',
    'Descubra se o conflito é um cadastro que já existe (então o plano deve ser outro nome ou nem ser feito) ou só colisão de nome, e proponha a melhor solução.',
    'Devolva: "analise" (2 a 4 frases em pt-BR), "manter" (o que do plano atual está certo e deve ficar),',
    '"mudancas" (cada troca proposta, independente das outras, com "descricao" curta e "motivo"),',
    'e "specJson" com o objeto "spec" COMPLETO já com TODAS as mudanças aplicadas, no mesmo formato do atual (mesmas chaves), serializado como JSON.',
    'Se a melhor solução for não criar o cadastro, devolva o spec atual sem mudanças e diga isso em "analise".',
    ...(orientacao ? ['', 'ORIENTAÇÃO DO USUÁRIO (tem prioridade sobre a sua proposta):', orientacao] : []),
    '',
    'PEDIDO ORIGINAL:',
    plan.request,
    '',
    'SPEC ATUAL:',
    JSON.stringify(plan.spec, null, 2),
    '',
    `ERROS: ${JSON.stringify(errors)}`,
    `AVISOS: ${JSON.stringify(warnings)}`,
    `NÃO COBERTO: ${JSON.stringify(unsupported)}`,
  ].join('\n');
}

async function perguntarAoClaude({ projectDir, config, orientacao, ...contexto }) {
  console.log(chalk.magenta('▸ O Claude está lendo o projeto e o plano… (pode levar alguns minutos)'));
  const resposta = await chamarClaudeJson({
    projectDir,
    prompt: montarPrompt({ ...contexto, contexto: config.ai.ollama.projectContext, orientacao }),
    schema: SCHEMA,
    tools: ['Read', 'Grep', 'Glob'],
    claude: config.ai.ollama.claude ?? {},
  });

  try {
    return { ...resposta, spec: JSON.parse(resposta.specJson) };
  } catch (error) {
    throw new Error(`O Claude devolveu um spec que não é JSON válido (${error.message}). Rode detro plan --revalidar para tentar de novo.`);
  }
}

function mostrarResposta(resposta) {
  console.log();
  console.log(chalk.magenta.bold('Análise do Claude:'));
  console.log(`  ${resposta.analise}`);
  if (resposta.manter.length > 0) {
    console.log(chalk.green.bold('Manter:'));
    resposta.manter.forEach((item) => console.log(chalk.green(`  ✓ ${item}`)));
  }
  if (resposta.mudancas.length > 0) {
    console.log(chalk.yellow.bold('Mudanças propostas:'));
    resposta.mudancas.forEach((item, i) => console.log(chalk.yellow(`  ${i + 1}. ${item.descricao}`) + chalk.dim(` — ${item.motivo}`)));
  }
  console.log();
}

async function salvar({ projectDir, plan, spec }) {
  await saveLastPlan({ projectDir, request: plan.request, spec, requirements: plan.requirements ?? [], createdAt: plan.createdAt });
  return { acao: 'revalidar' };
}

export async function oferecerAjusteClaude({ projectDir, config, plan, errors = [], warnings = [], unsupported = [] }) {
  if (config.ai.ollama.claude?.enabled === false || !process.stdin.isTTY) return null;
  if (errors.length + warnings.length + unsupported.length === 0) return null;

  console.log();
  const inicio = await select({
    message: 'O que fazer com esse plano?',
    default: errors.length > 0 ? 'claude' : 'seguir',
    choices: [
      { name: 'Perguntar ao Claude a melhor solução', value: 'claude' },
      { name: 'Reformular o pedido (o detro interpreta de novo)', value: 'reformular' },
      { name: 'Seguir com o plano como está', value: 'seguir' },
    ],
  });

  if (inicio === 'seguir') return null;
  if (inicio === 'reformular') return { acao: 'replanejar', pedido: await input({ message: 'Novo pedido:', default: plan.request, required: true }) };

  const contexto = { plan, errors, warnings, unsupported };
  let orientacao;

  for (;;) {
    const resposta = await perguntarAoClaude({ projectDir, config, orientacao, ...contexto });
    mostrarResposta(resposta);

    const semMudanca = resposta.mudancas.length === 0 || JSON.stringify(resposta.spec) === JSON.stringify(plan.spec);
    const escolha = await select({
      message: 'E agora?',
      choices: [
        ...(semMudanca ? [] : [
          { name: 'Aplicar todas as mudanças e revalidar', value: 'todas' },
          { name: 'Escolher quais mudanças aplicar', value: 'escolher' },
        ]),
        { name: 'Orientar o Claude (manter/remover algo, outra ideia) e perguntar de novo', value: 'orientar' },
        { name: 'Reformular o pedido (o detro interpreta de novo)', value: 'reformular' },
        { name: 'Manter o plano como estava', value: 'manter' },
      ],
    });

    if (escolha === 'manter') {
      console.log(chalk.dim('Plano mantido como estava.'));
      return null;
    }
    if (escolha === 'todas') return salvar({ projectDir, plan, spec: resposta.spec });
    if (escolha === 'reformular') return { acao: 'replanejar', pedido: await input({ message: 'Novo pedido:', default: plan.request, required: true }) };

    if (escolha === 'orientar') {
      orientacao = await input({ message: 'Orientação para o Claude:', required: true });
      continue;
    }

    const aceitas = await checkbox({
      message: 'Mudanças a aplicar (espaço marca/desmarca):',
      choices: resposta.mudancas.map((item, i) => ({ name: item.descricao, value: i, checked: true })),
    });

    if (aceitas.length === resposta.mudancas.length) return salvar({ projectDir, plan, spec: resposta.spec });
    if (aceitas.length === 0) {
      console.log(chalk.dim('Nenhuma mudança marcada; plano mantido como estava.'));
      return null;
    }

    const recusadas = resposta.mudancas.filter((_, i) => !aceitas.includes(i));
    orientacao = [
      'Aplique SOMENTE estas mudanças:',
      ...aceitas.map((i) => `- ${resposta.mudancas[i].descricao}`),
      'NÃO aplique estas (o usuário recusou; mantenha o spec atual nesses pontos):',
      ...recusadas.map((item) => `- ${item.descricao}`),
    ].join('\n');
  }
}
