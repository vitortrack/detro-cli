<h1 align="center">detro CLI</h1>

<p align="center">
  Gerador de CRUD e de código com IA para projetos TypeScript.<br>
  <strong>Ollama</strong> gera localmente · <strong>Claude Code</strong> revisa, corrige e assume quando o modelo local erra.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@vitortrack777/detro"><img src="https://img.shields.io/npm/v/@vitortrack777/detro.svg" alt="versão no npm"></a>
  <a href="https://www.npmjs.com/package/@vitortrack777/detro"><img src="https://img.shields.io/npm/dm/@vitortrack777/detro.svg" alt="downloads"></a>
  <img src="https://img.shields.io/node/v/@vitortrack777/detro.svg" alt="node">
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@vitortrack777/detro.svg" alt="licença MIT"></a>
</p>

```bash
npm install -g @vitortrack777/detro
detro plan "cadastro de garagens com nome, endereço e ativo"
detro apply --dry-run
detro apply
```

---

## Sumário

- [Sobre](#sobre)
- [Princípios](#princípios)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Tutorial: do zero num projeto de teste](#tutorial-do-zero-num-projeto-de-teste)
- [Como a IA funciona](#como-a-ia-funciona)
  - [O ciclo plan → dry-run → apply](#o-ciclo-plan--dry-run--apply)
  - [Contexto: o que os modelos recebem](#contexto-o-que-os-modelos-recebem)
  - [Ollama + Claude: quem faz o quê](#ollama--claude-quem-faz-o-quê)
  - [Modos de geração](#modos-de-geração)
- [Guia de uso](#guia-de-uso)
  - [Criar um cadastro (CRUD)](#criar-um-cadastro-crud)
  - [Mudança pontual numa tela](#mudança-pontual-numa-tela)
  - [Plano genérico](#plano-genérico)
  - [Modo livre](#modo-livre)
  - [Pedido em arquivo](#pedido-em-arquivo)
  - [Ajustar e revalidar o plano](#ajustar-e-revalidar-o-plano)
  - [Revisar o plano com o Claude](#revisar-o-plano-com-o-claude)
  - [Aplicar no projeto](#aplicar-no-projeto)
  - [Checar e corrigir código existente](#checar-e-corrigir-código-existente)
  - [Menu lateral](#menu-lateral)
  - [Vários pedidos em lote](#vários-pedidos-em-lote)
- [Referência de comandos](#referência-de-comandos)
- [Configuração](#configuração)
- [Arquivos em `.detro/`](#arquivos-em-detro)
- [Detecção de stack](#detecção-de-stack)
- [Solução de problemas](#solução-de-problemas)
- [Limites conhecidos](#limites-conhecidos)
- [Comandos de ambiente](#comandos-de-ambiente)
- [Desenvolvendo o detro](#desenvolvendo-o-detro)
- [Licença](#licença)

---

## Sobre

O **detro** recebe um pedido em português e transforma em código dentro do seu projeto: migration
PostgreSQL, módulo NestJS, tela React, item de menu e permissão. Também altera telas que já
existem, revisa arquivos e corrige erros de tipo.

O trabalho é dividido entre dois modelos:

- O **Ollama** roda na sua máquina e faz o trabalho pesado e repetitivo, sem custo por chamada.
- O **Claude Code** revisa cada resposta do Ollama, assume quando ele falha e cuida do que exige ler
  o projeto: planos genéricos, mudanças livres e a verificação final da feature.

Nenhum dos dois escreve no seu projeto. Os modelos devolvem propostas, o detro valida (tipos e regras)
e só grava depois que você confirma com `detro apply`.

## Princípios

1. **Plano antes de código.** Todo pedido vira um plano salvo em `.detro/last-plan.json`, que você lê,
   edita e revalida antes de qualquer arquivo ser gerado.
2. **Nada é escrito sem confirmação.** `plan` e `apply --dry-run` nunca tocam no projeto. Só o
   `apply` escreve, e só o que o dry-run mostrou.
3. **O compilador é o juiz.** O código gerado passa pelo `tsc` do próprio projeto. O que não
   compila volta para a IA corrigir, até o limite de `maxRepairs`.
4. **O padrão do projeto vence o padrão do modelo.** O detro copia uma feature que já existe no seu
   repositório e manda os `CLAUDE.md` como regra.
5. **Modelos sem escrita.** O Claude roda só com ferramentas de leitura (`Read`, `Grep`, `Glob`) ou
   sem nenhuma, e sem os seus plugins pessoais.

## Requisitos

| Requisito | Versão | Obrigatório | Para quê |
|---|---|---|---|
| [Node.js](https://nodejs.org) | 20 ou superior | Sim | Executar o CLI |
| [Claude Code](https://docs.anthropic.com/claude-code) | Atual, instalado e logado (`claude`) | Sim* | Revisão, planos genéricos, modo livre, verificação final |
| [Ollama](https://ollama.com) | Atual, rodando (`ollama serve`) | Não | Geração local. Sem ele, as chamadas vão direto para o Claude |
| TypeScript no projeto | `typescript` em `node_modules` de cada `tsconfig.json` | Para checagem de tipos | `check`, `fix` e validação do código gerado |
| Docker + PostgreSQL | — | Não | Aplicar a migration no banco de dev durante o `apply` |

\* Dá para desligar o Claude com `"claude": { "enabled": false }`, mas aí plano genérico, modo livre,
revisão e verificação final deixam de existir. Sobra só o que o Ollama faz com os templates.

> O Claude Code usa a **sua assinatura**. Por padrão o detro remove `ANTHROPIC_API_KEY` do ambiente
> da chamada, para o uso não ir para a API paga sem você perceber (veja `usarApiKey`).

Modelo do Ollama recomendado para começar:

```bash
ollama pull qwen2.5-coder:7b     # padrão; 14b é mais preciso se a máquina aguentar
```

## Instalação

### Pelo npm (uso normal)

```bash
npm install -g @vitortrack777/detro
detro version
```

O pacote se chama `@vitortrack777/detro` e o comando instalado é `detro`.

### A partir do código (para desenvolver o detro)

```bash
git clone git@github.com:vitortrack/detro-cli.git
cd detro-cli
bash ./detro.sh install     # npm install + npm link + autocompletar do bash
```

| Comando | O que faz |
|---|---|
| `bash ./detro.sh install` | Instala dependências, cria o link global `detro` e instala o autocompletar do bash |
| `bash ./detro.sh update` | Mesmo que `install`, para atualizar depois de um `git pull` |
| `bash ./detro.sh uninstall` | Remove o link global e o autocompletar |

Depois do `install`, abra um terminal novo (ou `source ~/.bashrc`) para o autocompletar funcionar.

## Tutorial: do zero num projeto de teste

Este passo a passo configura o detro num projeto de teste e passa pelos comandos principais. A ideia
é testar num projeto (ou numa branch) onde errar não custa nada, antes de usar no projeto de verdade.

O projeto de teste pode ser qualquer repositório TypeScript. Para ver o detro funcionando por
inteiro, o ideal é um projeto com:

- `api/` (NestJS, Express ou parecido) e `web/` (React), cada um com seu `tsconfig.json` e `npm install` feito;
- pelo menos **uma feature completa** (ex.: `users`, com tabela, rota da API e tela). É ela que o
  detro copia na criação por exemplo;
- de preferência um `CLAUDE.md` na raiz com as regras do projeto.

### Passo 1 — Instale as ferramentas

```bash
# Node 20+
node -v

# detro
npm install -g @vitortrack777/detro
detro version

# Claude Code: instale e faça login uma vez (abre o navegador)
claude

# Ollama (opcional, mas recomendado): suba o servidor e baixe o modelo
ollama serve &
ollama pull qwen2.5-coder:7b
```

Sem o Ollama, tudo funciona do mesmo jeito, mas toda chamada vai para o Claude.

### Passo 2 — Entre no projeto e numa branch de teste

```bash
cd ~/projetos/projeto-teste
git checkout -b teste-detro
git status          # comece com a árvore limpa: fica fácil ver e desfazer o que o detro escrever
```

### Passo 3 — Veja o que o detro entende do projeto

```bash
detro ai perfil
```

Confira três coisas na saída:

1. **Frontend / Backend / Banco/ORM / Infra**: a stack está certa? É ela que vai como contexto em todo
   pedido.
2. **TypeScript**: aparecem `api` e `web`? Se aparecer `(sem typescript instalado)`, rode
   `npm install` na pasta indicada. Sem isso não há checagem de tipos.
3. **geração de features**: qual modo vai ser usado (preset, criação por exemplo ou modo livre).

### Passo 4 — Crie a configuração

Crie `.detro/config.json` na raiz. Uma configuração recomendada para começar:

```json
{
  "projeto": {
    "nome": "Projeto Teste",
    "descricao": "cadastro de clientes e pedidos; NestJS + React + PostgreSQL; mensagens em pt-BR"
  },
  "ai": {
    "geracao": "auto",
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434",
      "model": "qwen2.5-coder:7b",
      "numCtx": 24576,
      "claude": {
        "enabled": true,
        "revisar": true,
        "verificarFeature": true,
        "afterAttempts": 2,
        "usarApiKey": false
      }
    },
    "generation": { "maxRepairs": 2 },
    "database": { "container": null },
    "references": {
      "formModal": "web/src/components/users/UserFormModal.tsx",
      "page": "web/src/pages/Users.tsx"
    }
  }
}
```

O que ajustar para o seu projeto:

| Chave | Como preencher |
|---|---|
| `projeto.descricao` | Uma frase: o domínio, a stack e as regras que valem para tudo. Vai em **toda** chamada |
| `references.formModal` / `references.page` | Um modal e uma página que já existem e têm o visual que você quer copiar. Caminho relativo à raiz |
| `database.container` | Deixe `null` se só houver um PostgreSQL no Docker. Com mais de um, ponha o nome (`docker ps`) |
| `ollama.model` | O modelo que você baixou. Na dúvida, `detro ai models` |
| `claude.usarApiKey` | Deixe `false` para usar a assinatura do Claude Code e não a API paga |

Atalhos que gravam no mesmo arquivo:

```bash
detro ai model qwen2.5-coder:14b     # troca o modelo (avisa se não estiver instalado)
detro ai ctx 32768                   # aumenta a janela de contexto do Ollama
```

E ponha no `.gitignore` os arquivos de trabalho do detro:

```gitignore
.detro/last-*.json
```

### Passo 5 — Confira se está tudo de pé

```bash
detro ai status      # servidor do Ollama, modelo atual, contexto e correções automáticas
detro ai selftest    # compila templates e patches no seu projeto, sem chamar a IA
detro ai ask "em uma frase, o que é um DTO no NestJS?"   # testa a ida e volta com o modelo
```

Se o `selftest` passar e o `ask` responder, a IA está configurada.

### Passo 6 — Primeiro pedido: uma mudança pontual

Comece pequeno, numa tela que já existe:

```bash
detro plan "na tela de Usuários, mostrar a coluna e-mail"
```

O detro diz qual arquivo vai alterar (`Arquivo: ...`) e salva o plano em `.detro/last-plan.json`.
Se o arquivo estiver errado, troque `edit.file` no JSON.

```bash
detro apply --dry-run     # a IA propõe as edições; você vê o diff; nada é escrito
detro apply               # escreve
git diff                  # confira o que mudou
```

### Passo 7 — Um cadastro completo

```bash
detro plan "cadastro de categorias com nome, descrição e ativo, no menu Cadastros"
```

Leia o plano: requisitos e cobertura, entidade, tabela, campos, rota, menu e permissão. Se algo não
estiver como você quer, ajuste sem gerar de novo:

```bash
detro plan --ajustar "sem exclusão; descrição opcional"
```

Se o plano tiver erros ou avisos, escolha **Perguntar ao Claude a melhor solução** no menu (veja
[Revisar o plano com o Claude](#revisar-o-plano-com-o-claude)). Com o plano limpo:

```bash
detro apply --dry-run     # migration + API + tela + menu, com tipos checados e verificação final
detro apply               # escreve; pergunta se aplica a migration e se rebuilda api/web
```

Abra a tela no navegador e teste criar, editar e listar.

### Passo 8 — Um pedido fora dos formatos

```bash
detro plan "relatório com o total de pedidos por cliente no mês, no menu Relatórios"
```

Vira **plano genérico**: o Claude lê o projeto e devolve os arquivos, os passos e os riscos, sem
escrever código. Revise, ajuste com `--ajustar` se precisar, e siga com `apply --dry-run` e `apply`.

### Passo 9 — Revise e corrija

```bash
detro check               # tipos + regras nos arquivos que o detro alterou
detro check --ia          # mais revisão de lógica pelo modelo
detro fix <arquivo>       # se sobrou erro num arquivo, a IA corrige
detro apply               # aplica a correção
```

### Passo 10 — Desfaça o teste (se quiser)

Como tudo foi numa branch, voltar é simples:

```bash
git checkout -- . && git clean -fd     # descarta o que o detro escreveu (confira antes com git status)
git checkout main && git branch -D teste-detro       # troque main pela sua branch principal
```

Migrations aplicadas no banco de dev não são desfeitas pelo git: remova as tabelas de teste à mão,
ou recrie o banco de dev.

### Resumo do fluxo

```bash
detro ai perfil                     # 1. o que o detro entende do projeto
detro ai status && detro ai selftest  # 2. IA e templates ok
detro plan "<pedido>"               # 3. plano (nada escrito)
detro plan --ajustar "<mudança>"    # 4. ajuste fino, se precisar
detro apply --dry-run               # 5. código gerado e validado (nada escrito)
detro apply                         # 6. escreve, migration, rebuild
detro check                         # 7. revisão final
```

---

## Como a IA funciona

### O ciclo plan → dry-run → apply

```
 pedido em pt-BR
       │
       ▼
┌──────────────┐  .detro/last-plan.json  ┌──────────────────┐  .detro/last-implementation.json  ┌──────────────┐
│  detro plan  │ ──────────────────────▶ │ detro apply      │ ────────────────────────────────▶ │ detro apply  │
│              │                         │   --dry-run      │                                   │              │
│ entende o    │  você lê, edita,        │ gera o código,   │   você lê o diff                  │ escreve os   │
│ pedido e     │  --ajustar, --revalidar │ checa tipos e    │                                   │ arquivos,    │
│ monta o plano│                         │ regras, corrige  │                                   │ migration e  │
└──────────────┘                         └──────────────────┘                                   │ rebuild      │
                                                                                                └──────────────┘
   nada escrito                             nada escrito                                          escreve
```

- **`plan`** classifica o pedido (cadastro, tela, consulta, menu, mudança pontual ou genérico) e
  salva o plano. Não gera código.
- **`apply --dry-run`** lê o plano salvo, gera o código, roda o `tsc` do projeto e as regras, pede
  correção à IA quando algo falha e salva a implementação pronta. Mostra o diff. Não escreve.
- **`apply`** grava exatamente o que o dry-run preparou. Recusa se o plano mudou depois do dry-run
  (compara um hash) ou se a implementação já foi aplicada.

### Contexto: o que os modelos recebem

Todo pedido, para os dois modelos, começa com o mesmo bloco de contexto, montado de novo a cada
comando:

```
PROJETO: <projeto.nome> — <projeto.descricao>
STACK DETECTADA: Frontend: React, Vite, ...; Backend: NestJS, ...; Banco/ORM: TypeORM, ...; Infra: PostgreSQL, PostGIS.
```

| Parte | De onde vem |
|---|---|
| `PROJETO` | `projeto.nome` (ou o nome da pasta, se vazio) e `projeto.descricao` do `.detro/config.json` |
| `STACK DETECTADA` | Varredura de `package.json`, arquivos de projeto de outras linguagens e `docker-compose` (veja [Detecção de stack](#detecção-de-stack)) |

No Ollama, esse bloco entra no início da mensagem `system`. No Claude, entra no topo do prompt.

Por cima desse bloco, cada etapa acrescenta o que precisa:

| Etapa | Contexto extra |
|---|---|
| Cadastro (preset/exemplo) | Spec do plano, feature modelo do projeto, `references.formModal`/`references.page`, catálogo de componentes, tabelas existentes |
| Revisão do Claude | O pedido inteiro enviado ao Ollama **mais** a resposta do Ollama, para corrigir |
| Plano genérico, modo livre, revisão de plano | O Claude lê o projeto com `Read`/`Grep`/`Glob`: os `CLAUDE.md` (raiz, `api/`, `web/`, `db/`, `.claude/`), uma feature parecida e onde ela é registrada |
| Correção (`fix`, reparos do dry-run) | O arquivo atual e a lista exata de erros do `tsc` e das regras |

**Como dar mais contexto ao detro**

1. **`projeto.descricao`**: uma frase sobre o domínio e as regras que valem para tudo (multi-tenant,
   fuso, idioma das mensagens). Vai em toda chamada, então seja breve.
2. **`CLAUDE.md` no repositório**: regras de arquitetura, banco e estilo. O Claude é instruído a lê-los
   antes de propor qualquer coisa. É aqui que mora o detalhe; o detro não precisa saber dele.
3. **`references`**: aponte uma tela e um modal "modelo". As telas geradas copiam o visual deles.
4. **O próprio pedido**: nomes, rótulos, rota, permissão e ações escritos no pedido são seguidos.

O Ollama tem janela limitada (`numCtx`, padrão 24.576 tokens). O detro estima o tamanho do prompt
antes de enviar e recusa se passar de 80% da janela, em vez de deixar o Ollama cortar em silêncio.

### Ollama + Claude: quem faz o quê

```
                     contexto do projeto (PROJETO + STACK) em toda chamada
                                          │
pedido ──▶ ┌──────────────┐  resposta  ┌─────────────────────┐  corrigida  ┌─────────────────────────┐
           │    Ollama    │ ─────────▶ │ Claude revisa       │ ──────────▶ │ detro valida            │
           │   (local)    │            │ (revisar: true)     │             │ tsc + regras do projeto │
           └──────────────┘            └─────────────────────┘             └─────────────────────────┘
                 │                                                                      │
                 │ caiu, estourou o tempo,                                    falhou: volta para
                 │ JSON inválido, contexto cheio                              correção (maxRepairs)
                 ▼                                                                      │
           Claude assume  ◀──────────────────── depois de afterAttempts erros seguidos ─┘
```

| Situação | Quem atende | Detalhe |
|---|---|---|
| Chamada normal | Ollama | Com o contexto do projeto no `system` |
| Toda resposta do Ollama | Claude revisa | Com `revisar: true`. Sugestões aparecem como `✎ claude: ...`. Se a revisão falhar, segue com a resposta do Ollama |
| Ollama caiu, estourou o tempo, resposta vazia ou cortada, contexto cheio | Claude assume | Aviso `↑ ... — chamando o Claude…` |
| Ollama devolveu JSON inválido | Claude assume | Só nas respostas estruturadas |
| `afterAttempts` erros seguidos no mesmo item | Claude direto | A próxima tentativa nem passa pelo Ollama |
| Pedido fora dos formatos | Claude | [Plano genérico](#plano-genérico), lendo o projeto |
| `plan --livre` | Claude | [Modo livre](#modo-livre) |
| Plano com erros/avisos | Claude (se você pedir) | [Revisão de plano](#revisar-o-plano-com-o-claude) |
| Fim do `apply --dry-run` | Claude | Verificação final (`verificarFeature`): confere coerência entre todos os arquivos da feature |
| Ollama não instalado | Claude | Toda chamada cai no Claude |

**Como o Claude é chamado**

O detro executa o `claude` em modo não interativo:

```
claude -p --output-format json --json-schema <schema> \
       --no-session-persistence --setting-sources project \
       --tools ""                  # revisão e geração estruturada
       --tools Read Grep Glob      # plano genérico, modo livre, revisão de plano
```

- `--tools ""` ou só leitura: o Claude **nunca** escreve arquivos. Quem escreve é o detro, no `apply`.
- `--setting-sources project`: carrega só as configurações do projeto, não os seus plugins e hooks
  pessoais. O resultado não depende de quem está rodando.
- `--json-schema`: a resposta vem estruturada e validada, sem texto solto para interpretar.
- `--no-session-persistence`: as chamadas não poluem o seu histórico do Claude Code.

### Modos de geração

O modo sai do `detro ai perfil`, ou é forçado com `"ai": { "geracao": ... }`:

| Modo | `geracao` | Quando entra | Como gera |
|---|---|---|---|
| **Preset NestJS multi-tenant** | `auto` | O projeto tem **todas** as convenções do preset (o `perfil` lista quais) | Templates prontos para cadastro, consulta, tela e menu |
| **Criação por exemplo** | `auto` ou `exemplo` | Projetos TypeScript em geral (Express, NestJS, Next.js, React…) | Acha uma feature que já existe e copia o padrão (ex.: `users` → `products`) |
| **Plano genérico** | `auto` ou `livre` | Pedido fora dos formatos, qualquer stack, ou sem feature modelo | O Claude monta o plano; o dry-run implementa seguindo o plano aprovado |

- `"geracao": "exemplo"` desliga o preset mesmo que o projeto o atenda.
- `"geracao": "livre"` manda todo pedido para o plano genérico.

---

## Guia de uso

### Criar um cadastro (CRUD)

```bash
detro plan "cadastro de garagens com nome, endereço, capacidade e ativo"
```

O detro separa os requisitos do pedido, monta o plano (entidade, tabela, campos, rota, menu,
permissão) e mostra a cobertura de cada requisito. Em seguida:

```bash
detro apply --dry-run     # migration + API + tela + menu, com tipos checados
detro apply
```

Dicas para o pedido:

- Liste os campos e o tipo quando não for óbvio: "capacidade em litros (número)".
- Diga o que **não** quer: "sem exclusão", "somente em memória" ou "sem backend" (gera só o front).
- Nomes, título, texto de botão e ações pedidos são seguidos literalmente.

### Mudança pontual numa tela

```bash
detro plan "na tela de Paradas, mostrar a coluna código"
detro plan "no modal de cadastro de aluno, adicionar o campo observação (só texto)"
```

O detro identifica o arquivo alvo e salva o plano com ele (`edit.file`). Se escolheu o arquivo
errado, troque `edit.file` no `.detro/last-plan.json`. O dry-run mostra o diff das edições.

### Plano genérico

Relatório, integração, ajuste espalhado por várias telas: o que não é cadastro, tela, consulta,
menu ou mudança pontual vira **plano genérico**. O Claude lê o projeto e devolve, **sem escrever
código**:

- o que entendeu do pedido;
- cada arquivo a criar ou alterar, e o que muda nele;
- os passos, os riscos e o que fica a confirmar.

```bash
detro plan "relatório com o total de viagens por linha no mês, no menu Relatórios"
detro plan --ajustar "sem gráfico; período obrigatório, abrindo no mês atual"
detro apply --dry-run     # o Claude implementa exatamente o plano aprovado; tipos checados
detro apply
```

### Modo livre

Pula o plano: o Claude lê o projeto e já propõe o código.

```bash
detro plan --livre "no modal X, trocar o título A por B"
detro apply               # direto, sem --dry-run
```

A proposta do modo livre (e do `fix`) já é a implementação, então vai direto para `detro apply`. O
`apply --dry-run` gera a partir do plano salvo e **recusa** sobrescrever uma proposta pendente. Para
jogá-la fora: `detro apply --dry-run --descartar`.

Arquivos existentes voltam como **trechos** (`find`/`replace`), não como arquivo inteiro. Se um
trecho não bate ou o resultado não compila, o Claude corrige até `maxRepairs` vezes.

### Pedido em arquivo

Para pedidos longos, escreva em Markdown:

```bash
detro plan -f pedido.md          # procura na pasta atual, na raiz e em .detro/pedidos/
cat pedido.md | detro plan -     # pela entrada padrão
```

Funciona com lista em tópicos ou com documento em seções:

```markdown
# Cadastro de garagens

## Dados
- nome (obrigatório)
- endereço
- capacidade em vagas (número)
- ativo

## Restrições
- sem exclusão, só desativar
- menu "Frota", permissão "vehicles"
```

### Ajustar e revalidar o plano

O plano fica em `.detro/last-plan.json`. Há duas formas de mudar sem gerar tudo de novo:

```bash
# 1) à mão: edite o JSON (entity, route, fields, menu, permissão…) e revalide
detro plan --revalidar

# 2) pedindo ao Claude só a mudança; o resto do plano fica igual
detro plan --ajustar "trocar o ícone para Users e tirar a exclusão"
detro plan --ajustar              # sem texto, ele pergunta o que mudar
```

O `--ajustar` funciona com planos de cadastro e com planos genéricos, com ou sem problemas.

### Revisar o plano com o Claude

Quando um plano (novo ou revalidado) tem **erros**, **avisos** ou itens **não cobertos**, o detro
pergunta:

| Opção | O que acontece |
|---|---|
| Perguntar ao Claude a melhor solução | O Claude lê o projeto (só leitura) e devolve a análise, o que **manter** e as **mudanças** propostas, numeradas e com motivo |
| Reformular o pedido | Você edita o texto do pedido e o detro interpreta tudo de novo |
| Seguir com o plano como está | Nada muda: siga com `detro apply --dry-run` ou edite o JSON |

Depois da resposta do Claude, as opções dependem do que ele propôs:

| Opção | Aparece quando | O que acontece |
|---|---|---|
| Aplicar todas as mudanças e revalidar | As mudanças cabem no plano | Salva o plano ajustado e roda `--revalidar` sozinho |
| Escolher quais mudanças aplicar | As mudanças cabem no plano | Espaço marca/desmarca; o Claude refaz o plano só com as marcadas |
| Seguir com a proposta do Claude | A proposta **não cabe** no formato de cadastro (ex.: "não crie cadastro novo; adicione a coluna no módulo que já existe") | O detro junta o pedido com a análise e monta um **plano genérico** a partir dela |
| Confirmar o plano e seguir | O Claude não propôs mudança | O plano fica como está e o fluxo segue |
| Orientar o Claude | Sempre | Texto livre ("cidade como texto livre", "mantenha o nome Mechanic"), e ele responde de novo |
| Reformular o pedido | Sempre | Igual à opção da tabela anterior |
| Manter o plano como estava | Houve proposta de mudança | Sai sem alterar o `.detro/last-plan.json` |

O ciclo se repete a cada revalidação até o plano ficar limpo ou você escolher seguir. Com
`claude.enabled: false`, ou fora de um terminal interativo (CI, pipe), o menu não aparece.

### Aplicar no projeto

```bash
detro apply --dry-run          # gera e valida, salva em .detro/last-implementation.json
detro apply                    # escreve
detro apply --sim              # aceita todos os passos sem perguntar
detro apply --sem-banco        # não aplica a migration
detro apply --sem-restart      # não rebuilda
```

No fim do dry-run, a **verificação final** do Claude confere a coerência entre todos os arquivos da
feature: nomes, rotas, tipos, permissões e menu. As correções só entram se **todas** passarem nos
tipos juntas. Problemas que já existiam no projeto viram sugestões `Já existia:` em vez de
alterações.

O `apply`:

1. Escreve os arquivos (`+` criado, `~` alterado).
2. Se há migration, pergunta se aplica no banco de dev, **em transação única**, no container
   PostgreSQL encontrado (ou em `ai.database.container`).
3. Pergunta se rebuilda os serviços afetados (`api`, `web`) pelo script de ambiente do projeto.
4. Lista o que ficou para você fazer, se algo foi pulado ou falhou.

### Checar e corrigir código existente

```bash
detro check                      # tipos + regras nos arquivos alterados no git
detro check src/a.ts src/b.tsx   # só esses arquivos
detro check --ia                 # idem, mais revisão de falhas de lógica pelo modelo
detro check --tudo               # todos os arquivos de api/ e web/ (sem --ia)

detro fix api/src/modules/x/x.service.ts    # a IA corrige os erros do arquivo
detro apply                                 # aplica a correção proposta
```

Além do `tsc`, o `check` roda regras do projeto, por exemplo:

| Regra | Severidade | O que pega |
|---|---|---|
| `st-distance-geography` | erro | `ST_Distance`/`ST_DWithin` em `geometry` (resultado em graus, não em metros) |
| `schedule-timezone` | aviso | Comparação de horário com grade sem `AT TIME ZONE` |
| `mutation-without-permission` | aviso | Endpoint que altera dados sem decorator de permissão |
| `public-endpoint` | info | Endpoint marcado como público |
| `no-any` | aviso | `any` novo |
| `empty-catch` | aviso | `catch` vazio que engole erro |
| `jsx-key` | aviso | Lista em JSX sem `key` |
| `coalesce-update` | aviso | `COALESCE` em `UPDATE` que impede limpar o campo |
| `divide-by-length` | aviso | Divisão por `.length` sem proteção contra zero |

Em React, também aponta falhas de lógica: promise sem `await`, dependência de hook faltando, estado
sem setter, mutação direta de estado e `useEffect` em laço.

O `fix` aceita arquivos de até 700 linhas e tenta até `maxRepairs + 1` vezes.

### Menu lateral

```bash
detro menu                                                         # lista grupos e itens
detro menu mover "Tipos de ocorrência" "Rotas e operação" --permissao routes
detro menu renomear "Garagens" "Garagens e pátios"
detro menu icone "Garagens" Warehouse
detro menu permissao "Garagens" vehicles
detro apply
```

Também funciona em linguagem natural: `detro plan "mova Tipos de ocorrência para Rotas e operação"`.

### Vários pedidos em lote

```bash
detro lote erros-tela-a.md erros-tela-b.md
detro lote "erros-*.md"              # aceita curinga
detro lote --dry-run "erros-*.md"    # só mostra os diffs
```

Um arquivo por pedido de mudança pontual, rodados em sequência. O modelo tenta primeiro. Se falhar e
o pedido tiver blocos **"Trecho atual"/"Trecho novo"**, o detro aplica os trechos literalmente.
Escreve no projeto ao final.

---

## Referência de comandos

### Planejamento e geração

| Comando | Descrição |
|---|---|
| `detro plan "<pedido>"` | Entende o pedido e salva o plano em `.detro/last-plan.json` |
| `detro plan -f <arquivo.md>` | Idem, lendo de arquivo (pasta atual, raiz ou `.detro/pedidos/`) |
| `detro plan -` | Idem, lendo da entrada padrão |
| `detro plan --livre "<pedido>"` | Pula o plano: o Claude lê o projeto e propõe o código |
| `detro plan --revalidar` | Revalida o plano salvo depois de editar o JSON |
| `detro plan --ajustar "<mudança>"` | Mantém o plano e pede ao Claude só essa mudança |
| `detro apply --dry-run` | Gera e valida o código a partir do plano, sem escrever |
| `detro apply --dry-run --descartar` | Idem, descartando uma proposta de `--livre`/`fix` pendente |
| `detro apply` | Escreve a implementação preparada; oferece migration e rebuild |
| `detro apply --sim` | Idem, aceitando os passos sem perguntar |
| `detro apply --sem-banco` / `--sem-restart` | Pula a migration ou o rebuild |

### Qualidade

| Comando | Descrição |
|---|---|
| `detro check [arquivos...]` | Tipos + regras (padrão: arquivos alterados no git) |
| `detro check --ia [arquivos...]` | Idem, mais revisão de lógica pelo modelo |
| `detro check --tudo` | Todos os arquivos de `api/` e `web/` |
| `detro fix <arquivo>` | A IA corrige os erros do arquivo (depois: `detro apply`) |
| `detro lote [--dry-run] <pedidos...>` | Vários pedidos de mudança pontual em sequência |
| `detro menu <listar\|mover\|renomear\|icone\|permissao> ...` | Ajustes no menu lateral |

### IA

| Comando | Descrição |
|---|---|
| `detro ai perfil` | Stack, convenções e o que o detro faz neste projeto (é o contexto enviado aos modelos) |
| `detro ai status` | Conexão com o Ollama, modelo e contexto |
| `detro ai models` | Modelos instalados no Ollama |
| `detro ai model <nome>` | Troca o modelo (avisa se ainda não está instalado) |
| `detro ai ctx <tokens>` | Tamanho do contexto do Ollama, de 4096 a 262144 |
| `detro ai ask "<pergunta>"` | Pergunta livre ao modelo |
| `detro ai selftest` | Autoteste sem IA: templates e patches compilam no projeto |
| `detro ai provider ollama` | Define o provider (hoje só `ollama`) |

### Gerais

| Comando | Descrição |
|---|---|
| `detro` | Menu interativo |
| `detro version` (`-v`, `--version`) | Versão instalada |
| `detro help` | Ajuda do script de ambiente do projeto |

---

## Configuração

Tudo é opcional. O detro funciona sem `.detro/config.json`, com os padrões abaixo. O que você
escrever é mesclado por cima deles, então basta incluir o que muda.

```json
{
  "projeto": {
    "nome": null,
    "descricao": null
  },
  "ai": {
    "provider": "ollama",
    "geracao": "auto",
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434",
      "model": "qwen2.5-coder:7b",
      "numCtx": 24576,
      "temperature": 0.2,
      "timeoutMs": 900000,
      "claude": {
        "enabled": true,
        "revisar": true,
        "verificarFeature": true,
        "usarApiKey": false,
        "afterAttempts": 2,
        "model": null,
        "timeoutMs": 600000
      }
    },
    "generation": { "maxRepairs": 2 },
    "database": { "container": null },
    "references": { "formModal": null, "page": null },
    "catalog": { "exclude": [] },
    "review": { "maxFileChars": 24000, "tenantExclude": ["/workers/"] }
  }
}
```

### `projeto`

| Chave | Padrão | Descrição |
|---|---|---|
| `nome` | nome da pasta | Nome do projeto no contexto (`PROJETO: ...`) |
| `descricao` | — | Uma frase sobre o domínio e a stack. Vai em **toda** chamada aos modelos |

### `ai`

| Chave | Padrão | Descrição |
|---|---|---|
| `provider` | `"ollama"` | Único suportado hoje |
| `geracao` | `"auto"` | `auto`, `exemplo` ou `livre` (veja [Modos de geração](#modos-de-geração)) |

### `ai.ollama`

| Chave | Padrão | Descrição |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:11434` | Endereço do Ollama |
| `model` | `qwen2.5-coder:7b` | Modelo. Troque com `detro ai model <nome>` |
| `numCtx` | `24576` | Janela de contexto em tokens. Maior usa mais memória. Troque com `detro ai ctx` |
| `temperature` | `0.2` | Variação das respostas livres. Respostas estruturadas sempre usam `0` |
| `timeoutMs` | `900000` (15 min) | Tempo máximo **sem gerar nada**; o contador reinicia a cada pedaço recebido |

### `ai.ollama.claude`

| Chave | Padrão | Descrição |
|---|---|---|
| `enabled` | `true` | Liga o Claude. Desligado, somem revisão, fallback, plano genérico, modo livre e verificação final |
| `revisar` | `true` | O Claude revisa toda resposta do Ollama |
| `verificarFeature` | `true` | Verificação final de coerência no fim do `apply --dry-run` |
| `afterAttempts` | `2` | Depois de quantos erros seguidos do Ollama a tentativa vai direto ao Claude |
| `model` | `null` | Modelo do Claude (`--model`). `null` usa o padrão do seu Claude Code |
| `usarApiKey` | `false` | `false` remove `ANTHROPIC_API_KEY` do ambiente: o uso conta na assinatura, não na API |
| `timeoutMs` | `600000` (10 min) | Limite por chamada. Na revisão de plano, o teto é 3 min |

### Demais chaves

| Chave | Padrão | Descrição |
|---|---|---|
| `generation.maxRepairs` | `2` | Quantas vezes a IA tenta corrigir o que não passou nos tipos/regras |
| `database.container` | `null` | Container PostgreSQL para aplicar migrations. Obrigatório se houver mais de um rodando |
| `references.formModal` | `null` | Caminho de um modal do projeto que serve de modelo visual |
| `references.page` | `null` | Caminho de uma página do projeto que serve de modelo visual |
| `catalog.exclude` | `[]` | Componentes que não devem entrar no catálogo enviado à IA |
| `review.maxFileChars` | `24000` | Tamanho máximo de arquivo na revisão com IA |
| `review.tenantExclude` | `["/workers/"]` | Caminhos ignorados pela checagem de filtro por tenant |

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `DETRO_APP_SCRIPT` | Script de ambiente a usar no lugar de `appDev`/`app` (ex.: `scripts/dev`) |
| `ANTHROPIC_API_KEY` | Só é repassada ao Claude com `usarApiKey: true` |

## Arquivos em `.detro/`

| Arquivo | Criado por | Conteúdo |
|---|---|---|
| `config.json` | Você, ou `detro ai model`/`ctx`/`provider` | Configuração |
| `last-plan.json` | `detro plan` | O plano atual. Pode ser editado à mão (depois: `--revalidar`) |
| `last-implementation.json` | `apply --dry-run`, `plan --livre`, `fix`, `menu` | Os arquivos prontos para o `apply`, com hash do plano e dos originais |
| `last-attempt.json` | `apply --dry-run` que falhou | A última tentativa, para diagnóstico |
| `pedidos/` | Você | Pedidos em Markdown para `detro plan -f` |

Recomendação: versione `config.json` e `pedidos/`, e ponha os `last-*.json` no `.gitignore`.

## Detecção de stack

O `detro ai perfil` mostra o que foi encontrado. Isso vira a linha `STACK DETECTADA` do contexto:

- **JavaScript/TypeScript**, pelos `package.json`: React, Vue, Angular, Svelte, Next.js, Vite, React
  Query, Tailwind, NestJS, Express, Fastify, Prisma, TypeORM, Drizzle, Mongoose…
- **Outras linguagens**, pelos arquivos de projeto: Python (Django, FastAPI, Flask), PHP (Laravel,
  Symfony), Java/Kotlin (Spring Boot), Go (Gin, Fiber, Echo), Ruby (Rails), .NET (ASP.NET Core), Rust.
- **Infra**, pelos `docker-compose`: PostgreSQL, PostGIS, MySQL, MongoDB, Redis, RabbitMQ…
- **TypeScript**: cada `tsconfig.json` e se o `typescript` está instalado ao lado dele.

Se o projeto não segue as convenções dos geradores, o `plan` vai para o plano genérico. Arquivos que
não são TypeScript saem sem checagem de tipos.

## Solução de problemas

| Mensagem | Causa | O que fazer |
|---|---|---|
| `Não foi possível conectar ao Ollama` | Ollama parado ou em outro endereço | `ollama serve`, ou ajuste `ai.ollama.baseUrl` |
| `O modelo X não está instalado no Ollama` | Modelo não baixado | `ollama pull X`, ou `detro ai models` para escolher um instalado |
| `O prompt tem ~N tokens e o contexto configurado é M` | Prompt maior que 80% da janela | `detro ai ctx 32768`, ou aponte `references` menores |
| `A resposta do modelo foi cortada pelo limite de contexto` | Janela pequena para a resposta | `detro ai ctx <maior>` |
| `O modelo ficou N min sem gerar nada` | Modelo lento ou travado | Use um modelo menor, ou aumente `ai.ollama.timeoutMs` |
| `Não foi possível executar o Claude Code` | `claude` fora do PATH ou deslogado | Instale e rode `claude` uma vez para logar |
| `O Claude passou de N min sem terminar` | Pedido grande | Aumente `ai.ollama.claude.timeoutMs`. O modo livre já tenta de novo numa versão enxuta |
| `Há uma proposta "..." pendente` | `--livre`/`fix` não aplicado | `detro apply` para aplicar, ou `detro apply --dry-run --descartar` |
| `A implementação preparada é de um plano diferente do atual` | O plano mudou depois do dry-run | Rode `detro apply --dry-run` de novo |
| `Há mais de um PostgreSQL rodando` | Vários containers | Defina `ai.database.container` |
| `TypeScript não encontrado em <dir>/node_modules` | Dependências não instaladas | `cd <dir> && npm install` |
| `o script app não existe ou não é executável` | Sem `appDev`/`app` | `chmod +x appDev`, ou use `DETRO_APP_SCRIPT` |

Para separar problema do detro de problema da IA, rode `detro ai selftest`: ele compila templates e
patches no seu projeto **sem chamar modelo nenhum**.

## Limites conhecidos

- A criação por exemplo precisa de pelo menos uma feature com arquivos em mais de uma camada. Sem
  ela, o pedido vira plano genérico.
- O plano genérico não tem template: os tipos são checados, mas as regras do projeto (permissão,
  tenant, fuso) dependem do Claude seguir os `CLAUDE.md`. Revise o plano antes do dry-run.
- Arquivos que não são TypeScript não passam por checagem de tipos. Revise o diff antes do `apply`.
- O preset NestJS multi-tenant só é usado em projetos com as convenções dele (o `perfil` lista quais).
- O menu de revisão de plano só aparece em terminal interativo.
- A IA varia entre execuções. Se um dry-run falhar, rodar de novo costuma resolver; se não, aumente
  `maxRepairs` ou use um modelo maior.

## Comandos de ambiente

Além da IA, o detro repassa os comandos de ambiente (`start`, `stop`, `restart`, `rebuild`, `logs`,
`status`, `clean`, `hot-reload`, `worker`, `auto-remove`, `execute`, `help`) para o script na raiz
do projeto, procurado nesta ordem: `$DETRO_APP_SCRIPT`, `appDev`, `app`.

```bash
detro restart api                          # = ./appDev restart api
DETRO_APP_SCRIPT=scripts/dev detro logs    # usa outro script
```

O script precisa ser executável (`chmod +x appDev`). O `apply` usa o mesmo script para rebuildar.

## Desenvolvendo o detro

```bash
git clone git@github.com:vitortrack/detro-cli.git
cd detro-cli
bash ./detro.sh install        # link global: o detro passa a rodar deste código
```

Estrutura:

```
index.js                 entrada: comandos internos e repasse ao script de ambiente
ai/commands.js           cada comando (plan, apply, check, fix, menu, lote, ai)
ai/config.js             padrões, merge do .detro/config.json e contexto do projeto
ai/profile.js            detecção de stack e convenções
ai/ollama.js             chamada ao Ollama, revisão e fallback para o Claude
ai/livre.js              modo livre e chamada estruturada ao Claude com ferramentas de leitura
ai/planoGenerico.js      plano genérico
ai/ajustePlano.js        revisão e --ajustar do plano com o Claude
ai/verificacaoFinal.js   verificação de coerência no fim do dry-run
ai/planner.js, spec.js   entendimento do pedido e validação do plano de cadastro
ai/generator.js          geração do cadastro (preset) e reparos
ai/example*.js           criação por exemplo
ai/templates/            templates do preset (banco, backend, frontend, patches)
ai/rules.js              regras do check
ai/semanticLint.js       falhas de lógica em React
ai/typescript.js         tsc do próprio projeto, em memória
```

Publicar uma versão:

```bash
npm version patch          # commit + tag vX.Y.Z
git push --follow-tags
npm publish
```

## Licença

[MIT](LICENSE) © vitortrack
