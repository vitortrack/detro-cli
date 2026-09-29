import {
  access,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';

import path from 'node:path';
import crypto from 'node:crypto';

function sha256(
  content,
) {
  return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex');
}

async function fileExists(
  filePath,
) {
  try {
    await access(
      filePath,
    );

    return true;
  } catch {
    return false;
  }
}

function resolveInsideProject(
  projectDir,
  relativePath,
) {
  const absolutePath =
    path.resolve(
      projectDir,
      relativePath,
    );

  const relative =
    path.relative(
      projectDir,
      absolutePath,
    );

  if (
    relative.startsWith('..') ||
    path.isAbsolute(
      relative,
    )
  ) {
    throw new Error(
      `Caminho fora do projeto bloqueado: ${relativePath}`,
    );
  }

  return absolutePath;
}

export async function applyImplementation({
  projectDir,
  implementation,
}) {
  const applied = [];

  /*
   * Primeiro validamos TUDO.
   * Só depois começamos a escrever.
   */
  for (
    const file
    of implementation.files
  ) {
    const absolutePath =
      resolveInsideProject(
        projectDir,
        file.path,
      );

    const exists =
      await fileExists(
        absolutePath,
      );

    if (
      file.action === 'create' &&
      exists
    ) {
      throw new Error(
        `O arquivo já existe e não será sobrescrito: ${file.path}`,
      );
    }

    if (
      file.action === 'modify'
    ) {
      if (!exists) {
        throw new Error(
          `Arquivo que deveria ser alterado não existe: ${file.path}`,
        );
      }

      const currentContent =
        await readFile(
          absolutePath,
          'utf8',
        );

      const currentHash =
        sha256(
          currentContent,
        );

      if (
        file.originalHash &&
        currentHash !==
          file.originalHash
      ) {
        throw new Error(
          `O arquivo mudou desde o dry-run: ${file.path}`,
        );
      }
    }
  }

  /*
   * Tudo validado.
   * Agora escreve.
   */
  for (
    const file
    of implementation.files
  ) {
    const absolutePath =
      resolveInsideProject(
        projectDir,
        file.path,
      );

    await mkdir(
      path.dirname(
        absolutePath,
      ),
      {
        recursive: true,
      },
    );

    await writeFile(
      absolutePath,
      `${file.content.trimEnd()}\n`,
      'utf8',
    );

    applied.push({
      path:
        file.path,

      action:
        file.action,
    });
  }

  return {
    applied,
  };
}