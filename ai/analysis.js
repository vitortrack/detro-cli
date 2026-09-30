const DATA_SECTION = /\b(dados|campos|atributos|modelo|estrutura|cadastro e edi|formul[áa]rio|informa[çc][õo]es)\b/i;
const RESTRICTION_SECTION = /\b(restri[çc][õo]es|n[ãa]o criar|n[ãa]o fazer|proibi|limita[çc][õo]es|fora do escopo)\b/i;

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function splitSections(text) {
  const sections = [];
  let current = { title: '', level: 0, lines: [] };

  for (const line of String(text).split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);

    if (heading) {
      sections.push(current);
      current = { title: heading[2].trim(), level: heading[1].length, lines: [] };
      continue;
    }

    current.lines.push(line);
  }

  sections.push(current);

  return sections
    .map((section) => ({ title: section.title, level: section.level, body: section.lines.join('\n').trim() }))
    .filter((section) => section.title || section.body);
}

function withParents(sections) {
  const stack = [];

  return sections.map((section) => {
    while (stack.length > 0 && stack.at(-1).level >= section.level && section.level > 0) {
      stack.pop();
    }

    const path = [...stack.map((item) => item.title), section.title].filter(Boolean).join(' › ');

    if (section.level > 0) {
      stack.push(section);
    }

    return { ...section, path };
  });
}

function negatedNear(text, index, window = 40) {
  return /\b(n[ãa]o|sem|nunca|jamais)\b[^.\n]*$/i.test(text.slice(Math.max(0, index - window), index));
}

function mention(text, pattern) {
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let positive = false;
  let negative = false;

  for (const match of text.matchAll(regex)) {
    if (negatedNear(text, match.index)) {
      negative = true;
    } else {
      positive = true;
    }
  }

  return { positive, negative, any: positive || negative };
}

function quoted(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

export function createsSomething(text) {
  const value = normalize(String(text).replace(/["“'`][^"”'`\n]*["”'`]/g, ' '));
  return /\b(cadastros? de|criar (uma |um )?(nova |novo )?(tela|pagina|feature|crud|cadastro|modulo)|crie (uma |um )?(nova |novo )?(tela|pagina|cadastro)|nova tela|novo cadastro|novo crud|nova feature|gerenciamento de)\b/.test(value);
}

function detectIntent(text, structured) {
  const value = normalize(text);
  const creates = createsSomething(text);

  if (!creates && /\b(corrig\w*|consert\w*|bug|nao funciona|quebrad\w*|esta dando erro|erro ao)\b/.test(value)) {
    return 'correcao';
  }

  const listing = /\b(listar|listagem|liste|consulta|consultar|relacao de|mostrar|mostre|exibir|visualizar|ver os|ver as)\b/.test(value);
  const crudVerbs = /\b(cadastr\w*|editar|excluir|incluir registro)\b/.test(value);

  const existingScreen = /\b(na|da|nesta|dessa|desta)\s+(tela|pagina|listagem)\b/.test(value) || /\b(coluna|campo|botao)\b/.test(value);

  if (listing && !crudVerbs && (!existingScreen || creates)) {
    return 'consulta';
  }

  if (!creates && /\b(menu|barra lateral|sidebar|item do menu)\b/.test(value) && /\b(mov|troc|pass|coloc|mud|renome|icone|permiss|transfer|leva|joga)\w*/.test(value)) {
    return 'menu';
  }

  if (!creates && /\b(adicionar|incluir|acrescentar|remover|mudar|alterar)\b[^.\n]{0,40}\b(campo|coluna|botao|filtro)\b/.test(value)) {
    return 'alteracao';
  }

  if (!creates && /\b(relatorio|dashboard|grafico|exportar|indicador)\b/.test(value)) {
    return 'relatorio';
  }

  if (!creates && !structured && value.split(/\s+/).length < 4) {
    return 'vago';
  }

  return 'crud';
}

export function analyzeRequest(request) {
  const text = String(request ?? '');
  const structured = /^#{1,6}\s/m.test(text);
  const sections = withParents(splitSections(text));
  const restrictionText = sections.filter((section) => RESTRICTION_SECTION.test(section.path)).map((section) => section.body).join('\n');
  const functionalText = sections.filter((section) => !RESTRICTION_SECTION.test(section.path)).map((section) => `${section.title}\n${section.body}`).join('\n');
  const dataSections = sections.filter((section) => DATA_SECTION.test(section.path) && !RESTRICTION_SECTION.test(section.path));
  const lower = normalize(text);

  const frontendOnly = [
    /\b(somente|apenas|so)\s+(em\s+|no\s+)?(memoria|estado local|front ?end)\b/,
    /\b(permanecer|ficar|manter)\s+(somente\s+|apenas\s+)?(em|no)\s+(memoria|estado local)\b/,
    /\b(nao (e necessario |precisa |deve )?(criar|persistir|gravar|salvar)|sem)\b[^.\n]{0,80}\b(backend|api|migrations?|banco( de dados)?|endpoints?|integracao http|persistir|persistencia)\b/,
    /\bnao criar\s*:?[\s\S]{0,300}\b(backend|controller|migration|chamadas http)\b/,
  ].some((pattern) => pattern.test(lower));

  const deleteMention = mention(functionalText, /\b(excluir|exclus[ãa]o|remover|apagar|deletar)\b/i);
  const toggle = /\b(ativar ou desativar|ativar\/desativar|ativar e desativar|inativar|alterar (o |seu )?status|mudar (o )?status)\b/i.test(functionalText);
  const badge = toggle || /\b(indica[çc][ãa]o visual|badge|etiqueta|ativo ou inativo)\b/i.test(functionalText);
  const searchMention = mention(functionalText, /\b(busca|buscar|pesquisa|pesquisar|filtro|filtrar)\b/i);

  const labelCandidates = [
    ...sections.filter((section) => section.level >= 3 && DATA_SECTION.test(section.path)).map((section) => section.title),
    ...[...functionalText.matchAll(/listagem deve (?:apresentar|exibir|mostrar)[^:\n]*:\s*\n((?:\s*[-*]\s+.+\n?)+)/gi)]
      .flatMap((match) => match[1].split('\n').map((line) => line.replace(/^\s*[-*]\s+/, '').replace(/[;.]$/, '').trim()).filter(Boolean)),
  ].filter((label) => label.length <= 40);

  return {
    creates: createsSomething(text),
    intent: detectIntent(text, structured),
    labels: [...new Set(labelCandidates)],
    structured,
    scope: frontendOnly ? 'frontend' : 'fullstack',
    names: {
      page: quoted(text, /p[áa]gina\s+(?:chamada|nomeada|com o nome(?: de)?)\s*:?\s+[`"']?([A-Z][A-Za-z0-9]*Page)\b/),
      modal: quoted(text, /modal\s+(?:chamado|nomeado|com o nome(?: de)?)\s*:?\s+[`"']?([A-Z][A-Za-z0-9]*FormModal)\b/),
    },
    title: quoted(text, /t[íi]tulo\s*:?\s*["“']([^"”'\n]{3,80})["”']/i) ?? quoted(text, /t[íi]tulo[^\n*]{0,40}:?\s*\*\*([^*\n]{3,80})\*\*/i),
    createLabel: quoted(text, /bot[ãa]o\s*:?\s*["“']([^"”'\n]{3,80})["”']/i),
    actions: {
      delete: deleteMention.any ? deleteMention.positive : !structured,
      toggleActive: toggle,
      statusBadge: badge,
      search: searchMention.any ? searchMention.positive : !structured,
    },
    dataText: dataSections.map((section) => `${section.title}\n${section.body}`).join('\n\n').trim(),
    restrictionText,
  };
}

export function describeIntent(intent) {
  return {
    relatorio: 'Parece um relatório, dashboard ou exportação. O detro cria cadastros e ajusta telas e menus existentes, mas ainda não gera relatórios.',
    vago: 'O pedido está curto demais. Diga o que criar ("cadastro de garagens com nome e endereço") ou o que mudar e onde ("na tela de Paradas, mostrar a coluna código").',
  }[intent] ?? null;
}
