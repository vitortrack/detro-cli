import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CONFIG = {
  projeto: {
    nome: null,
    descricao: null,
  },
  ai: {
    provider: 'ollama',
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:7b',
      numCtx: 24576,
      temperature: 0.2,
      timeoutMs: 900000,
      claude: {
        enabled: true,
        revisar: true,
        verificarFeature: true,
        usarApiKey: false,
        afterAttempts: 2,
        model: null,
        timeoutMs: 600000,
      },
    },
    generation: {
      maxRepairs: 2,
    },
    database: {
      container: null,
    },
    references: {
      formModal: null,
      page: null,
    },
    catalog: {
      exclude: [],
    },
    review: {
      maxFileChars: 24000,
      tenantExclude: ['/workers/'],
    },
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const result = { ...base };

  for (const [key, value] of Object.entries(override ?? {})) {
    result[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }

  return result;
}

async function comContextoDoProjeto(config, projectDir) {
  const nome = config.projeto?.nome ?? path.basename(projectDir);
  const descricao = config.projeto?.descricao;
  const { detectProfile, describeProfile } = await import('./profile.js');
  const stack = describeProfile(await detectProfile(projectDir));
  config.ai.ollama.projectContext = [`PROJETO: ${nome}${descricao ? ` — ${descricao}` : ''}`, stack].filter(Boolean).join('\n');
  return config;
}

export function getConfigPath(projectDir) {
  return path.join(projectDir, '.detro', 'config.json');
}

export async function loadDetroConfig(projectDir) {
  try {
    const raw = await readFile(getConfigPath(projectDir), 'utf8');
    return await comContextoDoProjeto(deepMerge(DEFAULT_CONFIG, JSON.parse(raw)), projectDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return await comContextoDoProjeto(structuredClone(DEFAULT_CONFIG), projectDir);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`O arquivo .detro/config.json não é um JSON válido: ${error.message}`);
    }

    throw error;
  }
}

export async function saveDetroConfig(projectDir, config) {
  const configPath = getConfigPath(projectDir);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function requireOllama(config) {
  if (config.ai.provider !== 'ollama') {
    throw new Error(`Provider ainda não suportado: ${config.ai.provider}. Use: detro ai provider ollama`);
  }

  return config.ai.ollama;
}
