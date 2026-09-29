# detro

`npm install -g @vitortrack777/detro` — o comando instalado é `detro`.

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

```bash
detro ai status                         # Ollama, modelo e contexto
detro plan "cadastro de garagens com nome e endereço"
detro plan --livre "no modal X, trocar o título A por B"
detro apply --dry-run                   # gera e valida, sem escrever
detro apply                             # escreve o que o dry-run mostrou
detro check                             # tipos + regras nos arquivos alterados
```

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
