/**
 * 跨平台路径探测与智能提权模块
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const sudo = require('sudo-prompt');

const PLATFORM = os.platform(); // 'win32' | 'darwin' | 'linux'

const CONFIG_DIR = path.join(os.homedir(), '.cursor-chinese');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LEGACY_CONFIG_FILE = path.join(os.homedir(), '.cursor-i18n-tool', 'config.json');

const WORKBENCH_MAIN = path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js');
const WORKBENCH_GLASS_MAIN = path.join('out', 'vs', 'workbench', 'workbench.glass.main.js');
const NLS_MESSAGES_FILE = 'nls.messages.json';
const NLS_MESSAGES = path.join('out', NLS_MESSAGES_FILE);

/**
 * 校验是否为有效的 Cursor resources/app 目录
 */
function isValidAppPath(appPath) {
    if (typeof appPath !== 'string' || !appPath || !fs.existsSync(appPath)) return false;
    return fs.existsSync(path.join(appPath, WORKBENCH_MAIN));
}

function readJsonObject(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function isSafeClpIdentifier(value) {
    // Cursor 当前使用十六进制 language pack hash 和 Git commit。只接受该格式，
    // 避免损坏的用户侧 JSON 将路径拼接引向 CLP 根目录之外。
    return typeof value === 'string' && /^[a-f0-9]+$/i.test(value);
}

/**
 * 查找 Windows 上当前 Cursor 提交对应的简体中文语言包 NLS 缓存。
 *
 * Cursor 启用语言包时会优先读取 %APPDATA%\Cursor\clp 中的派生缓存，
 * 因此安装目录 out/nls.messages.json 已汉化时，缓存仍可能覆盖原生菜单文案。
 * 用户目录中的语言包信息可能缺失、过期或损坏，不能阻断安装资源的正常处理。
 *
 * @param {string} appPath Cursor resources/app 目录
 * @param {{ platform?: string, appDataDir?: string }} [options] 仅用于测试注入
 * @returns {string[]}
 */
function findWindowsZhCnLanguagePackNlsMessagesPaths(appPath, options = {}) {
    const targetPlatform = options.platform || PLATFORM;
    if (targetPlatform !== 'win32') return [];

    try {
        const appDataDir = options.appDataDir
            || process.env.APPDATA
            || path.join(os.homedir(), 'AppData', 'Roaming');
        const product = readJsonObject(path.join(appPath, 'product.json'));
        // 不使用 product.json.dataFolderName：当前 Cursor 的值为 .cursor，
        // 但语言包配置和 CLP 缓存的实际根目录始终是 %APPDATA%\Cursor。
        const languagePacks = readJsonObject(path.join(appDataDir, 'Cursor', 'languagepacks.json'));
        const languagePack = languagePacks && languagePacks['zh-cn'];
        const hash = languagePack && languagePack.hash;
        const commit = product && product.commit;

        if (!isSafeClpIdentifier(hash) || !isSafeClpIdentifier(commit)) return [];

        const clpRoot = path.resolve(appDataDir, 'Cursor', 'clp');
        const nlsMessagesPath = path.resolve(
            clpRoot,
            `${hash}.zh-cn`,
            commit,
            NLS_MESSAGES_FILE
        );
        const relativePath = path.relative(clpRoot, nlsMessagesPath);
        if (
            relativePath === ''
            || relativePath === '..'
            || relativePath.startsWith(`..${path.sep}`)
            || path.isAbsolute(relativePath)
        ) {
            return [];
        }

        return fs.statSync(nlsMessagesPath).isFile() ? [nlsMessagesPath] : [];
    } catch {
        return [];
    }
}

/**
 * 由 app 目录构建路径对象
 */
function buildPathsFromAppPath(appPath) {
    const normalized = path.resolve(appPath);
    return {
        appPath: normalized,
        mainJsPath: path.join(normalized, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
        // Cursor 新版 Agent / Glass 窗口会把大量可见文案拆到独立 bundle。
        // 该文件在旧版本中不存在，因此后续处理都要按可选文件对待。
        glassJsPath: path.join(normalized, WORKBENCH_GLASS_MAIN),
        nlsMessagesPath: path.join(normalized, NLS_MESSAGES),
        // Windows 语言包会生成独立的 CLP 缓存；只返回当前 zh-cn 提交实际存在的文件。
        languagePackNlsMessagesPaths: findWindowsZhCnLanguagePackNlsMessagesPaths(normalized),
        htmlPath: path.join(normalized, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html'),
        productJsonPath: path.join(normalized, 'product.json'),
    };
}

/**
 * 将用户输入（安装根目录、.app、exe、或 resources/app）规范化为 app 目录
 * @param {string} input
 * @returns {string | null}
 */
function normalizeToAppPath(input) {
    if (!input || typeof input !== 'string') return null;

    let p = input.trim().replace(/^["']|["']$/g, '');
    if (!p) return null;

    try {
        p = path.resolve(p);
    } catch {
        return null;
    }

    if (!fs.existsSync(p)) return null;

    let realPath = p;
    try {
        // Linux 上用户经常传入 /usr/bin/cursor 这类符号链接。
        // 先解析真实路径，后续才能从可执行文件旁边找到 resources/app。
        realPath = fs.realpathSync(p);
    } catch {
        realPath = p;
    }

    if (isValidAppPath(p)) return p;
    if (realPath !== p && isValidAppPath(realPath)) return realPath;

    const base = path.basename(p);
    const baseLower = base.toLowerCase();

    // Windows: Cursor.exe 所在目录为安装根
    if (baseLower === 'cursor.exe') {
        const fromExe = path.join(path.dirname(p), 'resources', 'app');
        if (isValidAppPath(fromExe)) return fromExe;
    }

    // Linux / Windows 安装根中的可执行文件：../resources/app 或同级 resources/app。
    // 例如 /opt/Cursor/cursor、/usr/share/cursor/cursor、真实路径后的 AppImage 解包目录。
    const executableParents = new Set([
        path.dirname(p),
        path.dirname(realPath),
    ]);
    for (const executableDir of executableParents) {
        const fromExecutableDir = path.join(executableDir, 'resources', 'app');
        if (isValidAppPath(fromExecutableDir)) return fromExecutableDir;
        const fromExecutableParent = path.join(path.dirname(executableDir), 'resources', 'app');
        if (isValidAppPath(fromExecutableParent)) return fromExecutableParent;
    }

    // macOS: Cursor.app
    if (base.endsWith('.app')) {
        const fromApp = path.join(p, 'Contents', 'Resources', 'app');
        if (isValidAppPath(fromApp)) return fromApp;
    }

    // 安装根目录（含 resources/app）
    const fromResources = path.join(p, 'resources', 'app');
    if (isValidAppPath(fromResources)) return fromResources;

    // macOS: 用户可能选中 Contents 或 Resources
    const fromContents = path.join(p, 'Contents', 'Resources', 'app');
    if (isValidAppPath(fromContents)) return fromContents;

    const fromResourcesOnly = path.join(p, 'Resources', 'app');
    if (isValidAppPath(fromResourcesOnly)) return fromResourcesOnly;

    return null;
}

function appPathKey(appPath, targetPlatform = PLATFORM) {
    const resolved = path.resolve(appPath);
    return targetPlatform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeAndDeduplicateAppPaths(inputs, targetPlatform = PLATFORM) {
    if (!Array.isArray(inputs)) return [];

    const seen = new Set();
    const paths = [];
    for (const input of inputs) {
        const appPath = normalizeToAppPath(input);
        if (!appPath) continue;

        const key = appPathKey(appPath, targetPlatform);
        if (seen.has(key)) continue;

        seen.add(key);
        paths.push(path.resolve(appPath));
    }
    return paths;
}

/**
 * 查找当前正在运行的 Cursor 所属安装目录。
 *
 * 保存的路径可能在 Cursor 升级、改用 Program Files 安装后失效；当系统中只有
 * 一个运行中的安装时，优先使用它可以避免修改旧版本却让当前窗口保持英文。
 * 查询失败或同时运行多个不同安装时均降级为原有的配置/候选路径流程。
 *
 * @param {{ platform?: string, executablePaths?: string[] }} [options] 仅用于测试注入
 * @returns {string[]}
 */
function findRunningCursorAppPaths(options = {}) {
    const targetPlatform = options.platform || PLATFORM;
    if (targetPlatform !== 'win32') return [];

    let executablePaths = options.executablePaths;
    if (!Array.isArray(executablePaths)) {
        try {
            const { execFileSync } = require('child_process');
            const output = execFileSync('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                "Get-CimInstance -ClassName Win32_Process -Filter \"Name = 'Cursor.exe'\" | ForEach-Object { $_.ExecutablePath }",
            ], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 6000,
                windowsHide: true,
            });
            executablePaths = output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        } catch {
            return [];
        }
    }

    return normalizeAndDeduplicateAppPaths(executablePaths, targetPlatform);
}

/**
 * 默认候选安装路径（用于自动搜索）
 */
function getDefaultCandidates() {
    if (PLATFORM === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

        return [
            path.join(localAppData, 'Programs', 'cursor', 'resources', 'app'),
            path.join(localAppData, 'cursor', 'resources', 'app'),
            path.join(programFiles, 'cursor', 'resources', 'app'),
            path.join(programFiles, 'Cursor', 'resources', 'app'),
            path.join(programFilesX86, 'cursor', 'resources', 'app'),
            path.join(programFilesX86, 'Cursor', 'resources', 'app'),
        ];
    }

    if (PLATFORM === 'darwin') {
        return [
            '/Applications/Cursor.app/Contents/Resources/app',
            path.join(os.homedir(), 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app'),
        ];
    }

    if (PLATFORM === 'linux') {
        return [
            '/opt/Cursor/resources/app',
            '/opt/cursor/resources/app',
            '/usr/share/cursor/resources/app',
            '/usr/lib/cursor/resources/app',
            '/usr/lib64/cursor/resources/app',
            '/snap/cursor/current/resources/app',
            path.join(os.homedir(), '.local', 'share', 'cursor', 'resources', 'app'),
            path.join(os.homedir(), 'Applications', 'Cursor', 'resources', 'app'),
            path.join(os.homedir(), 'Applications', 'cursor', 'resources', 'app'),
        ];
    }

    return [];
}

/**
 * 在 macOS /Applications 下查找 Cursor*.app
 */
function scanMacApplicationsDir() {
    const found = [];
    const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const name = entry.name;
            if (!/^Cursor.*\.app$/i.test(name)) continue;
            const appPath = path.join(dir, name, 'Contents', 'Resources', 'app');
            if (isValidAppPath(appPath)) found.push(appPath);
        }
    }
    return found;
}

/**
 * Windows: 从卸载注册表读取 InstallLocation（若存在）
 */
function readWindowsRegistryInstallPaths() {
    if (PLATFORM !== 'win32') return [];

    const found = [];
    const regRoots = [
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];

    const { execSync } = require('child_process');

    for (const root of regRoots) {
        let keyOutput;
        try {
            keyOutput = execSync(`reg query "${root}" /s /f "Cursor" /k`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore'],
                timeout: 8000,
            });
        } catch {
            continue;
        }

        const installLocations = keyOutput.match(/InstallLocation\s+REG_SZ\s+(.+)/gi) || [];
        for (const line of installLocations) {
            const m = line.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
            if (!m) continue;
            const loc = m[1].trim();
            const appPath = normalizeToAppPath(loc);
            if (appPath) found.push(appPath);
        }
    }

    return found;
}

/**
 * 自动搜索所有有效的 Cursor app 路径（去重）
 * @returns {string[]}
 */
function findAllCursorCandidates() {
    const seen = new Set();
    const results = [];

    function add(appPath) {
        const resolved = path.resolve(appPath);
        const key = appPathKey(resolved);
        if (seen.has(key)) return;
        if (!isValidAppPath(resolved)) return;
        seen.add(key);
        results.push(resolved);
    }

    for (const c of getDefaultCandidates()) {
        add(c);
    }

    if (PLATFORM === 'darwin') {
        for (const p of scanMacApplicationsDir()) {
            add(p);
        }
    }

    if (PLATFORM === 'win32') {
        for (const p of readWindowsRegistryInstallPaths()) {
            add(p);
        }
    }

    return results;
}

function loadConfig() {
    try {
        const configPath = fs.existsSync(CONFIG_FILE)
            ? CONFIG_FILE
            : LEGACY_CONFIG_FILE;
        if (!fs.existsSync(configPath)) return {};
        const raw = fs.readFileSync(configPath, 'utf8');
        const data = JSON.parse(raw);
        return typeof data === 'object' && data !== null ? data : {};
    } catch {
        return {};
    }
}

function saveConfig(partial) {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        const prev = loadConfig();
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...prev, ...partial }, null, 2), 'utf8');
    } catch {
        // 配置写入失败不阻断主流程
    }
}

/**
 * 解析 Cursor 路径（CLI > 唯一运行中实例 > 已保存 > 自动探测）
 * @param {{ cliPath?: string | null, runningAppPaths?: string[] }} [options] runningAppPaths 仅用于测试注入
 * @returns {{ appPath: string, mainJsPath: string, htmlPath: string, productJsonPath: string } | null}
 */
function resolveCursorPath(options = {}) {
    const { cliPath, runningAppPaths } = options;

    if (cliPath) {
        const appPath = normalizeToAppPath(cliPath);
        if (appPath) {
            // --cursor-path 常用于提权子进程和一次性测试，不能覆盖用户已保存的安装位置。
            return buildPathsFromAppPath(appPath);
        }
        return null;
    }

    const runningCandidates = Array.isArray(runningAppPaths)
        ? normalizeAndDeduplicateAppPaths(runningAppPaths)
        : findRunningCursorAppPaths();
    if (runningCandidates.length === 1) {
        return buildPathsFromAppPath(runningCandidates[0]);
    }

    const config = loadConfig();
    if (config.cursorAppPath && isValidAppPath(config.cursorAppPath)) {
        return buildPathsFromAppPath(config.cursorAppPath);
    }

    const candidates = findAllCursorCandidates();
    if (candidates.length === 1) {
        saveConfig({ cursorAppPath: candidates[0] });
        return buildPathsFromAppPath(candidates[0]);
    }

    if (candidates.length > 1) {
        // 多个安装：优先使用已保存且仍在列表中的路径。Windows 路径大小写不敏感，
        // 否则 Program Files\\Cursor 与 Program Files\\cursor 会被误判为不同安装。
        if (typeof config.cursorAppPath === 'string' && config.cursorAppPath) {
            const savedKey = appPathKey(config.cursorAppPath);
            const match = candidates.find(c => appPathKey(c) === savedKey);
            if (match) return buildPathsFromAppPath(match);
        }
        return null;
    }

    return null;
}

/**
 * 探测 Cursor 安装路径（兼容旧 API，等价于 resolveCursorPath）
 */
function detectCursorPath(options) {
    return resolveCursorPath(options);
}

/**
 * 将 app 路径编码到命令行参数（供提权子进程使用）
 */
function encodeCursorPathArg(appPath) {
    return `--cursor-path=${JSON.stringify(appPath)}`;
}

/**
 * 从 process.argv 解析 --cursor-path
 */
function parseCursorPathArg() {
    const arg = process.argv.find(a => a.startsWith('--cursor-path='));
    if (!arg) return null;
    const raw = arg.slice('--cursor-path='.length);
    try {
        return JSON.parse(raw);
    } catch {
        return raw.replace(/^["']|["']$/g, '');
    }
}

/**
 * 检测目标文件及其所在目录是否真的可写。
 *
 * Windows 的 fs.access(W_OK) 在 UAC 分离令牌下可能对 Program Files 返回误判；
 * 汉化实际还要在同目录创建备份和临时文件，因此使用无内容的独占探针验证。
 */
function hasWritePermission(filePath) {
    if (typeof filePath !== 'string' || !filePath || !fs.existsSync(filePath)) {
        return false;
    }

    const dir = path.dirname(filePath);
    const probePath = path.join(
        dir,
        `.cursor-chinese-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    let targetDescriptor;
    let probeDescriptor;
    let probeCreated = false;

    try {
        // 只打开、不写入原文件，避免权限预检本身改变 Cursor 资源。
        targetDescriptor = fs.openSync(filePath, 'r+');
        fs.closeSync(targetDescriptor);
        targetDescriptor = undefined;

        probeDescriptor = fs.openSync(probePath, 'wx');
        probeCreated = true;
        fs.closeSync(probeDescriptor);
        probeDescriptor = undefined;
        fs.unlinkSync(probePath);
        probeCreated = false;
        return true;
    } catch {
        return false;
    } finally {
        if (typeof targetDescriptor === 'number') {
            try { fs.closeSync(targetDescriptor); } catch {}
        }
        if (typeof probeDescriptor === 'number') {
            try { fs.closeSync(probeDescriptor); } catch {}
        }
        if (probeCreated) {
            try { fs.unlinkSync(probePath); } catch {}
        }
    }
}

/**
 * 以管理员权限重新拉起自身进程
 * @param {'translate' | 'restore'} action
 * @param {string} [cursorAppPath]
 */
function elevateAndRun(action, cursorAppPath) {
    return new Promise((resolve, reject) => {
        const isPkg = typeof process.pkg !== 'undefined';
        let command;

        const pathArg = cursorAppPath ? ` ${encodeCursorPathArg(cursorAppPath)}` : '';

        if (isPkg) {
            command = `"${process.execPath}" --action=${action}${pathArg}`;
        } else {
            const entryScript = path.resolve(__dirname, '..', 'index.js');
            command = `"${process.execPath}" "${entryScript}" --action=${action}${pathArg}`;
        }

        // Program Files 安装通常需要 UAC。显式传递原调用者的用户目录，
        // 防止使用另一管理员凭据时，提权子进程改去读取该管理员的 CLP 缓存。
        const userDataEnv = {};
        for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) {
            if (typeof process.env[key] === 'string' && process.env[key]) {
                userDataEnv[key] = process.env[key];
            }
        }
        const options = {
            name: 'cursor chinese',
            ...(Object.keys(userDataEnv).length > 0 ? { env: userDataEnv } : {}),
        };

        sudo.exec(command, options, (error, stdout, stderr) => {
            if (stdout) process.stdout.write(stdout);
            if (stderr) process.stderr.write(stderr);
            if (error) {
                const elevatedError = error instanceof Error ? error : new Error(String(error));
                elevatedError.stdout = stdout || '';
                elevatedError.stderr = stderr || '';
                if (stderr && !elevatedError.message.includes(String(stderr).trim())) {
                    elevatedError.message = `${elevatedError.message}\n${String(stderr).trim()}`;
                }
                reject(elevatedError);
                return;
            }
            resolve();
        });
    });
}

module.exports = {
    PLATFORM,
    CONFIG_FILE,
    isValidAppPath,
    normalizeToAppPath,
    buildPathsFromAppPath,
    findWindowsZhCnLanguagePackNlsMessagesPaths,
    findRunningCursorAppPaths,
    findAllCursorCandidates,
    loadConfig,
    saveConfig,
    resolveCursorPath,
    detectCursorPath,
    parseCursorPathArg,
    hasWritePermission,
    elevateAndRun,
};
