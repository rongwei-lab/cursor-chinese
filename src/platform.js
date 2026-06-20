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

/**
 * 校验是否为有效的 Cursor resources/app 目录
 */
function isValidAppPath(appPath) {
    if (!appPath || !fs.existsSync(appPath)) return false;
    return fs.existsSync(path.join(appPath, WORKBENCH_MAIN));
}

/**
 * 由 app 目录构建路径对象
 */
function buildPathsFromAppPath(appPath) {
    const normalized = path.resolve(appPath);
    return {
        appPath: normalized,
        mainJsPath: path.join(normalized, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
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
        if (seen.has(resolved)) return;
        if (!isValidAppPath(resolved)) return;
        seen.add(resolved);
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
 * 解析 Cursor 路径（CLI > 已保存 > 自动探测）
 * @param {{ cliPath?: string | null }} [options]
 * @returns {{ appPath: string, mainJsPath: string, htmlPath: string, productJsonPath: string } | null}
 */
function resolveCursorPath(options = {}) {
    const { cliPath } = options;

    if (cliPath) {
        const appPath = normalizeToAppPath(cliPath);
        if (appPath) {
            saveConfig({ cursorAppPath: appPath });
            return buildPathsFromAppPath(appPath);
        }
        return null;
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
        // 多个安装：优先使用已保存且仍在列表中的路径
        if (config.cursorAppPath) {
            const saved = path.resolve(config.cursorAppPath);
            const match = candidates.find(c => path.resolve(c) === saved);
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
 * 检测目标文件是否有写入权限
 */
function hasWritePermission(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.W_OK);
        return true;
    } catch {
        return false;
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

        const options = {
            name: 'cursor chinese',
        };

        sudo.exec(command, options, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            if (stdout) process.stdout.write(stdout);
            if (stderr) process.stderr.write(stderr);
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
    findAllCursorCandidates,
    loadConfig,
    saveConfig,
    resolveCursorPath,
    detectCursorPath,
    parseCursorPathArg,
    hasWritePermission,
    elevateAndRun,
};
