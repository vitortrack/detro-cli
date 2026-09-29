import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { semanticLint } from './semanticLint.js';

const checkers = new Map();

export function toProjectPath(projectDir, absolutePath) {
  return path.relative(projectDir, absolutePath).replaceAll('\\', '/');
}

export function resolveProjectPath(projectDir, input, cwd = process.cwd()) {
  const fromCwd = path.resolve(cwd, input);
  const candidate = existsSync(fromCwd) ? fromCwd : path.resolve(projectDir, input);
  return toProjectPath(projectDir, candidate);
}

let projectRoot = process.cwd();
const workspaceCache = new Map();

export function setProjectRoot(dir) {
  projectRoot = dir;
  workspaceCache.clear();
}

export function workspaceOf(relativePath) {
  const normalized = String(relativePath).replaceAll('\\', '/');

  if (!/\.(ts|tsx|mts|cts)$/.test(normalized) || normalized.includes('node_modules/')) {
    return null;
  }

  let dir = path.posix.dirname(normalized);

  while (true) {
    if (workspaceCache.has(dir)) {
      return workspaceCache.get(dir);
    }

    if (existsSync(path.join(projectRoot, dir, 'tsconfig.json'))) {
      workspaceCache.set(dir, dir);
      return dir;
    }

    if (dir === '.' || dir === '' || dir === '/') {
      workspaceCache.set(dir, null);
      return null;
    }

    dir = path.posix.dirname(dir);
  }
}

export function loadTypeScript(projectDir, workspace = 'web') {
  try {
    return createRequire(path.join(projectDir, workspace, 'package.json'))('typescript');
  } catch {
    return null;
  }
}

function formatDiagnostic(ts, diagnostic) {
  let line = 0;

  if (diagnostic.file && diagnostic.start !== undefined) {
    line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
  }

  return {
    line,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  };
}

function createChecker(projectDir, workspace) {
  const ts = loadTypeScript(projectDir, workspace);

  if (!ts) {
    return null;
  }

  const root = path.join(projectDir, workspace);
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });

  if (!parsed) {
    return null;
  }

  const options = {
    ...parsed.options,
    noEmit: true,
    incremental: false,
    composite: false,
    declaration: false,
    sourceMap: false,
  };
  delete options.tsBuildInfoFile;

  const projectFiles = parsed.fileNames.map((file) => path.resolve(file));
  const ambientFiles = projectFiles.filter((file) => file.endsWith('.d.ts'));
  const baseHost = ts.createCompilerHost(options, true);
  const sourceCache = new Map();
  let oldProgram;

  function check({ virtualFiles = new Map(), targets, wholeProject = false, lint = false } = {}) {
    const virtual = new Map();

    for (const [relativePath, content] of virtualFiles) {
      if (workspaceOf(relativePath) === workspace) {
        virtual.set(path.resolve(projectDir, relativePath), content);
      }
    }

    const virtualDirs = new Set();

    for (const file of virtual.keys()) {
      let dir = path.dirname(file);

      while (dir.startsWith(root) && !virtualDirs.has(dir)) {
        virtualDirs.add(dir);
        dir = path.dirname(dir);
      }
    }

    const host = {
      ...baseHost,
      fileExists: (file) => virtual.has(path.resolve(file)) || baseHost.fileExists(file),
      readFile: (file) => virtual.get(path.resolve(file)) ?? baseHost.readFile(file),
      directoryExists: (dir) => virtualDirs.has(path.resolve(dir)) || ts.sys.directoryExists(dir),
      getSourceFile: (file, languageVersion, onError, shouldCreate) => {
        const absolute = path.resolve(file);
        const content = virtual.get(absolute);

        if (content !== undefined) {
          return ts.createSourceFile(file, content, languageVersion, true);
        }

        if (!sourceCache.has(absolute)) {
          sourceCache.set(absolute, baseHost.getSourceFile(file, languageVersion, onError, shouldCreate));
        }

        return sourceCache.get(absolute);
      },
    };

    const targetFiles = (targets ?? [...virtualFiles.keys()])
      .filter((relativePath) => workspaceOf(relativePath) === workspace)
      .map((relativePath) => path.resolve(projectDir, relativePath));

    const rootNames = [
      ...new Set([
        ...(wholeProject ? projectFiles : ambientFiles),
        ...targetFiles,
      ]),
    ];

    const program = ts.createProgram({ rootNames, options, host, oldProgram });
    oldProgram = program;

    const result = new Map();

    for (const file of targetFiles) {
      const relativePath = toProjectPath(projectDir, file);
      const sourceFile = program.getSourceFile(file);

      if (!sourceFile) {
        result.set(relativePath, [{ line: 0, code: 0, message: 'O arquivo não pôde ser carregado pelo TypeScript.' }]);
        continue;
      }

      const diagnostics = [
        ...program.getSyntacticDiagnostics(sourceFile),
        ...program.getSemanticDiagnostics(sourceFile),
      ];

      const items = diagnostics.map((diagnostic) => formatDiagnostic(ts, diagnostic));

      if (lint && !/\.d\.ts$/.test(file)) {
        items.push(...semanticLint(ts, program.getTypeChecker(), sourceFile).map((item) => ({ ...item, code: 0 })));
      }

      result.set(relativePath, items);
    }

    return result;
  }

  const serviceState = { virtual: new Map(), versions: new Map(), roots: [] };
  let languageService = null;

  function getLanguageService() {
    if (languageService) {
      return languageService;
    }

    const snapshot = (file) => {
      const content = serviceState.virtual.get(path.resolve(file)) ?? ts.sys.readFile(file);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    };

    languageService = ts.createLanguageService({
      getCompilationSettings: () => options,
      getScriptFileNames: () => serviceState.roots,
      getScriptVersion: (file) => String(serviceState.versions.get(path.resolve(file)) ?? 0),
      getScriptSnapshot: snapshot,
      getCurrentDirectory: () => root,
      getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
      fileExists: (file) => serviceState.virtual.has(path.resolve(file)) || ts.sys.fileExists(file),
      readFile: (file) => serviceState.virtual.get(path.resolve(file)) ?? ts.sys.readFile(file),
      directoryExists: (dir) => [...serviceState.virtual.keys()].some((file) => file.startsWith(`${path.resolve(dir)}${path.sep}`)) || ts.sys.directoryExists(dir),
      readDirectory: ts.sys.readDirectory,
      getDirectories: ts.sys.getDirectories,
    }, ts.createDocumentRegistry());

    return languageService;
  }

  function setVirtual(virtualFiles) {
    for (const [relativePath, content] of virtualFiles) {
      if (workspaceOf(relativePath) !== workspace) {
        continue;
      }

      const absolute = path.resolve(projectDir, relativePath);

      if (serviceState.virtual.get(absolute) !== content) {
        serviceState.virtual.set(absolute, content);
        serviceState.versions.set(absolute, (serviceState.versions.get(absolute) ?? 0) + 1);
      }
    }
  }

  function autoFix({ virtualFiles, target, codes }) {
    const absolute = path.resolve(projectDir, target);
    const service = getLanguageService();
    const applied = [];

    setVirtual(virtualFiles);
    serviceState.roots = [...new Set([...(options.jsx ? projectFiles : ambientFiles), absolute])];

    for (let round = 0; round < 15; round += 1) {
      const content = serviceState.virtual.get(absolute);
      const diagnostics = [
        ...service.getSyntacticDiagnostics(absolute),
        ...service.getSemanticDiagnostics(absolute),
      ].filter((diagnostic) => codes.includes(diagnostic.code) && diagnostic.start !== undefined);

      let fixed = false;

      for (const diagnostic of diagnostics) {
        const fixes = service.getCodeFixesAtPosition(
          absolute,
          diagnostic.start,
          diagnostic.start + (diagnostic.length ?? 0),
          [diagnostic.code],
          { indentSize: 2, tabSize: 2, convertTabsToSpaces: true, semicolons: ts.SemicolonPreference.Insert },
          { quotePreference: 'single', importModuleSpecifierPreference: 'non-relative', includePackageJsonAutoImports: 'off' },
        );

        const fix = fixes.find((item) =>
          (item.fixName === 'unusedIdentifier' && /^(Remove|Delete)/i.test(item.description))
          || item.fixName === 'import');

        const changes = fix?.changes.filter((change) => path.resolve(change.fileName) === absolute) ?? [];

        if (!fix || changes.length === 0 || changes.length !== fix.changes.length) {
          continue;
        }

        const edits = changes.flatMap((change) => change.textChanges).sort((a, b) => b.span.start - a.span.start);
        let next = content;

        for (const edit of edits) {
          next = next.slice(0, edit.span.start) + edit.newText + next.slice(edit.span.start + edit.span.length);
        }

        setVirtual(new Map([[target, next]]));
        applied.push(`TS${diagnostic.code}: ${fix.description}`);
        fixed = true;
        break;
      }

      if (!fixed) {
        break;
      }
    }

    return { content: serviceState.virtual.get(absolute), applied };
  }

  return {
    ts,
    workspace,
    projectFiles: projectFiles
      .filter((file) => !file.endsWith('.d.ts'))
      .map((file) => toProjectPath(projectDir, file)),
    check,
    autoFix,
  };
}

export function autoFix(projectDir, { virtualFiles, target, codes = [6133, 6192, 6196, 6198, 6199, 6205, 2304] }) {
  const checker = getChecker(projectDir, workspaceOf(target));

  if (!checker) {
    return { content: virtualFiles.get(target), applied: [] };
  }

  return checker.autoFix({ virtualFiles, target, codes });
}

export function getChecker(projectDir, workspace) {
  const key = `${projectDir}:${workspace}`;

  if (!checkers.has(key)) {
    checkers.clear();
    checkers.set(key, createChecker(projectDir, workspace));
  }

  return checkers.get(key);
}

export function typeCheck(projectDir, { virtualFiles = new Map(), targets, wholeProject = false, lint = false }) {
  const byWorkspace = new Map();

  for (const relativePath of targets) {
    const workspace = workspaceOf(relativePath);

    if (workspace) {
      byWorkspace.set(workspace, [...(byWorkspace.get(workspace) ?? []), relativePath]);
    }
  }

  const diagnostics = new Map();
  const unavailable = [];

  for (const [workspace, files] of byWorkspace) {
    const checker = getChecker(projectDir, workspace);

    if (!checker) {
      unavailable.push(workspace);
      continue;
    }

    for (const [file, items] of checker.check({ virtualFiles, targets: files, wholeProject, lint })) {
      diagnostics.set(file, items);
    }
  }

  return { diagnostics, unavailable };
}

export function syntaxCheck(projectDir, relativePath, content) {
  const ts = loadTypeScript(projectDir, workspaceOf(relativePath) ?? '.');

  if (!ts) {
    return null;
  }

  const { diagnostics = [] } = ts.transpileModule(content, {
    fileName: relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      experimentalDecorators: true,
      target: ts.ScriptTarget.ES2022,
    },
  });

  return diagnostics.map((diagnostic) => formatDiagnostic(ts, diagnostic));
}

export function typeCheckIsolated(projectDir, { virtualFiles = new Map(), targets, wholeProject = false, lint = false, maxMemoryMb = 6144 }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./typecheckWorker.js', import.meta.url), {
      workerData: { projectDir, virtualFiles: [...virtualFiles], targets, wholeProject, lint },
      resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb },
    });

    worker.once('message', (message) => {
      if (message.error) {
        reject(new Error(message.error));
        return;
      }

      resolve({ diagnostics: new Map(message.diagnostics), unavailable: message.unavailable });
    });

    worker.once('error', (error) => {
      reject(new Error(`A checagem de tipos falhou: ${error.message}. Tente com menos arquivos.`));
    });

    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`A checagem de tipos terminou com código ${code} (provável falta de memória). Tente com menos arquivos.`));
      }
    });
  });
}
