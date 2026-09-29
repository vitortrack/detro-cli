import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { findTsProjects } from './review.js';
import { loadTypeScript } from './typescript.js';

const STACKS = {
  frontend: { react: 'React', vue: 'Vue', '@angular/core': 'Angular', svelte: 'Svelte', next: 'Next.js', 'solid-js': 'Solid', vite: 'Vite', '@tanstack/react-query': 'React Query', 'react-router-dom': 'React Router', tailwindcss: 'Tailwind', zustand: 'Zustand' },
  backend: { '@nestjs/core': 'NestJS', express: 'Express', fastify: 'Fastify', koa: 'Koa', hono: 'Hono' },
  database: { pg: 'PostgreSQL (pg)', typeorm: 'TypeORM', prisma: 'Prisma', '@prisma/client': 'Prisma', sequelize: 'Sequelize', mongoose: 'MongoDB (mongoose)', knex: 'Knex', 'drizzle-orm': 'Drizzle' },
};

async function read(projectDir, file) {
  try {
    return await readFile(path.join(projectDir, file), 'utf8');
  } catch {
    return null;
  }
}

async function packageFiles(projectDir, dir = '.', depth = 0, found = []) {
  if (depth > 3) {
    return found;
  }

  let entries = [];

  try {
    entries = await readdir(path.join(projectDir, dir), { withFileTypes: true });
  } catch {
    return found;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === 'package.json')) {
    found.push(path.posix.join(dir, 'package.json'));
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'dist', 'build'].includes(entry.name)) {
      await packageFiles(projectDir, path.posix.join(dir, entry.name), depth + 1, found);
    }
  }

  return found;
}

const ECOSSISTEMAS = [
  { arquivo: /^(requirements.*\.txt|pyproject\.toml|Pipfile)$/, linguagem: 'Python', frameworks: { django: 'Django', fastapi: 'FastAPI', flask: 'Flask', sqlalchemy: 'SQLAlchemy' } },
  { arquivo: /^composer\.json$/, linguagem: 'PHP', frameworks: { 'laravel/framework': 'Laravel', 'symfony/': 'Symfony' } },
  { arquivo: /^(pom\.xml|build\.gradle(\.kts)?)$/, linguagem: 'Java/Kotlin', frameworks: { 'spring-boot': 'Spring Boot', hibernate: 'Hibernate' } },
  { arquivo: /^go\.mod$/, linguagem: 'Go', frameworks: { 'gin-gonic': 'Gin', 'gofiber': 'Fiber', 'labstack/echo': 'Echo', 'gorm.io': 'GORM' } },
  { arquivo: /^Gemfile$/, linguagem: 'Ruby', frameworks: { rails: 'Rails' } },
  { arquivo: /\.csproj$/, linguagem: '.NET', frameworks: { 'Microsoft.AspNetCore': 'ASP.NET Core', EntityFrameworkCore: 'Entity Framework' } },
  { arquivo: /^Cargo\.toml$/, linguagem: 'Rust', frameworks: { actix: 'Actix', axum: 'Axum' } },
];

const INFRA = { 'postgis/': 'PostGIS', 'postgres': 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', redis: 'Redis', rabbitmq: 'RabbitMQ', elasticsearch: 'Elasticsearch', nginx: 'Nginx' };

async function arquivosMarcadores(projectDir, dir = '.', depth = 0, found = []) {
  if (depth > 2) {
    return found;
  }

  let entries = [];

  try {
    entries = await readdir(path.join(projectDir, dir), { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const relativo = path.posix.join(dir, entry.name);
    if (entry.isFile() && (ECOSSISTEMAS.some((eco) => eco.arquivo.test(entry.name)) || /^(docker-)?compose.*\.ya?ml$/.test(entry.name))) {
      found.push(relativo);
    } else if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'dist', 'build', 'vendor', 'venv', 'target'].includes(entry.name)) {
      await arquivosMarcadores(projectDir, relativo, depth + 1, found);
    }
  }

  return found;
}

async function outrasStacks(projectDir) {
  const linguagens = new Set();
  const infra = new Set();

  for (const arquivo of await arquivosMarcadores(projectDir)) {
    const nome = path.posix.basename(arquivo);
    const conteudo = (await read(projectDir, arquivo)) ?? '';

    if (/compose.*\.ya?ml$/.test(nome)) {
      for (const imagem of conteudo.matchAll(/image:\s*["']?([^\s"']+)/g)) {
        const achado = Object.entries(INFRA).find(([chave]) => imagem[1].toLowerCase().includes(chave));
        if (achado) infra.add(achado[1]);
      }
      continue;
    }

    const eco = ECOSSISTEMAS.find((item) => item.arquivo.test(nome));
    const frameworks = Object.entries(eco.frameworks).filter(([chave]) => conteudo.toLowerCase().includes(chave.toLowerCase())).map(([, rotulo]) => rotulo);
    linguagens.add(frameworks.length > 0 ? `${eco.linguagem} (${frameworks.join(', ')})` : eco.linguagem);
  }

  return { outras: [...linguagens], infra: [...infra] };
}

export function describeProfile(profile) {
  const partes = [
    ['Frontend', profile.stacks.frontend],
    ['Backend', profile.stacks.backend],
    ['Banco/ORM', profile.stacks.database],
    ['Outras linguagens', profile.stacks.outras],
    ['Infra', profile.stacks.infra],
  ].filter(([, itens]) => itens?.length > 0).map(([rotulo, itens]) => `${rotulo}: ${itens.join(', ')}`);

  const convencoes = profile.capabilities.fullstack ? ' Segue as convenções completas do detro (NestJS multi-tenant + React).' : '';
  return partes.length > 0 ? `STACK DETECTADA: ${partes.join('; ')}.${convencoes}` : '';
}

async function check(projectDir, file, pattern) {
  const content = await read(projectDir, file);
  return Boolean(content && (!pattern || pattern.test(content)));
}

async function hasSql(projectDir, dir) {
  try {
    return (await readdir(path.join(projectDir, dir))).some((name) => name.endsWith('.sql'));
  } catch {
    return false;
  }
}

export async function detectProfile(projectDir) {
  const stacks = { frontend: new Set(), backend: new Set(), database: new Set() };

  for (const file of await packageFiles(projectDir)) {
    try {
      const pkg = JSON.parse(await read(projectDir, file));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      for (const [kind, map] of Object.entries(STACKS)) {
        for (const [name, label] of Object.entries(map)) {
          if (deps[name]) {
            stacks[kind].add(label);
          }
        }
      }
    } catch {
      continue;
    }
  }

  const tsProjects = (await findTsProjects(projectDir)).map((dir) => ({ dir, typescript: Boolean(loadTypeScript(projectDir, dir)) }));

  const conventions = [
    ['Rotas com <RequireScreen> em web/src/App.tsx', await check(projectDir, 'web/src/App.tsx', /<RequireScreen\s/), 'front'],
    ['Menu NAV_GROUPS em web/src/components/Sidebar.tsx', await check(projectDir, 'web/src/components/Sidebar.tsx', /NAV_GROUPS/), 'menu'],
    ['ScreenKey em web/src/lib/screens.ts', await check(projectDir, 'web/src/lib/screens.ts', /type\s+ScreenKey/), 'front'],
    ['Componentes Modal, Field, DataTable, PageHeader, EmptyState em web/src/components', (await Promise.all(['Modal', 'Field', 'DataTable', 'PageHeader', 'EmptyState'].map((name) => check(projectDir, `web/src/components/${name}.tsx`)))).every(Boolean), 'front'],
    ['Cliente HTTP em web/src/lib/api.ts', await check(projectDir, 'web/src/lib/api.ts', /export const api\b/), 'back'],
    ['Módulo raiz NestJS em api/src/app.module.ts', await check(projectDir, 'api/src/app.module.ts', /@Module/), 'back'],
    ['ScreenKey em api/src/modules/permissions/screens.ts', await check(projectDir, 'api/src/modules/permissions/screens.ts', /type\s+ScreenKey/), 'back'],
    ['@RequirePermission / @CurrentOperator em api/src/modules/auth/decorators', (await check(projectDir, 'api/src/modules/auth/decorators/permissions.decorator.ts', /RequirePermission/)) && (await check(projectDir, 'api/src/modules/auth/decorators/current-operator.decorator.ts', /CurrentOperator/)), 'back'],
    ['Migrations SQL em db/init/', await hasSql(projectDir, 'db/init'), 'back'],
  ].map(([name, ok, area]) => ({ name, ok, area }));

  const ok = (areas) => conventions.filter((item) => areas.includes(item.area)).every((item) => item.ok);
  const typesOk = tsProjects.some((project) => project.typescript);

  return {
    stacks: { ...Object.fromEntries(Object.entries(stacks).map(([kind, set]) => [kind, [...set]])), ...(await outrasStacks(projectDir)) },
    tsProjects,
    conventions,
    capabilities: {
      review: typesOk,
      edit: true,
      menu: ok(['menu', 'front']),
      frontend: ok(['front', 'menu']),
      fullstack: ok(['front', 'menu', 'back']),
    },
  };
}

export function missingFor(profile, capability) {
  const areas = { menu: ['menu', 'front'], frontend: ['front', 'menu'], fullstack: ['front', 'menu', 'back'] }[capability] ?? [];
  return profile.conventions.filter((item) => areas.includes(item.area) && !item.ok).map((item) => item.name);
}
