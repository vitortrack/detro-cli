import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

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
