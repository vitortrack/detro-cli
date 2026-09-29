import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadDetroConfig, requireOllama, saveDetroConfig } from './config.js';
import { applyMigration, findAppScript, findPostgresContainer, restartServices } from './devEnvironment.js';
import { unifiedDiff } from './diff.js';
import { planejarLivre } from './livre.js';
import { prepareFix } from './fixer.js';
import { generateCrud, prepareSpec, sha256 } from './generator.js';
import { loadImplementation, markImplementationApplied, saveAttempt, saveImplementation } from './implementationStore.js';
import { applyImplementation } from './implementationWriter.js';
import { listOllamaModels, ollamaChat } from './ollama.js';
import { createPlan, finishCoverage } from './planner.js';
import { loadLastPlan, saveLastPlan } from './planStore.js';
import { resolveTargets, runCheck } from './review.js';
import { runSelftest } from './selftest.js';
import { detectProfile } from './profile.js';
import { planMenuOperation, readMenu } from './menu.js';
import { prepareEdit, prepareLiteralEdit } from './editor.js';
import { resolveTargets as resolveEditTargets } from './targets.js';
import { generateQuery, prepareQuerySpec } from './queryGenerator.js';
import { generateByExample, planExampleFiles } from './exampleGenerator.js';
import { generatePage, preparePageSpec } from './page.js';
import { describeQuerySpec } from './querySpec.js';
import { workspaceOf } from './typescript.js';
import { describeSpec } from './spec.js';

const RULE = '─'.repeat(60);

function printAiUsage() {
  console.log(`
Uso:

  detro ai status                 Conexão com o Ollama e modelo atual
  detro ai models                 Modelos instalados
  detro ai model <nome>           Troca o modelo (ex.: qwen2.5-coder:14b)
  detro ai ctx <tokens>           Tamanho do contexto enviado ao Ollama (padrão 24576)
  detro ai ask <pergunta>         Pergunta livre ao modelo
  detro ai selftest               Autoteste sem IA: templates e patches compilam no projeto
  detro ai perfil                 Stack, convenções e o que o detro consegue fazer neste projeto

  detro plan "<pedido>"           Entende o pedido e prepara o plano (.detro/last-plan.json):
                                  - cadastro novo: "cadastro de garagens com nome e endereço"
                                  - ajuste de menu: "mova Tipos de ocorrência para Rotas e operação"
                                  - mudança/correção numa tela: "na tela de Paradas, mostrar a coluna código"

  detro plan --livre "<pedido>"   Pedido livre direto ao Claude (lê o projeto, propõe a mudança;
                                  também é usado quando o pipeline do Ollama não encaixa o pedido)
  detro plan -f pedido.md         Idem, lendo de um arquivo (pasta atual, raiz ou .detro/pedidos/).
                                  Aceita lista em tópicos ou documento com seções (## Dados,
                                  ## Restrições...). "somente em memória"/"sem backend" gera
                                  só o frontend; nomes, título, botão e ações pedidos são seguidos.
  detro plan --revalidar          Revalida o plano depois de editar o JSON à mão
  detro apply --dry-run           Gera e valida o código, sem escrever no projeto
  detro apply                     Escreve o que o último dry-run (ou fix) preparou e oferece
                                  aplicar a migration no banco de dev e rebuildar api/web
  detro apply --sim               Idem, aceitando os passos sem perguntar
              --sem-banco / --sem-restart   pula a migration ou o rebuild

  detro check [arquivos...]       Tipos + regras do projeto (padrão: arquivos alterados no git)
  detro check --ia [arquivos...]  Idem, mais revisão de falhas de lógica pelo modelo
  detro check --tudo              Todos os arquivos de api/ e web/ (sem --ia)
  detro fix <arquivo>             Pede ao modelo a correção dos erros do arquivo (depois: detro apply)

  detro lote <pedidos...>         Roda vários pedidos de mudança pontual em sequência, um arquivo por
                                  pedido (aceita curinga: detro lote "erros-*.md"). O modelo tenta
                                  primeiro; se falhar e o pedido tiver "Trecho atual"/"Trecho novo",
                                  aplica os trechos literalmente. Escreve no projeto ao final.
  detro lote --dry-run ...        Idem, só mostrando os diffs, sem escrever
`);
}

function requireText(parts, example) {
  const text = parts.join(' ').trim();

  if (!text) {
    throw new Error(`Informe um texto. Exemplo: ${example}`);
  }

  return text;
}

function createProgress() {
  const tty = process.stdout.isTTY;
  let active = false;

  function clear() {
    if (tty && active) {
      process.stdout.write('\r\x1b[2K');
      active = false;
    }
  }

  return {
    update(text) {
      if (!tty) {
        return;
      }

      process.stdout.write(`\r\x1b[2K${chalk.dim(text)}`);
      active = true;
    },
    log(...args) {
      clear();
      console.log(...args);
    },
    clear,
  };
}

function printList(items, color, symbol) {
  for (const item of items) {
    console.log(color(`    ${symbol} ${item}`));
  }
}

function eventPrinter(progress) {
  let currentAttempt = 1;

  return (event) => {
    switch (event.type) {
      case 'stage':
        progress.log(chalk.magenta(`\n▸ ${event.message}`));
        break;
      case 'warning':
        progress.log(chalk.yellow(`  ! ${event.message}`));
        break;
      case 'generating':
        currentAttempt = event.attempt;
        progress.update(`  gerando ${event.path}${event.attempt > 1 ? ` (correção ${event.attempt - 1})` : ''}...`);
        break;
      case 'progress':
        progress.update(`  ${event.path ?? event.file}${currentAttempt > 1 ? ` (correção ${currentAttempt - 1})` : ''} — ${event.tokens} tokens`);
        break;
      case 'autofix':
        progress.log(chalk.dim(`  ↺ ${event.path}: ${event.applied.length} correção(ões) automática(s) do TypeScript`));
        break;
      case 'reviewing':
        progress.update(`  revisando ${event.file} a partir da linha ${event.startLine}...`);
        break;
      case 'fix-attempt':
        progress.log(event.remaining === 0
          ? chalk.green(`  ✓ tentativa ${event.attempt}: sem problemas restantes`)
          : chalk.yellow(`  ~ tentativa ${event.attempt}: ${event.remaining} problema(s) restante(s)`));
        printList((event.problems ?? []).slice(0, 3).map((item) => String(item).slice(0, 200)), chalk.dim, '·');
        break;
      case 'validated': {
        const { validation } = event;

        if (validation.valid) {
          progress.log(chalk.green(`  ✓ ${event.path}`));
        } else {
          progress.log(chalk.red(`  ✗ ${event.path}`));
          printList(validation.errors.slice(0, 12), chalk.red, '-');

          if (validation.errors.length > 12) {
            console.log(chalk.red(`    ... e mais ${validation.errors.length - 12}`));
          }
        }

        printList(validation.warnings, chalk.yellow, '!');
        break;
      }
      default:
        break;
    }
  };
}

function printDiff(before, after) {
  const hunks = unifiedDiff(before, after);

  if (hunks === null) {
    console.log(chalk.dim('    (diff grande demais para exibir; confira com git diff depois do apply)'));
    return;
  }

  for (const hunk of hunks) {
    console.log(chalk.cyan(`    ${hunk.header}`));

    for (const line of hunk.lines) {
      const color = line.type === '+' ? chalk.green : line.type === '-' ? chalk.red : chalk.dim;
      console.log(color(`    ${line.type}${line.text}`));
    }
  }
}

export async function runAiCommand({ projectDir, args }) {
  const [subcommand, ...rest] = args;
  const config = await loadDetroConfig(projectDir);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printAiUsage();
    return 0;
  }

  if (subcommand === 'provider') {
    if (rest[0] !== 'ollama') {
      throw new Error('O único provider suportado é: ollama');
    }

    config.ai.provider = 'ollama';
    await saveDetroConfig(projectDir, config);
    console.log(chalk.green('Provider configurado: ollama'));
    return 0;
  }

  if (subcommand === 'perfil') {
    const profile = await detectProfile(projectDir);
    const list = (items) => (items.length > 0 ? items.join(', ') : chalk.dim('não detectado'));
    console.log(chalk.cyan.bold(`DETRO AI — perfil de ${projectDir}`));
    console.log();
    console.log(`Frontend:  ${list(profile.stacks.frontend)}`);
    console.log(`Backend:   ${list(profile.stacks.backend)}`);
    console.log(`Banco/ORM: ${list(profile.stacks.database)}`);
    console.log(`TypeScript: ${profile.tsProjects.length > 0 ? profile.tsProjects.map((item) => `${item.dir}${item.typescript ? '' : chalk.yellow(' (sem typescript instalado)')}`).join(', ') : chalk.dim('nenhum tsconfig.json')}`);
    console.log();
    console.log(chalk.cyan.bold('Convenções que os formatos especializados usam:'));

    for (const item of profile.conventions) {
      console.log(item.ok ? chalk.green(`  ✓ ${item.name}`) : chalk.dim(`  · ${item.name}`));
    }

    const yes = (value, text) => (value ? chalk.green(`  ✓ ${text}`) : chalk.yellow(`  ~ ${text}`));
    console.log();
    console.log(chalk.cyan.bold('O que o detro faz aqui:'));
    console.log(yes(profile.capabilities.review, 'check / fix com o compilador do projeto'));
    console.log(yes(true, 'mudanças pontuais em arquivos existentes (detro plan "no arquivo/tela X, ...")'));
    console.log(profile.capabilities.fullstack
      ? chalk.green('  ✓ criação especializada: cadastro completo, só frontend, consulta, menu')
      : chalk.yellow('  ~ criação por exemplo: copia o padrão de uma feature parecida deste projeto (sem as convenções especializadas)'));
    return 0;
  }

  if (subcommand === 'selftest') {
    const progress = createProgress();
    console.log(chalk.cyan.bold('DETRO AI — autoteste (sem IA)'));

    const results = await runSelftest({ projectDir, onStage: (message) => progress.log(chalk.magenta(`▸ ${message}`)) });
    progress.clear();

    for (const item of results) {
      console.log(item.ok ? chalk.green(`  ✓ ${item.name}`) : chalk.red(`  ✗ ${item.name}${item.detail ? `\n      ${item.detail}` : ''}`));
    }

    const failed = results.filter((item) => !item.ok).length;
    console.log();
    console.log(failed === 0 ? chalk.green.bold(`Tudo certo: ${results.length} verificações.`) : chalk.red.bold(`${failed} de ${results.length} verificações falharam.`));
    return failed === 0 ? 0 : 1;
  }

  const ollama = requireOllama(config);

  if (subcommand === 'model') {
    if (!rest[0]) {
      throw new Error('Informe o modelo. Exemplo: detro ai model qwen2.5-coder:7b');
    }

    config.ai.ollama.model = rest[0];
    await saveDetroConfig(projectDir, config);
    console.log(chalk.green(`Modelo configurado: ${rest[0]}`));

    const installed = await listOllamaModels(ollama.baseUrl)
      .then((models) => models.some((model) => model.name === rest[0] || model.name === `${rest[0]}:latest`))
      .catch(() => null);

    if (installed === false) {
      console.log(chalk.yellow(`Atenção: ${rest[0]} ainda não está instalado no Ollama. Baixe antes de usar: ollama pull ${rest[0]}`));
    } else if (installed === null) {
      console.log(chalk.yellow('Não consegui falar com o Ollama para confirmar se o modelo está instalado. Confira com: detro ai status'));
    }

    return 0;
  }

  if (subcommand === 'ctx') {
    const value = Number(rest[0]);

    if (!Number.isInteger(value) || value < 4096 || value > 262144) {
      throw new Error('Informe o contexto em tokens, entre 4096 e 262144. Exemplo: detro ai ctx 32768');
    }

    config.ai.ollama.numCtx = value;
    await saveDetroConfig(projectDir, config);
    console.log(chalk.green(`Contexto configurado: ${value} tokens`));
    console.log(chalk.dim('Contexto maior usa mais memória de vídeo/RAM; se o Ollama ficar lento, reduza.'));
    return 0;
  }

  if (subcommand === 'status' || subcommand === 'models') {
    const models = await listOllamaModels(ollama.baseUrl);
    const installed = models.some((model) => model.name === ollama.model);

    if (subcommand === 'models') {
      if (models.length === 0) {
        console.log(chalk.yellow('Nenhum modelo instalado no Ollama. Instale com: ollama pull qwen2.5-coder:7b'));
        return 0;
      }

      console.log(chalk.cyan.bold('Modelos Ollama instalados:'));

      for (const model of models) {
        console.log(`  - ${model.name}${model.name === ollama.model ? chalk.green(' (atual)') : ''}`);
      }

      return 0;
    }

    console.log(chalk.cyan.bold('DETRO AI'));
    console.log(`Provider: ${chalk.white(config.ai.provider)}`);
    console.log(`Servidor: ${chalk.white(ollama.baseUrl)}`);
    console.log(`Status: ${chalk.green('conectado')}`);
    console.log(`Modelo: ${chalk.white(ollama.model)}`);
    console.log(`Modelo instalado: ${installed ? chalk.green('sim') : chalk.yellow(`não — rode: ollama pull ${ollama.model}`)}`);
    console.log(`Contexto: ${chalk.white(`${ollama.numCtx} tokens`)}`);
    console.log(`Correções automáticas: ${chalk.white(config.ai.generation.maxRepairs)}`);
    return 0;
  }

  if (subcommand === 'ask') {
    const question = requireText(rest, 'detro ai ask "como funciona o useQuery?"');
    const progress = createProgress();

    const { content } = await ollamaChat({
      ollama,
      messages: [
        { role: 'system', content: 'Responda em português do Brasil. Seja objetivo e técnico.' },
        { role: 'user', content: question },
      ],
      onProgress: (tokens) => progress.update(`Consultando ${ollama.model}... ${tokens} tokens`),
    });

    progress.clear();
    console.log(content);
    return 0;
  }

  throw new Error(`Subcomando de IA desconhecido: ${subcommand}. Veja: detro ai help`);
}

function printPlanResult({ spec, names, errors, warnings }) {
  console.log();
  console.log(chalk.cyan.bold('Especificação:'));
  console.log(describeSpec(spec));

  console.log();
  console.log(chalk.cyan.bold('Arquivos que o apply vai gerar:'));

  const labels = {
    migration: 'migration (template)',
    dto: 'DTOs (template)',
    service: 'service com SQL por operadora (template)',
    controller: 'controller com permissão (template)',
    module: 'módulo Nest (template)',
    appModule: 'registro do módulo (patch)',
    type: 'tipos do front (template)',
    apiClient: 'cliente de API (template)',
    formModal: 'modal de cadastro (IA)',
    page: 'página (IA)',
    app: 'registro da rota (patch)',
    sidebar: 'item no menu lateral (patch)',
  };

  if (spec.permissionMode === 'nova') {
    labels.webScreens = 'tela de permissão no front (patch)';
    labels.apiScreens = 'tela de permissão no backend (patch)';
  }

  if (spec.scope === 'frontend') {
    for (const key of ['migration', 'dto', 'service', 'controller', 'module', 'appModule', 'apiClient', 'webScreens', 'apiScreens']) {
      delete labels[key];
    }

    labels.page = 'página com dados em memória (IA)';
  }

  for (const [key, label] of Object.entries(labels)) {
    const file = names.files[key];
    const symbol = ['appModule', 'app', 'sidebar', 'webScreens', 'apiScreens'].includes(key) ? chalk.cyan('~') : chalk.green('+');
    console.log(`  ${symbol} ${file} ${chalk.dim(label)}`);
  }

  if (spec.unsupported?.length > 0) {
    console.log();
    console.log(chalk.yellow.bold('Não coberto pelo gerador (fica para você implementar depois):'));
    printList(spec.unsupported, chalk.yellow, '•');
  }

  if (warnings.length > 0) {
    console.log();
    console.log(chalk.yellow.bold('Avisos:'));
    printList(warnings, chalk.yellow, '!');
  }

  if (errors.length > 0) {
    console.log();
    console.log(chalk.red.bold('Problemas que impedem o apply:'));
    printList(errors, chalk.red, '✗');
  }
}

function printPagePlan(result) {
  console.log();
  console.log(chalk.cyan.bold('O que encontrei no projeto:'));
  printList(result.evidence, chalk.white, '•');
  console.log();
  console.log(chalk.cyan.bold('Proposta (tela sob medida, só frontend):'));
  console.log(`  Página: ${result.spec.component} em ${result.spec.files.page}`);
  console.log(`  Tipos e dados iniciais: ${result.spec.files.types}`);
  console.log(`  Título: ${result.spec.title}`);
  console.log(`  Rota: ${result.spec.route} (permissão ${result.spec.screen})`);
  console.log(`  Menu: ${result.spec.menu.group}${result.spec.menu.after ? `, depois de "${result.spec.menu.after}"` : ', no fim'} → "${result.spec.menuLabel}" (ícone ${result.spec.menuIcon})`);
  console.log(chalk.dim('  A IA escreve os tipos e a tela a partir do pedido completo; rota e menu entram sem IA; tudo validado pelo TypeScript.'));

  if (result.errors.length > 0) {
    console.log();
    console.log(chalk.red.bold('Problemas que impedem o apply:'));
    printList(result.errors, chalk.red, '✗');
  }
}

function printExamplePlan(result) {
  console.log();
  console.log(chalk.cyan.bold('O que encontrei no projeto:'));
  console.log(`  Feature usada de modelo: ${chalk.white(result.example.stem)} (${result.example.files.length} arquivos)`);
  printList(result.example.files, chalk.dim, '·');

  if (result.example.registrations.length > 0) {
    console.log('  Onde ela está registrada (vai receber a nova feature):');
    printList(result.example.registrations.map((item) => `${item.file}${item.symbols?.length ? ` (${item.symbols.join(', ')})` : ''}${item.routes?.length ? ` (rota ${item.routes.join(', ')})` : ''}`), chalk.dim, '·');
  }

  if (result.alternatives?.length > 0) {
    console.log(chalk.dim(`  Outras possíveis: ${result.alternatives.join(', ')}`));
  }

  console.log();
  console.log(chalk.cyan.bold('Proposta:'));
  console.log(`  ${result.spec.entity} / ${result.spec.entityPlural} — "${result.spec.title}"`);
  printList(result.spec.fields.map((field) => `${field.name} (${field.type}) "${field.label}" ${field.required ? 'obrigatório' : 'opcional'}${field.options ? ` [${field.options.map((option) => option.label).join(', ')}]` : ''}`), chalk.white, '-');
  console.log('  Arquivos novos (copiados do modelo e adaptados pela IA):');
  printList(result.newFiles.map((item) => `${item.to}  ← ${item.from}`), chalk.green, '+');

  if (result.spec.unsupported?.length > 0) {
    console.log();
    console.log(chalk.yellow.bold('Não coberto (fica para você):'));
    printList(result.spec.unsupported, chalk.yellow, '•');
  }

  if (result.warnings.length > 0) {
    console.log();
    console.log(chalk.yellow.bold('Avisos:'));
    printList(result.warnings, chalk.yellow, '!');
  }

  if (result.errors.length > 0) {
    console.log();
    console.log(chalk.red.bold('Problemas que impedem o apply:'));
    printList(result.errors, chalk.red, '✗');
  }
}

function printQueryPlan(result) {
  if (result.evidence?.length > 0) {
    console.log();
    console.log(chalk.cyan.bold('O que encontrei no projeto:'));
    printList(result.evidence, chalk.white, '•');
  }

  console.log();
  console.log(chalk.cyan.bold('Proposta:'));
  console.log(describeQuerySpec(result.spec));

  if (result.spec.unsupported?.length > 0) {
    console.log();
    console.log(chalk.yellow.bold('Não coberto (fica para você):'));
    printList(result.spec.unsupported, chalk.yellow, '•');
  }

  if (result.warnings.length > 0) {
    console.log();
    console.log(chalk.yellow.bold('Avisos:'));
    printList(result.warnings, chalk.yellow, '!');
  }

  if (result.errors.length > 0) {
    console.log();
    console.log(chalk.red.bold('Problemas que impedem o apply:'));
    printList(result.errors, chalk.red, '✗');
  }
}

function planHashOf(plan) {
  return sha256(JSON.stringify(plan.spec ?? plan.operation ?? plan.edit));
}

function describeOperation(operation) {
  const extra = operation.permission ? ` (permissão: ${operation.permission})` : '';

  return {
    move: `Mover "${operation.item}" para o grupo "${operation.group}"${extra}`,
    rename: `Renomear "${operation.item}" para "${operation.label}"${extra}`,
    icon: `Trocar o ícone de "${operation.item}" para ${operation.icon}${extra}`,
    permission: `Trocar a permissão de "${operation.item}" para ${operation.permission}`,
  }[operation.type] ?? JSON.stringify(operation);
}

function printMenuPreview(operation, preview) {
  console.log();
  console.log(chalk.cyan.bold('Ajuste de menu:'));
  console.log(`  ${describeOperation(operation)}`);
  printList(preview.summary, chalk.green, '•');
  printList(preview.notes, chalk.yellow, '!');

  if (preview.errors.length > 0) {
    console.log(chalk.red.bold('Problemas de compilação:'));
    printList(preview.errors, chalk.red, '✗');
  }
}

async function prepareEditImplementation(projectDir, config, plan, progress) {
  const result = await prepareEdit({
    projectDir,
    config,
    file: plan.edit.file,
    instructions: plan.edit.instructions,
    onEvent: eventPrinter(progress),
  });

  progress.clear();
  console.log();
  console.log(`${chalk.cyan('ALTERAR')} ${chalk.white.bold(result.file)}`);

  if (result.summary) {
    console.log(chalk.dim(`  ${result.summary}`));
  }

  printDiff(result.original, result.content);

  if (!result.ok) {
    console.log();
    console.log(chalk.red.bold('As edições propostas não passaram na validação. Nada foi preparado:'));
    printList(result.problems, chalk.red, '-');
    console.log(chalk.yellow('Tente de novo, descreva a mudança com mais detalhe (onde e o quê), ou use um modelo maior.'));
    return 1;
  }

  const implementationFile = await saveImplementation({
    projectDir,
    implementation: {
      version: 2,
      kind: 'edit',
      createdAt: new Date().toISOString(),
      request: plan.request,
      files: [result.implementationFile],
      migration: null,
      services: [workspaceOf(result.file) ?? 'web'],
      planHash: planHashOf(plan),
    },
  });

  console.log();
  console.log(chalk.green.bold('Edição validada: compila sem erros novos.'));
  console.log(chalk.dim(`Preparada em: ${implementationFile}`));
  console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado. Confira se o diff faz o que você pediu.'));
  console.log(chalk.cyan('Se estiver bom: detro apply'));
  return 0;
}

async function prepareMenuImplementation(projectDir, operation, { request, planHash } = {}) {
  const preview = await planMenuOperation({ projectDir, operation });
  printMenuPreview(operation, preview);

  for (const file of preview.files) {
    console.log();
    console.log(`${chalk.cyan('ALTERAR')} ${chalk.white.bold(file.path)}`);
    printDiff(file.original, file.content);
  }

  if (preview.errors.length > 0) {
    console.log();
    console.log(chalk.red.bold('O ajuste não compila; nada foi preparado.'));
    return 1;
  }

  const implementationFile = await saveImplementation({
    projectDir,
    implementation: {
      version: 2,
      kind: 'menu',
      createdAt: new Date().toISOString(),
      request: request ?? describeOperation(operation),
      files: preview.files.map(({ action, kind, path: filePath, content, originalHash }) => ({ action, kind, path: filePath, content, originalHash })),
      migration: null,
      services: ['web'],
      ...(planHash ? { planHash } : {}),
    },
  });

  console.log();
  console.log(chalk.dim(`Preparado em: ${implementationFile}`));
  console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));
  console.log(chalk.cyan('Se o diff estiver bom: detro apply'));
  return 0;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runMenuCommand({ projectDir, args }) {
  const [subcommand, ...rest] = args;
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--permissao') {
      index += 1;
      continue;
    }

    positional.push(rest[index]);
  }

  const permission = optionValue(rest, '--permissao');

  if (!subcommand || subcommand === 'listar' || subcommand === 'help') {
    const menu = await readMenu(projectDir);
    console.log(chalk.cyan.bold('Menu lateral (web/src/components/Sidebar.tsx)'));

    for (const group of menu.groups) {
      console.log();
      console.log(chalk.white.bold(group.label));

      for (const item of menu.items.filter((entry) => entry.group === group.label)) {
        console.log(`  ${item.parent ? '    ' : ''}- ${item.label} ${chalk.dim(`${item.to ?? ''}${item.screen ? ` [${item.screen}]` : ''}`)}`);
      }
    }

    console.log();
    console.log(chalk.dim('Uso: detro menu mover "<item>" "<grupo>" [--permissao <tela>] | renomear "<item>" "<novo nome>" | icone "<item>" <Icone> | permissao "<item>" <tela>'));
    return 0;
  }

  const operations = {
    mover: () => ({ type: 'move', item: positional[0], group: positional[1] }),
    renomear: () => ({ type: 'rename', item: positional[0], label: positional[1] }),
    icone: () => ({ type: 'icon', item: positional[0], icon: positional[1] }),
    permissao: () => ({ type: 'permission', item: positional[0], permission: positional[1] }),
  };

  if (!operations[subcommand]) {
    throw new Error(`Subcomando de menu desconhecido: ${subcommand}. Use: listar, mover, renomear, icone ou permissao.`);
  }

  const operation = operations[subcommand]();

  if (!operation.item || (operation.type === 'move' && !operation.group) || (operation.type === 'rename' && !operation.label) || (operation.type === 'icon' && !operation.icon) || (operation.type === 'permission' && !operation.permission)) {
    throw new Error('Faltou argumento. Ex.: detro menu mover "Tipos de ocorrência" "Rotas e operação" --permissao routes');
  }

  if (permission && operation.type !== 'permission') {
    operation.permission = permission;
  }

  console.log(chalk.cyan.bold('DETRO MENU'));
  return prepareMenuImplementation(projectDir, operation);
}

function printRequirements(covered, extractedFrom) {
  if (!covered?.length) {
    return;
  }

  console.log();
  const origin = { tópicos: 'lidos dos tópicos do pedido', documento: 'lidos das seções de dados do documento', ia: 'separados pela IA', plano: 'do plano salvo' }[extractedFrom] ?? 'separados pela IA';
  console.log(chalk.cyan.bold(`Requisitos (${origin}):`));

  for (const item of covered) {
    const target = item.coveredBy.join(', ');
    const color = target.includes('não coberto') ? chalk.yellow : chalk.green;
    console.log(`  ${chalk.dim(`#${item.id}`)} ${item.text} ${chalk.dim('→')} ${color(target)}`);
  }
}

async function readRequestInput(args, projectDir) {
  const fileIndex = args.findIndex((arg) => arg === '-f' || arg === '--arquivo');

  if (fileIndex >= 0) {
    const file = args[fileIndex + 1];

    if (!file) {
      throw new Error('Informe o arquivo do pedido. Exemplo: detro plan -f pedido.md');
    }

    const candidates = [path.resolve(process.cwd(), file), path.resolve(projectDir, file), path.resolve(projectDir, '.detro', 'pedidos', file)];

    for (const candidate of candidates) {
      try {
        return (await readFile(candidate, 'utf8')).trim();
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    throw new Error(`Arquivo do pedido não encontrado: ${file}. Procurei na pasta atual, na raiz do projeto e em .detro/pedidos/.`);
  }

  if (args.length === 1 && args[0] === '-') {
    const chunks = [];

    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString('utf8').trim();
  }

  return requireText(args.filter((arg) => !arg.startsWith('--')), 'detro plan "cadastro de reservatórios com nome, capacidade em litros e ativo"  (ou: detro plan -f pedido.md)');
}

export async function runPlanCommand({ projectDir, args }) {
  const config = await loadDetroConfig(projectDir);

  if (args.includes('--revalidar')) {
    const { filePath, plan } = await loadLastPlan(projectDir);

    if (plan.recipe === 'page') {
      console.log(chalk.cyan.bold('DETRO PLAN — revalidação (tela sob medida)'));
      const prepared = await preparePageSpec(projectDir, plan.spec);
      printPagePlan({ spec: prepared.spec, evidence: plan.evidence ?? [], errors: prepared.errors, warnings: [] });
      await saveLastPlan({ projectDir, request: plan.request, recipe: 'page', spec: prepared.spec, evidence: plan.evidence });
      return prepared.errors.length > 0 ? 1 : 0;
    }

    if (plan.recipe === 'example') {
      console.log(chalk.cyan.bold('DETRO PLAN — revalidação (criação por exemplo)'));
      const preview = await planExampleFiles(projectDir, plan.example, plan.spec);
      printExamplePlan({ spec: plan.spec, example: plan.example, newFiles: preview.files, errors: preview.errors, warnings: [], alternatives: [] });
      await saveLastPlan({ projectDir, request: plan.request, recipe: 'example', spec: plan.spec, requirements: plan.requirements, example: plan.example });
      return preview.errors.length > 0 ? 1 : 0;
    }

    if (plan.recipe === 'query') {
      console.log(chalk.cyan.bold('DETRO PLAN — revalidação (consulta)'));
      const prepared = await prepareQuerySpec(projectDir, plan.spec);
      printQueryPlan({ ...prepared, evidence: [] });

      if (prepared.errors.length === 0) {
        await saveLastPlan({ projectDir, request: plan.request, recipe: 'query', spec: prepared.spec });
      }

      return prepared.errors.length > 0 ? 1 : 0;
    }

    if (plan.recipe === 'edit') {
      console.log(chalk.cyan.bold('DETRO PLAN — revalidação (mudança em tela existente)'));
      console.log(`  Arquivo: ${plan.edit.file}`);
      console.log(`  Pedido: ${plan.edit.instructions}`);
      await saveLastPlan({ projectDir, request: plan.request, recipe: 'edit', edit: plan.edit });
      return 0;
    }

    if (plan.recipe === 'menu') {
      console.log(chalk.cyan.bold('DETRO PLAN — revalidação (menu)'));
      const preview = await planMenuOperation({ projectDir, operation: plan.operation });
      printMenuPreview(plan.operation, preview);
      await saveLastPlan({ projectDir, request: plan.request, recipe: 'menu', operation: plan.operation });
      console.log();
      console.log(chalk.dim(`Plano: ${filePath}`));
      return preview.errors.length > 0 ? 1 : 0;
    }

    const requirements = plan.requirements ?? [];
    const prepared = await prepareSpec(projectDir, plan.spec, requirements);
    const covered = requirements.length > 0 ? finishCoverage(requirements, prepared) : [];

    if (prepared.errors.length === 0) {
      await saveLastPlan({ projectDir, request: plan.request, spec: prepared.spec, requirements });
    }

    console.log(chalk.cyan.bold('DETRO PLAN — revalidação'));
    printRequirements(covered, 'plano');
    printPlanResult(prepared);
    console.log();
    console.log(chalk.dim(`Plano: ${filePath}`));
    return prepared.errors.length > 0 ? 1 : 0;
  }

  const request = await readRequestInput(args, projectDir);

  if (!request) {
    throw new Error('O pedido está vazio. Descreva o cadastro e os dados que ele precisa ter.');
  }

  const progress = createProgress();

  console.log(chalk.cyan.bold('DETRO PLAN'));
  console.log(chalk.dim(`Pedido: ${request.length > 400 ? `${request.slice(0, 400)}…` : request}`));

  const claudeLigado = config.ai.ollama.claude?.enabled !== false;

  if (args.includes('--livre')) {
    return planejarLivre({ projectDir, config, request, printDiff });
  }

  let result;
  try {
    result = await createPlan({
      projectDir,
      config,
      request,
      onStage: (message) => progress.log(chalk.magenta(`▸ ${message}`)),
      onProgress: (tokens) => progress.update(`  ${config.ai.ollama.model}... ${tokens} tokens`),
    });
  } catch (error) {
    progress.clear();
    if (!claudeLigado) throw error;
    return planejarLivre({ projectDir, config, request, motivo: error.message, printDiff });
  }

  progress.clear();

  if (result.kind === 'page') {
    printPagePlan(result);
    const planFile = await saveLastPlan({ projectDir, request, recipe: 'page', spec: result.spec, evidence: result.evidence });
    console.log();
    console.log(chalk.dim(`Plano salvo em: ${planFile} (ajuste menu, rótulo, rota ou permissão no JSON e rode detro plan --revalidar)`));
    console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));

    if (result.errors.length === 0) {
      console.log();
      console.log(chalk.cyan('Próximo passo: detro apply --dry-run'));
    }

    return result.errors.length > 0 ? 1 : 0;
  }

  if (result.kind === 'example') {
    printRequirements(result.covered, 'ia');
    printExamplePlan(result);
    const planFile = await saveLastPlan({ projectDir, request, recipe: 'example', spec: result.spec, requirements: result.requirements, example: result.example });
    console.log();
    console.log(chalk.dim(`Plano salvo em: ${planFile} (troque a feature modelo em "example.stem"/"example.files" se preferir outra)`));
    console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));

    if (result.errors.length === 0) {
      console.log();
      console.log(chalk.cyan('Próximo passo: detro apply --dry-run'));
    }

    return result.errors.length > 0 ? 1 : 0;
  }

  if (result.kind === 'query') {
    printQueryPlan(result);
    const planFile = await saveLastPlan({ projectDir, request, recipe: 'query', spec: result.spec });
    console.log();
    console.log(chalk.dim(`Plano salvo em: ${planFile} (ajuste colunas, filtros, condição ou menu no JSON e rode detro plan --revalidar)`));
    console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));

    if (result.errors.length === 0) {
      console.log();
      console.log(chalk.cyan('Próximo passo: detro apply --dry-run'));
    }

    return result.errors.length > 0 ? 1 : 0;
  }

  if (result.kind === 'edit') {
    console.log();
    console.log(chalk.cyan.bold('Mudança em tela existente:'));
    console.log(`  Arquivo: ${chalk.white(result.target.file)} ${chalk.dim(`(${result.target.reason})`)}`);
    console.log(`  Pedido: ${result.instructions}`);
    const planFile = await saveLastPlan({ projectDir, request, recipe: 'edit', edit: { file: result.target.file, instructions: result.instructions } });
    console.log();
    console.log(chalk.dim(`Plano salvo em: ${planFile} (se o arquivo estiver errado, ajuste "edit.file" no JSON)`));
    console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));
    console.log();
    console.log(chalk.cyan('Próximo passo: detro apply --dry-run  (o modelo propõe as edições e você vê o diff)'));
    return 0;
  }

  if (result.kind === 'menu') {
    printMenuPreview(result.operation, result.preview);
    const planFile = await saveLastPlan({ projectDir, request, recipe: 'menu', operation: result.operation });
    console.log();
    console.log(chalk.dim(`Plano salvo em: ${planFile} (ajuste "operation" no JSON e rode detro plan --revalidar)`));
    console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));

    if (result.preview.errors.length === 0) {
      console.log();
      console.log(chalk.cyan('Próximo passo: detro apply --dry-run'));
    }

    return result.preview.errors.length > 0 ? 1 : 0;
  }

  if (result.blocked) {
    console.log();
    console.log(chalk.yellow.bold('Esse pedido não é um cadastro novo:'));
    console.log(chalk.yellow(`  ${result.message}`));
    console.log(chalk.dim('Nenhum plano foi salvo. Se for mesmo um cadastro novo, descreva-o como "cadastro de <coisa> com <dados>".'));
    return 1;
  }

  printRequirements(result.covered, result.extractedFrom);
  printPlanResult(result);

  const planFile = await saveLastPlan({ projectDir, request, spec: result.spec, requirements: result.requirements });

  console.log();
  console.log(chalk.dim(`Plano salvo em: ${planFile}`));
  console.log(chalk.dim('Ajuste campos, rótulos, rota ou permissão editando o JSON e rode "detro plan --revalidar".'));
  console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));

  if (result.errors.length === 0) {
    console.log();
    console.log(chalk.cyan('Próximo passo: detro apply --dry-run'));
  }

  return result.errors.length > 0 ? 1 : 0;
}

function printGeneratedPreview(files) {
  for (const file of files) {
    console.log();
    const action = file.action === 'create' ? chalk.green('CRIAR') : chalk.cyan('ALTERAR');
    const origin = file.kind === 'ai' ? chalk.magenta(`IA, ${file.attempts} tentativa(s)`) : chalk.dim(file.kind);
    console.log(`${action} ${chalk.white.bold(file.path)} ${origin}`);

    if (file.added) {
      printList(file.added, chalk.green, '+');
      continue;
    }

    if (file.original) {
      printDiff(file.original, file.content);
      continue;
    }

    if (file.kind === 'ai' || !file.validation?.valid) {
      console.log(chalk.dim(RULE));
      console.log(file.content);
      console.log(chalk.dim(RULE));
    }
  }
}

async function runDryRun(projectDir) {
  const config = await loadDetroConfig(projectDir);
  const { filePath, plan } = await loadLastPlan(projectDir);
  const progress = createProgress();

  console.log(chalk.cyan.bold('DETRO APPLY — DRY RUN'));
  console.log(chalk.dim(`Plano: ${filePath}`));
  console.log(chalk.dim(`Pedido: ${plan.request}`));

  if (plan.recipe === 'menu') {
    return prepareMenuImplementation(projectDir, plan.operation, { request: plan.request, planHash: planHashOf(plan) });
  }

  if (plan.recipe === 'edit') {
    return prepareEditImplementation(projectDir, config, plan, progress);
  }

  const generate = { query: generateQuery, example: generateByExample, page: generatePage }[plan.recipe] ?? generateCrud;
  const result = await generate({
    projectDir,
    config,
    spec: plan.spec,
    plan,
    onEvent: eventPrinter(progress),
  });

  progress.clear();

  console.log();
  console.log(chalk.magenta.bold('PRÉVIA'));
  console.log(chalk.dim('Templates não são exibidos por inteiro (são determinísticos); arquivos da IA sim.'));
  printGeneratedPreview(result.files);

  if (!result.valid) {
    const attemptFile = await saveAttempt(projectDir, {
      createdAt: new Date().toISOString(),
      request: plan.request,
      files: result.files.map(({ action, kind, path, content, validation }) => ({ action, kind, path, content, errors: validation?.errors ?? [] })),
    });

    console.log();
    console.log(chalk.red.bold('A implementação não passou na validação. Nada foi preparado para o apply.'));
    console.log(chalk.dim(`Tentativa salva para inspeção em: ${attemptFile}`));
    console.log(chalk.yellow('Tente de novo (a IA varia entre execuções), aumente as correções em ai.generation.maxRepairs, ou use um modelo maior: detro ai model qwen2.5-coder:14b'));
    return 1;
  }

  const implementationFile = await saveImplementation({
    projectDir,
    implementation: {
      version: 2,
      kind: 'crud',
      createdAt: new Date().toISOString(),
      request: plan.request,
      files: result.files.map(({ action, kind, path, content, originalHash }) => ({ action, kind, path, content, originalHash })),
      migration: result.spec.scope === 'frontend' || ['query', 'example', 'page'].includes(plan.recipe) ? null : result.names.files.migration,
      services: plan.recipe === 'example' ? [] : result.spec.scope === 'frontend' || plan.recipe === 'page' ? ['web'] : ['api', 'web'],
      planHash: planHashOf(plan),
    },
  });

  console.log();
  console.log(chalk.green.bold(`Implementação validada: ${result.files.length} arquivo(s), tipos checados com o TypeScript do projeto.`));
  console.log(chalk.dim(`Preparada em: ${implementationFile}`));
  console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));
  console.log();
  console.log(chalk.cyan('Se a prévia estiver boa: detro apply'));
  return 0;
}

export async function runApplyCommand({ projectDir, args }) {
  if (args.includes('--dry-run')) {
    return runDryRun(projectDir);
  }

  const { filePath, implementation } = await loadImplementation(projectDir);

  if (implementation.planHash) {
    const current = await loadLastPlan(projectDir).catch(() => null);

    if (!current || planHashOf(current.plan) !== implementation.planHash) {
      throw new Error('A implementação preparada é de um plano diferente do atual (o plano mudou ou um dry-run mais recente falhou). Rode detro apply --dry-run de novo.');
    }
  }

  if (implementation.appliedAt) {
    throw new Error(`Esta implementação já foi aplicada em ${implementation.appliedAt}. Gere outra com detro apply --dry-run ou detro fix.`);
  }

  console.log(chalk.cyan.bold('DETRO APPLY'));
  console.log(chalk.dim(`Implementação: ${filePath} (${implementation.createdAt})`));
  console.log();

  const result = await applyImplementation({ projectDir, implementation });
  await markImplementationApplied(projectDir, implementation);

  console.log(chalk.green.bold('Arquivos escritos:'));

  for (const file of result.applied) {
    console.log(chalk.green(`  ${file.action === 'create' ? '+' : '~'} ${file.path}`));
  }

  const autoConfirm = args.includes('--sim');
  const skipDatabase = args.includes('--sem-banco');
  const skipRestart = args.includes('--sem-restart');
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const pending = [];

  async function ask(message) {
    if (autoConfirm) {
      return true;
    }

    if (!interactive) {
      return false;
    }

    return confirm({ message, default: true });
  }

  const config = await loadDetroConfig(projectDir);

  if (implementation.migration) {
    console.log();

    if (!skipDatabase && await ask(`Aplicar ${implementation.migration} no banco de dev agora (em transação única)?`)) {
      try {
        const container = await findPostgresContainer(config.ai.database?.container);
        console.log(chalk.dim(`Aplicando no container ${container.name}...`));
        await applyMigration({ projectDir, migration: implementation.migration, container });
        console.log(chalk.green(`  ✓ Migration aplicada em ${container.name}`));
      } catch (error) {
        console.log(chalk.red(`  ✗ ${error.message}`));
        pending.push(`Aplicar a migration no banco de dev: ${implementation.migration}`);
      }
    } else {
      pending.push(`Aplicar a migration no banco de dev: ${implementation.migration}`);
    }
  }

  const services = implementation.services ?? [];

  if (services.length > 0) {
    const script = await findAppScript(projectDir);

    if (script && !skipRestart && await ask(`Rebuildar ${services.join(' e ')} agora (${path.basename(script)} restart ${services.join(' ')})?`)) {
      const code = await restartServices({ projectDir, script, services });

      if (code !== 0) {
        pending.push(`O restart terminou com código ${code}: confira com docker logs detrorj-api --tail 50`);
      }
    } else {
      pending.push(`Rebuildar: ./app restart ${services.join(' ')}`);
    }
  }

  console.log();

  if (pending.length === 0) {
    console.log(chalk.green.bold('Pronto. Abra a tela no navegador e teste o fluxo de cadastro, edição e exclusão.'));
  } else {
    console.log(chalk.yellow.bold('Falta com você:'));

    for (const item of pending) {
      console.log(chalk.yellow(`  - ${item}`));
    }
  }

  return 0;
}

function printFindings(findings) {
  const colors = { erro: chalk.red, aviso: chalk.yellow, info: chalk.cyan };
  let currentFile = null;

  for (const item of findings) {
    if (item.file !== currentFile) {
      currentFile = item.file;
      console.log();
      console.log(chalk.white.bold(item.file));
    }

    const tag = item.source === 'ia' ? chalk.magenta(' [IA: confirme]') : chalk.dim(` [${item.rule}]`);
    console.log(`  ${colors[item.severity](item.severity.padEnd(5))} ${chalk.dim(`linha ${item.line}`)} ${item.message}${tag}`);
  }
}

export async function runCheckCommand({ projectDir, args }) {
  const useAi = args.includes('--ia');
  const all = args.includes('--tudo');
  const inputs = args.filter((arg) => !arg.startsWith('--'));

  if (all && useAi) {
    throw new Error('--ia com --tudo revisaria o projeto inteiro no modelo local. Informe os arquivos: detro check --ia <arquivo...>');
  }

  const config = await loadDetroConfig(projectDir);
  const files = await resolveTargets(projectDir, inputs, { all });

  console.log(chalk.cyan.bold('DETRO CHECK'));

  if (files.length === 0) {
    console.log(chalk.yellow(inputs.length > 0
      ? 'Nenhum dos arquivos informados é .ts/.tsx/.sql (fora de node_modules/dist).'
      : 'Nenhum arquivo .ts/.tsx/.sql alterado no git. Informe arquivos: detro check <arquivo...>'));
    return 0;
  }

  console.log(chalk.dim(`${files.length} arquivo(s)${all ? ' (projeto inteiro)' : inputs.length === 0 ? ' alterado(s) no git' : ''}`));

  const progress = createProgress();
  const { findings, warnings } = await runCheck({ projectDir, config, files, useAi, onEvent: eventPrinter(progress) });
  progress.clear();

  printList(warnings, chalk.yellow, '!');

  if (findings.length === 0) {
    console.log();
    console.log(chalk.green.bold('Nenhum problema encontrado.'));
    console.log(chalk.dim('Isto cobre tipos e as regras automáticas do projeto; não substitui build nem teste na tela.'));
    return 0;
  }

  printFindings(findings);

  const count = (severity) => findings.filter((item) => item.severity === severity).length;
  console.log();
  console.log(`${chalk.red(`${count('erro')} erro(s)`)}, ${chalk.yellow(`${count('aviso')} aviso(s)`)}, ${chalk.cyan(`${count('info')} info`)}`);

  if (count('erro') > 0) {
    console.log(chalk.dim('Para pedir a correção ao modelo: detro fix <arquivo>'));
  }

  return count('erro') > 0 ? 1 : 0;
}

export async function runFixCommand({ projectDir, args }) {
  const input = args.find((arg) => !arg.startsWith('--'));

  if (!input) {
    throw new Error('Informe o arquivo. Exemplo: detro fix web/src/pages/Stops.tsx');
  }

  const config = await loadDetroConfig(projectDir);
  const progress = createProgress();

  console.log(chalk.cyan.bold('DETRO FIX'));

  const result = await prepareFix({ projectDir, config, input, onEvent: eventPrinter(progress) });
  progress.clear();

  if (result.nothingToFix) {
    console.log(chalk.green(`Nenhum erro de tipo ou de regra em ${result.file}.`));
    console.log(chalk.dim(`Para procurar falhas de lógica: detro check --ia ${result.file}`));
    return 0;
  }

  console.log();
  console.log(chalk.white.bold(`Problemas encontrados (${result.initialProblems.length}):`));
  printList(result.initialProblems, chalk.red, '-');

  if (!result.improved) {
    console.log();
    console.log(chalk.red.bold('O modelo não conseguiu reduzir os problemas. Nada foi preparado.'));
    return 1;
  }

  console.log();
  console.log(chalk.white.bold(`Alteração proposta em ${result.file}:`));
  printDiff(result.original, `${result.content.trimEnd()}\n`);

  if (result.remaining.length > 0) {
    console.log();
    console.log(chalk.yellow.bold(`Ainda restam ${result.remaining.length} problema(s) depois da correção:`));
    printList(result.remaining, chalk.yellow, '-');
  }

  const implementationFile = await saveImplementation({ projectDir, implementation: result.implementation });

  console.log();
  console.log(chalk.dim(`Preparada em: ${implementationFile}`));
  console.log(chalk.yellow('Nenhum arquivo do projeto foi alterado.'));
  console.log(chalk.cyan('Se o diff estiver bom: detro apply'));
  return 0;
}


function sameCode(content) {
  return content.split('\n').map((line) => line.trimEnd()).join('\n').trimEnd();
}

async function expandBatchInputs(projectDir, inputs) {
  const files = [];

  for (const input of inputs) {
    if (!input.includes('*')) {
      files.push(input);
      continue;
    }

    const dir = path.join(projectDir, '.detro', 'pedidos');
    const pattern = new RegExp(`^${path.basename(input).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const matches = (await readdir(dir).catch(() => [])).filter((name) => pattern.test(name)).sort();

    if (matches.length === 0) {
      throw new Error(`Nenhum pedido em .detro/pedidos/ casa com ${input}.`);
    }

    files.push(...matches);
  }

  return files;
}

export async function runBatchCommand({ projectDir, args }) {
  const dryRun = args.includes('--dry-run');
  const inputs = await expandBatchInputs(projectDir, args.filter((arg) => !arg.startsWith('--')));

  if (inputs.length === 0) {
    throw new Error('Informe os pedidos. Exemplo: detro lote "erros-*.md"  (procura na pasta atual, na raiz e em .detro/pedidos/)');
  }

  const config = await loadDetroConfig(projectDir);
  const progress = createProgress();
  const virtualFiles = new Map();
  const originals = new Map();
  const results = [];

  console.log(chalk.cyan.bold(`DETRO LOTE — ${inputs.length} pedido(s)${dryRun ? ' (dry-run)' : ''}`));

  for (const input of inputs) {
    console.log();
    console.log(chalk.white.bold(`${RULE}\n${input}`));

    try {
      const request = await readRequestInput(['-f', input], projectDir);
      const targets = await resolveEditTargets(projectDir, request);

      if (targets.length !== 1) {
        throw new Error(targets.length === 0
          ? 'O pedido não cita nenhum arquivo existente. Cite o caminho, ex.: web/src/lib/api.ts.'
          : `O pedido cita mais de um arquivo (${targets.map((item) => item.file).join(', ')}). Deixe um arquivo por pedido.`);
      }

      const { file } = targets[0];

      if (!originals.has(file)) {
        originals.set(file, await readFile(path.join(projectDir, file), 'utf8'));
      }

      let result = await prepareEdit({ projectDir, config, file, instructions: request, virtualFiles, onEvent: eventPrinter(progress) });
      let via = 'modelo';
      progress.clear();
      const literal = await prepareLiteralEdit({ projectDir, file, instructions: request, virtualFiles });

      if (literal?.ok && (!result.ok || sameCode(result.content) !== sameCode(literal.content))) {
        console.log(chalk.yellow(result.ok
          ? '  O modelo compilou, mas o resultado difere dos trechos do pedido. Diff do modelo:'
          : '  O modelo não passou na validação. Usando os trechos literais do pedido.'));

        if (result.ok) {
          printDiff(literal.content, result.content);
        }

        via = result.ok ? 'trechos (modelo divergiu)' : 'trechos (modelo falhou)';
        result = literal;
      } else if (!result.ok && literal) {
        result = { ...result, problems: [...result.problems, ...literal.problems.map((item) => `trechos do pedido: ${item}`)] };
      }

      if (!result.ok) {
        results.push({ input, file, status: 'falhou', problems: result.problems });
        console.log(chalk.red(`  ✗ ${file}`));
        printList(result.problems.slice(0, 5), chalk.red, '-');
        continue;
      }

      console.log(`${chalk.cyan('ALTERAR')} ${chalk.white.bold(file)} ${chalk.dim(`via ${via}`)}`);

      if (result.summary) {
        console.log(chalk.dim(`  ${result.summary}`));
      }

      printDiff(result.original, result.content);
      virtualFiles.set(file, result.content);
      results.push({ input, file, status: via });
    } catch (error) {
      progress.clear();
      results.push({ input, status: 'falhou', problems: [error.message] });
      console.log(chalk.red(`  ✗ ${error.message}`));
    }
  }

  const written = [];
  const conflicts = [];

  if (!dryRun) {
    for (const [file, content] of virtualFiles) {
      const current = await readFile(path.join(projectDir, file), 'utf8');

      if (current !== originals.get(file)) {
        conflicts.push(file);
        continue;
      }

      await writeFile(path.join(projectDir, file), content, 'utf8');
      written.push(file);
    }
  }

  console.log();
  console.log(chalk.white.bold(`${RULE}\nResumo`));

  for (const item of results) {
    const color = item.status === 'falhou' ? chalk.red : item.status === 'modelo' ? chalk.green : chalk.yellow;
    console.log(color(`  ${item.status.padEnd(26)} ${item.input}${item.file ? chalk.dim(` → ${item.file}`) : ''}`));
  }

  if (dryRun) {
    console.log(chalk.yellow('\nDry-run: nenhum arquivo do projeto foi alterado.'));
  } else {
    printList(written, chalk.green, '~');
    printList(conflicts.map((file) => `${file} mudou durante o lote; não foi sobrescrito`), chalk.red, '!');

    if (written.length > 0) {
      const services = [...new Set(written.map((file) => workspaceOf(file)).filter(Boolean))];
      console.log(chalk.cyan(`\nConfira com: git diff    Depois: ./app restart ${services.join(' ')}`));
    }
  }

  return results.some((item) => item.status === 'falhou') || conflicts.length > 0 ? 1 : 0;
}
