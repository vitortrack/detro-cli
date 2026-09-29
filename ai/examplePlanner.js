import { requireOllama } from './config.js';
import { findRegistrations, listFeatures } from './example.js';
import { planExampleFiles } from './exampleGenerator.js';
import { ollamaJson } from './ollama.js';
import { coverage, extractRequirements, renderRequirements } from './requirements.js';
import { FIELD_TYPES, normalizeSpec, specSchema } from './spec.js';

const SYSTEM = `
Você transforma REQUISITOS numerados em uma especificação JSON de cadastro (entidade e campos). Responda SOMENTE com o JSON.

- entity / entityPlural: nome em inglês, PascalCase (ex.: Supplier / Suppliers).
- labelSingular / labelPlural: nome curto em português, minúsculo. gender: "f" ou "m". title: título curto.
- route: rota em português, minúsculo, sem acento, com hífen. screen, permissionMode, menuIcon: use "", "nova" e "List".
- fields: um campo por requisito de dado, cada um com "source" (número do requisito). name em camelCase inglês; label em português;
  type: ${FIELD_TYPES.filter((type) => type !== 'reference').join(' | ')}; enum com "options" [{value, label}] exatamente como no requisito.
- rules: [] (ou compare entre dois campos do mesmo tipo, quando o requisito pedir).
- unsupported: [{source, text}] para o que não é um dado simples (upload, cálculo, vínculo com outro cadastro, relatório).
`.trim();

export async function createExamplePlan({ projectDir, config, request, analysis, onProgress, onStage = () => {} }) {
  const ollama = requireOllama(config);

  onStage('Procurando uma feature parecida neste projeto para usar de modelo');
  const features = await listFeatures(projectDir);

  if (features.length === 0) {
    return { blocked: true, message: 'Não achei nenhuma feature com arquivos em mais de uma camada para usar de modelo. Crie a primeira feature à mão; o detro passa a copiar o padrão dela.' };
  }

  onStage('Separando o pedido em requisitos');
  const { requirements } = await extractRequirements({ ollama, request, analysis, onProgress });

  onStage(`Montando a especificação (${requirements.length} requisitos)`);
  const raw = await ollamaJson({
    ollama,
    schema: specSchema([], []),
    onProgress,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'PEDIDO:\ncadastro de garagens com nome obrigatório, endereço, capacidade de ônibus e se está ativa\n\nREQUISITOS:\n#1 [campo] nome obrigatório\n#2 [campo] endereço\n#3 [campo] capacidade de ônibus\n#4 [campo] se está ativa' },
      { role: 'assistant', content: JSON.stringify({ entity: 'Garage', entityPlural: 'Garages', labelSingular: 'garagem', labelPlural: 'garagens', gender: 'f', title: 'Garagens', route: '/garagens', screen: '', permissionMode: 'nova', menuIcon: 'List', fields: [{ source: 1, name: 'name', label: 'Nome', type: 'string', required: true }, { source: 2, name: 'address', label: 'Endereço', type: 'string', required: false }, { source: 3, name: 'busCapacity', label: 'Capacidade de ônibus', type: 'integer', required: false, min: 0 }, { source: 4, name: 'active', label: 'Ativa', type: 'boolean', required: false }], rules: [], unsupported: [] }) },
      { role: 'user', content: `PEDIDO:\n${request}\n\nREQUISITOS:\n${renderRequirements(requirements)}` },
    ],
  });

  const { spec, errors, warnings } = normalizeSpec({ ...raw, screen: '' }, { requirements, analysis: { ...analysis, scope: 'frontend', names: analysis?.names ?? {} } });
  const reference = features[0];
  const registrations = await findRegistrations(projectDir, reference.files);
  const example = { stem: reference.stem, files: reference.files, registrations };
  const preview = await planExampleFiles(projectDir, example, spec);

  return {
    kind: 'example',
    spec,
    example,
    newFiles: preview.files,
    alternatives: features.slice(1, 5).map((feature) => `${feature.stem} (${feature.files.length} arquivos)`),
    requirements,
    covered: coverage(requirements, spec),
    errors: [...errors.filter((item) => !/"screen"/.test(item)), ...preview.errors],
    warnings,
  };
}
