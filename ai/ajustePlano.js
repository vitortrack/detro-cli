import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { chamarClaudeJson } from './livre.js';
import { saveLastPlan } from './planStore.js';

const SCHEMA = {
  type: 'object',
  properties: {
    analise: { type: 'string' },
    manter: { type: 'array', items: { type: 'string' } },
    mudar: { type: 'array', items: { type: 'string' } },
    specJson: { type: 'string' },
  },
  required: ['analise', 'manter', 'mudar', 'specJson'],
};

function montarPrompt({ plan, errors, warnings, unsupported, contexto }) {
  return [
    contexto ?? '',
    'O gerador "detro" montou o plano de um cadastro CRUD neste repositório e a validação apontou os itens abaixo.',
    'Você só tem ferramentas de LEITURA: explore o código com Read/Grep/Glob e siga os CLAUDE.md (raiz, api/, web/, .claude/, db/).',
    'Descubra se o conflito é um cadastro que já existe (então o plano deve ser outro nome ou nem ser feito) ou só colisão de nome, e proponha a melhor solução.',
    'Devolva: "analise" (2 a 4 frases em pt-BR), "manter" (o que do plano atual está certo e deve ficar), "mudar" (cada troca proposta e o porquê),',
    'e "specJson" com o objeto "spec" COMPLETO ajustado, no mesmo formato do atual (mesmas chaves), serializado como JSON. Se a melhor solução for não criar o cadastro, devolva o spec atual sem mudanças e diga isso em "analise".',
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

export async function oferecerAjusteClaude({ projectDir, config, plan, errors = [], warnings = [], unsupported = [] }) {
  const claude = config.ai.ollama.claude ?? {};
  if (claude.enabled === false || !process.stdin.isTTY) return false;
  if (errors.length + warnings.length + unsupported.length === 0) return false;

  console.log();
  const pedir = await confirm({ message: 'Perguntar ao Claude a melhor solução para esse plano?', default: errors.length > 0 });
  if (!pedir) return false;

  console.log(chalk.magenta('▸ O Claude está lendo o projeto e o plano…'));
  const resposta = await chamarClaudeJson({
    projectDir,
    prompt: montarPrompt({ plan, errors, warnings, unsupported, contexto: config.ai.ollama.projectContext }),
    schema: SCHEMA,
    tools: ['Read', 'Grep', 'Glob'],
    claude,
  });

  let spec;
  try {
    spec = JSON.parse(resposta.specJson);
  } catch (error) {
    throw new Error(`O Claude devolveu um spec que não é JSON válido (${error.message}). Rode detro plan --revalidar para tentar de novo.`);
  }

  console.log();
  console.log(chalk.magenta.bold('Análise do Claude:'));
  console.log(`  ${resposta.analise}`);
  if (resposta.manter.length > 0) {
    console.log(chalk.green.bold('Manter:'));
    resposta.manter.forEach((item) => console.log(chalk.green(`  ✓ ${item}`)));
  }
  if (resposta.mudar.length > 0) {
    console.log(chalk.yellow.bold('Mudar:'));
    resposta.mudar.forEach((item) => console.log(chalk.yellow(`  ~ ${item}`)));
  }

  if (JSON.stringify(spec) === JSON.stringify(plan.spec)) {
    console.log(chalk.dim('  O Claude não propôs mudança no plano.'));
    return false;
  }

  console.log();
  const aplicar = await confirm({ message: 'Salvar o plano ajustado e revalidar?', default: true });
  if (!aplicar) {
    console.log(chalk.dim('Plano mantido como estava.'));
    return false;
  }

  await saveLastPlan({ projectDir, request: plan.request, spec, requirements: plan.requirements ?? [], createdAt: plan.createdAt });
  return true;
}
