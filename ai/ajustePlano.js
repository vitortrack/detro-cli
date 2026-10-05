import { checkbox, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { chamarIaJson } from './livre.js';
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

const eGenerico = (plan) => plan.recipe === 'generico';
const objetoDoPlano = (plan) => (eGenerico(plan) ? plan.generic : plan.spec);

function montarPrompt({ plan, errors, warnings, unsupported, contexto, orientacao }) {
  return [
    contexto ?? '',
    eGenerico(plan)
      ? 'O gerador "detro" montou um plano genérico (arquivos a criar ou alterar e passos) para um pedido neste repositório, e a validação apontou os itens abaixo.'
      : 'O gerador "detro" montou o plano de um cadastro CRUD neste repositório e a validação apontou os itens abaixo.',
    'Os ERROS abaixo já dizem onde está cada conflito (arquivo e motivo). Decida a partir deles e do SPEC; leia no máximo 3 arquivos, e só se precisar confirmar algo. Não explore o repositório.',
    eGenerico(plan)
      ? 'Proponha a melhor solução mantendo o plano o mais próximo possível do pedido.'
      : 'Descubra se o conflito é um cadastro que já existe (então o plano deve ser outro nome ou nem ser feito) ou só colisão de nome, e proponha a melhor solução.',
    'Devolva: "analise" (2 a 4 frases em pt-BR), "manter" (o que do plano atual está certo e deve ficar),',
    '"mudancas" (cada troca proposta, independente das outras, com "descricao" curta e "motivo"),',
    'e "specJson" com o objeto "spec" COMPLETO já com TODAS as mudanças aplicadas, no mesmo formato do atual (mesmas chaves), serializado como JSON.',
    'Se a melhor solução for não criar o cadastro, devolva o spec atual sem mudanças e diga isso em "analise".',
    ...(orientacao ? ['', 'ORIENTAÇÃO DO USUÁRIO (tem prioridade sobre a sua proposta; mude só o que ela pede e mantenha o resto do spec igual):', orientacao] : []),
    '',
    'PEDIDO ORIGINAL:',
    plan.request,
    '',
    eGenerico(plan) ? 'PLANO ATUAL:' : 'SPEC ATUAL:',
    JSON.stringify(objetoDoPlano(plan), null, 2),
    '',
    `ERROS: ${JSON.stringify(errors)}`,
    `AVISOS: ${JSON.stringify(warnings)}`,
    `NÃO COBERTO: ${JSON.stringify(unsupported)}`,
  ].join('\n');
}

const LIMITE_AJUSTE_MS = 180000;

async function perguntarAoClaude({ projectDir, config, orientacao, ...contexto }) {
  const claude = config.ai.ollama.claude ?? {};
  const pedir = (tools) => chamarIaJson({
    ollama: config.ai.ollama,
    projectDir,
    prompt: montarPrompt({ ...contexto, contexto: config.ai.ollama.projectContext, orientacao }),
    schema: SCHEMA,
    tools,
    claude: { ...claude, timeoutMs: Math.min(claude.timeoutMs ?? LIMITE_AJUSTE_MS, LIMITE_AJUSTE_MS) },
    esforco: 'low',
  });

  console.log(chalk.magenta('▸ O Claude está analisando o plano…'));
  const resposta = await pedir(['Read', 'Grep', 'Glob']).catch((error) => {
    console.log(chalk.yellow(`  ${error.message}`));
    console.log(chalk.magenta('▸ Tentando de novo só com o plano e os erros, sem ler o projeto…'));
    return pedir([]);
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

function pedidoDaProposta(pedido, resposta) {
  return [
    pedido,
    '',
    'Solução já definida na análise do plano (siga esta, não crie cadastro novo):',
    resposta.analise,
    ...resposta.manter.map((item) => `- Manter: ${item}`),
    ...resposta.mudancas.map((item) => `- ${item.descricao} (${item.motivo})`),
  ].join('\n');
}

async function salvar({ projectDir, plan, spec }) {
  await saveLastPlan(eGenerico(plan)
    ? { projectDir, request: plan.request, recipe: 'generico', generic: spec, createdAt: plan.createdAt }
    : { projectDir, request: plan.request, spec, requirements: plan.requirements ?? [], createdAt: plan.createdAt });
  return { acao: 'revalidar' };
}

export async function oferecerAjusteClaude({ projectDir, config, plan, errors = [], warnings = [], unsupported = [], sempre = false }) {
  if (config.ai.ollama.claude?.enabled === false || !process.stdin.isTTY) return null;
  if (!sempre && errors.length + warnings.length + unsupported.length === 0) return null;

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

  return conversarComClaude({ projectDir, config, plan, errors, warnings, unsupported });
}

export function ajustarPlano({ projectDir, config, plan, instrucao, errors = [], warnings = [], unsupported = [] }) {
  return conversarComClaude({ projectDir, config, plan, errors, warnings, unsupported, orientacao: instrucao });
}

async function conversarComClaude({ projectDir, config, plan, errors, warnings, unsupported, orientacao }) {
  const contexto = { plan, errors, warnings, unsupported };

  for (;;) {
    const resposta = await perguntarAoClaude({ projectDir, config, orientacao, ...contexto });
    mostrarResposta(resposta);

    const semMudanca = resposta.mudancas.length === 0 || JSON.stringify(resposta.spec) === JSON.stringify(objetoDoPlano(plan));
    const propostaForaDoSpec = semMudanca && resposta.mudancas.length > 0;
    const escolha = await select({
      message: 'E agora?',
      choices: [
        ...(semMudanca ? [] : [
          { name: 'Aplicar todas as mudanças e revalidar', value: 'todas' },
          { name: 'Escolher quais mudanças aplicar', value: 'escolher' },
        ]),
        ...(propostaForaDoSpec ? [{ name: 'Seguir com a proposta do Claude (o detro monta o plano a partir dela)', value: 'proposta' }] : []),
        ...(resposta.mudancas.length === 0 ? [{ name: 'Confirmar o plano e seguir', value: 'manter' }] : []),
        { name: 'Orientar o Claude (manter/remover algo, outra ideia) e perguntar de novo', value: 'orientar' },
        { name: 'Reformular o pedido (o detro interpreta de novo)', value: 'reformular' },
        ...(resposta.mudancas.length > 0 ? [{ name: 'Manter o plano como estava', value: 'manter' }] : []),
      ],
    });

    if (escolha === 'manter') {
      console.log(chalk.dim(resposta.mudancas.length === 0 ? 'Plano confirmado.' : 'Plano mantido como estava.'));
      return null;
    }
    if (escolha === 'proposta') return { acao: 'generico', pedido: pedidoDaProposta(plan.request, resposta) };
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
