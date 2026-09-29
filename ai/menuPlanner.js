import { listScreens } from './catalog.js';
import { requireOllama } from './config.js';
import { MENU_OPERATIONS, planMenuOperation, readMenu } from './menu.js';
import { ollamaJson } from './ollama.js';

const SYSTEM = `
Você interpreta um pedido de ajuste no menu lateral do painel do projeto. Responda SOMENTE com JSON.

- type: "move" (mudar o item de grupo), "rename" (trocar o nome exibido), "icon" (trocar o ícone) ou "permission" (trocar a permissão exigida).
- item: o item do menu citado, EXATAMENTE como aparece na lista ITENS.
- group: só para "move": o grupo de destino, EXATAMENTE como na lista GRUPOS.
- label: só para "rename": o novo nome.
- icon: só para "icon": nome do ícone do lucide-react em PascalCase.
- permission: a permissão (tela) pedida, EXATAMENTE como na lista PERMISSÕES; "" se o pedido não falar de permissão.
`.trim();

function schema(menu, screens) {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: MENU_OPERATIONS },
      item: { type: 'string', enum: menu.items.map((item) => item.label) },
      group: { type: 'string', enum: ['', ...menu.groups.map((group) => group.label)] },
      label: { type: 'string' },
      icon: { type: 'string' },
      permission: { type: 'string', enum: ['', ...screens] },
    },
    required: ['type', 'item', 'group', 'label', 'icon', 'permission'],
  };
}

function context(menu, screens) {
  return [
    `GRUPOS: ${menu.groups.map((group) => group.label).join(' | ')}`,
    'ITENS (grupo › item [permissão]):',
    ...menu.items.map((item) => `- ${item.group}${item.parent ? ` › ${item.parent}` : ''} › ${item.label}${item.screen ? ` [${item.screen}]` : ''}`),
    `PERMISSÕES: ${screens.map((screen) => `${screen.key} (${screen.label})`).join(', ')}`,
  ].join('\n');
}

export async function createMenuPlan({ projectDir, config, request, onProgress, onStage = () => {} }) {
  const ollama = requireOllama(config);
  onStage('Lendo o menu do projeto');
  const menu = await readMenu(projectDir);
  const screens = await listScreens(projectDir);

  onStage('Interpretando o ajuste de menu');

  const raw = await ollamaJson({
    ollama,
    schema: schema(menu, screens.map((screen) => screen.key)),
    onProgress,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `MENU DO PROJETO:\n${context(menu, screens)}\n\nPEDIDO:\nmover empresas para planejamento e usar a permissão de grades` },
      { role: 'assistant', content: JSON.stringify({ type: 'move', item: 'Empresas', group: 'Planejamento', label: '', icon: '', permission: 'schedules' }) },
      { role: 'user', content: `MENU DO PROJETO:\n${context(menu, screens)}\n\nPEDIDO:\n${request}` },
    ],
  });

  const operation = {
    type: raw.type,
    item: raw.item,
    ...(raw.type === 'move' ? { group: raw.group } : {}),
    ...(raw.type === 'rename' ? { label: raw.label } : {}),
    ...(raw.type === 'icon' ? { icon: raw.icon } : {}),
    ...(raw.permission ? { permission: raw.permission } : {}),
  };

  const preview = await planMenuOperation({ projectDir, operation });
  return { kind: 'menu', operation, preview };
}
