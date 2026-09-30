# detro CLI — gerador de CRUD e código com IA (Ollama + Claude Code)

**detro** é um CLI de desenvolvimento com IA: a partir de um pedido em português, gera um CRUD
completo (migration PostgreSQL, API NestJS e tela React) e corrige código existente, com o Ollama
rodando local e o Claude Code revisando.

```bash
npm install -g @vitortrack777/detro     # o comando instalado é detro
detro plan "cadastro de garagens com nome e endereço"
detro apply
```

CLI de desenvolvimento com IA para projetos TypeScript (NestJS em `api/`, React em `web/`).
O Ollama gera o código localmente; o Claude Code revisa, corrige e assume quando o Ollama erra.
Nada é escrito no projeto sem passar pela validação de tipos e pelo `detro apply`.

## Requisitos

- Node.js 20+
- [Claude Code](https://docs.anthropic.com/claude-code) instalado e logado (`claude`) — usa a sua assinatura
- [Ollama](https://ollama.com) (opcional): sem ele, as chamadas vão direto para o Claude

## Instalação

```bash
npm install -g @vitortrack777/detro
```

Ou a partir do código, para desenvolver o próprio detro:

```bash
git clone git@github.com:vitortrack/detro-cli.git
cd detro-cli
bash ./detro.sh install   # npm install + npm link + autocompletar do bash
```

## Uso

Rode a partir da raiz do projeto (a pasta com `.detro/`, `.git` ou `package.json`).

Comece pelo perfil: o detro detecta a stack do projeto sozinho a cada comando e manda esse resumo
junto com todo pedido, para o Ollama e para o Claude. O `detro ai perfil` mostra exatamente o que os
modelos vão receber. Se faltar algo, preencha `projeto.nome` e `projeto.descricao` em
`.detro/config.json`: os dois também entram no contexto (ver [Detecção de stack](#detecção-de-stack)).

```bash
detro ai perfil                         # stack, convenções e o que o detro sabe gerar aqui
detro ai status                         # Ollama, modelo e contexto
detro plan "cadastro de garagens com nome e endereço"
detro plan --livre "no modal X, trocar o título A por B"
detro apply --dry-run                   # gera e valida, sem escrever
detro apply                             # escreve o que o dry-run mostrou
```

Proposta de `detro plan --livre` ou `detro fix` vai direto para `detro apply`, sem `--dry-run`: o dry-run gera a partir do plano salvo e recusa sobrescrever uma proposta pendente (use `--descartar` para jogá-la fora).

```bash
detro check                             # tipos + regras nos arquivos alterados
```

### Ajustar e revalidar o plano

O `detro plan` salva o plano em `.detro/last-plan.json`. Para ajustar sem gerar de novo:

```bash
# edite .detro/last-plan.json (entity, route, fields, menu, permissão...) e depois:
detro plan --revalidar                  # valida o plano salvo e mostra o resultado
detro plan --ajustar "trocar o ícone para Users e tirar a exclusão"
                                        # mantém o plano e pede ao Claude só essa mudança
```

O `--ajustar` serve também para plano **sem** problemas: o Claude muda só o que você pediu, mostra
o que mantém e cada mudança numerada, e você escolhe no mesmo menu abaixo (aplicar todas, escolher
quais, orientar de novo, reformular ou manter). Sem texto, ele pergunta o que mudar.

Em cadastros, quando o plano (novo ou revalidado) tem **erros**, **avisos** ou itens **não cobertos**,
o detro pergunta o que fazer:

| Opção | O que acontece |
|---|---|
| Perguntar ao Claude a melhor solução | O Claude lê o projeto (só leitura) e devolve análise, o que **manter** e as **mudanças** propostas, numeradas e com motivo |
| Reformular o pedido | Você edita o texto do pedido e o detro interpreta tudo de novo |
| Seguir com o plano como está | Nada muda; siga com `detro apply --dry-run` ou edite o JSON |

Depois da resposta do Claude:

| Opção | O que acontece |
|---|---|
| Aplicar todas as mudanças e revalidar | Salva o plano ajustado e roda `--revalidar` sozinho |
| Escolher quais mudanças aplicar | Espaço marca/desmarca; o Claude refaz o plano só com as marcadas e mostra de novo |
| Orientar o Claude | Texto livre ("cidade como texto livre", "mantenha o nome Mechanic") e ele responde de novo |
| Reformular o pedido | Mesmo que acima |
| Manter o plano como estava | Sai sem alterar o `.detro/last-plan.json` |

O ciclo se repete a cada revalidação até o plano ficar limpo ou você escolher seguir/manter.
Com `claude.enabled: false` ou fora de um terminal interativo (CI, pipe), o menu não aparece.

### Como o Claude participa

| Quando | O que acontece |
|---|---|
| Toda resposta do Ollama (`revisar: true`) | O Claude revisa e corrige; sugestões aparecem com `✎ claude:` |
| O Ollama erra `afterAttempts` vezes seguidas | A tentativa seguinte vai direto para o Claude |
| O Ollama cai, estoura o tempo ou devolve JSON inválido | O Claude assume |
| O pipeline não encaixa o pedido | Modo livre: o Claude lê o projeto (só leitura) e propõe a mudança com diff |
| Fim do `detro apply --dry-run` | Verificação final: o Claude confere a coerência entre todos os arquivos da feature (nomes, rotas, tipos, permissões, menu). As correções só entram se **todas** passarem nos tipos juntas; problemas que já existiam no projeto viram sugestões `Já existia:` em vez de alterações |

O Claude roda sem ferramentas de escrita (`--tools ""` ou só Read/Grep/Glob no modo livre) e com
`--setting-sources project`, para não carregar plugins pessoais. Quem escreve os arquivos é o `detro`.

## Detecção de stack

`detro ai perfil` mostra o que o detro encontrou no projeto, e isso entra no contexto de todo pedido
(Ollama e Claude):

- **JavaScript/TypeScript** pelos `package.json`: React, Vue, Angular, Svelte, Next.js, Vite, React Query,
  Tailwind, NestJS, Express, Fastify, Prisma, TypeORM, Drizzle, Mongoose…
- **Outras linguagens** pelos arquivos de projeto: Python (Django, FastAPI, Flask), PHP (Laravel, Symfony),
  Java/Kotlin (Spring Boot), Go (Gin, Fiber, Echo), Ruby (Rails), .NET (ASP.NET Core), Rust
- **Infra** pelos `docker-compose`: PostgreSQL, PostGIS, MySQL, MongoDB, Redis, RabbitMQ…

Se o projeto não segue as convenções dos geradores, `detro plan` vai direto para o modo livre.
Arquivos que não são TypeScript saem sem checagem de tipos: revise o diff antes do `detro apply`.

## Configuração (`.detro/config.json` no projeto)

```json
{
  "projeto": { "nome": "Meu Sistema", "descricao": "o que o sistema faz e a stack" },
  "ai": {
    "ollama": {
      "model": "qwen2.5-coder:7b",
      "claude": { "enabled": true, "revisar": true, "verificarFeature": true, "afterAttempts": 2, "model": null, "usarApiKey": false }
    },
    "references": {
      "formModal": "web/src/components/exemplo/ExemploFormModal.tsx",
      "page": "web/src/pages/exemplo/ExemploPage.tsx"
    },
    "review": { "tenantExclude": ["/workers/"] }
  }
}
```

- `usarApiKey: false` remove `ANTHROPIC_API_KEY` do ambiente, para o uso contar na assinatura e não na API.
- `references`: uma tela e um modal do projeto que servem de modelo para as telas geradas.

## Comandos de ambiente

`start`, `stop`, `restart`, `logs` etc. repassam para um script `appDev` (ou `app`) na raiz do projeto.
Para usar outro nome: `DETRO_APP_SCRIPT=scripts/dev detro restart api`.

## Como o detro gera features

O modo é escolhido pelo que `detro ai perfil` encontra no projeto (ou forçado por `"ai": { "geracao": ... }`):

| Modo | Quando | Como |
|---|---|---|
| **Criação por exemplo** | Projetos TypeScript em geral (Express, NestJS, Next.js, React…) | Acha uma feature que já existe no projeto e copia o padrão dela para a nova (ex.: `users` → `products`) |
| **Modo livre** | Qualquer stack, ou quando não há feature modelo | O Claude lê o projeto e propõe a mudança completa |
| **Preset NestJS multi-tenant** | Só quando o projeto tem todas as convenções do preset | Templates prontos para cadastro, consulta, tela e menu |

`"geracao": "exemplo"` desliga o preset mesmo que o projeto o atenda; `"geracao": "livre"` manda tudo para o Claude.

## Limites conhecidos

- A criação por exemplo precisa de pelo menos uma feature com arquivos em mais de uma camada; sem ela, o pedido vai para o modo livre.
- Arquivos que não são TypeScript não passam por checagem de tipos: revise o diff antes do `detro apply`.
- O preset NestJS multi-tenant só é usado em projetos com as convenções dele (`detro ai perfil` lista quais).
