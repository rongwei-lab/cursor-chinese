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

const chalk = require('chalk');
const inquirer = require('inquirer');
const {
    resolveCursorPath,
    parseCursorPathArg,
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
    const appPath = normalizeToAppPath(manualPath.trim());
    saveConfig({ cursorAppPath: appPath });
    return buildPathsFromAppPath(appPath);
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

    const { selected } = await inquirer.prompt([
        {
            type: 'list',
            name: 'selected',
            message: chalk.white.bold('检测到多个 Cursor 安装，请选择：'),
            choices,
            default: preselected && candidates.includes(preselected) ? preselected : 0,
        },
    ]);

    if (selected === '__manual__') return promptManualPath();
    if (selected === '__rescan__') return obtainCursorPaths({ forceRescan: true });

    saveConfig({ cursorAppPath: selected });
    return buildPathsFromAppPath(selected);
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
    const cliPath = getCliCursorPath();
    const paths = resolveCursorPath({ cliPath: cliPath || undefined });

    if (!paths) {
        console.error('❌ 找不到 Cursor 安装目录！');
        console.error('请使用 --cursor-path 指定路径，例如：');
        console.error('  node index.js --action=translate --cursor-path="C:\\Users\\你\\AppData\\Local\\Programs\\cursor"');
        process.exit(1);
    }

    if (action === 'translate') {
        translate(paths);
    } else if (action === 'restore') {
        restore(paths);
    } else {
        console.error(`❌ 未知操作: ${action}`);
        process.exit(1);
    }

    process.exit(0);
}

// ═══════════════════════════════════════════════
// 交互模式（用户双击/终端运行入口）
// ═══════════════════════════════════════════════

async function runInteractive() {
    console.log('');
    console.log(chalk.cyan.bold('  cursor chinese'));
    console.log(chalk.gray('  Cursor 本地汉化工具 · 一键汉化 / 随时还原'));
    console.log(chalk.gray('  ──────────────────────────────────────'));
    console.log('');

    const paths = await obtainCursorPaths();
    if (!paths) {
        await waitForExit();
        return;
    }

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

    const needElevation = !hasWritePermission(paths.mainJsPath);

    if (needElevation) {
        console.log('');
        console.log(chalk.yellow('  🔒 需要管理员权限才能修改 Cursor 核心文件。'));
        console.log(chalk.yellow('  ⏳ 正在请求提权，请在弹出的系统提示中确认...'));
        console.log('');

        try {
            await elevateAndRun(action, paths.appPath);
            console.log('');
            console.log(chalk.green.bold('  ✅ 操作已在管理员权限下完成！'));
        } catch (e) {
            console.log('');
            console.log(chalk.red.bold('  ❌ 提权失败或用户取消: ') + chalk.red(e.message));
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
    if (process.stdout.isTTY) {
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
if (silentAction) {
    runSilent(silentAction);
} else {
    runInteractive().catch(err => {
        console.error(chalk.red('❌ 发生未预料的错误: ') + err.message);
        process.exit(1);
    });
}
