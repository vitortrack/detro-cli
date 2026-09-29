import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PLAN_VERSION = 2;

export function getPlanFile(projectDir) {
  return path.join(projectDir, '.detro', 'last-plan.json');
}

export async function saveLastPlan({ projectDir, request, spec, requirements = [], createdAt, recipe = 'crud', operation, edit, example, evidence }) {
  const filePath = getPlanFile(projectDir);
  await mkdir(path.dirname(filePath), { recursive: true });

  const data = {
    version: PLAN_VERSION,
    recipe,
    createdAt: createdAt ?? new Date().toISOString(),
    request,
    ...(recipe === 'menu' ? { operation } : recipe === 'edit' ? { edit } : { requirements, spec, ...(example ? { example } : {}), ...(evidence ? { evidence } : {}) }),
  };

  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return filePath;
}

export async function loadLastPlan(projectDir) {
  const filePath = getPlanFile(projectDir);
  let raw;

  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Nenhum plano encontrado. Execute primeiro: detro plan "descrição da feature"');
    }

    throw error;
  }

  let plan;

  try {
    plan = JSON.parse(raw);
  } catch (error) {
    throw new Error(`O arquivo .detro/last-plan.json não é um JSON válido (${error.message}). Corrija a edição ou gere de novo com detro plan.`);
  }

  if (plan.version !== PLAN_VERSION || (!plan.spec && !plan.operation && !plan.edit)) {
    throw new Error('O último plano está no formato antigo. Gere de novo com: detro plan "descrição da feature"');
  }

  return { filePath, plan };
}
