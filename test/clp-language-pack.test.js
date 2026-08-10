'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// 测试不安装生产依赖；platform.js 仅在实际提权时才会使用该模块。
const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
    if (request === 'sudo-prompt') return { exec() {} };
    return originalLoad.apply(this, arguments);
};
const {
    findWindowsZhCnLanguagePackNlsMessagesPaths,
    findRunningCursorAppPaths,
    hasWritePermission,
    resolveCursorPath,
} = require('../src/platform');
const { translate, restore } = require('../src/i18n-core');
Module._load = originalLoad;

function withTempDir(callback) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-chinese-clp-'));
    try {
        return callback(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runQuietly(callback) {
    const originalLog = console.log;
    console.log = () => {};
    try {
        return callback();
    } finally {
        console.log = originalLog;
    }
}

function createCursorAppFixture(root, name, commit) {
    const installRoot = path.join(root, name);
    const appPath = path.join(installRoot, 'resources', 'app');
    const mainJsPath = path.join(appPath, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
    const executablePath = path.join(installRoot, 'Cursor.exe');

    fs.mkdirSync(path.dirname(mainJsPath), { recursive: true });
    fs.writeFileSync(mainJsPath, 'const fixture = true;\n', 'utf8');
    fs.writeFileSync(executablePath, '', 'utf8');
    writeJson(path.join(appPath, 'product.json'), { commit });

    return { appPath, executablePath };
}

test('仅定位当前 Cursor 提交的 zh-cn CLP NLS 缓存', () => {
    withTempDir((root) => {
        const appPath = path.join(root, 'app');
        const appDataDir = path.join(root, 'roaming');
        const hash = '961861409b910b3b9f8eaebbfc43da6c';
        const commit = '3f21b08f0b436a07be29fbfe00b304fa15553350';
        const oldCommit = '1111111111111111111111111111111111111111';
        const currentNlsPath = path.join(
            appDataDir,
            'Cursor',
            'clp',
            `${hash}.zh-cn`,
            commit,
            'nls.messages.json'
        );
        const oldNlsPath = path.join(
            appDataDir,
            'Cursor',
            'clp',
            `${hash}.zh-cn`,
            oldCommit,
            'nls.messages.json'
        );

        writeJson(path.join(appPath, 'product.json'), {
            commit,
            realCommit: oldCommit,
        });
        writeJson(path.join(appDataDir, 'Cursor', 'languagepacks.json'), {
            'zh-cn': { hash },
        });
        writeJson(currentNlsPath, ['&&File']);
        writeJson(oldNlsPath, ['&&File']);

        const resolved = findWindowsZhCnLanguagePackNlsMessagesPaths(appPath, {
            platform: 'win32',
            appDataDir,
        });

        assert.deepEqual(resolved, [currentNlsPath]);
        assert.notEqual(resolved[0], oldNlsPath);
    });
});

test('CLP 元数据异常或非 Windows 平台时安全跳过', () => {
    withTempDir((root) => {
        const appPath = path.join(root, 'app');
        const appDataDir = path.join(root, 'roaming');

        writeJson(path.join(appPath, 'product.json'), { commit: '../outside' });
        writeJson(path.join(appDataDir, 'Cursor', 'languagepacks.json'), {
            'zh-cn': { hash: '../outside' },
        });

        assert.deepEqual(
            findWindowsZhCnLanguagePackNlsMessagesPaths(appPath, {
                platform: 'win32',
                appDataDir,
            }),
            []
        );
        assert.deepEqual(
            findWindowsZhCnLanguagePackNlsMessagesPaths(appPath, {
                platform: 'darwin',
                appDataDir,
            }),
            []
        );
    });
});

test('唯一运行中的 Cursor 优先于陈旧配置，显式路径仍有最高优先级', () => {
    withTempDir((root) => {
        const stale = createCursorAppFixture(
            root,
            'stale-cursor',
            '1111111111111111111111111111111111111111'
        );
        const running = createCursorAppFixture(
            root,
            'running-cursor',
            '2222222222222222222222222222222222222222'
        );

        const runningPaths = findRunningCursorAppPaths({
            platform: 'win32',
            executablePaths: [running.executablePath, running.executablePath],
        });
        assert.deepEqual(runningPaths, [running.appPath]);
        assert.deepEqual(
            findRunningCursorAppPaths({
                platform: 'darwin',
                executablePaths: [running.executablePath],
            }),
            []
        );

        assert.equal(
            resolveCursorPath({ runningAppPaths: [running.appPath] }).appPath,
            running.appPath
        );
        assert.equal(
            resolveCursorPath({
                cliPath: stale.executablePath,
                runningAppPaths: [running.appPath],
            }).appPath,
            stale.appPath
        );
    });
});

test('写入权限预检验证原文件与所在目录，且不会遗留探针文件', () => {
    withTempDir((root) => {
        const targetPath = path.join(root, 'resources', 'app', 'out', 'target.txt');
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, 'fixture', 'utf8');

        assert.equal(hasWritePermission(targetPath), true);
        assert.equal(hasWritePermission(path.join(root, 'missing.txt')), false);
        assert.deepEqual(
            fs.readdirSync(path.dirname(targetPath)).filter(name => name.startsWith('.cursor-chinese-write-probe-')),
            []
        );
    });
});

test('默认 NLS 与当前 CLP 缓存会一同备份、汉化和恢复', () => {
    withTempDir((root) => {
        const appPath = path.join(root, 'app');
        const mainJsPath = path.join(appPath, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
        const htmlPath = path.join(appPath, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html');
        const productJsonPath = path.join(appPath, 'product.json');
        const nlsMessagesPath = path.join(appPath, 'out', 'nls.messages.json');
        const languagePackNlsMessagesPath = path.join(root, 'clp', 'nls.messages.json');
        const originalMessages = [
            '&&File',
            '&&Edit',
            '&&Selection',
            '&&View',
            '&&Go',
            '&&Run',
            '&&Terminal',
            '&&Help',
        ];
        const expectedMessages = [
            '&&文件',
            '&&编辑',
            '&&选择',
            '&&视图',
            '&&转到',
            '&&运行',
            '&&终端',
            '&&帮助',
        ];

        fs.mkdirSync(path.dirname(mainJsPath), { recursive: true });
        fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
        fs.writeFileSync(mainJsPath, 'const untouched = true;\n', 'utf8');
        fs.writeFileSync(htmlPath, '<html></html>', 'utf8');
        writeJson(productJsonPath, {
            checksums: {
                'out/vs/workbench/workbench.desktop.main.js': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
        });
        writeJson(nlsMessagesPath, originalMessages);
        writeJson(languagePackNlsMessagesPath, originalMessages);

        const paths = {
            appPath,
            mainJsPath,
            htmlPath,
            productJsonPath,
            nlsMessagesPath,
            languagePackNlsMessagesPaths: [languagePackNlsMessagesPath],
        };

        runQuietly(() => translate(paths));

        assert.deepEqual(readJson(nlsMessagesPath), expectedMessages);
        assert.deepEqual(readJson(languagePackNlsMessagesPath), expectedMessages);
        assert.deepEqual(readJson(`${nlsMessagesPath}.backup`), originalMessages);
        assert.deepEqual(readJson(`${languagePackNlsMessagesPath}.backup`), originalMessages);

        const cacheBackup = fs.readFileSync(`${languagePackNlsMessagesPath}.backup`, 'utf8');
        runQuietly(() => translate(paths));
        assert.equal(fs.readFileSync(`${languagePackNlsMessagesPath}.backup`, 'utf8'), cacheBackup);

        runQuietly(() => restore(paths));
        assert.deepEqual(readJson(nlsMessagesPath), originalMessages);
        assert.deepEqual(readJson(languagePackNlsMessagesPath), originalMessages);
    });
});

test('Cursor 3.15.6 Glass 菜单、动态索引说明和原生菜单词条会保持汉化且可重复执行', () => {
    withTempDir((root) => {
        const appPath = path.join(root, 'cursor-3.15.6', 'resources', 'app');
        const mainJsPath = path.join(appPath, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
        const glassJsPath = path.join(appPath, 'out', 'vs', 'workbench', 'workbench.glass.main.js');
        const htmlPath = path.join(appPath, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html');
        const productJsonPath = path.join(appPath, 'product.json');
        const nlsMessagesPath = path.join(appPath, 'out', 'nls.messages.json');

        // Cursor 3.15.6 会把末尾的空格与 files 合并为一个数组元素；旧版本仍可能保留拆分形式。
        const desktopSource = [
            'const desktopNewLimit = config.autoIndexingMaxNumFiles.toLocaleString("en-US",{useGrouping:!0});',
            'const desktopNew={children:["Automatically index any new folders with fewer than"," ",desktopNewLimit," files"]};',
            'const desktopLegacyLimit = getLegacyLimit();',
            'const desktopLegacy={children:["Automatically index any new folders with fewer than"," ",desktopLegacyLimit," ","files"]};',
        ].join('\n');
        const glassSource = [
            'const glassNewLimit = config.autoIndexingMaxNumFiles.toLocaleString("en-US",{useGrouping:!0});',
            'const glassNew={children:["Automatically index any new folders with fewer than"," ",glassNewLimit," files"]};',
            'const glassLegacyLimit = getLegacyLimit();',
            'const glassLegacy={children:["Automatically index any new folders with fewer than"," ",glassLegacyLimit," ","files"]};',
            'SGa=[{menuId:ft.MenubarMainMenu,menubarKey:"GlassMacApplication"},{menuId:ft.MenubarFileMenu,menubarKey:"File"},{menuId:ft.MenubarViewMenu,menubarKey:"View"},{menuId:ft.MenubarHelpMenu,menubarKey:"Help"},{menuId:ft.MenubarEditMenu,menubarKey:"Edit"}],BKm=[{menuId:ft.MenubarMainMenu,label:"Cursor",trigger:"logo"},{menuId:ft.MenubarFileMenu,label:"File",trigger:"text"},{menuId:ft.MenubarEditMenu,label:"Edit",trigger:"text"},{menuId:ft.MenubarViewMenu,label:"View",trigger:"text"},{menuId:ft.MenubarHelpMenu,label:"Help",trigger:"text"}];',
            'Zs({id:"newTerminal",title:"New Terminal",icon:"terminal",glassCategory:"Workspace",menu:{column:ft.MenubarFileMenu,group:"2_new_tabs",order:1,title:"New Terminal"}});',
            'Zs({id:"newBrowser",title:"New Browser",icon:"globe",glassCategory:"View",menu:{column:ft.MenubarFileMenu,group:"2_new_tabs",order:2,title:"New Browser"}});',
            'Zs({id:"openIde",title:"Open IDE",icon:"window",glassCategory:"Workspace",menu:{column:ft.MenubarFileMenu,group:"2_open",order:3,title:"Open IDE"}});',
            'Zs({id:"quitApplication",title:"Quit",icon:"close",glassCategory:"View",menu:{column:ft.MenubarFileMenu,group:"9_exit",order:0,title:"Exit"}});',
        ].join('\n');

        fs.mkdirSync(path.dirname(mainJsPath), { recursive: true });
        fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
        fs.writeFileSync(mainJsPath, desktopSource, 'utf8');
        fs.writeFileSync(glassJsPath, glassSource, 'utf8');
        fs.writeFileSync(htmlPath, '<html></html>', 'utf8');
        writeJson(productJsonPath, {
            commit: 'a1f686545fd0ce8917bbd2449f733551a9bce420',
            checksums: {
                'out/vs/workbench/workbench.desktop.main.js': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                'out/vs/workbench/workbench.glass.main.js': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
        });
        writeJson(nlsMessagesPath, ['&&Exit', 'New Terminal', '&&File']);

        const paths = {
            appPath,
            mainJsPath,
            glassJsPath,
            htmlPath,
            productJsonPath,
            nlsMessagesPath,
        };

        runQuietly(() => translate(paths));

        const desktopTranslated = fs.readFileSync(mainJsPath, 'utf8');
        const glassTranslated = fs.readFileSync(glassJsPath, 'utf8');
        assert.match(
            desktopTranslated,
            /children:\["自动索引少于"\s*,\s*" "\s*,\s*desktopNewLimit\s*,\s*" 个文件的新文件夹"\]/
        );
        assert.match(
            desktopTranslated,
            /children:\["自动索引少于"\s*,\s*" "\s*,\s*desktopLegacyLimit\s*,\s*" 个文件的新文件夹"\]/
        );
        assert.match(
            glassTranslated,
            /children:\["自动索引少于"\s*,\s*" "\s*,\s*glassNewLimit\s*,\s*" 个文件的新文件夹"\]/
        );
        assert.match(
            glassTranslated,
            /children:\["自动索引少于"\s*,\s*" "\s*,\s*glassLegacyLimit\s*,\s*" 个文件的新文件夹"\]/
        );
        assert.doesNotMatch(desktopTranslated, /Automatically index any new folders with fewer than/);
        assert.doesNotMatch(glassTranslated, /Automatically index any new folders with fewer than/);

        for (const [english, chinese] of [
            ['File', '文件'],
            ['Edit', '编辑'],
            ['View', '视图'],
            ['Help', '帮助'],
        ]) {
            assert.ok(glassTranslated.includes(`label:"${chinese}",trigger:"text"`), `${english} 菜单标签应汉化`);
        }

        for (const [id, english, chinese] of [
            ['newTerminal', 'New Terminal', '新建终端'],
            ['newBrowser', 'New Browser', '新建浏览器'],
            ['openIde', 'Open IDE', '打开 IDE'],
        ]) {
            assert.ok(glassTranslated.includes(`id:"${id}",title:"${chinese}"`), `${english} 命令标题应汉化`);
            assert.doesNotMatch(glassTranslated, new RegExp(`id:"${id}",title:"${english}"`));
        }
        assert.ok(glassTranslated.includes('group:"2_new_tabs",order:1,title:"新建终端"'));
        assert.ok(glassTranslated.includes('group:"2_new_tabs",order:2,title:"新建浏览器"'));
        assert.ok(glassTranslated.includes('group:"2_open",order:3,title:"打开 IDE"'));
        assert.ok(glassTranslated.includes('group:"9_exit",order:0,title:"退出"'));
        assert.deepEqual(readJson(nlsMessagesPath), ['&&退出', '新建终端', '&&文件']);

        const firstRun = {
            desktop: desktopTranslated,
            glass: glassTranslated,
            nls: fs.readFileSync(nlsMessagesPath, 'utf8'),
            desktopBackup: fs.readFileSync(`${mainJsPath}.backup`, 'utf8'),
            glassBackup: fs.readFileSync(`${glassJsPath}.backup`, 'utf8'),
            nlsBackup: fs.readFileSync(`${nlsMessagesPath}.backup`, 'utf8'),
        };

        runQuietly(() => translate(paths));

        assert.equal(fs.readFileSync(mainJsPath, 'utf8'), firstRun.desktop);
        assert.equal(fs.readFileSync(glassJsPath, 'utf8'), firstRun.glass);
        assert.equal(fs.readFileSync(nlsMessagesPath, 'utf8'), firstRun.nls);
        assert.equal(fs.readFileSync(`${mainJsPath}.backup`, 'utf8'), firstRun.desktopBackup);
        assert.equal(fs.readFileSync(`${glassJsPath}.backup`, 'utf8'), firstRun.glassBackup);
        assert.equal(fs.readFileSync(`${nlsMessagesPath}.backup`, 'utf8'), firstRun.nlsBackup);
    });
});
