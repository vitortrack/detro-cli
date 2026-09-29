import { analyzeRequest, describeIntent } from './analysis.js';
import { listScreens, listTables, referenceableTables } from './catalog.js';
import { createExamplePlan } from './examplePlanner.js';
import { createMenuPlan } from './menuPlanner.js';
import { createPagePlan } from './page.js';
import { detectProfile, missingFor } from './profile.js';
import { createQueryPlan } from './queryPlanner.js';
import { resolveTargets } from './targets.js';
import { requireOllama } from './config.js';
import { prepareSpec } from './generator.js';
import { ollamaJson } from './ollama.js';
import {
  bulletRequirements,
  EXAMPLE_REQUEST,
  EXAMPLE_RESULT,
  coverage,
  extractRequirements,
  renderRequirements,
} from './requirements.js';
import { COMPARE_OPERATORS, FIELD_TYPES, specSchema } from './spec.js';

const EXAMPLE_REQUIREMENTS = EXAMPLE_RESULT.requirements.map((item, index) => ({ id: index + 1, options: [], ...item }));

const EXAMPLE_SPEC = {
  entity: 'Garage',
  entityPlural: 'Garages',
  labelSingular: 'garagem',
  labelPlural: 'garagens',
  gender: 'f',
  title: 'Garagens',
  route: '/garagens',
  screen: 'vehicles',
  permissionMode: 'nova',
  menuIcon: 'Warehouse',
  fields: [
    { source: 1, name: 'name', label: 'Nome', type: 'string', required: true, unique: true, maxLength: 120 },
    { source: 2, name: 'company', label: 'Empresa responsável', type: 'reference', required: true, references: 'companies' },
    { source: 3, name: 'address', label: 'Endereço', type: 'string', required: false, maxLength: 250 },
    { source: 4, name: 'busCapacity', label: 'Capacidade de ônibus', type: 'integer', required: true, min: 0 },
    {
      source: 5,
      name: 'status',
      label: 'Situação',
      type: 'enum',
      required: true,
      options: [
        { value: 'operating', label: 'Operando' },
        { value: 'renovation', label: 'Em reforma' },
        { value: 'closed', label: 'Fechada' },
      ],
    },
    { source: 6, name: 'openedAt', label: 'Data de abertura', type: 'date', required: true },
    { source: 7, name: 'closedAt', label: 'Data de encerramento', type: 'date', required: false },
  ],
  rules: [
    { source: 8, type: 'compare', left: 'closedAt', operator: '>=', right: 'openedAt', message: 'A data de encerramento não pode ser antes da abertura.' },
    { source: 9, type: 'blockDelete', field: 'status', values: ['Operando'], message: 'Não é possível excluir uma garagem operando. Mude a situação antes de excluir.' },
  ],
  unsupported: [
    { source: 10, text: 'Foto da fachada: upload de arquivo não é gerado pelo detro.' },
    { source: 11, text: 'Total de ônibus estacionados calculado automaticamente: campo calculado não é gerado pelo detro.' },
  ],
};

function systemPrompt(screens, references) {
  return `
Você transforma REQUISITOS numerados em uma especificação JSON de CRUD para o projeto.

Responda SOMENTE com o JSON.

Regra principal: TODO requisito aparece pelo menos uma vez, e cada campo, regra e item de "unsupported" tem "source" com o número do requisito de onde veio.
- [campo] → um campo simples. [vinculo] → campo "reference". [opcoes] → campo "enum". [regra] → item em "rules" (ou "unsupported" se não couber). [arquivo], [calculo], [outro] → "unsupported".

Dados gerais:
- entity: nome da entidade em inglês, singular, PascalCase (ex.: Reservoir, Garage). entityPlural: plural em inglês.
- labelSingular / labelPlural: nome curto em português, minúsculo (prefira "posto" a "posto de abastecimento conveniado").
- gender: "f" se o nome em português for feminino ("a garagem"), "m" se masculino ("o reservatório").
- title: título curto, só a primeira letra maiúscula. route: em português, minúsculo, sem acento, com hífen (ex.: /garagens).
- screen: a tela existente mais próxima do assunto (define o grupo do menu). Opções:
${screens.map((screen) => `  - ${screen.key}: ${screen.label}`).join('\n')}
- permissionMode: "nova" (padrão) ou "existente" (só se o pedido mandar usar a permissão de "screen").
- menuIcon: ícone do lucide-react em PascalCase que represente o assunto (ex.: Fuel, Warehouse, Droplets, ClipboardList).

Campos (fields); nunca inclua id, operador ou datas de criação/alteração:
- name: camelCase em inglês. label: rótulo em português.
- type: ${FIELD_TYPES.join(' | ')}
  - string = texto curto; text = texto longo; integer = inteiro; decimal = número com casas; boolean = sim/não; date = data.
  - enum: "options" com label EXATAMENTE igual às opções do requisito, na mesma ordem, e value em inglês snake_case.
  - reference: "references" com uma destas tabelas (nome — coluna mostrada):
${references.map((table) => `    - ${table.name} — ${table.labelColumn}${table.tenant ? ' (por operadora)' : ''}`).join('\n')}
    Se o cadastro citado não estiver na lista, NÃO invente: coloque em "unsupported".
- required: true se o pedido indicar obrigatório ou se for o nome/identificação principal.
- unique: true só para identificadores que não podem repetir na operadora (nome, código, placa).
- maxLength (string): limite razoável. min/max (números): só quando fizer sentido (quantidade não negativa → min 0).

Regras (rules), só destes dois tipos:
- {"type": "compare", "left", "operator", "right", "message"}: um campo não pode ser antes/depois/maior/menor que outro. operator: ${COMPARE_OPERATORS.join(', ')}. Os dois campos do mesmo tipo (date, integer ou decimal).
- {"type": "blockDelete", "field", "values", "message"}: "não pode excluir quando <campo> for <valor>". field é enum ou boolean; values são os LABELS das opções (ou "true"/"false").

unsupported: {"source", "text"} para o que não cabe (upload, cálculo, regra que depende de outra tabela, relatório, integração, vínculo com cadastro inexistente). "text" diz o que ficou de fora e por quê.
`.trim();
}

function planRequest(request, requirements, analysis = null) {
  const notes = analysis?.scope === 'frontend'
    ? '\n\nOBSERVAÇÃO: modo só frontend (dados em memória). Não use "reference": vínculo com outro cadastro vai para "unsupported".'
    : '';

  return `PEDIDO:
${analysis?.structured && analysis.dataText ? analysis.dataText : request}

REQUISITOS:
${renderRequirements(requirements)}${notes}`;
}

const COVERAGE_TOPICS = [
  { pattern: /\b(foto|fotos|imagem|imagens|anexo|anexos|arquivo|arquivos|upload|pdf)\b/, topic: 'arquivo/foto' },
  { pattern: /\b(calcul\w*|automaticamente|soma|somatório|total de|média)\b/, topic: 'campo calculado' },
  { pattern: /\b(não pode excluir|nao pode excluir|impedir|bloquear|somente se|só pode|apenas se)\b/, topic: 'regra de negócio', covered: (spec) => (spec.rules ?? []).some((rule) => rule.type === 'blockDelete') },
  { pattern: /\b(vinculad\w*|associad\w*|pertence\w*|relacionad\w*|ligad\w* a)\b/, topic: 'vínculo com outro cadastro', covered: (spec) => spec.fields.some((field) => field.type === 'reference') },
  { pattern: /\b(status|situação|situacao|categoria|tipo de|opções|opcoes)\b/, topic: 'lista de opções', covered: (spec) => spec.fields.some((field) => field.type === 'enum') },
  { pattern: /\b(antes d[aeo]|depois d[aeo]|maior que|menor que|posterior|anterior)\b/, topic: 'regra entre campos', covered: (spec) => (spec.rules ?? []).some((rule) => rule.type === 'compare') },
];

function normalizeText(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function coverageWarnings(request, spec) {
  const optionWords = new Set(spec.fields.flatMap((field) => field.options ?? []).map((option) => normalizeText(option.label)));
  const text = request.toLowerCase();
  const unsupported = normalizeText((spec.unsupported ?? []).join(' '));
  const warnings = [];

  for (const item of COVERAGE_TOPICS) {
    const match = text.match(item.pattern);

    if (!match) {
      continue;
    }

    const word = normalizeText(match[0]);

    if (optionWords.has(word)) {
      continue;
    }

    const mentionedInUnsupported = unsupported.includes(word) || unsupported.includes(normalizeText(item.topic.split('/')[0]));

    if (!mentionedInUnsupported && !(item.covered?.(spec))) {
      warnings.push(`O pedido fala em "${match[0]}" (${item.topic}), mas nada no plano trata disso. Confira se não ficou de fora.`);
    }
  }

  return warnings;
}

function kindWarnings(covered, spec) {
  const warnings = [];

  for (const item of covered) {
    const fields = spec.fields.filter((field) => field.source === item.id);

    if (item.kind === 'vinculo' && fields.length > 0 && !fields.some((field) => field.type === 'reference')) {
      warnings.push(`Requisito #${item.id} "${item.text}" parece um vínculo com outro cadastro, mas virou o campo ${fields[0].name} (${fields[0].type}). Se for vínculo, troque para "reference" no plano.`);
    }
  }

  return warnings;
}

export function finishCoverage(requirements, prepared) {
  const covered = coverage(requirements, prepared.spec);

  for (const item of covered.filter((entry) => entry.coveredBy.length === 0)) {
    const text = `Requisito não interpretado: "${item.text}". Implemente à mão ou reescreva o pedido deixando esse ponto mais claro.`;
    prepared.spec.unsupportedItems.push({ source: item.id, text });
    prepared.spec.unsupported.push(text);
    prepared.warnings.push(`O requisito #${item.id} "${item.text}" não entrou no plano e foi para "não coberto".`);
    item.coveredBy.push('não coberto');
  }

  prepared.warnings.push(...kindWarnings(covered, prepared.spec));
  return covered;
}

export async function createPlan({ projectDir, config, request, onProgress, onStage = () => {} }) {
  const analysis = analyzeRequest(request);
  const profile = await detectProfile(projectDir);
  const geracao = config.ai.geracao ?? 'auto';

  if (geracao === 'livre') {
    return { blocked: true, analysis, message: 'ai.geracao está como "livre": o pedido vai direto para o Claude.' };
  }

  if (geracao === 'exemplo') {
    profile.capabilities = { ...profile.capabilities, menu: false, frontend: false, fullstack: false };
  }

  const bespoke = analysis.scope === 'frontend' && analysis.structured && !/\bcadastr/i.test(request);

  if (bespoke && profile.capabilities.menu) {
    return createPagePlan({ projectDir, config, request, analysis, onProgress, onStage });
  }

  if (analysis.intent === 'consulta') {
    if (analysis.scope === 'frontend') {
      return { blocked: true, analysis, message: 'O pedido é só frontend, e a consulta do detro sempre cria backend. Se for uma tela sob medida (chat, painel interativo), ela está fora dos formatos do detro: peça direto ao Claude.' };
    }

    if (!profile.capabilities.fullstack) {
      return { blocked: true, analysis, message: `Consulta especializada precisa das convenções do detro, que este projeto não tem (${missingFor(profile, 'fullstack').slice(0, 3).join('; ')}). Peça como cadastro ("cadastro de ...") para o detro copiar uma feature existente, ou como mudança pontual num arquivo.` };
    }

    return createQueryPlan({ projectDir, config, request, analysis, onProgress, onStage });
  }

  if (analysis.intent === 'menu' && profile.capabilities.menu) {
    return createMenuPlan({ projectDir, config, request, onProgress, onStage });
  }

  const editVerbs = /\b(mud|alter|ajust|troc|corrig|consert|adicion|inclu|acrescent|remov|tir|deix|coloc|mostr|exib|esconde|ocult|desabilit|habilit|valid)\w*/i;

  if (['correcao', 'alteracao', 'menu'].includes(analysis.intent) || (!analysis.creates && !analysis.structured && editVerbs.test(request))) {
    onStage('Procurando a tela ou o arquivo citado');
    const targets = await resolveTargets(projectDir, request);

    if (targets.length === 1) {
      return { kind: 'edit', target: targets[0], instructions: request };
    }

    if (targets.length > 1) {
      return { blocked: true, analysis, message: `O pedido pode ser sobre mais de uma tela: ${targets.map((item) => `${item.file} (${item.reason})`).join('; ')}. Diga o nome exato da tela ou cite o arquivo.` };
    }

    if (analysis.intent !== 'crud') {
      return { blocked: true, analysis, message: 'Não identifiquei qual tela ou arquivo mudar. Cite o nome da tela como aparece no menu (ex.: "na tela de Paradas ...") ou o caminho do arquivo (ex.: web/src/pages/Stops.tsx).' };
    }
  }

  const intentMessage = describeIntent(analysis.intent);

  if (intentMessage) {
    return { blocked: true, analysis, message: intentMessage };
  }

  const specialized = analysis.scope === 'frontend' ? profile.capabilities.frontend : profile.capabilities.fullstack;

  if (!specialized) {
    return createExamplePlan({ projectDir, config, request, analysis, onProgress, onStage });
  }

  const ollama = requireOllama(config);
  const screens = await listScreens(projectDir);
  const references = referenceableTables(await listTables(projectDir));

  if (screens.length === 0) {
    throw new Error('Não encontrei as telas de permissão (ScreenKey) em web/src/lib/screens.ts e api/src/modules/permissions/screens.ts.');
  }

  if (analysis.structured || !bulletRequirements(request)) {
    onStage(analysis.structured ? 'Lendo as seções de dados do documento' : 'Separando o pedido em requisitos');
  }

  const extracted = await extractRequirements({ ollama, request, analysis, onProgress });
  const { requirements } = extracted;

  if (requirements.length === 0) {
    throw new Error('Não consegui separar o pedido em requisitos. Descreva o cadastro e os dados, ex.: "cadastro de garagens com nome, endereço e capacidade".');
  }

  onStage(`Montando a especificação (${requirements.length} requisitos)`);

  const schema = specSchema(screens.map((screen) => screen.key), references.map((table) => table.name));
  const messages = [
    { role: 'system', content: systemPrompt(screens, references) },
    { role: 'user', content: planRequest(EXAMPLE_REQUEST, EXAMPLE_REQUIREMENTS) },
    { role: 'assistant', content: JSON.stringify(EXAMPLE_SPEC) },
    { role: 'user', content: planRequest(request, requirements, analysis) },
  ];

  let raw = await ollamaJson({ ollama, schema, onProgress, messages });
  let prepared = await prepareSpec(projectDir, raw, requirements, analysis);
  let missing = coverage(requirements, prepared.spec).filter((item) => item.coveredBy.length === 0);

  if (missing.length > 0) {
    onStage(`Revisando ${missing.length} requisito(s) que ficaram de fora`);

    raw = await ollamaJson({
      ollama,
      schema,
      onProgress,
      messages: [
        ...messages,
        { role: 'assistant', content: JSON.stringify(raw) },
        {
          role: 'user',
          content: `Estes requisitos não aparecem em nenhum campo, regra ou unsupported:\n${missing.map((item) => `#${item.id} [${item.kind}] ${item.text}`).join('\n')}\n\nDevolva o JSON COMPLETO de novo, incluindo-os com "source".`,
        },
      ],
    });

    prepared = await prepareSpec(projectDir, raw, requirements, analysis);
    missing = coverage(requirements, prepared.spec).filter((item) => item.coveredBy.length === 0);
  }

  const covered = finishCoverage(requirements, prepared);
  prepared.warnings.push(...coverageWarnings(analysis.structured && analysis.dataText ? analysis.dataText : request, prepared.spec));

  return { raw, requirements, covered, analysis, extractedFrom: analysis.structured ? 'documento' : extracted.source, ...prepared };
}
