import { ollamaJson } from './ollama.js';

export const REQUIREMENT_KINDS = ['campo', 'vinculo', 'opcoes', 'regra', 'arquivo', 'calculo', 'outro'];

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;

const REQUIREMENTS_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: REQUIREMENT_KINDS },
          field: { type: 'string' },
          required: { type: 'boolean' },
          options: { type: 'array', items: { type: 'string' } },
          values: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'kind'],
      },
    },
  },
  required: ['subject', 'requirements'],
};

const REQUIREMENTS_SYSTEM = `
Você separa um pedido de cadastro em requisitos atômicos. Responda SOMENTE com JSON.

- subject: o que está sendo cadastrado, em português, no singular (ex.: "contrato de manutenção").
- requirements: um item por informação ou regra pedida, na ordem do pedido, com o texto do próprio pedido (curto).
  - kind "campo": um dado simples (nome, endereço, valor, data, quantidade, sim/não).
  - kind "vinculo": ligação com outro cadastro ("empresa contratada", "veículo atendido", "escola do aluno").
  - kind "opcoes": escolha entre opções fixas (situação, tipo, categoria). Em "options", as opções escritas no pedido.
  - kind "regra": restrição ("fim não pode ser antes do início", "não pode excluir se...").
  - kind "arquivo": foto, anexo, PDF, upload.
  - kind "calculo": valor calculado automaticamente, total, soma, média.
  - kind "outro": qualquer outra coisa (relatório, integração, notificação).
- Não invente requisitos que o pedido não cita. Não junte dois dados num item só.
- field: se o pedido der o identificador técnico entre crases (ex.: \`name\`), copie-o.
- required: true se o pedido disser obrigatório; false se disser opcional; omita se não disser.
- Se o mesmo dado aparecer em mais de um lugar (lista de dados e detalhes do formulário), gere UM requisito só, juntando tudo.
- Opções com valor técnico e rótulo (ex.: \`low\` → Baixa): "options" são os rótulos em português e "values" os valores técnicos, na mesma ordem.
- Ignore o que for sobre a tela (listagem, botões, colunas, rotas, estilo) e sobre o que NÃO fazer: só dados e regras do cadastro.
`.trim();

const STRUCTURED_EXAMPLE_REQUEST = `## Dados
- \`code\`: código do item
- \`kind\`: tipo do item
- \`notes\`: observações

Os valores de \`kind\` são \`internal\` e \`external\`, exibidos como Interno e Externo.

### Código
- obrigatório;
- não repetir.

### Observações
- opcional.`;

const STRUCTURED_EXAMPLE_RESULT = {
  subject: 'item',
  requirements: [
    { text: 'código do item, obrigatório, não repetir', kind: 'campo', field: 'code', required: true },
    { text: 'tipo do item (Interno, Externo)', kind: 'opcoes', field: 'kind', options: ['Interno', 'Externo'], values: ['internal', 'external'] },
    { text: 'observações', kind: 'campo', field: 'notes', required: false },
  ],
};

export const EXAMPLE_REQUEST = 'cadastro de garagens com nome, empresa responsável, endereço, capacidade de ônibus, situação (operando, em reforma ou fechada), data de abertura e data de encerramento que não pode ser antes da abertura, não pode excluir garagem operando, foto da fachada e total de ônibus estacionados calculado automaticamente';

export const EXAMPLE_RESULT = {
  subject: 'garagem',
  requirements: [
    { text: 'nome', kind: 'campo' },
    { text: 'empresa responsável', kind: 'vinculo' },
    { text: 'endereço', kind: 'campo' },
    { text: 'capacidade de ônibus', kind: 'campo' },
    { text: 'situação (operando, em reforma ou fechada)', kind: 'opcoes', options: ['operando', 'em reforma', 'fechada'] },
    { text: 'data de abertura', kind: 'campo' },
    { text: 'data de encerramento', kind: 'campo' },
    { text: 'encerramento não pode ser antes da abertura', kind: 'regra' },
    { text: 'não pode excluir garagem operando', kind: 'regra' },
    { text: 'foto da fachada', kind: 'arquivo' },
    { text: 'total de ônibus estacionados calculado automaticamente', kind: 'calculo' },
  ],
};

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function explicitOptions(text) {
  const inside = String(text ?? '').match(/\(([^()]+)\)/);
  const source = inside?.[1] ?? String(text ?? '').match(/\bentre\s+(.+)$/i)?.[1];

  if (!source) {
    return [];
  }

  const parts = source
    .split(/,|;|\/|\bou\b|\be\b/i)
    .map((part) => cleanText(part).replace(/^["']|["']$/g, ''))
    .filter((part) => part && part.length <= 40);

  return parts.length >= 2 ? [...new Set(parts)] : [];
}

export function bulletRequirements(request) {
  const lines = String(request).split('\n');
  const items = lines.map((line) => line.match(BULLET)?.[1]).filter(Boolean).map(cleanText);

  if (items.length < 2) {
    return null;
  }

  const header = lines.find((line) => line.trim() && !BULLET.test(line)) ?? '';
  return { subject: cleanText(header).replace(/[:.]$/, ''), items };
}

function inferKind(text) {
  const value = text.toLowerCase();

  if (/\b(foto|fotos|imagem|anexo|arquivo|pdf|upload)\b/.test(value)) {
    return 'arquivo';
  }

  if (/\b(calcul\w*|automaticamente|soma|total de|média)\b/.test(value)) {
    return 'calculo';
  }

  if (/\b(não pode|nao pode|somente se|só pode|apenas se|antes d[aeo]|depois d[aeo]|maior que|menor que)\b/.test(value)) {
    return 'regra';
  }

  if (explicitOptions(text).length >= 2) {
    return 'opcoes';
  }

  return 'campo';
}

export function requiredHint(text) {
  const value = String(text ?? '').toLowerCase();

  if (/\b(se houver|quando houver|se tiver|opcional|não obrigatóri[oa]|nao obrigatori[oa])\b/.test(value)) {
    return false;
  }

  if (/\bobrigat[óo]ri[oa]s?\b/.test(value)) {
    return true;
  }

  return undefined;
}

function finalize(subject, rawItems, request = '') {
  const requirements = rawItems
    .map((item) => ({ ...item, text: cleanText(item.text) }))
    .filter((item) => item.text)
    .map((item, index) => {
      const fromText = explicitOptions(item.text);
      const options = fromText.length >= 2 ? fromText : (item.options ?? []).map(cleanText).filter(Boolean);
      const kind = REQUIREMENT_KINDS.includes(item.kind) ? item.kind : inferKind(item.text);

      const required = requiredHint(item.text) ?? (typeof item.required === 'boolean' ? item.required : undefined);
      const values = (item.values ?? []).map(cleanText).filter(Boolean);
      const field = /^[A-Za-z][A-Za-z0-9_]*$/.test(String(item.field ?? '')) && String(request).includes(`\`${item.field}\``) ? item.field : undefined;
      const yesNo = options.length === 2 && options.every((option) => /^(sim|n[ãa]o|yes|no|true|false|ativo|inativo|verdadeiro|falso)$/i.test(option));

      return {
        id: index + 1,
        text: item.text,
        kind: yesNo && kind === 'opcoes' ? 'campo' : options.length >= 2 && kind === 'campo' && !yesNo ? 'opcoes' : kind,
        options: options.length >= 2 && !yesNo ? options : [],
        ...(options.length >= 2 && !yesNo && values.length === options.length ? { values } : {}),
        ...(field ? { field } : {}),
        ...(required === undefined ? {} : { required }),
        ...(/^(id|identificador)\b/i.test(field ?? item.text) ? { automatic: true } : {}),
      };
    });

  return { subject: cleanText(subject), requirements };
}

export async function extractRequirements({ ollama, request, analysis, onProgress }) {
  const bullets = analysis?.structured ? null : bulletRequirements(request);

  if (bullets) {
    return {
      ...finalize(bullets.subject, bullets.items.map((text) => ({ text, kind: inferKind(text) })), request),
      source: 'tópicos',
    };
  }

  const result = await ollamaJson({
    ollama,
    schema: REQUIREMENTS_SCHEMA,
    onProgress,
    messages: [
      { role: 'system', content: REQUIREMENTS_SYSTEM },
      { role: 'user', content: EXAMPLE_REQUEST },
      { role: 'assistant', content: JSON.stringify(EXAMPLE_RESULT) },
      { role: 'user', content: STRUCTURED_EXAMPLE_REQUEST },
      { role: 'assistant', content: JSON.stringify(STRUCTURED_EXAMPLE_RESULT) },
      { role: 'user', content: analysis?.structured && analysis.dataText ? analysis.dataText : request },
    ],
  });

  return {
    ...finalize(result.subject, Array.isArray(result.requirements) ? result.requirements : [], request),
    source: 'ia',
  };
}

export function renderRequirements(requirements) {
  return requirements
    .map((item) => `#${item.id} [${item.kind}] ${item.text}${item.options.length > 0 ? ` — opções: ${item.options.join(' | ')}` : ''}`)
    .join('\n');
}

export function coverage(requirements, spec) {
  const owners = new Map(requirements.map((item) => [item.id, []]));

  for (const field of spec.fields) {
    if (owners.has(field.source)) {
      owners.get(field.source).push(`campo ${field.name}${field.type === 'reference' ? ` (vínculo ${field.references.name})` : field.type === 'enum' ? ' (opções)' : ''}`);
    }
  }

  for (const rule of spec.rules ?? []) {
    if (owners.has(rule.source)) {
      owners.get(rule.source).push(rule.type === 'blockDelete' ? 'regra de exclusão' : `regra ${rule.left} ${rule.operator} ${rule.right}`);
    }
  }

  for (const item of spec.unsupportedItems ?? []) {
    if (owners.has(item.source)) {
      owners.get(item.source).push('não coberto');
    }
  }

  return requirements.map((item) => ({
    ...item,
    coveredBy: owners.get(item.id).length === 0 && item.automatic ? ['gerado automaticamente'] : owners.get(item.id),
  }));
}
