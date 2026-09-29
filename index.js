#!/usr/bin/env -S node --max-old-space-size=4096

import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import {
    access,
    readFile,
} from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    runAiCommand,
    runPlanCommand,
    runApplyCommand,
    runCheckCommand,
    runFixCommand,
    runMenuCommand,
    runBatchCommand,
} from './ai/commands.js';
import { setProjectRoot } from './ai/typescript.js';

const __filename =
    fileURLToPath(
        import.meta.url,
    );

const __dirname =
    path.dirname(
        __filename,
    );

function findProjectRoot(start) {
    for (const marker of ['.detro', '.git', 'package.json']) {
        let dir = start;

        while (true) {
            if (existsSync(path.join(dir, marker))) {
                return dir;
            }

            const parent = path.dirname(dir);

            if (parent === dir) {
                break;
            }

            dir = parent;
        }
    }

    return start;
}

const PROJECT_DIR =
    findProjectRoot(
        process.cwd(),
    );

setProjectRoot(
    PROJECT_DIR,
);

const APP_SCRIPT =
    [process.env.DETRO_APP_SCRIPT, 'appDev', 'app']
        .filter(Boolean)
        .map((name) => path.resolve(PROJECT_DIR, name))
        .find((file) => existsSync(file))
    ?? path.join(PROJECT_DIR, 'appDev');

const PACKAGE_FILE =
    path.join(
        __dirname,
        'package.json',
    );

async function getCliVersion() {
    const raw =
        await readFile(
            PACKAGE_FILE,
            'utf8',
        );

    return JSON.parse(
        raw,
    ).version ?? 'desconhecida';
}

const commands = [
    {
        name: 'start — Sobe o stack e builda somente o que mudou',
        value: 'start',
    },
    {
        name: 'restart — Reinicia somente os serviços alterados',
        value: 'restart',
    },
    {
        name: 'rebuild — Faz build sem cache e recriação forçada',
        value: 'rebuild',
    },
    {
        name: 'logs — Exibe os logs dos containers',
        value: 'logs',
    },
    {
        name: 'status — Exibe containers e uso do Docker',
        value: 'status',
    },
    {
        name: 'stop — Para e remove os containers',
        value: 'stop',
    },
    {
        name: 'clean — Remove imagens órfãs e limita o cache',
        value: 'clean',
    },
    {
        name: 'hot-reload — Atualiza somente o frontend',
        value: 'hot-reload',
    },
    {
        name: 'worker — Faz o build do front atualizando pasta dist',
        value: 'worker',
    },
    {
        name: 'auto-remove — Remove containers, rede e volumes',
        value: 'auto-remove',
    },
    {
        name: 'execute — Executa comandos auxiliares como restore e backup',
        value: 'execute',
    },
    {
        name: 'ai — Configura e utiliza a IA local do DETRO',
        value: 'ai',
    },
    {
        name: 'plan — Gera a especificação de um CRUD a partir de uma descrição',
        value: 'plan',
    },
    {
        name: 'apply — Gera/valida (--dry-run) e aplica o código preparado',
        value: 'apply',
    },
    {
        name: 'check — Tipos, regras do projeto e falhas de lógica (--ia)',
        value: 'check',
    },
    {
        name: 'fix — Pede à IA a correção dos erros de um arquivo',
        value: 'fix',
    },
    {
        name: 'help — Exibe a ajuda completa do ./app',
        value: 'help',
    },
    {
        name: 'version — Mostra a versão instalada da CLI detro',
        value: 'version',
    },
    {
        name: 'sair',
        value: 'exit',
    },
];

async function validateApp() {
    try {
        console.log(
            'Script in Mode Development:',
        );

        console.warn(
            APP_SCRIPT,
        );

        await access(
            APP_SCRIPT,
            constants.F_OK |
                constants.X_OK,
        );
    } catch {
        console.error(
            chalk.red(
                'Erro: o script app não existe ou não é executável.',
            ),
        );

        console.error(
            chalk.yellow(
                APP_SCRIPT,
            ),
        );

        console.error();

        console.error(
            chalk.dim(
                `Execute: chmod +x "${APP_SCRIPT}"`,
            ),
        );

        process.exit(1);
    }
}

function runApp(args) {
    return new Promise(
        (
            resolve,
            reject,
        ) => {
            const child =
                spawn(
                    APP_SCRIPT,
                    args,
                    {
                        cwd:
                            PROJECT_DIR,

                        stdio:
                            'inherit',

                        shell:
                            false,
                    },
                );

            child.on(
                'error',
                reject,
            );

            child.on(
                'close',
                (code) => {
                    resolve(
                        code ?? 1,
                    );
                },
            );
        },
    );
}

function showHeader() {
    console.clear();

    console.log(
        chalk.cyan.bold(
            'DETRO CLI',
        ),
    );

    console.log(
        chalk.dim(
            'Ambiente de desenvolvimento + IA (Ollama com revisão do Claude)',
        ),
    );

    console.log(
        chalk.dim(
            `Projeto: ${PROJECT_DIR}`,
        ),
    );

    console.log();
}

async function showAiMenu() {
    showHeader();

    console.log(
        chalk.magenta.bold(
            'DETRO AI',
        ),
    );

    console.log();

    const action =
        await select({
            message:
                'Selecione uma ação de IA:',

            choices: [
                {
                    name: 'status — Verifica conexão com Ollama e modelo atual',
                    value: 'status',
                },
                {
                    name: 'models — Lista os modelos instalados no Ollama',
                    value: 'models',
                },
                {
                    name: 'help — Mostra os comandos disponíveis de IA',
                    value: 'help',
                },
                {
                    name: 'voltar',
                    value: 'back',
                },
            ],

            pageSize: 10,
            loop: false,
        });

    if (
        action === 'back'
    ) {
        return showMenu();
    }

    return runAiCommand({
        projectDir:
            PROJECT_DIR,

        args:
            [action],
    });
}

async function showMenu() {
    showHeader();

    const command =
        await select({
            message:
                'Selecione um comando:',

            choices:
                commands,

            pageSize:
                commands.length,

            loop:
                false,
        });

    if (
        command === 'exit'
    ) {
        return 0;
    }

    if (
        command === 'ai'
    ) {
        return showAiMenu();
    }

    if (
        command === 'plan'
    ) {
        console.log();

        console.log(
            chalk.yellow(
                'Use o comando:',
            ),
        );

        console.log();

        console.log(
            chalk.cyan(
                '  detro plan "descreva a feature que deseja criar"',
            ),
        );

        console.log();

        return 0;
    }

    if (
        command === 'apply'
    ) {
        console.log();

        console.log(
            chalk.yellow(
                'Use:',
            ),
        );

        console.log();

        console.log(
            chalk.cyan(
                '  detro apply --dry-run   gera e valida sem escrever',
            ),
        );

        console.log(
            chalk.cyan(
                '  detro apply             escreve o que foi preparado',
            ),
        );

        console.log();

        return 0;
    }

    if (
        command === 'check'
    ) {
        return runCheckCommand({
            projectDir:
                PROJECT_DIR,

            args: [],
        });
    }

    if (
        command === 'fix'
    ) {
        console.log();

        console.log(
            chalk.yellow(
                'Use o comando:',
            ),
        );

        console.log();

        console.log(
            chalk.cyan(
                '  detro fix <arquivo>',
            ),
        );

        console.log();

        return 0;
    }

    if (
        command === 'help'
    ) {
        return runApp([
            '--help',
        ]);
    }

    if (
        command === 'version'
    ) {
        console.log(
            chalk.cyan(
                `detro CLI — versão ${await getCliVersion()}`,
            ),
        );

        return 0;
    }

    return runApp([
        command,
    ]);
}

async function handleInternalCommand(
    args,
) {
    const command =
        args[0];

    if (
        command === 'ai'
    ) {
        return runAiCommand({
            projectDir:
                PROJECT_DIR,

            args:
                args.slice(1),
        });
    }

    if (
        command === 'plan'
    ) {
        return runPlanCommand({
            projectDir:
                PROJECT_DIR,

            args:
                args.slice(1),
        });
    }

    if (
        command === 'apply'
    ) {
        return runApplyCommand({
            projectDir:
                PROJECT_DIR,

            args:
                args.slice(1),
        });
    }

    if (
        command === 'check'
    ) {
        return runCheckCommand({
            projectDir:
                PROJECT_DIR,

            args:
                args.slice(1),
        });
    }

    if (
        command === 'fix'
    ) {
        return runFixCommand({
            projectDir:
                PROJECT_DIR,

            args:
                args.slice(1),
        });
    }

    if (
        command === 'menu'
    ) {
        return runMenuCommand({
            projectDir:
                PROJECT_DIR,

            args:
                args.slice(1),
        });
    }

    if (
        command === 'lote'
    ) {
        return runBatchCommand({
            projectDir:
                PROJECT_DIR,

            args:
                args.slice(1),
        });
    }

    return null;
}

async function main() {
    const args =
        process.argv.slice(2);

    if (
        args[0] ===
            'version' ||
        args[0] ===
            '--version' ||
        args[0] ===
            '-v'
    ) {
        console.log(
            chalk.cyan(
                `detro CLI — versão ${await getCliVersion()}`,
            ),
        );

        process.exit(0);
    }

    /*
     * Comandos internos:
     *
     * ai
     * plan
     * apply
     * check
     * fix
     *
     * Não passam pelo appDev.
     */
    if (
        args.length > 0
    ) {
        const internalCode =
            await handleInternalCommand(
                args,
            );

        if (
            internalCode !==
            null
        ) {
            process.exit(
                internalCode,
            );
        }
    }

    /*
     * Daqui para baixo:
     * comandos tradicionais do appDev.
     */
    await validateApp();

    if (
        args.length === 0
    ) {
        const code =
            await showMenu();

        process.exit(
            code,
        );
    }

    const code =
        await runApp(
            args,
        );

    process.exit(
        code,
    );
}

main().catch(
    (error) => {
        if (
            error?.name ===
            'ExitPromptError'
        ) {
            console.log(
                chalk.yellow(
                    '\nOperação cancelada.',
                ),
            );

            process.exit(0);
        }

        console.error(
            chalk.red(
                `Erro: ${error.message}`,
            ),
        );

        process.exit(1);
    },
);