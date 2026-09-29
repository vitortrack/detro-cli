import { analyzeRequest } from './analysis.js';
import { applyEdits, literalEdits } from './editor.js';
import { insertMenuItem, readMenu } from './menu.js';
import { deriveQueryNames, normalizeQuerySpec } from './querySpec.js';
import { buildQueryApiClient, buildQueryController, buildQueryDto, buildQueryModule, buildQueryService, buildQueryWebTypes } from './templates/query.js';
import { listScreens, listTables, readProjectFile, referenceableTables } from './catalog.js';
import { bulletRequirements, coverage, explicitOptions } from './requirements.js';
import { deriveNames, normalizeSpec } from './spec.js';
import { buildController, buildDto, buildModule, buildService } from './templates/backend.js';
import { buildMigration } from './templates/database.js';
import { buildApiClient, buildWebTypes } from './templates/frontend.js';
import { patchAppModule, patchAppRoutes, patchScreens, patchSidebar } from './templates/patches.js';
import { loadTypeScript, syntaxCheck, typeCheck, typeCheckIsolated } from './typescript.js';

const SIMPLE = {
  entity: 'DetroSelftestTank',
  entityPlural: 'DetroSelftestTanks',
  labelSingular: 'tanque',
  labelPlural: 'tanques',
  gender: 'm',
  title: 'Tanques',
  route: '/detro-selftest-tanques',
  screen: 'vehicles',
  permissionMode: 'nova',
  menuIcon: 'Droplets',
  fields: [
    { source: 1, name: 'name', label: 'Nome', type: 'string', required: true, unique: true },
    { source: 2, name: 'capacity', label: 'Capacidade', type: 'decimal', required: true, min: 0 },
    { source: 3, name: 'notes', label: 'Observações', type: 'text', required: false },
    { source: 4, name: 'active', label: 'Ativo', type: 'boolean', required: false },
  ],
  rules: [],
  unsupported: [],
};

const COMPLEX_REQUIREMENTS = [
  { id: 1, text: 'nome', kind: 'campo', options: [] },
  { id: 2, text: 'empresa', kind: 'vinculo', options: [] },
  { id: 3, text: 'situação (vigente, suspenso ou encerrado)', kind: 'opcoes', options: ['vigente', 'suspenso', 'encerrado'] },
  { id: 4, text: 'início', kind: 'campo', options: [] },
  { id: 5, text: 'fim', kind: 'campo', options: [] },
  { id: 6, text: 'fim não pode ser antes do início', kind: 'regra', options: [] },
  { id: 7, text: 'não pode excluir vigente', kind: 'regra', options: [] },
  { id: 8, text: 'anexo em PDF', kind: 'arquivo', options: [] },
];

const COMPLEX = {
  entity: 'DetroSelftestContract',
  entityPlural: 'DetroSelftestContracts',
  labelSingular: 'contrato',
  labelPlural: 'contratos',
  gender: 'm',
  title: 'Contratos',
  route: '/detro-selftest-contratos',
  screen: 'vehicles',
  permissionMode: 'existente',
  menuIcon: 'ClipboardList',
  fields: [
    { source: 1, name: 'name', label: 'Nome', type: 'string', required: true, unique: true },
    { source: 2, name: 'company', label: 'Empresa', type: 'reference', required: true, references: 'companies' },
    { source: 3, name: 'status', label: 'Situação', type: 'enum', required: true, options: [{ value: 'suspended', label: 'Suspended' }, { value: 'active', label: 'Vigente' }, { value: 'closed', label: 'Encerrado' }] },
    { source: 4, name: 'startDate', label: 'Início', type: 'date', required: true },
    { source: 5, name: 'endDate', label: 'Fim', type: 'date', required: false },
    { source: 8, name: 'attachment', label: 'Anexo', type: 'text', required: false },
  ],
  rules: [
    { source: 6, type: 'compare', left: 'endDate', operator: '>=', right: 'startDate' },
    { source: 7, type: 'blockDelete', field: 'status', values: ['Vigente'] },
  ],
  unsupported: [],
};

const LOCAL_DOC = `# Feature: Cadastro de Tipos de Teste

## Funcionalidades
- cadastrar;
- editar;
- ativar ou desativar.

Os dados podem permanecer somente em memória. Não é necessário criar backend, API ou migration.

## Dados
- \`name\`: nome
- \`level\`: nível (\`low\`, \`high\`)
- \`active\`: ativo

## Tela
Criar uma página chamada \`DetroSelftestKindsPage\` com título "Tipos de teste" e botão "Novo tipo de teste".
Criar um modal chamado \`DetroSelftestKindFormModal\`.

## Restrições
Não criar:
- backend;
- migration.`;

const LOCAL_REQUIREMENTS = [
  { id: 1, text: 'nome obrigatório', kind: 'campo', field: 'name', required: true, options: [] },
  { id: 2, text: 'nível (Baixo, Alto)', kind: 'opcoes', field: 'level', options: ['Baixo', 'Alto'], values: ['low', 'high'] },
  { id: 3, text: 'ativo', kind: 'campo', field: 'active', options: [] },
  { id: 4, text: 'empresa', kind: 'vinculo', options: [] },
];

const LOCAL = {
  entity: 'Kind',
  entityPlural: 'Kinds',
  labelSingular: 'tipo de teste',
  labelPlural: 'tipos de teste',
  gender: 'm',
  title: 'Tipos',
  route: '/detro-selftest-tipos',
  screen: 'vehicles',
  permissionMode: 'nova',
  menuIcon: 'Tags',
  fields: [
    { source: 1, name: 'title', label: 'Nome', type: 'string', required: true, unique: true },
    { source: 2, name: 'level', label: 'Nível', type: 'enum', required: true, options: [{ value: 'b', label: 'Baixo' }, { value: 'a', label: 'Alto' }] },
    { source: 3, name: 'active', label: 'Ativo', type: 'boolean', required: false },
    { source: 4, name: 'company', label: 'Empresa', type: 'reference', required: false, references: 'companies' },
  ],
  rules: [],
  unsupported: [],
};

function check(results, name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
}

function stubModal(names) {
  return `import type { ${names.entity} } from '@/types/${names.kebab}';

export function ${names.entity}FormModal({ value }: { value: ${names.entity} | null }) {
  return <div>{value?.id}</div>;
}
`;
}

function stubPage(names) {
  return `export function ${names.entityPlural}Page() {
  return <div />;
}
`;
}

async function buildFixture(projectDir, raw, requirements, context, analysis = null) {
  const { spec, errors, warnings } = normalizeSpec(raw, { ...context, requirements, analysis });
  const names = deriveNames(spec, '999');
  const ts = loadTypeScript(projectDir, 'web');
  const files = new Map();
  const base = { spec, names };

  const local = spec.scope === 'frontend';

  if (!local && spec.permissionMode === 'nova') {
    for (const key of ['webScreens', 'apiScreens']) {
      const original = await readProjectFile(projectDir, names.files[key]);
      files.set(names.files[key], patchScreens({ ts, content: original, fileName: names.files[key], relatedKey: spec.screen, key: names.permission, label: spec.title }).content);
    }
  }

  if (!local) {
    files.set(names.files.dto, buildDto(base));
    files.set(names.files.service, buildService(base));
    files.set(names.files.controller, buildController(base));
    files.set(names.files.module, buildModule(base));
    files.set(names.files.apiClient, buildApiClient(base));
  }

  files.set(names.files.type, buildWebTypes(base));
  files.set(names.files.formModal, stubModal(names));
  files.set(names.files.page, stubPage(names));
  files.set(names.files.app, patchAppRoutes({ ts, content: await readProjectFile(projectDir, names.files.app), spec, names }).content);
  files.set(names.files.sidebar, patchSidebar({ ts, content: await readProjectFile(projectDir, names.files.sidebar), spec, names }).content);

  const appModule = patchAppModule({ ts, content: await readProjectFile(projectDir, names.files.appModule), names }).content;
  const migration = buildMigration({ ...base, number: '999' });

  return { spec, names, errors, warnings, files, appModule, migration };
}

export async function runSelftest({ projectDir, onStage = () => {} }) {
  const results = [];

  check(results, 'opções entre parênteses', JSON.stringify(explicitOptions('situação (vigente, suspenso ou encerrado)')) === JSON.stringify(['vigente', 'suspenso', 'encerrado']));
  check(results, 'pedido em tópicos', bulletRequirements('Cadastro de tanques:\n- nome\n- capacidade\n- ativo')?.items.length === 3);

  const localAnalysis = analyzeRequest(LOCAL_DOC);
  check(results, 'documento: escopo só frontend', localAnalysis.scope === 'frontend');
  check(results, 'documento: nomes, título e botão exigidos', localAnalysis.names.page === 'DetroSelftestKindsPage' && localAnalysis.names.modal === 'DetroSelftestKindFormModal' && localAnalysis.title === 'Tipos de teste' && localAnalysis.createLabel === 'Novo tipo de teste');
  check(results, 'documento: ações (sem excluir, com ativar/desativar)', localAnalysis.actions.delete === false && localAnalysis.actions.toggleActive === true);
  check(results, 'triagem: correção', analyzeRequest('corrigir o erro ao salvar na tela de paradas').intent === 'correcao');
  check(results, 'triagem: "Corrigir" com seções vira correção', analyzeRequest('# Corrigir a mensagem de validação\n\n## Detalhe\n\nArquivo: api/src/main.ts').intent === 'correcao');
  const literal = literalEdits('Trecho atual:\n\n```ts\nconst a = 1;\n```\n\nTrecho novo:\n\n```ts\nconst a = 2;\n```');
  check(results, 'lote: trechos literais do pedido', literal.length === 1 && applyEdits('const a = 1;\n', literal).content === 'const a = 2;\n');
  check(results, 'triagem: alteração', analyzeRequest('adicionar o campo telefone na tela de motoristas').intent === 'alteracao');
  check(results, 'triagem: cadastro', analyzeRequest('cadastro de garagens com nome e endereço').intent === 'crud');
  check(results, 'triagem: consulta nova ("nova tela ... nesta listagem")', analyzeRequest('Crie uma nova tela que liste veiculos com km inferior a 20000, com filtros e informações nesta listagem como placa, em um submenu de veículos').intent === 'consulta');
  check(results, 'triagem: alteração de tela existente não vira consulta', analyzeRequest('na tela de Paradas mostrar a coluna código').intent !== 'consulta');
  check(results, 'triagem: menu', analyzeRequest('mova tipos de ocorrência do menu para rotas e operação').intent === 'menu');
  check(results, 'triagem: texto entre aspas não vira cadastro', analyzeRequest('na tela de Paradas trocar o botão para "Cadastrar parada"').creates === false);

  const sample = 'function A() {\n  return (\n    <button>\n      Nova parada\n    </button>\n  );\n}\nconst title = \'Nova parada\';\n';
  const flat = applyEdits(sample, [{ find: '<button>\nNova parada\n</button>', replace: '<button>\nCadastrar parada\n</button>' }]);
  check(results, 'edição: trecho sem indentação é reindentado', flat.problems.length === 0 && flat.content.includes('    <button>\n      Cadastrar parada\n    </button>'), JSON.stringify(flat));
  const inline = applyEdits(sample, [{ find: "const title = 'Nova parada';", replace: "const title = 'Parada';" }]);
  check(results, 'edição: troca exata', inline.problems.length === 0 && inline.content.includes("const title = 'Parada';") && inline.content.includes('      Nova parada'));
  const ambiguous = applyEdits(sample, [{ find: 'Nova parada', replace: 'X' }]);
  check(results, 'edição: trecho repetido é recusado', ambiguous.problems.length === 1 && ambiguous.content === sample);

  for (const workspace of ['web', 'api']) {
    check(results, `TypeScript em ${workspace}/node_modules`, loadTypeScript(projectDir, workspace));
  }

  if (results.some((item) => !item.ok)) {
    return results;
  }

  const context = {
    screens: (await listScreens(projectDir)).map((screen) => screen.key),
    references: referenceableTables(await listTables(projectDir)),
  };

  for (const [label, raw, requirements, analysis] of [['simples', SIMPLE, [], null], ['vínculo/opções/regras', COMPLEX, COMPLEX_REQUIREMENTS, null], ['só frontend', LOCAL, LOCAL_REQUIREMENTS, localAnalysis]]) {
    onStage(`Gerando a feature de teste (${label})`);
    const fixture = await buildFixture(projectDir, raw, requirements, context, analysis);

    if (label === 'só frontend') {
      const level = fixture.spec.fields.find((field) => field.name === 'level');
      check(results, `[${label}] nomes do pedido prevalecem`, fixture.spec.entity === 'DetroSelftestKind' && fixture.names.files.page.endsWith('DetroSelftestKindsPage.tsx') && fixture.spec.title === 'Tipos de teste');
      check(results, `[${label}] campo renomeado para o identificador do pedido`, fixture.spec.fields.some((field) => field.name === 'name'));
      check(results, `[${label}] valores técnicos das opções vêm do pedido`, level?.options.map((option) => `${option.value}=${option.label}`).join(',') === 'low=Baixo,high=Alto');
      check(results, `[${label}] vínculo fora (sem API)`, !fixture.spec.fields.some((field) => field.type === 'reference') && fixture.spec.unsupportedItems.some((item) => item.source === 4));
      check(results, `[${label}] tela sem excluir, com ativar/desativar e badge`, fixture.spec.page.delete === false && fixture.spec.page.toggleActive && fixture.spec.page.statusBadge);
      check(results, `[${label}] tipos têm o montador local`, /export function buildDetroSelftestKind\(/.test(fixture.files.get(fixture.names.files.type)));
    }

    check(results, `[${label}] plano sem erros`, fixture.errors.length === 0, fixture.errors.join('; '));

    const again = normalizeSpec(JSON.parse(JSON.stringify(fixture.spec)), { ...context, requirements });
    check(results, `[${label}] revalidar não muda o plano`, JSON.stringify(again.spec) === JSON.stringify(fixture.spec));

    if (label === 'vínculo/opções/regras') {
      const status = fixture.spec.fields.find((field) => field.name === 'status');
      check(results, `[${label}] opções seguem o pedido`, status?.options.map((option) => option.label).join('|') === 'Vigente|Suspenso|Encerrado', status?.options.map((option) => `${option.value}=${option.label}`).join(', '));
      check(results, `[${label}] regra de exclusão aponta para "Vigente"`, fixture.spec.rules.some((rule) => rule.type === 'blockDelete' && rule.values.includes('active')), JSON.stringify(fixture.spec.rules));
      check(results, `[${label}] anexo foi para "não coberto"`, !fixture.spec.fields.some((field) => field.name === 'attachment') && fixture.spec.unsupportedItems.some((item) => item.source === 8));
      check(results, `[${label}] todo requisito tem dono`, coverage(requirements, fixture.spec).every((item) => item.coveredBy.length > 0));
      check(results, `[${label}] migration tem FK, CHECK IN e CHECK de datas`, /REFERENCES companies\(id\)/.test(fixture.migration) && /status IN \(/.test(fixture.migration) && /end_date >= start_date/.test(fixture.migration));
    }

    if (fixture.spec.scope !== 'frontend') {
      const syntax = syntaxCheck(projectDir, fixture.names.files.appModule, fixture.appModule) ?? [];
      check(results, `[${label}] app.module.ts (sintaxe)`, syntax.length === 0, syntax.map((item) => item.message).join('; '));
    }

    onStage(`Compilando a feature de teste (${label}) com o TypeScript do projeto`);
    const targets = [...fixture.files.keys()];
    const { diagnostics } = await typeCheckIsolated(projectDir, { virtualFiles: fixture.files, targets });

    for (const [file, items] of diagnostics) {
      check(results, `[${label}] ${file}`, items.length === 0, items.slice(0, 3).map((item) => `linha ${item.line}: ${item.message}`).join('; '));
    }
  }

  const reactSample = `import { useEffect, useMemo, useState } from 'react';

export function DetroSelftestReact({ flag }: { flag: boolean }) {
  const [items, setItems] = useState<number[]>([1]);
  const [selected] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const first = useMemo(() => items[0], [items]);
  const sorted = useMemo(() => items.sort(), [items]);
  const copy = useMemo(() => [...items].sort(), [items]);

  useEffect(() => {
    if (first) setItems((current) => current.map((item) => item));
  }, [first]);

  useEffect(() => {
    if (flag || query === 'x') return;
    setQuery('x');
  }, [flag, query]);

  return <div>{selected}{first}{sorted[0]}{copy[0]}</div>;
}
`;
  const reactFile = 'web/src/pages/DetroSelftestReact.tsx';
  const reactRules = (typeCheck(projectDir, { virtualFiles: new Map([[reactFile, reactSample]]), targets: [reactFile], lint: true }).diagnostics.get(reactFile) ?? []).map((item) => item.rule).filter(Boolean);
  check(results, 'lint: loop de useEffect detectado', reactRules.filter((rule) => rule === 'effect-loop').length === 1, reactRules.join(', '));
  check(results, 'lint: mutação de estado detectada (só a sem cópia)', reactRules.filter((rule) => rule === 'state-mutation').length === 1, reactRules.join(', '));
  check(results, 'lint: estado sem setter detectado', reactRules.includes('state-without-setter'), reactRules.join(', '));

  onStage('Gerando a consulta de teste (veículos com filtro fixo e filtros de tela)');
  const vehicles = (await listTables(projectDir)).get('vehicles');

  if (vehicles) {
    const menu = await readMenu(projectDir);
    const query = normalizeQuerySpec({
      entity: 'DetroSelftestLowKm',
      title: 'Teste de consulta',
      subtitle: '',
      route: '/detro-selftest-consulta',
      menuIcon: 'Gauge',
      menu: { group: 'Gestão de frota', parent: 'Veículos', after: 'Lista de veículos' },
      columns: [{ column: 'id', label: 'Id' }, { column: 'plate', label: 'Placa' }, { column: 'odometer_current_km', label: 'Km total' }, { column: 'active', label: 'Ativo' }, { column: 'created_at', label: 'Criado em' }],
      conditions: [{ column: 'odometer_current_km', operator: '<', value: '20000' }, { column: 'plate', operator: 'contains', value: "a'b" }],
      filters: [{ column: 'plate', kind: 'search', label: 'Placa' }, { column: 'odometer_current_km', kind: 'range', label: 'Km' }, { column: 'active', kind: 'boolean', label: 'Ativo' }, { column: 'created_at', kind: 'range', label: 'Criado em' }],
      orderBy: { column: 'odometer_current_km', direction: 'asc' },
      unsupported: [],
    }, { table: 'vehicles', tableInfo: vehicles, menu });
    const names = deriveQueryNames(query.spec);
    const base = { spec: query.spec, names };
    const service = buildQueryService(base);

    check(results, '[consulta] colunas, condições e filtros reconhecidos', query.errors.length === 0 && query.spec.columns.length === 5 && query.spec.conditions.length === 2 && query.spec.filters.length === 4, JSON.stringify(query.errors));
    check(results, '[consulta] valores entram como parâmetro, não no SQL', !service.includes("a'b%'") && service.includes('params.push("%a\'b%")') && service.includes('params.push(20000)'));
    check(results, '[consulta] filtra pela operadora', service.includes("'t.operator_id = $1'"));

    const ts = loadTypeScript(projectDir, 'web');
    const files = new Map([
      [names.files.dto, buildQueryDto(base)],
      [names.files.service, service],
      [names.files.controller, buildQueryController(base)],
      [names.files.module, buildQueryModule(base)],
      [names.files.type, buildQueryWebTypes(base)],
      [names.files.apiClient, buildQueryApiClient(base)],
      [names.files.sidebar, insertMenuItem({ ts, content: await readProjectFile(projectDir, names.files.sidebar), placement: query.spec.menu, entry: { to: query.spec.route, icon: 'Gauge', label: 'Teste de consulta', screen: 'vehicles' } })],
    ]);

    check(results, '[consulta] submenu entra depois de "Lista de veículos"', /Lista de veículos[\s\S]{0,120}\},\s*\{\s*to: '\/detro-selftest-consulta'/.test(files.get(names.files.sidebar)));

    onStage('Compilando a consulta de teste com o TypeScript do projeto');
    const { diagnostics } = await typeCheckIsolated(projectDir, { virtualFiles: files, targets: [...files.keys()] });

    for (const [file, items] of diagnostics) {
      check(results, `[consulta] ${file}`, items.length === 0, items.slice(0, 3).map((item) => `linha ${item.line}: ${item.message}`).join('; '));
    }
  }

  return results;
}
