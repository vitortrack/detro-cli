import { execFile, spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const POSTGRES_IMAGE = /^(postgres|postgis\/postgis)(:|$)/;

export async function findPostgresContainer(preferred) {
  let stdout;

  try {
    ({ stdout } = await run('docker', ['ps', '--format', '{{.ID}}\t{{.Image}}\t{{.Names}}']));
  } catch {
    throw new Error('Não consegui falar com o Docker. Verifique se ele está rodando e se seu usuário tem acesso (docker ps).');
  }

  const containers = stdout.split('\n').filter(Boolean).map((line) => {
    const [id, image, name] = line.split('\t');
    return { id, image, name };
  });

  if (preferred) {
    const match = containers.find((container) => container.name === preferred || container.id.startsWith(preferred));

    if (!match) {
      throw new Error(`O container "${preferred}" (ai.database.container) não está rodando. Suba o banco com ./app start.`);
    }

    return match;
  }

  const candidates = containers.filter((container) => POSTGRES_IMAGE.test(container.image));

  if (candidates.length === 0) {
    throw new Error('Nenhum container PostgreSQL rodando. Suba o banco com ./app start.');
  }

  if (candidates.length > 1) {
    throw new Error(`Há mais de um PostgreSQL rodando (${candidates.map((container) => container.name).join(', ')}). Defina ai.database.container em .detro/config.json.`);
  }

  return candidates[0];
}

export async function applyMigration({ projectDir, migration, container }) {
  const sql = await readFile(path.join(projectDir, migration), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec', '-i', container.id, 'sh', '-c',
      'exec psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`A migration falhou e foi desfeita (transação única):\n${output.trim()}`));
      }
    });

    child.stdin.end(sql);
  });
}

export async function findAppScript(projectDir) {
  for (const name of [process.env.DETRO_APP_SCRIPT, 'appDev', 'app'].filter(Boolean)) {
    const script = path.join(projectDir, name);

    try {
      await access(script, constants.X_OK);
      return script;
    } catch {
      continue;
    }
  }

  return null;
}

export function restartServices({ projectDir, script, services }) {
  return new Promise((resolve, reject) => {
    const child = spawn(script, ['restart', ...services], { cwd: projectDir, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
