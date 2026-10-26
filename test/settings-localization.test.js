'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function mockedLoad(request) {
    if (request === 'sudo-prompt') return { exec() {} };
    return originalLoad.apply(this, arguments);
};
const { translate, restore } = require('../src/i18n-core');
Module._load = originalLoad;

function withSettingsFixture(source, callback) {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-chinese-settings-'));
    const paths = {
        appPath,
        mainJsPath: path.join(appPath, 'workbench.desktop.main.js'),
        glassJsPath: path.join(appPath, 'workbench.glass.main.js'),
        htmlPath: path.join(appPath, 'workbench.html'),
        productJsonPath: path.join(appPath, 'product.json'),
    };
    for (const filePath of [paths.mainJsPath, paths.glassJsPath]) fs.writeFileSync(filePath, source);
    fs.writeFileSync(paths.htmlPath, '<html></html>');
    fs.writeFileSync(paths.productJsonPath, JSON.stringify({ checksums: {
        'out/vs/workbench/workbench.desktop.main.js': 'a'.repeat(43),
        'out/vs/workbench/workbench.glass.main.js': 'b'.repeat(43),
    } }));
    const originalLog = console.log;
    console.log = () => {};
    try {
        callback(paths);
    } finally {
        console.log = originalLog;
        fs.rmSync(appPath, { recursive: true, force: true });
    }
}

function evaluate(source) {
    const context = {};
    vm.runInNewContext(source, context);
    return JSON.parse(JSON.stringify(context.result));
}

test('两个工作台均翻译设置、搜索目录与 HTML，同时保留配置值和代码逻辑', () => {
    const source = String.raw`
        const catalog = [];
        function register(tab, id, entry) { catalog.push({ tab, id, ...entry }); }
        register("general", "cloud-agent-approval-notifications-while-focused", {
            label: "Cloud Agent Approval Banners While Focused",
            description: "Also show the approval banner while Cursor is focused; the request card in the agent conversation always shows"
        });
        register("chat", "auto-approve-transitions", {
            label: "Auto-Approve Mode Transitions",
            description: "Allow agent to switch to modes without asking. When off, skips if unanswered within 15 seconds."
        });
        const mode = {label: "Auto-Approve Mode Transitions", description: "Allow agent to switch to modes like Plan or Debug without asking. When off, Cursor asks first, but skips if unanswered within 15 seconds."};
        const banner = {title: "Plugins, MCPs, Skills, and Rules have moved to Customize", description: "We've introduced a new home for all the ways to customize Cursor.", action: {label: "Open Customize"}};
        const html = '<div>Dismiss</div><button>Open Customize</button><span>Voice';
        const options = [{value: "Voice", label: "Voice"}, {value: "Queue", label: "Queue"}, {value: "workspace", label: "Workspace"}];
        const sidebar = {voice:"Voice","git-prs":"Source Control",indexing:"Code Intelligence"};
        const metadata = {"aria-label": "Chat width", accessibleLabel: "Network diagnostics", label:"Read Access", description:"Control whether agents can read files outside the workspace without approval."};
        const theme = {label:"Light · High contrast", title:'Reset "Don’t Ask Again" Dialogs', description:"See warnings and tips that you’ve hidden"};
        const warning = {children:"\u26A0\uFE0F Warning: Updates Apply Automatically"};
        const escaped = {description:'Sign in to get started with Cursor\'s AI features'};
        const data = {id:"Voice", value:"Source Control", command:"Queue", path:"/tmp/Voice", language:"en", source:"Source Control"};
        const sourceControl = data.source === "Source Control";
        globalThis.result = {catalog, mode, banner, html, options, sidebar, metadata, theme, warning, escaped, data, sourceControl};
    `;

    withSettingsFixture(source, paths => {
        translate(paths);
        const results = [];
        for (const filePath of [paths.mainJsPath, paths.glassJsPath]) {
            const translated = fs.readFileSync(filePath, 'utf8');
            const result = evaluate(translated);
            results.push(result);
            assert.match(result.catalog[0].label, /云端智能体审批横幅/);
            assert.match(result.catalog[0].description, /始终显示/);
            assert.match(result.catalog[1].description, /15 秒.*跳过切换/);
            assert.match(result.mode.description, /计划或调试.*15 秒/);
            assert.equal(result.catalog[0].id, 'cloud-agent-approval-notifications-while-focused');
            assert.match(result.banner.title, /已移至“自定义”/);
            assert.equal(result.banner.action.label, '打开自定义');
            assert.equal(result.html, '<div>忽略</div><button>打开自定义</button><span>语音');
            assert.deepEqual(result.options.map(option => option.value), ['Voice', 'Queue', 'workspace']);
            assert.deepEqual(result.options.map(option => option.label), ['语音', '排队', '工作区']);
            assert.deepEqual(result.sidebar, {voice:'语音', 'git-prs':'源代码管理', indexing:'代码智能'});
            assert.equal(result.metadata.accessibleLabel, '网络诊断');
            assert.equal(result.metadata.label, '读取权限');
            assert.equal(result.theme.label, '浅色 · 高对比度');
            assert.equal(result.theme.title, '重置“不再询问”弹窗');
            assert.match(result.warning.children, /警告：更新会自动应用/);
            assert.match(result.escaped.description, /^登录/);
            assert.equal(result.sourceControl, true);
            assert.deepEqual(result.data, evaluate(source).data);
        }
        assert.deepEqual(results[0], results[1]);
        const checksums = JSON.parse(fs.readFileSync(paths.productJsonPath)).checksums;
        for (const filePath of [paths.mainJsPath, paths.glassJsPath]) {
            assert.equal(checksums['out/vs/workbench/' + path.basename(filePath)],
                crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('base64').replace(/=+$/, ''));
        }
        const firstPass = [paths.mainJsPath, paths.glassJsPath].map(filePath => fs.readFileSync(filePath, 'utf8'));
        translate(paths);
        assert.deepEqual([paths.mainJsPath, paths.glassJsPath].map(filePath => fs.readFileSync(filePath, 'utf8')), firstPass);
        restore(paths);
        assert.equal(fs.readFileSync(paths.mainJsPath, 'utf8'), source);
        assert.equal(fs.readFileSync(paths.glassJsPath, 'utf8'), source);
    });
});

test('动态设置保留快捷键、模型名和路径插值，键位元数据保持不变', () => {
    const source = [
        'const key="Ctrl+", model="custom-model", n=72, config={dataFolderName:".cursor"};',
        'const preview={label:`Preview Box for Terminal ${key}K`};',
        'const removal={title:"Remove model",message:`Are you sure you want to remove the model "${model}"? You can add it back later.`};',
        'const validation={error:`Model name must be at most ${n} characters.`};',
        'const permission={description:`Run Mode (Enforced by ~/${config.dataFolderName??".cursor"}/permissions.json)`};',
        'const provider={label:`Use ${model} API Key`,value:model};',
        'const keybindingTable={KeyCode:72,label:"Voice",VK_VOICE:72};',
        'globalThis.result={preview,removal,validation,permission,provider,keybindingTable};',
    ].join('\n');
    withSettingsFixture(source, paths => {
        translate(paths);
        for (const filePath of [paths.mainJsPath, paths.glassJsPath]) {
            const result = evaluate(fs.readFileSync(filePath, 'utf8'));
            assert.equal(result.preview.label, '终端 Ctrl+K 预览框');
            assert.match(result.removal.message, /“custom-model”/);
            assert.equal(result.validation.error, '模型名称不能超过 72 个字符。');
            assert.match(result.permission.description, /~\/\.cursor\/permissions\.json/);
            assert.equal(result.provider.label, '使用 custom-model API 密钥');
            assert.equal(result.provider.value, 'custom-model');
            assert.equal(result.keybindingTable.label, 'Voice');
        }
    });
});

test('主题颜色和语音语言仅翻译显示名称，保留持久化键与未知字段回退', () => {
    const source = [
        'const tokens=["sidebar","redFillHover","terminalAnsiBrightCyan","futureToken"];',
        'const descriptions={sidebar:"Sidebar background and panels",redFillHover:"Red fill hover",terminalAnsiBrightCyan:"Bright terminal cyan"};',
        'const alphaTokens=new Set(["sidebar"]);',
        'function formatToken(t){return t;}',
        'const fields=tokens.map(t=>({description:descriptions[t],label:formatToken(t),tokenName:t,usesHex8ByDefault:alphaTokens.has(t)}));',
        'const languages={auto:"Auto-detect",en:"English","ar-EG":"Arabic (Egypt)","ar-SA":"Arabic (Saudi Arabia)","ar-AE":"Arabic (United Arab Emirates)",bn:"Bengali",ca:"Catalan",zh:"Chinese (Simplified)",da:"Danish",nl:"Dutch",fi:"Finnish",fr:"French",de:"German",hi:"Hindi",hu:"Hungarian",id:"Indonesian",it:"Italian",ja:"Japanese",ko:"Korean",pl:"Polish","pt-BR":"Portuguese (Brazil)","pt-PT":"Portuguese (Portugal)",ru:"Russian","es-MX":"Spanish (Mexico)","es-ES":"Spanish (Spain)",sv:"Swedish",th:"Thai",tr:"Turkish",vi:"Vietnamese"};',
        'const language="en";',
        'const action={title:`Run ${"my-server"} on this machine?`,message:`Please try again. Request ID: ${"request-id"}`};',
        'const credentials=["MY_TOKEN","MY_SECRET"];',
        "const authHint={description:`Re-enter ${credentials.length===1?credentials[0]:`${credentials.slice(0,-1).join(', ')} and ${credentials.at(-1)}`} here. Your Cursor account doesn't send secret values back to this computer.`};",
        'globalThis.result={fields,languages,language,action,authHint};',
    ].join('\n');
    withSettingsFixture(source, paths => {
        translate(paths);
        const original = evaluate(source);
        for (const filePath of [paths.mainJsPath, paths.glassJsPath]) {
            const translated = fs.readFileSync(filePath, 'utf8');
            const result = evaluate(translated);
            assert.deepEqual(result.fields.map(field => field.tokenName), original.fields.map(field => field.tokenName));
            assert.deepEqual(result.fields.map(field => field.label), ['侧边栏', '红色悬停填充色', '终端 ANSI 亮青色', 'futureToken']);
            assert.equal(result.fields[0].usesHex8ByDefault, true);
            assert.equal(result.fields[1].description, '红色悬停填充色');
            assert.deepEqual(Object.keys(result.languages), Object.keys(original.languages));
            assert.equal(result.languages.en, '英语');
            assert.equal(result.languages.zh, '简体中文');
            assert.equal(result.language, 'en');
            assert.equal(result.action.title, '在此电脑上运行 my-server？');
            assert.equal(result.action.message, '请重试。请求 ID：request-id');
            assert.equal(result.authHint.description, '请在此重新输入 MY_TOKEN and MY_SECRET。您的 Cursor 账号不会将密钥值返回到此电脑。');
        }
        const firstPass = fs.readFileSync(paths.glassJsPath, 'utf8');
        translate(paths);
        assert.equal(fs.readFileSync(paths.glassJsPath, 'utf8'), firstPass);
    });
});
