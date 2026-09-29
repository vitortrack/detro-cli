import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function getImplementationFile(projectDir) {
  return path.join(projectDir, '.detro', 'last-implementation.json');
}

export async function saveImplementation({ projectDir, implementation }) {
  const filePath = getImplementationFile(projectDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(implementation, null, 2)}\n`, 'utf8');
  return filePath;
}

export async function loadImplementation(projectDir) {
  const filePath = getImplementationFile(projectDir);
  let raw;

  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Nenhuma implementação preparada foi encontrada. Execute primeiro: detro apply --dry-run (ou detro fix <arquivo>).');
    }

    throw error;
  }

  try {
    return { filePath, implementation: JSON.parse(raw) };
  } catch {
    throw new Error('O arquivo .detro/last-implementation.json está inválido. Gere de novo com detro apply --dry-run.');
  }
}

export async function markImplementationApplied(projectDir, implementation) {
  await saveImplementation({
    projectDir,
    implementation: { ...implementation, appliedAt: new Date().toISOString() },
  });
}

export async function saveAttempt(projectDir, attempt) {
  const filePath = path.join(projectDir, '.detro', 'last-attempt.json');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(attempt, null, 2)}\n`, 'utf8');
  return filePath;
}
