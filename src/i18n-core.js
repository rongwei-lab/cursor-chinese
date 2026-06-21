/**
 * 核心汉化逻辑 + Hash 修复 + Mac Gatekeeper 修复
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { safeGlobalDict, riskyShortWords } = require('./dict');
const { PLATFORM } = require('./platform');

// 辅助：转义正则特殊字符
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ═══════════════════════════════════════════════
// 预编译正则（模块加载时一次性构建，后续复用）
// ═══════════════════════════════════════════════

// 安全长句：按长度降序排列，确保长句优先匹配
const safeEntries = Object.entries(safeGlobalDict).sort((a, b) => b[0].length - a[0].length);
const safePattern = safeEntries.map(([en]) => escapeRegExp(en)).join('|');

// 单次大正则：匹配被引号包裹的安全长句
const safeMegaRegex = new RegExp(`(["'\`])(${safePattern})\\1`, 'g');

// 长句裸文本正则（>=20 字符，不会与代码变量冲突）
const longEntries = safeEntries.filter(([en]) => en.length >= 20);
const longPattern = longEntries.map(([en]) => escapeRegExp(en)).join('|');
const longMegaRegex = longPattern ? new RegExp(`(${longPattern})`, 'g') : null;

// 危险短词的 UI 属性列表（仅限可见 UI 文案，勿覆盖键位/扫描表）
const uiProps = [
    'children', 'title', 'label', 'placeholder', 'description', 'tooltip', 'text',
    'name', 'message', 'detail',
    'markdownDescription', 'aria-label', 'ariaLabel', 'emptyStateText',
    'currentLabel', 'breadcrumbLabel',
];
const uiPropsPattern = uiProps.join('|');

/** 键盘扫描表、VK_*、KeyCode 等键位元数据 — 禁止汉化短词误伤 */
function isProtectedKeybindingContext(content, index, word) {
    const radius = 160;
    const start = Math.max(0, index - radius);
    const end = Math.min(content.length, index + radius + word.length);
    const slice = content.slice(start, end);
    const escaped = escapeRegExp(word);

    if (/VK_[A-Z0-9_]+/.test(slice)) return true;
    if (/\bKeyCode\b|\bScanCode\b|keybindingService|KeyboardEvent/.test(slice)) return true;
    if (new RegExp(`\\[\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*["']${escaped}["']`).test(slice)) return true;
    if (new RegExp(`["']${escaped}["']\\s*,\\s*\\d+\\s*,\\s*["']${escaped}["']`).test(slice)) return true;

    return false;
}

// 为每个危险短词预编译 3 种正则
const riskyRegexes = Object.entries(riskyShortWords).map(([en, zh]) => {
    const escaped = escapeRegExp(en);
    return {
        en, zh,
        // UI 属性赋值: children: "General"
        propRegex: new RegExp(`(${uiPropsPattern})\\s*:\\s*(["'\`])(${escaped})\\2`, 'g'),
        // JSX 文本节点: React.createElement("div", null, "General")
        jsxRegex: new RegExp(`(null|}|\\w)\\s*,\\s*(["'\`])(${escaped})\\2\\s*(?=[,)])`, 'g'),
        // HTML 标签内文本: >General<
        htmlRegex: new RegExp(`>\\s*(${escaped})\\s*<`, 'g'),
    };
});

// ═══════════════════════════════════════════════
// 终端进度展示
// ═══════════════════════════════════════════════

const PROGRESS_BAR_WIDTH = 24;

/**
 * 压缩并截断终端展示文本，避免正在替换的长模板撑满整行。
 * 这里保留“正在改什么”的关键信息，详细命中数量会在处理结束后汇总。
 */
function compactText(value, maxLength = 72) {
    const compact = String(value)
        .replace(/\s+/g, ' ')
        .replace(/\n/g, ' ')
        .trim();
    const chars = Array.from(compact);
    if (chars.length <= maxLength) return compact;
    return chars.slice(0, maxLength - 1).join('') + '…';
}

function formatReplacementDetail(from, to, count) {
    const suffix = count > 0 ? `（${count} 处）` : '';
    return `${compactText(from, 30)} → ${compactText(to, 30)}${suffix}`;
}

/**
 * 轻量进度条：TTY 下原地刷新，非 TTY 下只输出阶段完成行。
 * 这样既适合截图里的交互终端，也不会在日志文件里刷出大量重复行。
 */
function createProgress(totalPhases) {
    let current = 0;
    const isTTY = Boolean(process.stdout.isTTY);

    const render = (label, detail = '') => {
        const percent = Math.min(100, Math.round((current / totalPhases) * 100));
        const filled = Math.round((percent / 100) * PROGRESS_BAR_WIDTH);
        const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled);
        const line = `  [${bar}] ${String(percent).padStart(3)}% ${label}${detail ? `：${compactText(detail)}` : ''}`;

        if (isTTY) {
            process.stdout.write(`\r\x1b[K${line}`);
        } else if (current > 0) {
            console.log(line);
        }
    };

    return {
        update(label, detail) {
            if (isTTY) render(label, detail);
        },
        step(label, detail) {
            current = Math.min(totalPhases, current + 1);
            render(label, detail);
        },
        finish(label, detail) {
            current = totalPhases;
            render(label, detail);
            process.stdout.write('\n');
        },
    };
}

function applyReplacementString(template, args) {
    return template.replace(/\$(\d+)/g, (match, index) => {
        const value = args[Number(index)];
        return value === undefined ? match : value;
    });
}

function replaceRegexWithCount(content, regex, replacement) {
    let count = 0;
    const nextContent = content.replace(regex, (...args) => {
        count++;
        if (typeof replacement === 'function') {
            return replacement(...args);
        }
        return applyReplacementString(replacement, args);
    });
    return { content: nextContent, count };
}

function countStringOccurrences(content, needle) {
    if (!needle) return 0;

    let count = 0;
    let index = 0;
    while ((index = content.indexOf(needle, index)) !== -1) {
        count++;
        index += needle.length;
    }
    return count;
}

function replaceStringWithCount(content, search, replacement) {
    const count = countStringOccurrences(content, search);
    if (count === 0) return { content, count };
    return { content: content.split(search).join(replacement), count };
}

function createChangeTracker(maxSamples = 12) {
    const groupCounts = new Map();
    const samples = [];

    return {
        record(group, from, to, count) {
            if (count <= 0) return;

            groupCounts.set(group, (groupCounts.get(group) || 0) + count);
            if (samples.length < maxSamples) {
                samples.push({ group, from, to, count });
            }
        },
        print() {
            const total = [...groupCounts.values()].reduce((sum, count) => sum + count, 0);
            console.log(`  ✅ 汉化替换完成，共修改 ${total} 处。`);

            if (groupCounts.size > 0) {
                console.log('  🧾 修改内容摘要：');
                for (const [group, count] of groupCounts.entries()) {
                    console.log(`    - ${group}: ${count} 处`);
                }
            }

            if (samples.length > 0) {
                console.log('  🔎 本次命中的部分内容：');
                samples.forEach(({ group, from, to, count }) => {
                    console.log(`    - ${group}: ${formatReplacementDetail(from, to, count)}`);
                });
            }
        },
    };
}


// ═══════════════════════════════════════════════
// 备份与还原
// ═══════════════════════════════════════════════

function backupFile(filePath) {
    const backupPath = filePath + '.backup';
    const fileName = path.basename(filePath);
    if (fs.existsSync(backupPath)) {
        // 已有备份 → 保留当前文件，避免重复汉化时覆盖现有补丁
        return `🧩 ${fileName}: 已发现原版备份，保留当前文件继续汉化`;
    } else if (fs.existsSync(filePath)) {
        // 首次运行 → 创建备份
        fs.copyFileSync(filePath, backupPath);
        return `💾 ${fileName}: 已备份纯净原版文件`;
    }
    return null;
}

function restoreFromBackup(filePath) {
    const backupPath = filePath + '.backup';
    if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, filePath);
        return true;
    }
    return false;
}


// ═══════════════════════════════════════════════
// Hash 修复
// ═══════════════════════════════════════════════

function detectHashAlgo(hash) {
    const len = hash.length;
    if (len <= 24) return 'md5';
    if (len <= 44) return 'sha256';
    if (len <= 88) return 'sha512';
    return 'sha256';
}

/**
 * 安全写回大文件：优先临时文件替换；失败时回退为直接覆盖（兼容 Program Files 下文件被占用）
 */
function writeFileSafe(filePath, content, encoding = 'utf8') {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.cursor-i18n-${path.basename(filePath)}.${process.pid}.tmp`);

    const verifyExists = () => {
        if (!fs.existsSync(filePath)) {
            throw new Error(`写入后无法找到文件: ${filePath}`);
        }
    };

    const cleanupTmp = () => {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
            // ignore
        }
    };

    try {
        fs.writeFileSync(tmpPath, content, encoding);
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            fs.renameSync(tmpPath, filePath);
            verifyExists();
            return;
        } catch {
            cleanupTmp();
        }
    } catch {
        cleanupTmp();
    }

    fs.writeFileSync(filePath, content, encoding);
    verifyExists();
}

/**
 * 使用内存中的文件内容更新 product.json 校验值（避免写回后立刻读盘失败）
 * @param {string | Buffer} fileContent
 */
function fixProductHash(fileContent, productJsonPath) {
    const contentBuffer = Buffer.isBuffer(fileContent)
        ? fileContent
        : Buffer.from(fileContent, 'utf8');

    if (!fs.existsSync(productJsonPath)) {
        throw new Error(`找不到 product.json: ${productJsonPath}`);
    }

    const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
    let hashUpdated = false;

    if (productJson.checksums) {
        for (const key in productJson.checksums) {
            if (key.endsWith('workbench.desktop.main.js')) {
                const oldHash = productJson.checksums[key];
                const algo = detectHashAlgo(oldHash);
                const newHash = crypto.createHash(algo)
                    .update(contentBuffer)
                    .digest('base64')
                    .replace(/=+$/, '');
                productJson.checksums[key] = newHash;
                hashUpdated = true;
                break;
            }
        }
    }

    if (hashUpdated) {
        writeFileSafe(productJsonPath, JSON.stringify(productJson, null, '\t'), 'utf8');
    }
    return hashUpdated;
}


// ═══════════════════════════════════════════════
// Mac Gatekeeper 修复
// ═══════════════════════════════════════════════

function fixMacGatekeeper(appPath) {
    if (PLATFORM !== 'darwin') return;

    // 往上找到 .app 目录
    const appBundlePath = appPath.split('/Contents/')[0];
    if (!appBundlePath || !appBundlePath.endsWith('.app')) return;

    console.log('🍎 正在修复 macOS Gatekeeper 签名...');

    // 1. 清除隔离属性
    try {
        execSync(`xattr -cr "${appBundlePath}"`, { stdio: 'pipe' });
        console.log('  ✅ 已清除隔离属性 (xattr -cr)');
    } catch (e) {
        console.log('  ⚠️ 清除隔离属性失败: ' + e.message);
    }

    // 2. 重签名（容错：用户可能未安装 Xcode 命令行工具）
    try {
        execSync(`codesign --force --deep --sign - "${appBundlePath}"`, { stdio: 'pipe' });
        console.log('  ✅ 已完成本地重签名 (codesign)');
    } catch (e) {
        console.log('  ⚠️ codesign 重签名失败（可能未安装 Xcode 命令行工具），不影响使用: ' + e.message);
    }
}


// ═══════════════════════════════════════════════
// 核心汉化
// ═══════════════════════════════════════════════

/**
 * 执行汉化
 * @param {{ appPath: string, mainJsPath: string, htmlPath: string, productJsonPath: string }} paths
 */
function translate(paths) {
    const { appPath, mainJsPath, htmlPath, productJsonPath } = paths;

    // 1. 备份
    console.log('');
    const msgs = [
        backupFile(htmlPath),
        backupFile(mainJsPath),
        backupFile(productJsonPath),
    ].filter(Boolean);
    msgs.forEach(m => console.log(`  ${m}`));

    // 2. 读取核心 JS
    console.log('\n⚙️  正在读取并处理核心代码...');
    let jsContent = fs.readFileSync(mainJsPath, 'utf8');
    const progress = createProgress(6);
    const changes = createChangeTracker();
    progress.update('准备汉化词库', '正在扫描可替换文本');

    // 3. 安全长句：单次大正则替换
    jsContent = jsContent.replace(safeMegaRegex, (match, quote, en) => {
        changes.record('安全长句', en, safeGlobalDict[en], 1);
        progress.update('替换安全长句', formatReplacementDetail(en, safeGlobalDict[en], 1));
        return `${quote}${safeGlobalDict[en]}${quote}`;
    });
    progress.step('安全长句替换完成');

    // 4. 长句裸文本替换
    if (longMegaRegex) {
        jsContent = jsContent.replace(longMegaRegex, (match, en) => {
            changes.record('裸文本长句', en, safeGlobalDict[en], 1);
            progress.update('替换裸文本长句', formatReplacementDetail(en, safeGlobalDict[en], 1));
            return safeGlobalDict[en];
        });
    }
    progress.step('裸文本长句处理完成');

    // 5. 暴力正则破译：处理带标点、特殊转义、单双引号混用的顽固长句
    progress.update('处理顽固词条', '包含特殊符号、动态模板和 Unicode 转义');
    const trickyReplacements = [
        {
            // 攻克 1：Reset "Don't Ask Again" Dialogs 
            // 魔法解析：(?:'|\\'|\\u2019|’|&#39;) 涵盖了前端所有的单引号变体，(?:\\?["']|\\u0022|&quot;) 兼容所有双引号变体
            regex: /Reset\s+(?:\\?["']|\\u201[CD]|\\u0022|&quot;)Don(?:'|\\'|\\u2019|’|&#39;)t\s+Ask\s+Again(?:\\?["']|\\u201[CD]|\\u0022|&quot;)\s+Dialogs/gi,
            zh: '重置“不再询问”弹窗'
        },
        {
            // 攻克 2：See warnings and tips that you've hidden
            regex: /See\s+warnings\s+and\s+tips\s+that\s+you(?:'|\\'|\\u2019|’|&#39;)ve\s+hidden/gi,
            zh: '查看您已隐藏的警告和提示'
        },
        {
            // 攻克 3：No Hidden Dialogs Yet
            regex: /No\s+Hidden\s+Dialogs\s+Yet/gi,
            zh: '暂无隐藏的弹窗'
        },
        {
            // 攻克 4：You haven't marked any dialogs as "Don't ask again"...
            regex: /You\s+haven(?:'|\\'|\\u2019|’|&#39;)t\s+marked\s+any\s+dialogs\s+as\s+(?:\\?["']|\\u201[CD]|\\u0022|&quot;)Don(?:'|\\'|\\u2019|’|&#39;)t\s+ask\s+again(?:\\?["']|\\u201[CD]|\\u0022|&quot;)\.\s*Any\s+hidden\s+dialogs\s+will\s+appear\s+here\s+to\s+manage\./gi,
            zh: '您尚未将任何弹窗标记为“不再询问”。任何隐藏的弹窗都将显示在此处以供管理。'
        },
        {
            // 攻克 5：截图2 的软链接超长警告
            // 魔法解析：them 和 Changing 之间可能有 ${...} 条件表达式（团队管理员控制标记）
            regex: /Use\s+with\s+caution\.\s*Skip\s+symlinks\s+during\s+\.cursorignore\s+file\s+discovery\.\s*Only\s+enable\s+if\s+your\s+repository\s+has\s+many\s+symlinks\s+and\s+all\s+\.cursorignore\s+files\s+are\s+reachable\s+without\s+them(?:\$\{[^}]*\}[^C]*)?\.\s*Changing\s+this\s+setting\s+will\s+require\s+a\s+restart\s+of\s+Cursor\./gi,
            zh: '请谨慎使用。在查找 .cursorignore 文件时跳过符号链接。仅当代码库包含大量符号链接且均可直接访问时才启用。更改此设置需重启 Cursor。'
        },
        {
            // 攻克 6a：label:`Submit with ${Fs?"⌘ + ":"Ctrl + "}Enter`
            regex: /Submit\s+with\s+(\$\{[^}]+\}|Ctrl\s*\+\s*)Enter/gi,
            zh: '使用 $1Enter 提交'
        },
        {
            // 攻克 6b：description:`When enabled, ${Fs?"⌘ + ":"Ctrl + "}Enter submits chat and Enter inserts a newline`
            regex: /When\s+enabled,\s+(\$\{[^}]+\}|Ctrl\s*\+\s*)Enter\s+submits\s+chat\s+and\s+Enter\s+inserts\s+a\s+newline/gi,
            zh: '启用后，$1Enter 提交聊天，Enter 插入换行'
        },
        {
            // 攻克 7：Apply .cursorignore files to all subdirectories...
            regex: /Apply\s+(.{0,10}?)\.cursorignore(.{0,10}?)\s+files\s+to\s+all\s+subdirectories(?:\$\{[^}]*\}[^C]*)?\.\s*Changing\s+this\s+setting\s+will\s+require\s+a\s+restart\s+of\s+Cursor\./gi,
            zh: '将 $1.cursorignore$2 文件应用于所有子目录。更改此设置需重启 Cursor。'
        },
        {
            // 攻克 10：Automatically import necessary modules for ${r}
            // 实际文件中是模板字符串，TypeScript/C++ 通过变量 ${r} 注入
            regex: /Automatically\s+import\s+necessary\s+modules\s+for\s+(\$\{[^}]+\}|TypeScript|C\+\+)/gi,
            zh: '自动为 $1 导入必要的模块'
        },
        {
            // 攻克 10.5：Accept the next word of a suggestion via ${...}
            // 实际文件中快捷键是通过 keybindingService 动态获取的变量
            regex: /Accept\s+the\s+next\s+word\s+of\s+a\s+suggestion\s+via\s+(\$\{[^}]+\}|Ctrl\+RightArrow)/gi,
            zh: '使用 $1 接受建议的下一个词'
        },
        {
            // 攻克 11：Embed codebase for improved contextual understanding and knowledge...
            regex: /Embed\s+codebase\s+for\s+improved\s+contextual\s+understanding\s+and\s+knowledge\.\s*Embeddings\s+and\s+metadata\s+are\s+stored\s+in\s+the\s+([^,]{1,50}?),\s*but\s+all\s+code\s+is\s+stored\s+locally\./gi,
            zh: '嵌入代码库以提升上下文理解和知识运用。嵌入向量和元数据存储在$1中，但所有代码均存储在本地。'
        },
        {
            // 攻克 13：Files to exclude from indexing in addition to .gitignore.
            regex: /Files\s+to\s+exclude\s+from\s+indexing\s+in\s+addition\s+to\s+([\s\S]{0,10}?)\.gitignore([\s\S]{0,10}?)\./gi,
            zh: '除 $1.gitignore$2 外要从索引中排除的额外文件。'
        },
        {
            // 攻克 14：Add documentation to use as context...
            regex: /Add\s+documentation\s+to\s+use\s+as\s+context\.\s*You\s+can\s+also\s+use\s+([\s\S]{0,20}?)@Add([\s\S]{0,20}?)\s+in\s+Chat\s+or\s+while\s+editing\s+to\s+add\s+a\s+doc\./gi,
            zh: '添加文档以用作上下文。您也可以在聊天或编辑框中使用 $1@Add$2 来添加文档。'
        },
        {
            // 攻克 15：You're over your current usage limit...
            regex: /You(?:'|\\'|\\u2019|’|&#39;)re\s+over\s+your\s+current\s+usage\s+limit\s+and\s+your\s+requests\s+are\s+being\s+processed\s+with\s+(.{1,20}?)\s+in\s+the\s+slow\s+queue\./gi,
            zh: '您已超出当前使用额度，您的请求正在慢速队列中由 $1 处理。'
        },
        {
            // 攻克 16：Automatically parse links when pasted into Quick Edit (${Fs?"⌘":"Ctrl+"}K) input
            // 实际文件中快捷键部分是三元表达式动态生成
            regex: /Automatically\s+parse\s+links\s+when\s+pasted\s+into\s+Quick\s+Edit\s+\((\$\{[^}]+\}|Ctrl\+)K\)\s+input/gi,
            zh: '粘贴到快速编辑 ($1K) 输入框时自动解析链接'
        },
        {
            // 攻克 17：Automatically jump to the next diff when accepting changes with ${Fs?"⌘":"Ctrl+"}Y
            regex: /Automatically\s+jump\s+to\s+the\s+next\s+diff\s+when\s+accepting\s+changes\s+with\s+(\$\{[^}]+\}|Ctrl\+)Y/gi,
            zh: '使用 $1Y 接受更改时自动跳转到下一个差异'
        },
        {
            // 攻克 18：Show a hint for ${Fs?"⌘":"Ctrl+"}K in the Terminal
            regex: /Show\s+a\s+hint\s+for\s+(\$\{[^}]+\}|Ctrl\+)K\s+in\s+the\s+Terminal/gi,
            zh: '在终端中显示 $1K 提示'
        },
        {
            // 攻克 19：Preview Box for Terminal ${Fs?"⌘":"Ctrl+"}K
            regex: /Preview\s+Box\s+for\s+Terminal\s+(\$\{[^}]+\}|Ctrl\+)K/gi,
            zh: '终端 $1K 的预览框'
        },
        {
            // 攻克 20：Automatically index any new folders with fewer than 250,000 files
            // 实际代码是一个数组：["Automatically index any new folders with fewer than"," ",Ui(()=>...)," ","files"]
            regex: /\[\s*"Automatically\s+index\s+any\s+new\s+folders\s+with\s+fewer\s+than"\s*,\s*" "\s*,\s*(.+?)\s*,\s*" "\s*,\s*"files"\s*\]/gi,
            zh: '["自动索引文件数量少于", " ", $1, " ", "个的新文件夹"]'
        },
        {
            // 攻克 21：Automatically index repositories to speed up Grep searches. All data is stored locally.
            regex: /"Automatically\s+index\s+repositories\s+to\s+speed\s+up\s+Grep\s+searches\.\s+All\s+data\s+is\s+stored\s+locally\."/gi,
            zh: '"自动索引代码库以加速 Grep 搜索。所有数据均存储在本地。"'
        },
        {
            // 用量页重置日期中的动态天数：`${st} (${Bt} days)`。
            // 只替换带两个模板变量的日期片段，避免误伤普通英文文档或代码标识里的 days。
            regex: /`\$\{([^}]+)\}\s+\(\$\{([^}]+)\}\s+days\)`/g,
            zh: '`${$1} (${$2} 天)`'
        },
        {
            // 用量页“包含在当前套餐中”：`Included in ${planName}`。
            regex: /`Included\s+in\s+\$\{([^}]+)\}`/g,
            zh: '`包含在 ${$1} 中`'
        },
        {
            // 另一套用量图组件会把套餐名拼成：`Included in ${planName.trim()} Plan`。
            regex: /`Included\s+in\s+\$\{([^}]+)\}\s+Plan`/g,
            zh: '`包含在 ${$1} 套餐中`'
        },
        {
            // MCP 服务器状态文案由 fx1() 动态拼接，例如 “2 tools enabled”。
            regex: /e\.push\(`\$\{n\.enabledToolCount\}\s+tools`\),\(n\.promptCount\?\?0\)>0&&e\.push\(`\$\{n\.promptCount\}\s+prompts`\),\(n\.resourceCount\?\?0\)>0&&e\.push\(`\$\{n\.resourceCount\}\s+resources`\),e\.length>0\?`\$\{e\.join\(", "\)\}\s+enabled`:"No tools, prompts, or resources"/g,
            zh: 'e.push(`${n.enabledToolCount} 个工具`),(n.promptCount??0)>0&&e.push(`${n.promptCount} 个提示`),(n.resourceCount??0)>0&&e.push(`${n.resourceCount} 个资源`),e.length>0?`${e.join("，")}已启用`:"没有工具、提示或资源"'
        },
        {
            // Agent 运行轨迹：Thought for 1s / Thought for 2s。
            regex: /Thought\s+for\s+(\d+(?:\.\d+)?)ms/gi,
            zh: '思考了 $1 毫秒'
        },
        {
            regex: /Thought\s+for\s+(\d+(?:\.\d+)?)s/gi,
            zh: '思考了 $1 秒'
        },
        {
            regex: /Thought\s+for\s+(\d+(?:\.\d+)?)m/gi,
            zh: '思考了 $1 分钟'
        },
        {
            // 模板形式：`Thought for ${duration}` 或 `Thought for ${seconds}s`。
            regex: /`Thought\s+for\s+\$\{([^}]+)\}ms`/g,
            zh: '`思考了 ${$1} 毫秒`'
        },
        {
            regex: /`Thought\s+for\s+\$\{([^}]+)\}s`/g,
            zh: '`思考了 ${$1} 秒`'
        },
        {
            regex: /`Thought\s+for\s+\$\{([^}]+)\}m`/g,
            zh: '`思考了 ${$1} 分钟`'
        },
        {
            regex: /`Thought\s+for\s+\$\{([^}]+)\}`/g,
            zh: '`思考了 ${$1}`'
        },
        {
            // Agent 运行轨迹：Ran ${toolName}。
            regex: /`Ran\s+\$\{([^}]+)\}`/g,
            zh: '`已运行 ${$1}`'
        },
        {
            // Agent 运行轨迹：普通字符串形式，如 "Ran Check recent git history"。
            // 只处理引号内以 Ran 开头的 UI 文案，避免误伤代码标识。
            regex: /(["'`])Ran\s+/g,
            zh: '$1已运行：'
        },
        {
            // 认证错误卡片：Copy Request (${requestId})。
            regex: /`Copy\s+Request\s+\(\$\{([^}]+)\}\)`/g,
            zh: '`复制请求 (${$1})`'
        },
        {
            // 插件安装人数：Used by 1 teammate / Used by 2 teammates。
            regex: /`Used\s+by\s+\$\{([^}]+)\}\s+\$\{([^}]+)\===1\?"teammate":"teammates"\}`/g,
            zh: '`${$1} 位成员使用`'
        },
        {
            // 插件列表与提示输入里的搜索结果分组。
            regex: /Gdf\(t,a,d,"Results",c\)/g,
            zh: 'Gdf(t,a,d,"结果",c)'
        },
        {
            regex: /\{id:"search-results",title:"Results",items:t\}/g,
            zh: '{id:"search-results",title:"结果",items:t}'
        },
        {
            regex: /\[\{title:"Results",items:m\}\]/g,
            zh: '[{title:"结果",items:m}]'
        }
    ];

    trickyReplacements.forEach(({ regex, zh }) => {
        const before = jsContent;
        const result = replaceRegexWithCount(jsContent, regex, zh);
        jsContent = result.content;
        changes.record('顽固词条', regex.source, zh, result.count);
        if (result.count > 0) {
            progress.update('替换顽固词条', formatReplacementDetail(regex.source, zh, result.count));
        } else if (before !== jsContent) {
            progress.update('替换顽固词条', compactText(regex.source));
        }
    });
    progress.step('顽固词条处理完成');

    // 5.1 设置侧边栏映射与部分编译模板片段
    const scopedReplacements = [
        ['general:"General"', 'general:"通用"'],
        ['appearance:"Appearance"', 'appearance:"外观"'],
        ['"vscode-settings":"VS Code Settings"', '"vscode-settings":"VS Code 设置"'],
        ['"plan-usage":"Plan & Usage"', '"plan-usage":"套餐与用量"'],
        ['Open VS Code Settings', '打开 VS Code 设置'],
        ['children:"Manage View"', 'children:"管理视图"'],
        ['children:"Group By"', 'children:"分组方式"'],
        ['chat:"Agents"', 'chat:"智能体"'],
        ['tab:"Tab"', 'tab:"Tab 补全"'],
        ['models:"Models"', 'models:"模型"'],
        ['mcp:"Tools & MCPs"', 'mcp:"工具与 MCP"'],
        ['hooks:"Hooks"', 'hooks:"钩子"'],
        ['beta:"Beta"', 'beta:"测试功能"'],
        ['network:"Network"', 'network:"网络"'],
        ['worktrees:"Worktrees"', 'worktrees:"工作树"'],
        ['docs:"Docs"', 'docs:"官方文档"'],
        ['`Search settings ${ne()}`', '`搜索设置 ${ne()}`'],
        ['n.isGlass?"Indexing":"索引与文档"', 'n.isGlass?"索引":"索引与文档"'],
        ['>Resets on ', '>重置于 '],
        ['title:"Authentication"', 'title:"身份验证"'],
        ['"Authentication error"', '"身份验证错误"'],
        ["'Authentication error'", "'身份验证错误'"],
        ['`Authentication error`', '`身份验证错误`'],
        ['title:"Authentication error"', 'title:"身份验证错误"'],
        ['children:"Authentication error"', 'children:"身份验证错误"'],
        ['"If you are logged in, try logging out and back in."', '"如果您已登录，请尝试退出后重新登录。"'],
        ["'If you are logged in, try logging out and back in.'", "'如果您已登录，请尝试退出后重新登录。'"],
        ['`If you are logged in, try logging out and back in.`', '`如果您已登录，请尝试退出后重新登录。`'],
        ['children:"If you are logged in, try logging out and back in."', 'children:"如果您已登录，请尝试退出后重新登录。"'],
        ['"Copy Request"', '"复制请求"'],
        ["'Copy Request'", "'复制请求'"],
        ['`Copy Request`', '`复制请求`'],
        ['"Copy Request (', '"复制请求 ('],
        ["'Copy Request (", "'复制请求 ("],
        ['`Copy Request (${', '`复制请求 (${'],
        ['label:"Copy Request"', 'label:"复制请求"'],
        ['children:"Copy Request"', 'children:"复制请求"'],
        ['label:"Wait for MCP Authentication"', 'label:"等待 MCP 身份验证"'],
        ['description:"Wait indefinitely to authenticate when prompted. When off, skip authentication prompts after 30 seconds."', 'description:"出现身份验证提示时会一直等待。关闭后，30 秒后跳过身份验证提示。"'],
        ['<div>Browser Automation</div>', '<div>浏览器自动化</div>'],
        ['"Connected to Browser Tab"', '"已连接到浏览器标签页"'],
        ['"Checking status..."', '"正在检查状态..."'],
        ['<div class=mcp-server-item-main-content-name>New MCP Server</div>', '<div class=mcp-server-item-main-content-name>新建 MCP 服务器</div>'],
        ['return n.isBlocked?n.blockedMessage??"Blocked by admin":"Disabled"', 'return n.isBlocked?n.blockedMessage??"被管理员阻止":"已禁用"'],
        ['return"Needs authentication"', 'return"需要身份验证"'],
        ['return n.error===M0w?n.error:"Error - Show Output"', 'return n.error===M0w?n.error:"错误 - 显示输出"'],
        ['return"Loading tools"', 'return"正在加载工具"'],
        ['return"Disabled"', 'return"已禁用"'],
        ['hSE=et("<div class=mcp-tools-toggle-message>Show less")', 'hSE=et("<div class=mcp-tools-toggle-message>收起")'],
        ['"Exchanging token..."', '"正在交换令牌..."'],
        ['"Waiting for callback..."', '"正在等待回调..."'],
        ['"Authenticating..."', '"正在验证..."'],
        ['"Authenticate"', '"身份验证"'],
        ['label:"Edit MCP configuration"', 'label:"编辑 MCP 配置"'],
        ['label:"Delete MCP server"', 'label:"删除 MCP 服务器"'],
        ['"Reloading MCP server..."', '"正在重新加载 MCP 服务器..."'],
        ['"Reload MCP server"', '"重新加载 MCP 服务器"'],

        // API Keys / 模型供应商密钥设置。
        ['"API Keys"', '"API 密钥"'],
        ['<div class=settings-menu-hoverable><div></div><div>API Keys', '<div class=settings-menu-hoverable><div></div><div>API 密钥'],
        ['"OpenAI API Key"', '"OpenAI API 密钥"'],
        ['"Enter your OpenAI API Key"', '"请输入 OpenAI API 密钥"'],
        ['placeholder:"Enter your Azure OpenAI API Key"', 'placeholder:"请输入 Azure OpenAI API 密钥"'],
        ['"Override OpenAI Base URL"', '"覆盖 OpenAI 基础 URL"'],
        ['"Change the base URL for OpenAI API requests."', '"修改 OpenAI API 请求的基础 URL。"'],
        ['"Anthropic API Key"', '"Anthropic API 密钥"'],
        ['"Enter your Anthropic API Key"', '"请输入 Anthropic API 密钥"'],
        ['"Google API Key"', '"Google API 密钥"'],
        ['"Enter your Google AI Studio API Key"', '"请输入 Google AI Studio API 密钥"'],
        ['"Configure Azure OpenAI to use OpenAI models through your Azure account."', '"配置 Azure OpenAI，通过你的 Azure 账号使用 OpenAI 模型。"'],
        ['"Base URL"', '"基础 URL"'],
        ['label:"API Key"', 'label:"API 密钥"'],
        ['"You can put in "', '"你可以填写 "'],
        ['"You can put in"', '"你可以填写"'],
        ['"your OpenAI key"', '"你的 OpenAI 密钥"'],
        ['<span>your OpenAI key', '<span>你的 OpenAI 密钥'],
        ['"to use OpenAI models at cost."', '"以按成本使用 OpenAI 模型。"'],
        ['" to use OpenAI models at cost."', '"，以按成本使用 OpenAI 模型。"'],
        ['"your Anthropic key"', '"你的 Anthropic 密钥"'],
        ['<span>your Anthropic key', '<span>你的 Anthropic 密钥'],
        ['\'to use Claude at cost. When enabled, this key will be used for all models beginning with "claude-".\'', '\'以按成本使用 Claude。启用后，此密钥将用于所有以 "claude-" 开头的模型。\''],
        ['"to use Claude at cost. When enabled, this key will be used for all models beginning with \\"claude-\\"."', '"以按成本使用 Claude。启用后，此密钥将用于所有以 \\"claude-\\" 开头的模型。"'],
        ['" to use Claude at cost. When enabled, this key will be used for all models beginning with \\"claude-\\"."', '"，以按成本使用 Claude。启用后，此密钥将用于所有以 \\"claude-\\" 开头的模型。"'],
        ['"your Google AI Studio key"', '"你的 Google AI Studio 密钥"'],
        ['<span>your Google AI Studio key', '<span>你的 Google AI Studio 密钥'],
        ['"to use Google models at-cost."', '"以按成本使用 Google 模型。"'],
        ['" to use Google models at-cost."', '"，以按成本使用 Google 模型。"'],

        // 云端智能体不可用状态。
        ['"Cloud Agents Unavailable"', '"云端智能体不可用"'],
        ['title:"Loading"', 'title:"加载中"'],
        ['description:"Loading Cloud Agents settings..."', 'description:"正在加载云端智能体设置..."'],
        ['"Cloud Agents require data storage to function."', '"云端智能体需要数据存储才能运行。"'],
        ['"Privacy Mode Enabled"', '"隐私模式已启用"'],
        ['"Cloud Agents are not available when your privacy mode is set to disable data storage. To use Cloud Agents, please update your privacy settings to allow data storage."', '"当隐私模式设置为禁用数据存储时，云端智能体不可用。要使用云端智能体，请更新隐私设置以允许数据存储。"'],
        ['"Open Privacy Settings"', '"打开隐私设置"'],
        ['title:"Get Started"', 'title:"开始使用"'],
        ['title:"Open a Git repository"', 'title:"打开 Git 仓库"'],
        ['"Open a folder that contains a Git repository to configure Cloud Agents."', '"打开包含 Git 仓库的文件夹以配置云端智能体。"'],
        ['actionTitle:"Open Folder"', 'actionTitle:"打开文件夹"'],
        ['label:"Manage Settings"', 'label:"管理设置"'],

        // 插件页空状态和插件搜索菜单。
        ['"No Plugins"', '"暂无插件"'],
        ['"Browse the marketplace or import custom plugins to extend Cursor with Skills, Rules, Agents, Hooks, and MCPs."', '"浏览插件市场或导入自定义插件，用技能、规则、智能体、钩子和 MCP 扩展 Cursor。"'],
        ['children:"Browse the marketplace or import custom plugins to extend"', 'children:"浏览插件市场或导入自定义插件来扩展"'],
        ['children:"Cursor with Skills, Rules, Agents, Hooks, and MCPs."', 'children:"Cursor 的技能、规则、智能体、钩子和 MCP。"'],
        ['"Add Plugin"', '"添加插件"'],
        ['"Add Plugins"', '"添加插件"'],
        ['"aria-label":"Add Plugins"', '"aria-label":"添加插件"'],
        ['"Search the marketplace"', '"搜索插件市场"'],
        ['placeholder:"Search the marketplace"', 'placeholder:"搜索插件市场"'],
        ['"Loading plugins..."', '"正在加载插件..."'],
        ['<span>Loading plugins...', '<span>正在加载插件...'],
        ['"No result"', '"无结果"'],
        ['"No Result"', '"无结果"'],
        ['children:"No results"', 'children:"无结果"'],
        ['children:"No results found"', 'children:"未找到结果"'],
        ['children:"No Results"', 'children:"无结果"'],
        ['children:"No Results Found"', 'children:"未找到结果"'],
        ['children:"No files found"', 'children:"未找到文件"'],
        ['children:"No matches found"', 'children:"未找到匹配项"'],
        ['children:"No plugins found"', 'children:"未找到插件"'],
        ['children:"No plugins found in this repository."', 'children:"此仓库中未找到插件。"'],
        ['children:"No plugins match your search."', 'children:"没有插件匹配你的搜索。"'],
        ['children:"All plugins have been added."', 'children:"所有插件均已添加。"'],
        ['children:"All plugins from this repository have already been added."', 'children:"此仓库中的所有插件均已添加。"'],
        ['children:"Add plugins or import from GitHub to make them available for your team."', 'children:"添加插件或从 GitHub 导入，使团队可以使用它们。"'],
        ['"Try changing your search query"', '"请尝试修改搜索条件"'],
        ['children:"Try a different search term or browse by category"', 'children:"请尝试其他搜索词或按分类浏览"'],
        ['children:"Try different filters"', 'children:"请尝试不同筛选条件"'],
        ['"Import Marketplace..."', '"导入插件市场..."'],
        ['"Manage plugins"', '"管理插件"'],
        ['children:"Browse Marketplace"', 'children:"浏览插件市场"'],
        ['title:"Results"', 'title:"结果"'],
        ['title:"Suggested"', 'title:"推荐"'],
        ['title:It?"Results":"Suggested"', 'title:It?"结果":"推荐"'],
        ['children:"Suggested"', 'children:"推荐"'],
        ['<h3 class=cloud-mcp-marketplace-title>Browse MCPs</h3>', '<h3 class=cloud-mcp-marketplace-title>浏览 MCP</h3>'],
        ['placeholder="Search anything"', 'placeholder="搜索任何内容"'],
        ['placeholder:"Search"', 'placeholder:"搜索"'],
        ['placeholder:"Search or Paste Link"', 'placeholder:"搜索或粘贴链接"'],

        // Agent 执行错误弹窗。
        ['"Agent Execution Timed Out"', '"智能体执行超时"'],
        ['"The agent execution provider did not respond in time. This may indicate the extension host is not running or is unresponsive."', '"智能体执行提供程序未及时响应。这可能表示扩展主机未运行或无响应。"'],
        ['"Reload Window"', '"重新加载窗口"'],
        ['label:"Reload Window"', 'label:"重新加载窗口"'],
        ['children:"Reload Window"', 'children:"重新加载窗口"'],
        ['children:"An unexpected error occurred. Reload the window to try again."', 'children:"发生意外错误。请重新加载窗口后重试。"'],
        ['children:"Copy Error"', 'children:"复制错误"'],

        // 常见可见 UI 状态、菜单与按钮。
        ['children:"Rendering diagram..."', 'children:"正在渲染图表..."'],
        ['children:"Mermaid Syntax Error"', 'children:"Mermaid 语法错误"'],
        ['children:"View diagram source"', 'children:"查看图表源码"'],
        ['children:"Open in Terminal Pane"', 'children:"在终端面板中打开"'],
        ['children:"Copy Command"', 'children:"复制命令"'],
        ['children:"Add to Allowlist and Run"', 'children:"添加到白名单并运行"'],
        ['children:"Empty directory"', 'children:"空目录"'],
        ['children:"No diagnostics found"', 'children:"未发现诊断信息"'],
        ['children:"No MCP resources available"', 'children:"暂无可用 MCP 资源"'],
        ['children:"Waiting for upload..."', 'children:"正在等待上传..."'],
        ['children:"This agent was working on "', 'children:"此智能体正在处理 "'],
        ['children:"Don\'t ask again"', 'children:"不再询问"'],
        ['children:"Stay on Current Branch"', 'children:"留在当前分支"'],
        ['children:"Checkout"', 'children:"检出"'],
        ['children:"Agent disconnected"', 'children:"智能体已断开连接"'],
        ['children:"View Report"', 'children:"查看报告"'],
        ['label:"Context Usage"', 'label:"上下文用量"'],
        ['children:"Pasted Link"', 'children:"已粘贴链接"'],
        ['children:"Remote HTTPS"', 'children:"远程 HTTPS"'],
        ['label:"Command"', 'label:"命令"'],
        ['label:"Arguments"', 'label:"参数"'],
        ['label:"Secrets"', 'label:"密钥"'],
        ['label:"Server URL"', 'label:"服务器 URL"'],
        ['label:"HTTP headers"', 'label:"HTTP 请求头"'],
        ['label:"Client ID"', 'label:"客户端 ID"'],
        ['label:"Client Secret"', 'label:"客户端密钥"'],
        ['placeholder:"OAuth Client ID (optional)"', 'placeholder:"OAuth 客户端 ID（可选）"'],
        ['placeholder:"OAuth Client Secret (optional)"', 'placeholder:"OAuth 客户端密钥（可选）"'],
        ['children:"Add MCP Server"', 'children:"添加 MCP 服务器"'],
        ['children:"Clear variables"', 'children:"清除变量"'],
        ['title:"Team Access"', 'title:"团队访问权限"'],
        ['title:"Plugin Settings"', 'title:"插件设置"'],
        ['children:"All Members"', 'children:"所有成员"'],
        ['children:"Marketplace Settings"', 'children:"插件市场设置"'],
        ['label:"Marketplace Access"', 'label:"插件市场访问权限"'],
        ['description:"Select who can see and use plugins from this team marketplace"', 'description:"选择谁可以查看和使用此团队插件市场中的插件"'],
        ['label:"Enable Auto Refresh"', 'label:"启用自动刷新"'],
        ['description:"Automatically update plugins when changes are pushed to the repository"', 'description:"当变更推送到仓库时自动更新插件"'],
        ['label:"Plugin Repository"', 'label:"插件仓库"'],
        ['description:"Fetch marketplace plugins from the GitHub repository"', 'description:"从 GitHub 仓库获取插件市场插件"'],
        ['label:"Remove Marketplace"', 'label:"移除插件市场"'],
        ['title:"Remove marketplace?"', 'title:"移除插件市场？"'],
        ['children:"Delete Marketplace"', 'children:"删除插件市场"'],
        ['title:"Delete marketplace?"', 'title:"删除插件市场？"'],
        ['description:"This marketplace and its access settings will be removed. The source repository won\'t be affected."', 'description:"将移除此插件市场及其访问设置。源仓库不会受到影响。"'],
        ['description:"This marketplace and its access settings will be removed. The repository won\'t be affected."', 'description:"将移除此插件市场及其访问设置。仓库不会受到影响。"'],
        ['description:"This marketplace will be removed from your account. The source repository won\'t be affected."', 'description:"将从你的账号中移除此插件市场。源仓库不会受到影响。"'],
        ['children:"Configure"', 'children:"配置"'],
        ['children:"Remove"', 'children:"移除"'],
        ['children:"Plugin"', 'children:"插件"'],
        ['children:"MCP Server"', 'children:"MCP 服务器"'],
        ['children:"Available Marketplaces"', 'children:"可用插件市场"'],
        ['children:"Access Settings"', 'children:"访问设置"'],
        ['children:"Plugin Installation"', 'children:"插件安装"'],
        ['children:"Default Off"', 'children:"默认关闭"'],
        ['children:"Default On"', 'children:"默认开启"'],
        ['children:"Required"', 'children:"必需"'],
        ['children:"Uninstall"', 'children:"卸载"'],
        ['children:"Add for Myself"', 'children:"为自己添加"'],
        ['children:"Add to Project"', 'children:"添加到项目"'],
        ['children:"Add to Team"', 'children:"添加到团队"'],
        ['children:"Finishing setup\\u2026"', 'children:"正在完成设置..."'],
        ['children:"Imported"', 'children:"已导入"'],
        ['children:"Local"', 'children:"本地"'],
        ['children:"Extension"', 'children:"扩展"'],
        ['title:"Verified"', 'title:"已验证"'],
        ['title:"Open in Editor"', 'title:"在编辑器中打开"'],
        ['title:"Pinned"', 'title:"已固定"'],
        ['title:"Open debug logs"', 'title:"打开调试日志"'],
        ['title:"Previous"', 'title:"上一个"'],
        ['title:"Next"', 'title:"下一个"'],
        ['title:"Scopes"', 'title:"作用域"'],
        ['title:"Restore default parameters"', 'title:"恢复默认参数"'],
        ['title:"Options"', 'title:"选项"'],
        ['title:"Uncommitted Changes"', 'title:"未提交变更"'],
        ['title:"Moving..."', 'title:"正在移动..."'],
        ['title:"Complete"', 'title:"完成"'],
        ['title:"Failed"', 'title:"失败"'],
        ['title:"View plan"', 'title:"查看计划"'],
        ['title:"Mine"', 'title:"我的"'],
        ['title:"Shared"', 'title:"共享"'],
        ['title:"Modes, skills, MCPs and more"', 'title:"模式、技能、MCP 等"'],
        ['title:"Copy Code"', 'title:"复制代码"'],
        ['title:"Download file"', 'title:"下载文件"'],
        ['title:"Download image"', 'title:"下载图片"'],
        ['children:"Open external link?"', 'children:"打开外部链接？"'],
        ['children:"You\'re about to visit an external website."', 'children:"你即将访问外部网站。"'],
        ['children:"Copy link"', 'children:"复制链接"'],
        ['children:"Open link"', 'children:"打开链接"'],
        ['title:"Download diagram"', 'title:"下载图表"'],
        ['title:"Download diagram as SVG"', 'title:"下载 SVG 图表"'],
        ['title:"Download diagram as PNG"', 'title:"下载 PNG 图表"'],
        ['title:"Download diagram as MMD"', 'title:"下载 MMD 图表"'],
        ['title:"View fullscreen"', 'title:"全屏查看"'],
        ['title:"Exit fullscreen"', 'title:"退出全屏"'],
        ['title:"Copy table"', 'title:"复制表格"'],
        ['title:"Copy table as CSV"', 'title:"复制为 CSV 表格"'],
        ['title:"Copy table as TSV"', 'title:"复制为 TSV 表格"'],
        ['title:"Download table"', 'title:"下载表格"'],
        ['title:"Download table as CSV"', 'title:"下载 CSV 表格"'],
        ['title:"Download table as Markdown"', 'title:"下载 Markdown 表格"'],
        ['title:"Zoom in"', 'title:"放大"'],
        ['title:"Zoom out"', 'title:"缩小"'],
        ['title:"Reset zoom and pan"', 'title:"重置缩放和平移"'],
        ['children:"Loading diagram..."', 'children:"正在加载图表..."'],
        ['children:"Show Code"', 'children:"显示代码"'],
        ['currentLabel:"Run History"', 'currentLabel:"运行历史"'],
        ['breadcrumbLabel:"Run History"', 'breadcrumbLabel:"运行历史"'],
        ['title:"Run History"', 'title:"运行历史"'],
        ['children:["Run History"," "', 'children:["运行历史"," "'],
        ['children:"No Runs Yet"', 'children:"暂无运行记录"'],
        ['children:"No Automations Yet"', 'children:"暂无自动化"'],
        ['children:"New Automation"', 'children:"新建自动化"'],
        ['children:"Run agents on a schedule or automatically in response to events. Billed at plan rates."', 'children:"按计划运行智能体，或响应事件自动运行。按套餐费率计费。"'],

        // 第三轮扫描发现的常见界面文案。
        ['<div>No results found.', '<div>未找到结果。'],
        ['emptyStateText:"No results found"', 'emptyStateText:"未找到结果"'],
        ['children:"No results found."', 'children:"未找到结果。"'],
        ['placeholder:"Search channels or paste channel ID..."', 'placeholder:"搜索频道或粘贴频道 ID..."'],
        ['children:"Loading channels..."', 'children:"正在加载频道..."'],
        ['"No channels available"', '"暂无可用频道"'],
        ['"No results for \\""', '"没有结果匹配 \\""'],
        ['children:["Add channel ID "', 'children:["添加频道 ID "'],
        ['"Any channel"', '"任意频道"'],
        ['title:"Selected"', 'title:"已选择"'],
        ['title:"Manage Marketplace"', 'title:"管理插件市场"'],
        ['title:"Date range"', 'title:"日期范围"'],
        ['title:"Rows per page"', 'title:"每页行数"'],
        ['placeholder:"Search Plugins, Skills, Tools, Subagents, Commands..."', 'placeholder:"搜索插件、技能、工具、子智能体、命令..."'],
        ['title:"All Marketplaces"', 'title:"所有插件市场"'],
        ['title:"Debug Logs"', 'title:"调试日志"'],
        ['children:"Waiting for log entries..."', 'children:"正在等待日志条目..."'],
        ['children:"Clear Logs"', 'children:"清空日志"'],
        ['label:"Reproduction Steps"', 'label:"复现步骤"'],
        ['children:"Mark Fixed"', 'children:"标记为已修复"'],
        ['children:"Load Diff"', 'children:"加载差异"'],
        ['children:"Generated files are not rendered by default."', 'children:"默认不渲染生成文件。"'],
        ['children:"Large diffs are hidden by default."', 'children:"默认隐藏大型差异。"'],
        ['children:"Diff content not available"', 'children:"差异内容不可用"'],
        ['children:"This file changed, but a text diff could not be rendered."', 'children:"此文件已更改，但无法渲染文本差异。"'],
        ['label:"Agent blocked"', 'label:"智能体已被阻止"'],
        ['label:"Up to date"', 'label:"已是最新"'],
        ['label:"Ready to save"', 'label:"准备保存"'],
        ['label:"Setting up"', 'label:"正在设置"'],
        ['placeholder:"Anything else?"', 'placeholder:"还有其他问题吗？"'],
        ['children:"Add Models"', 'children:"添加模型"'],
        ['children:"Your admin has disabled this option."', 'children:"你的管理员已禁用此选项。"'],
        ['children:"Show all models..."', 'children:"显示所有模型..."'],
        ['label:"MAX Mode"', 'label:"MAX 模式"'],
        ['children:"MAX MODE"', 'children:"MAX 模式"'],
        ['label:"Use Multiple Models"', 'label:"使用多个模型"'],
        ['children:"Enable MAX Mode"', 'children:"启用 MAX 模式"'],
        ['placeholder:"Search models"', 'placeholder:"搜索模型"'],
        ['children:"No models found"', 'children:"未找到模型"'],
        ['label:"Move to Local"', 'label:"移动到本地"'],
        ['children:"Move to Local"', 'children:"移动到本地"'],
        ['label:"Checkout branch locally"', 'label:"在本地检出分支"'],
        ['label:"Checkout & Move to Local"', 'label:"检出并移动到本地"'],
        ['tooltip:"Checkout branch and convert agent to local mode"', 'tooltip:"检出分支并将智能体转换为本地模式"'],
        ['description:"You have uncommitted changes in your working tree. Choose an option, then continue."', 'description:"你的工作树中有未提交的更改。请选择一个选项，然后继续。"'],
        ['children:"Do not ask me again"', 'children:"不再询问我"'],
        ['children:"Paste as one line"', 'children:"粘贴为一行"'],
        ['children:"Add an agent to get started"', 'children:"添加一个智能体以开始使用"'],
        ['placeholder:"Todo description..."', 'placeholder:"待办描述..."'],
        ['children:"Build in New Agent"', 'children:"在新智能体中构建"'],
        ['children:"Add a to-do to get started"', 'children:"添加一个待办以开始使用"'],
        ['label:"Add to Chat"', 'label:"添加到聊天"'],
        ['placeholder:"Plan body..."', 'placeholder:"计划正文..."'],
        ['children:"Save to workspace"', 'children:"保存到工作区"'],
        ['children:"Build in Parallel"', 'children:"并行构建"'],
        ['children:"Copy as Markdown"', 'children:"复制为 Markdown"'],
        ['children:"Find in Plan"', 'children:"在计划中查找"'],
        ['children:"Save to Workspace"', 'children:"保存到工作区"'],
        ['children:"View Plan"', 'children:"查看计划"'],
        ['children:"Error loading plugin"', 'children:"加载插件出错"'],
        ['children:"Try in Chat"', 'children:"在聊天中试用"'],
        ['children:"Import from GitHub"', 'children:"从 GitHub 导入"'],
        ['placeholder:"Enter a GitHub repository URL containing a plugin marketplace"', 'placeholder:"输入包含插件市场的 GitHub 仓库 URL"'],
        ['label:"GitHub Repository URL"', 'label:"GitHub 仓库 URL"'],
        ['children:"Open in Chat"', 'children:"在聊天中打开"'],
        ['children:"View Details"', 'children:"查看详情"'],
        ['children:"Remove from Cursor"', 'children:"从 Cursor 中移除"'],
        ['label:"All files and folders"', 'label:"所有文件和文件夹"'],
        ['children:"Add Skills"', 'children:"添加技能"'],
        ['placeholder:"Search MCP servers..."', 'placeholder:"搜索 MCP 服务器..."'],
        ['children:"Loading MCP servers..."', 'children:"正在加载 MCP 服务器..."'],
        ['label:"No MCP servers"', 'label:"暂无 MCP 服务器"'],
        ['children:"No MCP servers available"', 'children:"暂无可用 MCP 服务器"'],
        ['children:"No MCP servers configured"', 'children:"未配置 MCP 服务器"'],
        ['"No servers match your search"', '"没有服务器匹配你的搜索"'],
        ['children:"Open MCP Settings"', 'children:"打开 MCP 设置"'],
        ['placeholder:"Add agents, context, tools..."', 'placeholder:"添加智能体、上下文、工具..."'],
        ['children:"Loading skills..."', 'children:"正在加载技能..."'],
        ['children:"No skills available"', 'children:"暂无可用技能"'],
        ['children:"Waiting for logs"', 'children:"正在等待日志"'],
        ['placeholder:"SSH Hostname"', 'placeholder:"SSH 主机名"'],
        ['children:"Type in a host like user@host or select from SSH config"', 'children:"输入 user@host 形式的主机，或从 SSH 配置中选择"'],
        ['children:"Rename tab"', 'children:"重命名标签页"'],
        ['children:"Close Others"', 'children:"关闭其他标签页"'],
        ['children:"Close to the Right"', 'children:"关闭右侧标签页"'],
        ['children:"Close All"', 'children:"全部关闭"'],
        ['label:"Commit changes"', 'label:"提交更改"'],
        ['description:"Create a checkpoint commit with your current changes"', 'description:"使用当前更改创建检查点提交"'],
        ['label:"Stash changes"', 'label:"暂存更改"'],
        ['description:"Save your changes to a stash and restore them later"', 'description:"将更改保存到 stash，稍后可恢复"'],
        ['label:"Discard changes"', 'label:"放弃更改"'],
        ['description:"Delete your current uncommitted changes before switching"', 'description:"切换前删除当前未提交的更改"'],
        ['description:"Temporarily save uncommitted work, then check out the cloud agent branch."', 'description:"临时保存未提交的工作，然后检出云端智能体分支。"'],
        ['description:"Create a checkpoint commit of your changes, then check out the branch."', 'description:"为你的更改创建检查点提交，然后检出该分支。"'],
        ['label:"Hidden from agent"', 'label:"对智能体隐藏"'],
        ['label:"Leak scanned before commit"', 'label:"提交前已扫描泄漏"'],
        ['label:"Available at runtime"', 'label:"运行时可用"'],
        ['label:"Available at build"', 'label:"构建时可用"'],
        ['children:"No files"', 'children:"无文件"'],
        ['label:"Most Used"', 'label:"最常用"'],
        ['"glass.agentMigrationService.failed.title","Failed to migrate agent"', '"glass.agentMigrationService.failed.title","迁移智能体失败"'],
        ['"glass.agentMigrationService.failed.copyError","Copy Error"', '"glass.agentMigrationService.failed.copyError","复制错误"'],

        // 模式、提及菜单和快捷动作。
        ['label:"Change run mode"', 'label:"更改运行模式"'],
        ['label:"Add to allowlist"', 'label:"添加到白名单"'],
        ['label:"MCP Servers"', 'label:"MCP 服务器"'],
        ['children:"MCP Servers"', 'children:"MCP 服务器"'],
        ['"aria-label":"MCP Servers"', '"aria-label":"MCP 服务器"'],
        ['title:"Cloud MCP Servers"', 'title:"云端 MCP 服务器"'],
        ['title:"User MCP Servers"', 'title:"用户 MCP 服务器"'],
        ['title:"Team MCP Servers"', 'title:"团队 MCP 服务器"'],
        ['title:"Home MCP Servers"', 'title:"Home MCP 服务器"'],
        ['title:"Sign In to View Cloud MCP Servers"', 'title:"登录以查看云端 MCP 服务器"'],
        ['title:"Could Not Load Cloud MCP Servers"', 'title:"无法加载云端 MCP 服务器"'],
        ['title:"No User MCP Servers"', 'title:"暂无用户 MCP 服务器"'],
        ['title:"No Team MCP Servers"', 'title:"暂无团队 MCP 服务器"'],
        ['description:"Servers available to cloud agents."', 'description:"可供云端智能体使用的服务器。"'],
        ['description:"Servers available in this workspace."', 'description:"此工作区可用的服务器。"'],
        ['description:"Servers available from Home."', 'description:"Home 中可用的服务器。"'],
        ['description:"Your personal cloud MCP servers."', 'description:"你的个人云端 MCP 服务器。"'],
        ['description:"Cloud MCP servers shared by your team."', 'description:"团队共享的云端 MCP 服务器。"'],
        ['description:"Add a personal cloud MCP server to make it available to your cloud agents."', 'description:"添加个人云端 MCP 服务器，使云端智能体可以使用它。"'],
        ['description:"Team admins can configure shared MCP servers in the dashboard."', 'description:"团队管理员可在控制台配置共享 MCP 服务器。"'],
        ['message:"Loading cloud MCP servers..."', 'message:"正在加载云端 MCP 服务器..."'],
        ['message:"Loading user MCP servers..."', 'message:"正在加载用户 MCP 服务器..."'],
        ['message:"Loading team MCP servers..."', 'message:"正在加载团队 MCP 服务器..."'],
        ['message:"Loading workspace MCP servers..."', 'message:"正在加载工作区 MCP 服务器..."'],
        ['"Failed to load cloud MCP servers."', '"加载云端 MCP 服务器失败。"'],
        ['"Failed to load workspace MCP servers."', '"加载工作区 MCP 服务器失败。"'],
        ['children:"Open Dashboard"', 'children:"打开控制台"'],
        ['actionTitle:"Add MCP"', 'actionTitle:"添加 MCP"'],
        ['children:"Add MCP"', 'children:"添加 MCP"'],
        ['`Workspace"} MCP Servers`', '`Workspace"} MCP 服务器`'],
        ['`Workspace"} MCP Tools`', '`Workspace"} MCP 工具`'],
        ['"aria-label":"Mermaid Diagram"', '"aria-label":"Mermaid 图表"'],
        ['<span class=context-pill-warning-text>Tree outline', '<span class=context-pill-warning-text>树形大纲'],
        ['children:"Tree outline"', 'children:"树形大纲"'],

        // Rules / Skills / Subagents / Commands 二级菜单空状态与表单。
        ['title:"Rules"', 'title:"规则"'],
        ['helpTooltipLabel:"Learn about Rules"', 'helpTooltipLabel:"了解规则"'],
        ['description:"Use Rules to guide agent behavior, like enforcing best practices or coding standards. Rules can be applied always, by file path, or manually."', 'description:"使用规则引导智能体行为，例如强制执行最佳实践或编码标准。规则可以始终应用、按文件路径应用或手动应用。"'],
        ['title:"No Rules Yet"', 'title:"暂无规则"'],
        ['description:"Create rules to guide Agent behavior"', 'description:"创建规则来引导智能体行为"'],
        ['actionTitle:"New User Rule"', 'actionTitle:"新建用户规则"'],
        ['actionTitle:"New Project Rule"', 'actionTitle:"新建项目规则"'],
        ['title:"Could Not Load Rules"', 'title:"无法加载规则"'],
        ['"Failed to load workspace rules."', '"加载工作区规则失败。"'],
        ['<div>Loading Rules...', '<div>正在加载规则...'],
        ['placeholder="Rule content..."', 'placeholder="规则内容..."'],
        ['placeholder="Style request, response language, tone..."', 'placeholder="风格要求、回复语言、语气..."'],
        ['"[Untitled]"', '"[未命名]"'],
        ['"User Generated Memory"', '"用户生成记忆"'],
        ['"Applied intelligently"', '"智能应用"'],
        ['"Content is required."', '"内容不能为空。"'],
        ['"File pattern is required when applying to specific files."', '"应用到指定文件时必须填写文件模式。"'],
        ['"Failed to save changes. Please try again."', '"保存失败，请重试。"'],
        ['"Incorrect format, <span>fix with agent"', '"格式不正确，<span>使用智能体修复"'],
        ['title:"Delete Rule"', 'title:"删除规则"'],
        ['deleteDisabledTooltip:"Cannot delete team rules"', 'deleteDisabledTooltip:"无法删除团队规则"'],
        ['<button class=show-all-rules-button>Show all (<!> more)', '<button class=show-all-rules-button>显示全部（<!> 个更多）'],
        ['<button class=show-all-rules-button>Show less', '<button class=show-all-rules-button>收起'],
        ['children:"New"', 'children:"新建"'],
        ['children:"Done"', 'children:"完成"'],
        ['children:"Save"', 'children:"保存"'],
        ['"Done"', '"完成"'],
        ['"Save"', '"保存"'],
        ['title:"Could Not Load Skills"', 'title:"无法加载技能"'],
        ['"Failed to load workspace skills."', '"加载工作区技能失败。"'],
        ['<div>Loading Skills...', '<div>正在加载技能...'],
        ['title:"Could Not Load Subagents"', 'title:"无法加载子智能体"'],
        ['"Failed to load workspace subagents."', '"加载工作区子智能体失败。"'],
        ['<div>Loading Subagents...', '<div>正在加载子智能体...'],
        ['title:"Could Not Load Commands"', 'title:"无法加载命令"'],
        ['"Failed to load workspace commands."', '"加载工作区命令失败。"'],
        ['<div>Loading Commands...', '<div>正在加载命令...'],
        ['label:"Always applied"', 'label:"始终应用"'],
        ['label:"Agent decides when to apply"', 'label:"由智能体决定何时应用"'],
        ['label:"Apply to Specific Files & Folders"', 'label:"应用到指定文件和文件夹"'],
        ['"Always applied"', '"始终应用"'],
        ['"Agent decides when to apply"', '"由智能体决定何时应用"'],
        ['"Apply to Specific Files & Folders"', '"应用到指定文件和文件夹"'],
        ['children:"Create with Agent"', 'children:"使用智能体创建"'],
        ['"Saving..."', '"正在保存..."'],
        ['placeholder:"Plan and design before coding..."', 'placeholder:"编码前先规划和设计..."'],
        ['description:"Plan and design before coding"', 'description:"编码前先规划和设计"'],
        ['placeholder:"Debug and troubleshoot issues..."', 'placeholder:"调试并排查问题..."'],
        ['description:"Debug and troubleshoot issues"', 'description:"调试并排查问题"'],
        ['placeholder:"Ask questions without making changes..."', 'placeholder:"提问但不修改..."'],
        ['description:"Ask questions without making changes"', 'description:"提问但不修改"'],
        ['return"Mentions"', 'return"提及项"'],
        ['return"Files & Folders"', 'return"文件和文件夹"'],
        ['return"Agent Stores"', 'return"智能体存储"'],
        ['return"Terminals"', 'return"终端"'],
        ['return"Past Chats"', 'return"历史聊天"'],
        ['return"Branch (Diff with Main)"', 'return"分支（与 Main 对比）"'],
        ['label:"Grep Search"', 'label:"Grep 搜索"'],
        ['label:"Search files"', 'label:"搜索文件"'],
        ['"Searching files"', '"正在搜索文件"'],
        ['"Searched files"', '"已搜索文件"'],
        ['"Search files attempted"', '"已尝试搜索文件"'],
        ['"Search files..."', '"搜索文件..."'],
        ['"Search actions..."', '"搜索操作..."'],
        ['"Search agents..."', '"搜索智能体..."'],
        ['"Search files, actions, agents..."', '"搜索文件、操作、智能体..."'],
        ['children:Q?"Files":Z?"Agents":"Actions"', 'children:Q?"文件":Z?"智能体":"操作"'],
        ['description:"Files in workspace"', 'description:"工作区文件"'],
        ['label:"Edit & Reapply"', 'label:"编辑并重新应用"'],
        ['label:"Delete file"', 'label:"删除文件"'],
        ['"Delete file with unsaved changes?"', '"删除包含未保存更改的文件？"'],

        // 自动运行、安全确认和连接错误。
        ['title:"Enable Run Everything?"', 'title:"启用“运行所有”？"'],
        ['label:"Enable Run Everything"', 'label:"启用运行所有"'],
        ['title:"Leave Ask Every Time?"', 'title:"离开“每次询问”？"'],
        ['label:"Use Sandbox instead"', 'label:"改用沙盒"'],
        ['label:"Use Allowlist instead"', 'label:"改用白名单"'],
        ['label:"Continue"', 'label:"继续"'],
        ['title:"Unsupported Model"', 'title:"不支持的模型"'],
        ['title:"Connection stalled"', 'title:"连接停滞"'],
        ['title:"Connection failed"', 'title:"连接失败"'],
        ['"Connection stalled repeatedly"', '"连接反复停滞"'],
        ['"Connection failed repeatedly"', '"连接反复失败"'],
        ['detail:"The connection stalled. Please try again."', 'detail:"连接停滞。请重试。"'],
        ['"Connection failed. Please try again, or contact support if the issue persists."', '"连接失败。请重试；如果问题持续存在，请联系支持。"'],
        ['detail:"Connection failed. If the problem persists, please check your internet connection or VPN"', 'detail:"连接失败。如果问题持续存在，请检查你的网络连接或 VPN"'],

        // 斜杠菜单动作。
        ['name:"Reset"', 'name:"重置"'],
        ['description:"Clear the conversation and start fresh"', 'description:"清空对话并重新开始"'],
        ['name:"Summarize"', 'name:"总结"'],
        ['description:"Summarize the conversation"', 'description:"总结对话"'],
        ['description:"Request an agent to review your code"', 'description:"请求智能体审查你的代码"'],
        ['name:"Open Browser"', 'name:"打开浏览器"'],
        ['description:"Open a browser for web interactions"', 'description:"打开浏览器进行网页交互"'],
        ['description:"Install a plugin from the marketplace"', 'description:"从插件市场安装插件"'],
        ['children:"Browse and install plugins from the Cursor marketplace. Type a search query after the command to find plugins."', 'children:"从 Cursor 插件市场浏览并安装插件。在命令后输入搜索词以查找插件。"'],
        ['description:"Uninstall an installed plugin"', 'description:"卸载已安装插件"'],
        ['children:"Remove an installed plugin. Type a search query after the command to find plugins to uninstall."', 'children:"移除已安装插件。在命令后输入搜索词以查找要卸载的插件。"'],

        ['get title(){return`Configured Hooks (${D()})`}', 'get title(){return`已配置的钩子 (${D()})`}'],
        ['description:"Add a hooks.json file to your user, project, or enterprise config to start running custom scripts."', 'description:"在用户、项目或企业配置中添加 hooks.json 文件，即可开始运行自定义脚本。"'],
        ['helpTooltipLabel:"Learn about Hooks"', 'helpTooltipLabel:"了解钩子"'],
        ['title:"Configuration Errors"', 'title:"配置错误"'],
        ['children:"Open user config"', 'children:"打开用户配置"'],
        ['children:"Open project config"', 'children:"打开项目配置"'],
        ['children:"Open enterprise config"', 'children:"打开企业配置"'],
        ['children:"Open JSON"', 'children:"打开 JSON"'],
        ['title:"PR Preferences"', 'title:"PR 偏好设置"'],
        ['label:"Preferred PR destination"', 'label:"首选 PR 打开位置"'],
        ['qbE="Choose where PR links open across web, the desktop app and IDE."', 'qbE="选择 PR 链接在网页、桌面应用和 IDE 中的打开位置。"'],
        ['<p class=cursor-settings-cell-label>Window Layout</p>', '<p class=cursor-settings-cell-label>窗口布局</p>'],
        ['<div class=cursor-settings-cell-description>Switch between Agent and Editor default layouts</div>', '<div class=cursor-settings-cell-description>在智能体和编辑器默认布局之间切换</div>'],
        ['aria-label="Window Layout"', 'aria-label="窗口布局"'],
        ['<span class=layout-picker-segmented__label>Agent</span>', '<span class=layout-picker-segmented__label>智能体</span>'],
        ['<span class=layout-picker-segmented__label>Editor</span>', '<span class=layout-picker-segmented__label>编辑器</span>'],
        ['{id:"agent",label:"Agent"},{id:"editor",label:"Editor"}', '{id:"agent",label:"智能体"},{id:"editor",label:"编辑器"}'],
        ['label:"Title Bar"', 'label:"标题栏"'],
        ['description:"Show title bar in agent layout"', 'description:"在智能体布局中显示标题栏"'],
        ['description:"Show status bar at the bottom of the window"', 'description:"在窗口底部显示状态栏"'],
        ['label:"Review Control Location"', 'label:"审查控件位置"'],
        ['description:"Show inline diff review controls in top level breadcrumbs or floating island"', 'description:"在顶部面包屑或浮动面板中显示内联差异审查控件"'],
        ['{id:"breadcrumb",label:"Breadcrumb"},{id:"island",label:"Island"}', '{id:"breadcrumb",label:"面包屑"},{id:"island",label:"浮动面板"}'],
        ['<div><div>Share Data</div>', '<div><div>共享数据</div>'],
        ['<div><div>Improve Cursor for everyone', '<div><div>帮助所有人改进 Cursor'],
        ['<div><div>Privacy Mode</div>', '<div><div>隐私模式</div>'],
        ['<div><div>No training. Code may be stored for Background Agent and other features.', '<div><div>不用于训练。代码可能会被存储，以支持后台智能体和其他功能。'],
        ['<div><div>隐私模式（旧版）</div><div>No training and no storage. Background Agent and other features that require code storage will be disabled.', '<div><div>隐私模式（旧版）</div><div>不用于训练，也不存储。后台智能体和其他需要代码存储的功能将被禁用。'],
        ['<span>More Options</span>', '<span>更多选项</span>'],
        ['n.server.enabled?i()&&!s()?"Connecting...":s()&&J?.phase==="needsAuth"?"正在等待回调...":J?.phase==="checking"?s()?"正在交换令牌...":"Checking server status":J?.phase==="needsAuth"?"Needs authentication":J?.phase==="error"?d():"Connected":"Disabled"', 'n.server.enabled?i()&&!s()?"正在连接...":s()&&J?.phase==="needsAuth"?"正在等待回调...":J?.phase==="checking"?s()?"正在交换令牌...":"正在检查服务器状态":J?.phase==="needsAuth"?"需要身份验证":J?.phase==="error"?d():"已连接":"已禁用"'],
        ['name:"Agent",actionId:"composerMode.agent"', 'name:"智能体",actionId:"composerMode.agent"'],
        ['name:"Triage",actionId:"composerMode.triage"', 'name:"分诊",actionId:"composerMode.triage"'],
        ['name:"Plan",actionId:"composerMode.plan"', 'name:"计划",actionId:"composerMode.plan"'],
        ['name:"Spec",actionId:"composerMode.spec"', 'name:"规格",actionId:"composerMode.spec"'],
        ['name:"Debug",actionId:"composerMode.debug"', 'name:"调试",actionId:"composerMode.debug"'],
        ['name:"Multitask",actionId:"composerMode.multitask"', 'name:"多任务",actionId:"composerMode.multitask"'],
        ['name:"Ask",actionId:"composerMode.chat"', 'name:"对话",actionId:"composerMode.chat"'],
        ['name:"Project",actionId:"composerMode.project"', 'name:"项目",actionId:"composerMode.project"'],
        ['<span>On-Demand Usage', '<span>按需用量'],
        ['% Auto used', '% 自动用量'],
        ['% Auto and', '% 自动用量，'],
        ['% API used', '% API 用量'],
        ['return()=>Ze()?`$${fe(ue()?.used??0)}`:"Disabled"', 'return()=>Ze()?`$${fe(ue()?.used??0)}`:"已禁用"'],
        ['?"Fixed":Q()==="unlimited"?"Unlimited":"Disabled"', '?"固定":Q()==="unlimited"?"无限制":"已禁用"'],
        ['<div><span>Subagents', '<div><span>子智能体'],
        ['<div><div title="Choose Explore subagent model"', '<div><div title="选择探索子智能体模型"'],
        ['<div><div title="Choose 探索子智能体模型"', '<div><div title="选择探索子智能体模型"'],
        ['aria-label="Max Mode required"', 'aria-label="需要 Max 模式"'],
        ['SAS="Subagent model overrides will only be used in Max Mode"', 'SAS="子智能体模型覆盖仅会在 Max 模式中使用"'],
        ['label:"Reset to default"', 'label:"重置为默认值"'],
        ['label:"Disable",labelOutsidePicker:"Disabled"', 'label:"禁用",labelOutsidePicker:"已禁用"'],
        ['label:"Inherit from parent"', 'label:"继承父级设置"'],
        ['label:"Auto-Run in Sandbox"', 'label:"在沙盒中自动运行"'],
        ['label:"Run Everything (Unsandboxed)"', 'label:"运行所有（非沙盒）"'],
        ['title:"Approvals & Execution for commands, MCP and more"', 'title:"命令、MCP 等审批与执行"'],
        ['children:"Approvals & Execution for commands, MCP and more"', 'children:"命令、MCP 等审批与执行"'],
        ['label:"Run Mode"', 'label:"运行模式"'],
        ['title:"Run Mode"', 'title:"运行模式"'],
        ['children:"Run Mode"', 'children:"运行模式"'],
        ['description:"Choose how Agents run tools like command execution, MCP, and file writes."', 'description:"选择智能体如何运行命令执行、MCP 和文件写入等工具。"'],
        ['children:"Commands that are allowlisted will run automatically."', 'children:"列入白名单的命令将自动运行。"'],
        ['label:"Allowlist"', 'label:"白名单"'],
        ['children:"Allowlist"', 'children:"白名单"'],
        ['title:"Learn more"', 'title:"了解更多"'],
        ['children:"Learn more"', 'children:"了解更多"'],
        ['return"Auto-Run in Sandbox"', 'return"在沙盒中自动运行"'],
        ['return"Run Everything (Unsandboxed)"', 'return"运行所有（非沙盒）"'],
        ['return"Ask for permission before running each operation"', 'return"每次操作前请求许可"'],
        ['return"Automatically run operations after you approve them once"', 'return"在您批准一次后自动运行操作"'],
        ['return"Automatically run all operations without asking for permission"', 'return"无需请求许可，自动运行所有操作"'],
        ['return e?"Tools will auto-run in a sandbox if possible, otherwise respect the allowlist or ask for approval"', 'return e?"工具会尽可能在沙盒中自动运行，否则遵循白名单或请求批准"'],
        ['label:"sandbox.json Only"', 'label:"仅 sandbox.json"'],
        ['label:"sandbox.json + Defaults"', 'label:"sandbox.json + 默认值"'],
        ['label:"Allow All"', 'label:"全部允许"'],
        ['return"sandbox.json + Defaults"', 'return"sandbox.json + 默认值"'],
        ['?"Sandboxed network access is disabled by your admin.":"Sandboxed network access is controlled by your admin. You can still edit allowed/denied domains in sandbox.json in your workspace, but admin policy takes precedence."', '?"沙盒网络访问已被管理员禁用。":"沙盒网络访问由管理员控制。您仍可在工作区的 sandbox.json 中编辑允许或拒绝的域名，但管理员策略优先。"'],
        ['label:"Smart Allowlist"', 'label:"智能白名单"'],
        ['description:"Use AI-powered command classification to intelligently match commands against allowlist patterns and suggest sandbox modes"', 'description:"使用 AI 命令分类智能匹配白名单模式并建议沙盒模式"'],
        ['<strong>Deprecated Feature:</strong> The command denylist is often bypassable, providing a false sense of security. Consider using the allowlist approach instead for better security.', '<strong>已弃用功能：</strong>命令拒绝列表经常可被绕过，会造成虚假的安全感。建议改用白名单方式以获得更好的安全性。'],
        ['"aria-label":"Select model count"', '"aria-label":"选择模型数量"'],

        // Agent 运行轨迹和认证错误。
        ['"Thought for "', '"思考了 "'],
        ["'Thought for '", "'思考了 '"],
        ['`Thought for ${', '`思考了 ${'],
        ['"Ran"', '"已运行"'],
        ["'Ran'", "'已运行'"],
        ['`Ran`', '`已运行`'],
        ['"Ran "', '"已运行 "'],
        ["'Ran '", "'已运行 '"],
        ['`Ran ${', '`已运行 ${'],
        ['label:"Ran"', 'label:"已运行"'],
        ['children:"Ran"', 'children:"已运行"'],
        ['"Check recent git history"', '"检查最近 Git 历史"'],
        ["'Check recent git history'", "'检查最近 Git 历史'"],
        ['`Check recent git history`', '`检查最近 Git 历史`'],
        ['label:"Check recent git history"', 'label:"检查最近 Git 历史"'],
        ['children:"Check recent git history"', 'children:"检查最近 Git 历史"'],
        ['"Check current git status"', '"检查当前 Git 状态"'],
        ["'Check current git status'", "'检查当前 Git 状态'"],
        ['`Check current git status`', '`检查当前 Git 状态`'],
        ['label:"Check current git status"', 'label:"检查当前 Git 状态"'],
        ['children:"Check current git status"', 'children:"检查当前 Git 状态"'],

        // Agent 布局侧边栏、窗口菜单和筛选菜单。
        ['"New Agent"', '"新建智能体"'],
        ["'New Agent'", "'新建智能体'"],
        ['`New Agent`', '`新建智能体`'],
        ['name:"New Agent"', 'name:"新建智能体"'],
        ['label:"New Agent"', 'label:"新建智能体"'],
        ['title:"New Agent"', 'title:"新建智能体"'],
        ['children:"New Agent"', 'children:"新建智能体"'],
        ['"aria-label":"New Agent"', '"aria-label":"新建智能体"'],
        ['name:"New Agent",get icon(){return ie(NTe,{name:"agent"', 'name:"新建智能体",get icon(){return ie(NTe,{name:"agent"'],
        ['name:"Automations",get icon(){return ie(NTe,{name:"robot"', 'name:"自动化",get icon(){return ie(NTe,{name:"robot"'],
        ['name:"Customize",get icon(){return ie(NTe,{name:"extensions"', 'name:"插件市场",get icon(){return ie(NTe,{name:"extensions"'],
        ['children:"Open Agents Window"', 'children:"打开智能体窗口"'],
        ['"Plan, search, build anything"', '"规划、搜索、构建任何内容"'],
        ["'Plan, search, build anything'", "'规划、搜索、构建任何内容'"],
        ['`Plan, search, build anything`', '`规划、搜索、构建任何内容`'],
        ['placeholder:"Plan, search, build anything"', 'placeholder:"规划、搜索、构建任何内容"'],
        ['title:"Plan, search, build anything"', 'title:"规划、搜索、构建任何内容"'],
        ['"Search Agents..."', '"搜索智能体..."'],
        ["'Search Agents...'", "'搜索智能体...'"],
        ['`Search Agents...`', '`搜索智能体...`'],
        ['"Search Agents\\u2026"', '"搜索智能体\\u2026"'],
        ['"Search Agents…"', '"搜索智能体…"'],
        ['placeholder:"Search Agents..."', 'placeholder:"搜索智能体..."'],
        ['placeholder:"Search Agents\\u2026"', 'placeholder:"搜索智能体\\u2026"'],
        ['placeholder:"Search Agents…"', 'placeholder:"搜索智能体…"'],
        ['"No matching agents"', '"未找到匹配的智能体"'],
        ["'No matching agents'", "'未找到匹配的智能体'"],
        ['`No matching agents`', '`未找到匹配的智能体`'],
        ['children:"No matching agents"', 'children:"未找到匹配的智能体"'],
        ['"Archived"', '"已归档"'],
        ["'Archived'", "'已归档'"],
        ['`Archived`', '`已归档`'],
        ['label:"Archived"', 'label:"已归档"'],
        ['children:"Archived"', 'children:"已归档"'],
        ['title:"Archived"', 'title:"已归档"'],
        ['"aria-label":"Archived"', '"aria-label":"已归档"'],
        ['"Toggle Chat Pane"', '"切换聊天面板"'],
        ['"Maximize Chat"', '"最大化聊天"'],
        ['"Close Tab"', '"关闭标签页"'],
        ['"Close Other Tabs"', '"关闭其他标签页"'],
        ['"Close All Tabs"', '"关闭所有标签页"'],
        ['"Open Tab as Editor"', '"在编辑器中打开标签页"'],
        ['"Export Transcript"', '"导出对话记录"'],
        ['"Copy Request ID"', '"复制请求 ID"'],
        ['"Agent Settings"', '"智能体设置"'],
        ['label:"Toggle Chat Pane"', 'label:"切换聊天面板"'],
        ['label:"Maximize Chat"', 'label:"最大化聊天"'],
        ['label:"Close Tab"', 'label:"关闭标签页"'],
        ['label:"Close Other Tabs"', 'label:"关闭其他标签页"'],
        ['label:"Close All Tabs"', 'label:"关闭所有标签页"'],
        ['label:"Open Tab as Editor"', 'label:"在编辑器中打开标签页"'],
        ['label:"Export Transcript"', 'label:"导出对话记录"'],
        ['label:"Copy Request ID"', 'label:"复制请求 ID"'],
        ['label:"Agent Settings"', 'label:"智能体设置"'],
        ['label:"Automations"', 'label:"自动化"'],
        ['label:"Marketplace"', 'label:"插件市场"'],
        ['children:"Repositories"', 'children:"代码库"'],
        ['children:"Editor Window"', 'children:"编辑器窗口"'],
        ['"aria-label":"Editor Window"', '"aria-label":"编辑器窗口"'],
        ['label:"Open Editor Window"', 'label:"打开编辑器窗口"'],
        ['label:"Split Right"', 'label:"向右拆分"'],
        ['label:"Split Down"', 'label:"向下拆分"'],
        ['label:"Close",onSelect:r,disabled:s', 'label:"关闭",onSelect:r,disabled:s'],
        ['label:"Plan New Idea"', 'label:"规划新想法"'],
        ['label:"Run in Cloud"', 'label:"在云端运行"'],
        ['hint:"\\u21E7Tab"', 'hint:"\\u21E7Tab"'],
        ['"aria-label":"Group by options"', '"aria-label":"分组选项"'],
        ['"aria-label":"Sidebar filters"', '"aria-label":"侧边栏筛选器"'],
        ['label:"Group by",rightSection:ue,children:"Group by"', 'label:"分组方式",rightSection:ue,children:"分组方式"'],
        ['"aria-label":"Group by",maxWidth:uE', '"aria-label":"分组方式",maxWidth:uE'],
        ['label:"Display",children:"Display"', 'label:"显示",children:"显示"'],
        ['className:"automations-run-filter__heading",children:"Filter by"', 'className:"automations-run-filter__heading",children:"筛选条件"'],
        ['title:"Filter by",children:[ff,Bh,Dp]', 'title:"筛选条件",children:[ff,Bh,Dp]'],
        ['label:"Status",children:"Status"', 'label:"状态",children:"状态"'],
        ['"aria-label":"Show status filters"', '"aria-label":"显示状态筛选器"'],
        ['children:"Environment"}):null', 'children:"环境"}):null'],
        ['label:"Environment",children:"Environment"', 'label:"环境",children:"环境"'],
        ['"aria-label":"Show environment filters"', '"aria-label":"显示环境筛选器"'],
        ['label:"Source",children:"Source"', 'label:"来源",children:"来源"'],
        ['children:"Mark All as Read"', 'children:"全部标为已读"'],
        ['children:"Archive All"', 'children:"全部归档"'],
        ['children:"Remove from Sidebar"', 'children:"从侧边栏移除"'],
        ['a?.label??"Expand All"', 'a?.label??"全部展开"'],
        ['children:"Expand All"', 'children:"全部展开"'],
        ['children:"Collapse All"', 'children:"全部折叠"'],
        ['{value:"workspace",label:"Workspace",icon:"folder"},{value:"repository",label:"Repository",icon:"folder-library"},{value:"time",label:"Updated",icon:"clock"},{value:"status",label:"Status",icon:"circle-dashed"},{value:"environment",label:"Environment",icon:"server"}', '{value:"workspace",label:"工作区",icon:"folder"},{value:"repository",label:"代码库",icon:"folder-library"},{value:"time",label:"更新时间",icon:"clock"},{value:"status",label:"状态",icon:"circle-dashed"},{value:"environment",label:"环境",icon:"server"}'],
        ['{value:"needs_attention",label:"Needs Attention",icon:"exclamation-circle"},{value:"unread_only",label:"Unread",icon:"bell"},{value:"running",label:"Working",icon:"loading"},{value:"draft",label:"Draft",icon:"circle-dashed"},{value:"done",label:"Done",icon:"check-circle"}', '{value:"needs_attention",label:"需要处理",icon:"exclamation-circle"},{value:"unread_only",label:"未读",icon:"bell"},{value:"running",label:"进行中",icon:"loading"},{value:"draft",label:"草稿",icon:"circle-dashed"},{value:"done",label:"已完成",icon:"check-circle"}'],
        ['{value:"git:draft",label:"PR Draft",icon:"git-pull-request-draft"},{value:"git:open",label:"PR Open",icon:"git-pull-request"},{value:"git:merged",label:"PR Merged",icon:"git-merge"},{value:"git:closed",label:"PR Closed",icon:"git-pull-request-closed"},{value:"git:none",label:"No PR",icon:"slash-circle"}', '{value:"git:draft",label:"PR 草稿",icon:"git-pull-request-draft"},{value:"git:open",label:"PR 已打开",icon:"git-pull-request"},{value:"git:merged",label:"PR 已合并",icon:"git-merge"},{value:"git:closed",label:"PR 已关闭",icon:"git-pull-request-closed"},{value:"git:none",label:"无 PR",icon:"slash-circle"}'],
        ['{value:"workspace",label:"Workspace",icon:"folder"},{value:"branch",label:"Branch",icon:"git-branch"},{value:"updatedAt",label:"Updated",icon:"clock"},{value:"source",label:"Source",icon:"arrow-bracket-to-right"}', '{value:"workspace",label:"工作区",icon:"folder"},{value:"branch",label:"分支",icon:"git-branch"},{value:"updatedAt",label:"更新时间",icon:"clock"},{value:"source",label:"来源",icon:"arrow-bracket-to-right"}'],
        ['"source:desktop":{label:"Desktop",icon:"laptop"}', '"source:desktop":{label:"桌面端",icon:"laptop"}'],
        ['"source:web":{label:"Web",icon:"window"}', '"source:web":{label:"网页端",icon:"window"}'],
        ['"source:mobile":{label:"Mobile",icon:"device-mobile"}', '"source:mobile":{label:"移动端",icon:"device-mobile"}'],
        ['"source:slack":{label:"Slack"}', '"source:slack":{label:"Slack"}'],
        ['"source:linear":{label:"Linear"}', '"source:linear":{label:"Linear"}'],
        ['"source:scm":{label:"GitHub / GitLab",icon:"github"}', '"source:scm":{label:"GitHub / GitLab",icon:"github"}'],
        ['"source:cli":{label:"CLI",icon:"terminal"}', '"source:cli":{label:"命令行",icon:"terminal"}'],
        ['"source:setup":{label:"Setup",icon:"cog"}', '"source:setup":{label:"设置",icon:"cog"}'],
        ['"source:sdk":{label:"SDK",icon:"brackets-curly"}', '"source:sdk":{label:"SDK",icon:"brackets-curly"}'],
        ['"source:automations":{label:"Automations",icon:"robot"}', '"source:automations":{label:"自动化",icon:"robot"}'],
        ['"source:api":{label:"API",icon:"code"}', '"source:api":{label:"API",icon:"code"}'],
        ['"source:bugbot_autofix":{label:"Bugbot",icon:"bugbot"}', '"source:bugbot_autofix":{label:"Bugbot",icon:"bugbot"}'],
        ['"source:qabot_frontend":{label:"Frontend QA",icon:"robot"}', '"source:qabot_frontend":{label:"前端 QA",icon:"robot"}'],
        ['"source:local":{label:"Local",icon:"laptop"}', '"source:local":{label:"本地",icon:"laptop"}'],
        ['{value:"workspace",label:"Group by Workspace",icon:"folder"}', '{value:"workspace",label:"按工作区分组",icon:"folder"}'],
        ['{value:"repository",label:"Group by Repository",icon:"folder-library"}', '{value:"repository",label:"按代码库分组",icon:"folder-library"}'],
        ['{value:"time",label:"Group by Updated",icon:"clock"}', '{value:"time",label:"按更新时间分组",icon:"clock"}'],
        ['{value:"status",label:"Group by Status",icon:"circle-dashed"}', '{value:"status",label:"按状态分组",icon:"circle-dashed"}'],
        ['{value:"environment",label:"Group by Environment",icon:"server"}', '{value:"environment",label:"按环境分组",icon:"server"}'],

        // Agent 运行轨迹摘要：这些词都是高频英文，必须限定在工具状态对象或模板片段里替换。
        ['t??"Planning next moves"', 't??"正在规划下一步"'],
        ['"Planning next moves"', '"正在规划下一步"'],
        ['return{action:"Updating",details:"to-do list"}', 'return{action:"正在更新",details:"待办列表"}'],
        ['{action:"Cleared",details:"to-do list"}', '{action:"已清空",details:"待办列表"}'],
        ['{action:"Checked",details:"to-do list"}', '{action:"已检查",details:"待办列表"}'],
        ['{action:"Started to-do",details:r[0].content}', '{action:"开始待办",details:r[0].content}'],
        ['{action:`Started ${r.length} to-dos`,details:""}', '{action:`开始 ${r.length} 个待办`,details:""}'],
        ['{action:`Completed ${c} of ${e.length}`,details:s[0].content}', '{action:`已完成 ${c}/${e.length}`,details:s[0].content}'],
        ['{action:`Completed ${c} of ${e.length} to-dos`,details:""}', '{action:`已完成 ${c}/${e.length} 个待办`,details:""}'],
        ['{action:"Added to-do",details:o[0].content}', '{action:"新增待办",details:o[0].content}'],
        ['{action:`Added ${o.length} to-dos`,details:""}', '{action:`新增 ${o.length} 个待办`,details:""}'],
        ['{action:"Cancelled to-do",details:a[0].content}', '{action:"已取消待办",details:a[0].content}'],
        ['{action:`Cancelled ${a.length} to-dos`,details:""}', '{action:`已取消 ${a.length} 个待办`,details:""}'],
        ['return{action:"Read",details:""}', 'return{action:"读取",details:""}'],
        ['return{action:"Read",details:"tool output"}', 'return{action:"读取",details:"工具输出"}'],
        ['{action:"Read",details:`${r} L${s.startLine}-${s.endLine}`}', '{action:"读取",details:`${r} 第 ${s.startLine}-${s.endLine} 行`}'],
        ['{action:"Read",details:r}', '{action:"读取",details:r}'],
        ['return{action:"Read Todos",details:""}', 'return{action:"读取待办",details:""}'],
        ['return{action:"Explored",details:"available tools"}', 'return{action:"已探索",details:"可用工具"}'],
        ['return{action:e?"Exploring":"Explored",details:"available tools"}', 'return{action:e?"正在探索":"已探索",details:"可用工具"}'],
        ['getMcpToolsToolCall:{loading:"Exploring tools",completed:"Explored tools",error:"Explore tools"}', 'getMcpToolsToolCall:{loading:"正在探索工具",completed:"已探索工具",error:"探索工具"}'],

        // 新版 Agent Todo 摘要使用 verb 字段，字段名不同但最终展示位置相同。
        ['{verb:"Started to-do",primaryAction:"started",todoContent:i[0].content}', '{verb:"开始待办",primaryAction:"started",todoContent:i[0].content}'],
        ['{verb:`Started ${a} to-dos`,primaryAction:"started"}', '{verb:`开始 ${a} 个待办`,primaryAction:"started"}'],
        ['{verb:`Completed ${h} of ${e.length}`,primaryAction:"completed",todoContent:r[0].content}', '{verb:`已完成 ${h}/${e.length}`,primaryAction:"completed",todoContent:r[0].content}'],
        ['{verb:`Completed ${h} of ${e.length} to-dos`,primaryAction:"completed",todoContent:""}', '{verb:`已完成 ${h}/${e.length} 个待办`,primaryAction:"completed",todoContent:""}'],
        ['{verb:"Added to-do",primaryAction:"created",todoContent:o[0].content}', '{verb:"新增待办",primaryAction:"created",todoContent:o[0].content}'],
        ['{verb:`Added ${m} to-dos`,primaryAction:"created"}', '{verb:`新增 ${m} 个待办`,primaryAction:"created"}'],
        ['{verb:"Cancelled to-do",primaryAction:"cancelled",todoContent:s[0].content}', '{verb:"已取消待办",primaryAction:"cancelled",todoContent:s[0].content}'],
        ['{verb:`Cancelled ${d} to-dos`,primaryAction:"cancelled"}', '{verb:`已取消 ${d} 个待办`,primaryAction:"cancelled"}'],
        ['{verb:"Cleared to-do list"}', '{verb:"已清空待办列表"}'],
        ['{verb:"Checked to-do list"}', '{verb:"已检查待办列表"}'],

        // 新版工具详情格式化路径：只改工具详情返回值，避免误伤文档、日志或协议名。
        ['argument:"to-do list"', 'argument:"待办列表"'],
        ['case Kt.TODO_READ:case Kt.TODO_WRITE:return"to-do list"', 'case Kt.TODO_READ:case Kt.TODO_WRITE:return"待办列表"'],
        ['return"tool output"', 'return"工具输出"'],
        ['?`${r} L${t.startLineOneIndexed}-${t.endLineOneIndexedInclusive}`:r', '?`${r} 第 ${t.startLineOneIndexed}-${t.endLineOneIndexedInclusive} 行`:r'],
        ['?`${r} L${t.offset}-${t.offset+t.limit}`:r', '?`${r} 第 ${t.offset}-${t.offset+t.limit} 行`:r'],
        ['[Kt.READ_FILE_V2]:{label:"Read file",support:"rendered"}', '[Kt.READ_FILE_V2]:{label:"读取文件",support:"rendered"}'],
        ['return{loadingAction:"Editing",completedAction:"Edited",fileCount:e+t}', 'return{loadingAction:"正在编辑",completedAction:"已编辑",fileCount:e+t}'],
        ['return{loadingAction:"Deleting",completedAction:"Deleted",fileCount:t}', 'return{loadingAction:"正在删除",completedAction:"已删除",fileCount:t}'],
        ['loadingAction:i?.loadingAction??"Exploring"', 'loadingAction:i?.loadingAction??"正在探索"'],
        ['completedAction:i?.completedAction??"Explored"', 'completedAction:i?.completedAction??"已探索"'],
        ['`${e} file${e===1?"":"s"}`', '`${e} 个文件`'],
    ];

    scopedReplacements.forEach(([en, zh]) => {
        const result = replaceStringWithCount(jsContent, en, zh);
        jsContent = result.content;
        changes.record('界面片段', en, zh, result.count);
        if (result.count > 0) {
            progress.update('替换界面片段', formatReplacementDetail(en, zh, result.count));
        }
    });
    progress.step('界面片段处理完成');

    const worktreeCountResult = replaceRegexWithCount(
        jsContent,
        /`\$\{d\.length\} worktree\$\{d\.length===1\?"":"s"\}`/g,
        '`${d.length} 个工作树`'
    );
    jsContent = worktreeCountResult.content;
    changes.record('动态模板', '`${d.length} worktree${d.length===1?"":"s"}`', '`${d.length} 个工作树`', worktreeCountResult.count);
    // jsContent = jsContent.split('"Reset \\"Don\'t Ask Again\\" Dialogs"').join('"重置\\"不再询问\\"弹窗"');
    // jsContent = jsContent.split("'Reset \"Don\\'t Ask Again\" Dialogs'").join("'重置\"不再询问\"弹窗'");
    // jsContent = jsContent.split('label:\'Reset "Don\\u2019t Ask Again" Dialogs\'').join('label:\'重置“不再询问”弹窗\'');
    // jsContent = jsContent.split('description:"See warnings and tips that you\\u2019ve hidden"').join('description:"查看您已隐藏的警告和提示"');
    // jsContent = jsContent.split('title:"No Hidden Dialogs Yet"').join('title:"暂无隐藏的弹窗"');
    // jsContent = jsContent.split('description:\'You haven\\u2019t marked any dialogs as "Don\\u2019t ask again". Any hidden dialogs will appear here to manage.\'').join('description:\'您尚未将任何弹窗标记为“不再询问”。任何隐藏的弹窗都将显示在此处以供管理。\'');

    // 6. 危险短词：精准 UI 属性替换（跳过键盘扫描表等键位元数据）
    progress.update('处理短词', '仅替换可见 UI 属性，跳过键盘扫描表');
    for (const { en, zh, propRegex, jsxRegex, htmlRegex } of riskyRegexes) {
        const guard = (group, regex, build) => {
            let count = 0;
            jsContent = jsContent.replace(regex, (...args) => {
                const offset = args[args.length - 2];
                if (isProtectedKeybindingContext(jsContent, offset, en)) return args[0];
                count++;
                return build(...args);
            });
            changes.record(group, en, zh, count);
            if (count > 0) {
                progress.update('替换短词', formatReplacementDetail(en, zh, count));
            }
        };
        guard('UI 属性短词', propRegex, (_, p1, p2) => `${p1}: ${p2}${zh}${p2}`);
        guard('JSX 文本短词', jsxRegex, (_, p1, p2) => `${p1}, ${p2}${zh}${p2}`);
        guard('HTML 文本短词', htmlRegex, () => `>${zh}<`);
    }
    progress.step('短词处理完成');

    progress.finish('核心代码处理完成');
    changes.print();

    // 7. 写回（Program Files 等目录下避免写后立刻读盘失败）
    try {
        writeFileSafe(mainJsPath, jsContent, 'utf8');
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            throw new Error(
                `无法写入 ${mainJsPath}：权限不足。请关闭 Cursor 后以管理员身份运行本工具，或将 Cursor 安装到用户目录。`
            );
        }
        throw err;
    }
    console.log('✅ 核心 JS 文件智能汉化完成！');

    // 8. 修复 Hash（使用内存内容，不依赖写回后再次打开主 JS）
    console.log('\n🛠️  正在重新计算指纹并修复文件完整性...');
    const hashFixed = fixProductHash(jsContent, productJsonPath);
    if (hashFixed) {
        console.log('✅ 已更新 product.json 校验值，消除「安装已损坏」警告。');
    } else {
        console.log('⚠️  未找到对应的校验项，可能无需更新。');
    }

    // 9. Mac Gatekeeper 修复
    fixMacGatekeeper(appPath);

    console.log('\n🎉 汉化完成！请重启 Cursor 查看中文设置页。');
}


/**
 * 恢复英文原版
 * @param {{ mainJsPath: string, htmlPath: string, productJsonPath: string }} paths
 */
function restore(paths) {
    const { mainJsPath, htmlPath, productJsonPath } = paths;

    console.log('');
    let restored = 0;
    for (const filePath of [htmlPath, mainJsPath, productJsonPath]) {
        if (restoreFromBackup(filePath)) {
            console.log(`  ✅ 已还原: ${path.basename(filePath)}`);
            restored++;
        }
    }

    if (restored > 0) {
        console.log('\n🎉 已恢复英文原版！请重启 Cursor 生效。');
    } else {
        console.log('\n⚠️  未找到备份文件，无法还原。请确认之前是否执行过汉化。');
    }
}

module.exports = { translate, restore };
