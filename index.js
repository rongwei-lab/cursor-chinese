#!/usr/bin/env node

/**
 * cursor chinese — 入口文件
 *
 * 执行逻辑 (防止 sudo-prompt + inquirer 死锁):
 *
 *   1. 解析 process.argv，如果检测到 --action=translate 或 --action=restore
 *      → 直接静默执行对应操作，不启动 inquirer 菜单（提权后的子进程走这条路）
 *
 *   2. 否则 → 展示 inquirer 交互菜单让用户选择操作
 *      → 检测是否有写入权限
 *        → 有权限：直接执行
 *        → 无权限：通过 sudo-prompt 以管理员身份重拉自身，追加 --action 参数
 */

const fs = require('fs');
const chalk = require('chalk');
const inquirer = require('inquirer');
const path = require('path');
const { version: PACKAGE_VERSION } = require('./package.json');
const {
    resolveCursorPath,
    parseCursorPathArg,
    findRunningCursorAppPaths,
    findAllCursorCandidates,
    normalizeToAppPath,
    buildPathsFromAppPath,
    loadConfig,
    isValidAppPath,
    saveConfig,
    hasWritePermission,
    elevateAndRun,
    CONFIG_FILE,
} = require('./src/platform');
const { translate, restore } = require('./src/i18n-core');

// ═══════════════════════════════════════════════
// 解析命令行参数
// ═══════════════════════════════════════════════

function parseAction() {
    const actionArg = process.argv.find(arg => arg.startsWith('--action='));
    if (!actionArg) return null;
    return actionArg.split('=')[1]; // 'translate' | 'restore'
}

function getCliCursorPath() {
    return parseCursorPathArg();
}

// ═══════════════════════════════════════════════
// Cursor 路径解析（自动 / 手动 / 多选）
// ═══════════════════════════════════════════════

function pathHint() {
    if (process.platform === 'win32') {
        return '%LOCALAPPDATA%\\Programs\\cursor 或 Cursor.exe 所在目录';
    }
    if (process.platform === 'darwin') {
        return '/Applications/Cursor.app 或 .../Contents/Resources/app';
    }
    return 'Cursor 安装目录或 resources/app 路径';
}

async function promptManualPath() {
    const { manualPath } = await inquirer.prompt([
        {
            type: 'input',
            name: 'manualPath',
            message: chalk.white.bold('请输入 Cursor 安装路径：'),
            validate: (input) => {
                const trimmed = (input || '').trim();
                if (!trimmed) return '路径不能为空';
                if (!normalizeToAppPath(trimmed)) {
                    return `无法识别为有效的 Cursor 目录（需包含 workbench.desktop.main.js）。提示：${pathHint()}`;
                }
                return true;
            },
        },
    ]);
    const appPath = normalizeToAppPath(typeof manualPath === 'string' ? manualPath.trim() : '');
    if (!appPath) {
        console.log(chalk.red('  ❌ 输入的 Cursor 路径已无效，请重新选择。'));
        return null;
    }
    saveConfig({ cursorAppPath: appPath });
    return buildPathsFromAppPath(appPath);
}

function sameCursorAppPath(left, right) {
    if (!left || !right) return false;

    try {
        const normalizedLeft = path.resolve(left);
        const normalizedRight = path.resolve(right);
        return process.platform === 'win32'
            ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
            : normalizedLeft === normalizedRight;
    } catch {
        return false;
    }
}

async function promptSelectPath(candidates, preselected) {
    const choices = candidates.map((p, i) => ({
        name: p,
        value: p,
        short: p,
    }));

    choices.push(new inquirer.Separator());
    choices.push({
        name: chalk.cyan('📁 手动输入其他路径...'),
        value: '__manual__',
    });
    choices.push({
        name: chalk.gray('🔍 重新自动搜索'),
        value: '__rescan__',
    });

    const defaultCandidate = preselected
        ? candidates.find(candidate => sameCursorAppPath(candidate, preselected))
        : undefined;

    const { selected } = await inquirer.prompt([
        {
            type: 'list',
            name: 'selected',
            message: chalk.white.bold('检测到多个 Cursor 安装，请选择：'),
            choices,
            default: defaultCandidate || 0,
        },
    ]);

    if (selected === '__manual__') return promptManualPath();
    if (selected === '__rescan__') return obtainCursorPaths({ forceRescan: true });

    const appPath = normalizeToAppPath(selected);
    if (!appPath) {
        console.log(chalk.red('  ❌ 所选 Cursor 路径已无效，请重新选择。'));
        return null;
    }

    saveConfig({ cursorAppPath: appPath });
    return buildPathsFromAppPath(appPath);
}

function collectMutableFilePaths(paths) {
    const candidates = [
        paths.htmlPath,
        paths.mainJsPath,
        paths.glassJsPath,
        paths.nlsMessagesPath,
        ...(Array.isArray(paths.languagePackNlsMessagesPaths)
            ? paths.languagePackNlsMessagesPaths
            : []),
        paths.productJsonPath,
    ];
    const seen = new Set();

    return candidates.filter((filePath) => {
        if (typeof filePath !== 'string' || !fs.existsSync(filePath)) return false;
        const key = process.platform === 'win32'
            ? path.resolve(filePath).toLowerCase()
            : path.resolve(filePath);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function selectedCursorIsRunning(appPath) {
    return findRunningCursorAppPaths().some(
        runningAppPath => sameCursorAppPath(runningAppPath, appPath)
    );
}

function createCursorRunningError(appPath) {
    const error = new Error(`检测到目标 Cursor 正在运行：${appPath}。请完全退出 Cursor 后重试。`);
    error.code = 'CURSOR_RUNNING';
    return error;
}

const runtimeContext = {
    stage: 'startup',
    appPath: null,
};

function setRuntimeContext(stage, appPath) {
    runtimeContext.stage = stage;
    if (appPath !== undefined) {
        runtimeContext.appPath = appPath;
    }
}

function appendErrorLog(error) {
    const errorName = error && error.name ? error.name : 'Error';
    const errorCode = error && error.code ? String(error.code) : '';
    const errorMessage = error && error.message ? error.message : String(error);
    const errorStack = error && error.stack ? error.stack : errorMessage;
    const childOutput = [error && error.stderr, error && error.stdout]
        .filter(value => typeof value === 'string' && value.trim())
        .join('\n');
    const logContent = [
        `[${new Date().toISOString()}]`,
        `版本: ${PACKAGE_VERSION}`,
        `运行程序: ${process.execPath}`,
        `阶段: ${runtimeContext.stage}`,
        `目标 Cursor: ${runtimeContext.appPath || '(未定位)'}`,
        `错误: ${errorName}${errorCode ? ` (${errorCode})` : ''}: ${errorMessage}`,
        errorStack,
        childOutput ? `子进程输出:\n${childOutput}` : '',
        '',
    ].filter(Boolean).join('\n');
    const logDirs = [
        path.join(path.dirname(CONFIG_FILE), 'logs'),
        process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'cursor-chinese', 'logs')
            : null,
        process.env.TEMP ? path.join(process.env.TEMP, 'cursor-chinese-logs') : null,
    ].filter(Boolean);

    for (const logDir of logDirs) {
        try {
            fs.mkdirSync(logDir, { recursive: true });
            const logPath = path.join(logDir, 'cursor-chinese.log');
            fs.appendFileSync(logPath, `${logContent}\n`, 'utf8');
            return logPath;
        } catch {
            // 日志失败不能覆盖原始错误，也不能阻断退出提示。
        }
    }

    return null;
}

async function waitForErrorExit() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;

    console.log(chalk.gray('按 Enter 键退出...'));
    await new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.once('data', resolve);
    });
}

async function reportFatalError(error, waitForUser) {
    const errorCode = error && error.code ? ` [${error.code}]` : '';
    const errorMessage = error && error.message ? error.message : String(error);
    const errorStack = error && error.stack ? error.stack : errorMessage;
    const logPath = appendErrorLog(error);

    console.error(chalk.red.bold(`❌ 发生未预料的错误${errorCode}: ${errorMessage}`));
    console.error(chalk.gray(errorStack));
    if (logPath) {
        console.error(chalk.gray(`错误日志: ${logPath}`));
    }

    process.exitCode = 1;
    if (waitForUser) {
        try {
            await waitForErrorExit();
        } catch {
            // 错误提示阶段不应再次抛出并掩盖原始异常。
        }
    }
}

async function promptConfirmOrChange(paths) {
    const { choice } = await inquirer.prompt([
        {
            type: 'list',
            name: 'choice',
            message: chalk.white.bold('已定位 Cursor，是否使用此路径？'),
            choices: [
                { name: chalk.green(`✓ 使用: ${paths.appPath}`), value: 'use' },
                { name: chalk.cyan('📁 手动指定其他路径'), value: 'manual' },
                { name: chalk.gray('🔍 重新自动搜索'), value: 'rescan' },
            ],
        },
    ]);

    if (choice === 'use') return paths;
    if (choice === 'manual') return promptManualPath();
    return obtainCursorPaths({ forceRescan: true });
}

/**
 * 获取 Cursor 路径对象（交互式会提示用户选择）
 * @param {{ forceRescan?: boolean, skipConfirm?: boolean }} [options]
 */
async function obtainCursorPaths(options = {}) {
    const { forceRescan = false, skipConfirm = false } = options;
    const cliPath = getCliCursorPath();

    if (cliPath && !forceRescan) {
        const fromCli = resolveCursorPath({ cliPath });
        if (fromCli) return fromCli;
        console.log(chalk.red.bold('  ❌ 命令行指定的 Cursor 路径无效！'));
        console.log(chalk.yellow(`  参数: ${cliPath}`));
        console.log(chalk.gray(`  提示: ${pathHint()}`));
        return null;
    }

    if (!forceRescan) {
        const resolved = resolveCursorPath({});
        if (resolved) {
            const candidates = findAllCursorCandidates();
            if (candidates.length > 1) {
                return promptSelectPath(candidates, resolved.appPath);
            }
            const config = loadConfig();
            if (config.cursorAppPath && isValidAppPath(config.cursorAppPath)) {
                return resolved;
            }
            if (!skipConfirm) {
                return promptConfirmOrChange(resolved);
            }
            return resolved;
        }
    }

    console.log(chalk.yellow('  🔍 正在自动搜索 Cursor 安装路径...'));
    const candidates = findAllCursorCandidates();

    if (candidates.length === 0) {
        console.log(chalk.red.bold('  ❌ 未在默认位置找到 Cursor。'));
        console.log(chalk.gray(`  可手动指定安装目录（${pathHint()}）`));
        console.log(chalk.gray(`  配置将保存至: ${CONFIG_FILE}`));
        console.log('');
        return promptManualPath();
    }

    if (candidates.length === 1) {
        if (skipConfirm) {
            saveConfig({ cursorAppPath: candidates[0] });
            return buildPathsFromAppPath(candidates[0]);
        }
        return promptConfirmOrChange(buildPathsFromAppPath(candidates[0]));
    }

    return promptSelectPath(candidates);
}

// ═══════════════════════════════════════════════
// 静默模式（提权后的子进程入口）
// ═══════════════════════════════════════════════

async function runSilent(action) {
    setRuntimeContext('silent-path-resolution');
    const cliPath = getCliCursorPath();
    const paths = resolveCursorPath({ cliPath: cliPath || undefined });

    if (!paths) {
        throw new Error('找不到 Cursor 安装目录。请使用 --cursor-path 指定有效的 resources/app 或 Cursor.exe 路径。');
    }

    setRuntimeContext(`silent-${action}`, paths.appPath);
    if (selectedCursorIsRunning(paths.appPath)) {
        throw createCursorRunningError(paths.appPath);
    }

    if (action === 'translate') {
        translate(paths);
    } else if (action === 'restore') {
        restore(paths);
    } else {
        throw new Error(`未知操作: ${action}`);
    }
}

// ═══════════════════════════════════════════════
// 交互模式（用户双击/终端运行入口）
// ═══════════════════════════════════════════════

async function runInteractive() {
    console.log('');
    console.log(chalk.cyan.bold('  cursor chinese'));
    console.log(chalk.gray('  Cursor 本地汉化工具 · 一键汉化 / 随时还原'));
    console.log(chalk.gray(`  版本: ${PACKAGE_VERSION} · 运行程序: ${process.execPath}`));
    console.log(chalk.gray('  ──────────────────────────────────────'));
    console.log('');

    setRuntimeContext('interactive-path-selection');
    const paths = await obtainCursorPaths();
    if (!paths) {
        await waitForExit();
        return;
    }

    setRuntimeContext('interactive-action-selection', paths.appPath);
    console.log(chalk.gray(`  📂 Cursor: ${paths.appPath}`));
    console.log('');

    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: chalk.white.bold('请选择操作：'),
            choices: [
                { name: chalk.green('🚀 一键汉化'), value: 'translate' },
                { name: chalk.yellow('⏪ 恢复英文'), value: 'restore' },
                new inquirer.Separator(),
                { name: chalk.gray('❌ 退出'), value: 'exit' },
            ],
        },
    ]);

    if (action === 'exit') {
        console.log(chalk.gray('\n  再见！👋'));
        return;
    }

    if (selectedCursorIsRunning(paths.appPath)) {
        console.log('');
        console.log(chalk.yellow('  ⚠️ 检测到目标 Cursor 仍在运行。请完全退出 Cursor 后重新运行工具。'));
        console.log(chalk.gray(`  目标路径: ${paths.appPath}`));
        console.log('');
        await waitForExit();
        return;
    }

    setRuntimeContext(`interactive-${action}`, paths.appPath);
    const mutableFilePaths = collectMutableFilePaths(paths);
    const blockedFilePath = mutableFilePaths.find(filePath => !hasWritePermission(filePath));
    const needElevation = Boolean(blockedFilePath);

    if (needElevation) {
        console.log('');
        console.log(chalk.yellow('  🔒 需要管理员权限才能修改 Cursor 核心文件。'));
        console.log(chalk.gray(`  需要权限的文件: ${blockedFilePath}`));
        console.log(chalk.yellow('  ⏳ 正在请求提权，请在弹出的系统提示中确认...'));
        console.log('');

        try {
            setRuntimeContext(`elevation-${action}`, paths.appPath);
            await elevateAndRun(action, paths.appPath);
            console.log('');
            console.log(chalk.green.bold('  ✅ 操作已在管理员权限下完成！'));
        } catch (e) {
            const logPath = appendErrorLog(e);
            console.log('');
            console.log(chalk.red.bold('  ❌ 提权失败或用户取消: ') + chalk.red(e.message));
            if (logPath) {
                console.log(chalk.gray(`  错误日志: ${logPath}`));
            }
        }
    } else {
        if (action === 'translate') {
            translate(paths);
        } else {
            restore(paths);
        }
    }

    console.log('');
    await waitForExit();
}

async function waitForExit() {
    if (process.stdin.isTTY && process.stdout.isTTY) {
        await inquirer.prompt([
            {
                type: 'input',
                name: 'exit',
                message: chalk.gray('按 Enter 键退出...'),
            },
        ]);
    }
}

// ═══════════════════════════════════════════════
// 入口拦截：优先判断是否为静默模式
// ═══════════════════════════════════════════════

const silentAction = parseAction();

async function main() {
    if (silentAction) {
        await runSilent(silentAction);
        return;
    }

    await runInteractive();
}

void main().catch(error => reportFatalError(error, !silentAction));
