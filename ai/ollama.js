import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

function connectionError(url, error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new Error(`O Ollama não respondeu dentro do tempo limite (${url}). Aumente ai.ollama.timeoutMs em .detro/config.json.`);
  }

  return new Error(`Não foi possível conectar ao Ollama em ${url}: ${error.message}. Verifique se ele está rodando (ollama serve).`);
}

function httpError(status, body) {
  const missing = body.match(/model ['"]?([^'"\s]+)['"]? not found/i);

  if (status === 404 && missing) {
    return new Error(`O modelo ${missing[1]} não está instalado no Ollama. Baixe com: ollama pull ${missing[1]}  (ou volte para um instalado: detro ai models)`);
  }

  return new Error(`Ollama respondeu HTTP ${status}${body ? `: ${body}` : ''}`);
}

async function request(url, options = {}) {
  let response;

  try {
    response = await fetch(url, options);
  } catch (error) {
    throw connectionError(url, error);
  }

  if (!response.ok) {
    throw httpError(response.status, await response.text().catch(() => ''));
  }

  return response;
}

function postStream(url, payload, signal) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve(res);
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => reject(httpError(res.statusCode, body)));
    });

    req.on('error', (error) => reject(connectionError(url, error)));
    req.end(JSON.stringify(payload));
  });
}

export async function listOllamaModels(baseUrl) {
  const response = await request(`${normalizeBaseUrl(baseUrl)}/api/tags`);
  const data = await response.json();
  return data.models ?? [];
}

export function estimateTokens(messages) {
  const chars = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil(chars / 3);
}

function parseLine(line) {
  const data = JSON.parse(line);

  if (data.error) {
    throw new Error(`Ollama: ${data.error}`);
  }

  return data;
}

function comContexto(ollama, messages) {
  if (!ollama.projectContext) return messages;
  const [primeira, ...resto] = messages;
  return primeira?.role === 'system'
    ? [{ ...primeira, content: `${ollama.projectContext}\n\n${primeira.content}` }, ...resto]
    : [{ role: 'system', content: ollama.projectContext }, ...messages];
}

async function chatOllama({ ollama, messages, format, temperature, onProgress }) {
  const numCtx = ollama.numCtx;
  const estimated = estimateTokens(messages);

  if (numCtx && estimated > numCtx * 0.8) {
    throw new Error(
      `O prompt tem ~${estimated} tokens e o contexto configurado é ${numCtx}. `
      + 'Aumente com "detro ai ctx <tokens>" ou aponte referências menores em .detro/config.json.',
    );
  }

  const idleMs = ollama.timeoutMs ?? 900000;
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), idleMs);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), idleMs);
  };

  const response = await postStream(`${normalizeBaseUrl(ollama.baseUrl)}/api/chat`, {
    model: ollama.model,
    messages,
    stream: true,
    format,
    options: {
      temperature: temperature ?? ollama.temperature ?? 0.2,
      num_ctx: numCtx,
    },
  }, controller.signal).catch((error) => {
    clearTimeout(idle);
    throw error;
  });

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let chunks = 0;
  let final = null;

  function consume(data) {
    if (data.message?.content) {
      content += data.message.content;
      chunks += 1;
      onProgress?.(chunks);
    }

    if (data.done) {
      final = data;
    }
  }

  try {
    for await (const chunk of response) {
      touch();
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n');

      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (line) {
          consume(parseLine(line));
        }

        index = buffer.indexOf('\n');
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`O modelo ficou ${Math.round(idleMs / 60000)} min sem gerar nada. Aumente ai.ollama.timeoutMs em .detro/config.json ou use um modelo menor.`);
    }

    throw error;
  } finally {
    clearTimeout(idle);
  }

  if (buffer.trim()) {
    consume(parseLine(buffer.trim()));
  }

  if (!content.trim()) {
    throw new Error('O Ollama retornou uma resposta vazia. Confira se o modelo está instalado: detro ai status');
  }

  if (final?.done_reason === 'length') {
    throw new Error('A resposta do modelo foi cortada pelo limite de contexto. Aumente com "detro ai ctx <tokens>".');
  }

  if (numCtx && final?.prompt_eval_count >= numCtx) {
    throw new Error(`O prompt ocupou todo o contexto (${numCtx} tokens) e foi truncado pelo Ollama. Aumente com "detro ai ctx <tokens>".`);
  }

  return {
    content,
    promptTokens: final?.prompt_eval_count ?? null,
    outputTokens: final?.eval_count ?? chunks,
  };
}

function avisarEscalada(motivo) {
  process.stderr.write(`\n  ↑ ${motivo} — chamando o Claude…\n`);
}

function claudeChat({ claude = {}, messages, schema }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const prompt = messages
    .filter((m) => m.role !== 'system')
    .map((m) => (m.role === 'assistant' ? `RESPOSTA ANTERIOR (com problemas):\n${m.content}` : m.content))
    .join('\n\n---\n\n');

  const args = ['-p', '--tools', '', '--output-format', 'json', '--no-session-persistence', '--setting-sources', 'project'];
  if (system) args.push('--system-prompt', system);
  if (schema && typeof schema === 'object') args.push('--json-schema', JSON.stringify(schema));
  if (claude.model) args.push('--model', claude.model);

  const env = { ...process.env };
  if (!claude.usarApiKey) delete env.ANTHROPIC_API_KEY;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), claude.timeoutMs ?? 600000);

    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Não foi possível executar o Claude Code (${error.message}). Confira se o comando "claude" está instalado e logado.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let data;
      try {
        data = JSON.parse(out);
      } catch {
        reject(new Error(`O Claude Code não respondeu (código ${code}). ${err.trim().slice(0, 300)}`));
        return;
      }
      if (data.is_error) {
        reject(new Error(`O Claude Code recusou a chamada: ${String(data.result ?? '').slice(0, 300)}`));
        return;
      }
      const content = data.structured_output !== undefined ? JSON.stringify(data.structured_output) : String(data.result ?? '');
      resolve({ content, promptTokens: data.usage?.input_tokens ?? null, outputTokens: data.usage?.output_tokens ?? null, engine: 'claude' });
    });

    child.stdin.end(prompt);
  });
}

function falhaDoOllama(error) {
  return /Ollama|contexto|sem gerar nada|resposta vazia|cortada/.test(error?.message ?? '');
}

async function revisarComClaude({ claude, messages, content, format }) {
  const json = Boolean(format);
  const instrucao = json
    ? 'Devolva o JSON completo corrigido em "resultado" e, em "sugestoes", até 5 observações curtas em pt-BR para o desenvolvedor (lista vazia se não houver).'
    : 'Devolva SOMENTE o conteúdo completo corrigido, no mesmo formato, sem explicações nem comentários sobre a revisão.';
  const revisao = {
    role: 'user',
    content: `Um modelo local (Ollama) produziu a resposta abaixo para o pedido acima. Revise com rigor: corrija erros, complete o que faltar e siga todas as regras do pedido. ${instrucao}\n\nRESPOSTA DO OLLAMA:\n${content}`,
  };
  const envelope = json
    ? {
      type: 'object',
      properties: {
        resultado: typeof format === 'object' ? format : {},
        sugestoes: { type: 'array', items: { type: 'string' } },
      },
      required: ['resultado', 'sugestoes'],
    }
    : null;

  const resposta = await claudeChat({ claude, messages: [...messages, revisao], schema: envelope });

  if (!json) {
    return resposta;
  }

  const { resultado, sugestoes = [] } = JSON.parse(resposta.content);
  for (const sugestao of sugestoes) {
    process.stderr.write(`  ✎ claude: ${sugestao}\n`);
  }
  return { ...resposta, content: JSON.stringify(resultado) };
}

export async function ollamaChat({ ollama, messages: pedido, format, temperature, onProgress, attempt = 1 }) {
  const messages = comContexto(ollama, pedido);
  const claude = ollama.claude ?? {};
  const escalar = claude.enabled !== false;

  if (escalar && attempt > (claude.afterAttempts ?? 2)) {
    avisarEscalada(`O Ollama errou ${attempt - 1} vez(es) seguidas`);
    return claudeChat({ claude, messages, schema: format });
  }

  let resposta;
  try {
    resposta = await chatOllama({ ollama, messages, format, temperature, onProgress });
  } catch (error) {
    if (!escalar || !falhaDoOllama(error)) throw error;
    avisarEscalada(error.message);
    return claudeChat({ claude, messages, schema: format });
  }

  if (!escalar || claude.revisar === false) {
    return resposta;
  }

  process.stderr.write('\n  ✎ Claude revisando a resposta do Ollama…\n');
  try {
    return await revisarComClaude({ claude, messages, content: resposta.content, format });
  } catch (error) {
    process.stderr.write(`  ✎ revisão do Claude falhou (${error.message}); seguindo com a resposta do Ollama.\n`);
    return resposta;
  }
}

export async function ollamaJson({ ollama, messages, schema, onProgress, attempt = 1 }) {
  const { content, engine } = await ollamaChat({ ollama, messages, format: schema, temperature: 0, onProgress, attempt });

  try {
    return JSON.parse(content);
  } catch {
    if (engine === 'claude' || ollama.claude?.enabled === false) {
      throw new Error('O modelo não devolveu um JSON válido. Tente de novo ou use um modelo maior (detro ai model <nome>).');
    }
    avisarEscalada('O Ollama devolveu um JSON inválido');
    return JSON.parse((await claudeChat({ claude: ollama.claude ?? {}, messages, schema })).content);
  }
}

const MAX_PASSOS_AGENTE = 30;
const MAX_SAIDA_FERRAMENTA = 20000;
const git = promisify(execFile);

const FERRAMENTAS_AGENTE = [
  ['listar_arquivos', 'Lista os arquivos versionados cujo caminho contém o texto, ou que casam com um glob como "api/src/**/*.dto.ts" (equivale ao Glob).', { filtro: 'string' }, ['filtro']],
  ['buscar', 'Busca uma regex (git grep -E) no código e devolve caminho:linha:trecho (equivale ao Grep). "pasta" (relativa à raiz do projeto, ex.: "api/src") limita a busca.', { padrao: 'string', pasta: 'string' }, ['padrao']],
  ['ler_arquivo', 'Lê um arquivo com as linhas numeradas, até 400 linhas por chamada (equivale ao Read).', { caminho: 'string', inicio: 'integer', fim: 'integer' }, ['caminho']],
].map(([name, description, props, required]) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])), required },
  },
}));

function globParaRegex(glob) {
  const corpo = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${corpo}$`);
}

async function executarFerramenta(projectDir, { name, arguments: args = {} }) {
  const saidaGit = (params) => git('git', params, { cwd: projectDir, maxBuffer: 5e7 })
    .then(({ stdout }) => stdout, (error) => (error.code === 1 ? '' : Promise.reject(error)));

  if (name === 'listar_arquivos') {
    const filtro = String(args.filtro ?? '');
    const casa = filtro.includes('*') ? globParaRegex(filtro) : null;
    const achados = (await saidaGit(['ls-files'])).split('\n').filter((f) => f && (casa ? casa.test(f) : f.includes(filtro)));
    return achados.length > 0 ? achados.slice(0, 200).join('\n') : '(nenhum arquivo com esse trecho no caminho)';
  }
  if (name === 'buscar') {
    const linhas = (await saidaGit(['grep', '-n', '-I', '-E', '-e', String(args.padrao ?? ''), '--', args.pasta || '.'])).split('\n').filter(Boolean);
    return linhas.length > 0 ? linhas.slice(0, 100).join('\n') : '(nenhum resultado)';
  }
  if (name === 'ler_arquivo') {
    const absoluto = path.resolve(projectDir, String(args.caminho ?? ''));
    if (!absoluto.startsWith(path.resolve(projectDir) + path.sep)) return 'Erro: o caminho precisa estar dentro do projeto.';
    const linhas = (await readFile(absoluto, 'utf8')).split('\n');
    const inicio = Math.max(1, Number(args.inicio) || 1);
    const fim = Math.min(linhas.length, Number(args.fim) || inicio + 399, inicio + 399);
    const corpo = linhas.slice(inicio - 1, fim).map((linha, i) => `${inicio + i}: ${linha}`).join('\n');
    return fim < linhas.length ? `${corpo}\n(arquivo tem ${linhas.length} linhas; leia o resto com inicio=${fim + 1})` : corpo;
  }
  return `Erro: ferramenta inexistente "${name}". Use listar_arquivos, buscar ou ler_arquivo.`;
}

async function chamadaAgente(ollama, corpo) {
  const response = await request(`${normalizeBaseUrl(ollama.baseUrl)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollama.model, stream: false, options: { num_ctx: ollama.numCtx }, ...corpo }),
    signal: AbortSignal.timeout(ollama.timeoutMs ?? 900000),
  });
  const data = await response.json();
  if (data.error) throw new Error(`Ollama: ${data.error}`);
  return data.message ?? {};
}

function extrairJson(texto) {
  const limpo = String(texto ?? '').trim();
  try {
    return JSON.parse(limpo);
  } catch {
    const inicio = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (inicio < 0 || fim <= inicio) throw new Error('o agente não devolveu JSON');
    return JSON.parse(limpo.slice(inicio, fim + 1));
  }
}

export async function agenteJson({ projectDir, prompt, schema, comFerramentas, ollama }) {
  const messages = [
    {
      role: 'system',
      content: comFerramentas
        ? 'Suas ferramentas de leitura são listar_arquivos (Glob), buscar (Grep) e ler_arquivo (Read). Confirme no código antes de afirmar: nunca invente caminho, nome ou valor. Quando o enunciado citar Read/Grep/Glob, use as equivalentes.'
        : 'Responda só com o que está no enunciado.',
    },
    { role: 'user', content: prompt },
  ];

  if (comFerramentas) {
    for (let passo = 1; ; passo += 1) {
      if (passo > MAX_PASSOS_AGENTE) throw new Error(`o agente passou de ${MAX_PASSOS_AGENTE} passos sem concluir`);
      const mensagem = await chamadaAgente(ollama, { messages, tools: FERRAMENTAS_AGENTE, options: { num_ctx: ollama.numCtx, temperature: 0 } });
      messages.push({ role: 'assistant', content: mensagem.content ?? '', tool_calls: mensagem.tool_calls });
      if (!mensagem.tool_calls?.length) break;
      for (const chamada of mensagem.tool_calls) {
        const saida = await executarFerramenta(projectDir, chamada.function).catch((error) => `Erro: ${error.message}`);
        process.stderr.write(`    · ${chamada.function.name} ${JSON.stringify(chamada.function.arguments ?? {}).slice(0, 120)}\n`);
        messages.push({ role: 'tool', tool_name: chamada.function.name, content: saida.slice(0, MAX_SAIDA_FERRAMENTA) });
      }
    }
  }
  messages.push({ role: 'user', content: `Agora devolva a resposta final SOMENTE como JSON que siga EXATAMENTE este JSON Schema, com estas chaves e nenhuma outra:\n${JSON.stringify(schema)}` });

  const final = await chamadaAgente(ollama, { messages, format: schema, options: { num_ctx: ollama.numCtx, temperature: 0 } });
  const resposta = extrairJson(final.content);
  const faltando = (schema.required ?? []).filter((chave) => !(chave in resposta));
  if (faltando.length > 0) throw new Error(`a resposta do agente não segue o formato (faltou ${faltando.join(', ')})`);
  return resposta;
}
