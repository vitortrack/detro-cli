import { parentPort, workerData } from 'node:worker_threads';

import { typeCheck } from './typescript.js';

try {
  const { projectDir, virtualFiles, targets, wholeProject, lint } = workerData;
  const result = typeCheck(projectDir, { virtualFiles: new Map(virtualFiles), targets, wholeProject, lint });
  parentPort.postMessage({ diagnostics: [...result.diagnostics], unavailable: result.unavailable });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
