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
    'markdownDescription', 'aria-label', 'ariaLabel',
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
// 备份与还原
// ═══════════════════════════════════════════════

function backupFile(filePath) {
    const backupPath = filePath + '.backup';
    if (fs.existsSync(backupPath)) {
        // 已有备份 → 保留当前文件，避免重复汉化时覆盖现有补丁
        return '🧩 已发现原版备份，保留当前文件继续汉化';
    } else if (fs.existsSync(filePath)) {
        // 首次运行 → 创建备份
        fs.copyFileSync(filePath, backupPath);
        return '💾 已备份纯净原版文件 ———— 正在洗牌';
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

    const jokes = [
        "诺导指着满屏红字问蜗牛，蜗牛说这是给代码加的除夕皮肤。",
        "蓉蓉问苗苗这Bug怎么复现，苗苗推了推眼镜：“看缘分。”",
        "发总发了个大红包，海洋只抢到一分钱，表示要加班到天亮。",
        "杨书记开会抓摸鱼，结果前排的木木文已经抱着抱枕睡熟了。",
        "帅气飞对电脑深情发誓，只要不报错什么都行。系统弹了俩Warning。",
        "海洋写了个邮件自动回复，结果和木木文的脚本硬核对聊了一整夜。",
        "发总夸蓉蓉看电脑的眼神很专注，蓉蓉弱弱说：“发总，电脑死机了。”",
        "苗苗和帅气飞打赌修Bug，杨书记路过重启了服务器，Bug全没了。",
        "蜗牛把删库脚本交了上去，诺导看后连夜买站票逃离了这座城市。",
        "海洋跟发总申请买双屏，说是为了左边摸鱼右边看代码更高效。",
        "帅气飞把bug说成“不影响使用的特性”，被木木文追着打了三条街。",
        "蓉蓉以为自己写了个完美递归，结果把杨书记的机器终于跑死机了。",
        "苗苗的注释写得比代码还长，诺导看了直呼好一篇长篇短篇小说。",
        "发总问大家进度如何，蜗牛指着屏幕：“在建文件夹了，很快！”",
        "木木文声称自己掌握了面向运气编程，只要不报错那就是成功。",
        "诺导让海洋优化内存，海洋直接把功能删了：不运行就不会占内存。",
        "蓉蓉给变量起名a1、a2，帅气飞看源码时差点当场超度上西天了。",
        "杨书记提议大家早睡早起，凌晨三点发现苗苗还在偷偷提交代码。",
        "发总视察打卡记录，惊觉蜗牛为了改Bug已经连续三天睡在公司了。",
        "木木文的代码像是一杯意面上全是结，诺导顺着找Bug找进医院了。",
        "帅气飞用玄学修好了Bug，别人问怎么弄的，他说：“重启治百病。”",
        "蓉蓉发现了一个严重的漏洞，海洋看了一眼说：“没事，那叫彩蛋。”",
        "苗苗问蜗牛借个键盘，蜗牛拿出一个所有键位都被磨平的无字天书。",
        "杨书记为了团建让大家提建议，木木文建议大家周末一起熬夜改Bug。",
        "诺导试图理解帅气飞的代码逻辑链路，最终大脑CPU过载直接冒烟了。",
        "发总给大家发年终奖，海洋一打开，里面是一张“明年继续努力”的贺卡。",
        "蜗牛把测试环境配崩了无故触发警报，蓉蓉以为停电可以提前下班了。",
        "木木文的屏幕倒转过来看代码，声称是为了转换一下思考问题的角度。",
        "帅气飞写的接口延迟高达10秒，他解释说这叫“让用户有一点期待感”。",
        "苗苗一行代码解决核心问题，杨书记拍手叫绝，结果发现连的是测试库。"
    ];
    let lastJokeTime = Date.now();
    // 洗牌函数（Fisher-Yates）
    function shuffleArray(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }
    let shuffledJokes = shuffleArray([...jokes]);
    let jokeIndex = 0;
    function printJoke() {
        const now = Date.now();
        if (now - lastJokeTime > 3000) {
            if (jokeIndex >= shuffledJokes.length) {
                shuffledJokes = shuffleArray([...jokes]);
                jokeIndex = 0;
            }
            // 将文本限制在较短的范围，防止终端因为宽度不够自动换行产生多行
            process.stdout.write(`\r\x1b[K  📢 摸鱼小剧场: ${shuffledJokes[jokeIndex]}`);
            jokeIndex++;
            lastJokeTime = now;
        }
    }

    // 3. 安全长句：单次大正则替换
    jsContent = jsContent.replace(safeMegaRegex, (match, quote, en) => {
        printJoke();
        return `${quote}${safeGlobalDict[en]}${quote}`;
    });

    // 4. 长句裸文本替换
    if (longMegaRegex) {
        jsContent = jsContent.replace(longMegaRegex, (match, en) => {
            printJoke();
            return safeGlobalDict[en];
        });
    }

    process.stdout.write('\n'); // 换行保留最后一句笑话

    // 5. 含内嵌引号和特殊Unicode转义的词条
    // 5. 暴力正则破译：处理带标点、特殊转义、单双引号混用的顽固长句
    console.log('  🔍 正在处理包含特殊符号的顽固词条...');
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
        }
    ];

    trickyReplacements.forEach(({ regex, zh }) => {
        printJoke();
        jsContent = jsContent.replace(regex, zh);
    });

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
        printJoke();
        jsContent = jsContent.split(en).join(zh);
    });

    jsContent = jsContent.replace(
        /`\$\{d\.length\} worktree\$\{d\.length===1\?"":"s"\}`/g,
        '`${d.length} 个工作树`'
    );
    // jsContent = jsContent.split('"Reset \\"Don\'t Ask Again\\" Dialogs"').join('"重置\\"不再询问\\"弹窗"');
    // jsContent = jsContent.split("'Reset \"Don\\'t Ask Again\" Dialogs'").join("'重置\"不再询问\"弹窗'");
    // jsContent = jsContent.split('label:\'Reset "Don\\u2019t Ask Again" Dialogs\'').join('label:\'重置“不再询问”弹窗\'');
    // jsContent = jsContent.split('description:"See warnings and tips that you\\u2019ve hidden"').join('description:"查看您已隐藏的警告和提示"');
    // jsContent = jsContent.split('title:"No Hidden Dialogs Yet"').join('title:"暂无隐藏的弹窗"');
    // jsContent = jsContent.split('description:\'You haven\\u2019t marked any dialogs as "Don\\u2019t ask again". Any hidden dialogs will appear here to manage.\'').join('description:\'您尚未将任何弹窗标记为“不再询问”。任何隐藏的弹窗都将显示在此处以供管理。\'');

    // 6. 危险短词：精准 UI 属性替换（跳过键盘扫描表等键位元数据）
    for (const { en, zh, propRegex, jsxRegex, htmlRegex } of riskyRegexes) {
        printJoke();
        const guard = (regex, build) => {
            jsContent = jsContent.replace(regex, (...args) => {
                const offset = args[args.length - 2];
                if (isProtectedKeybindingContext(jsContent, offset, en)) return args[0];
                return build(...args);
            });
        };
        guard(propRegex, (_, p1, p2) => `${p1}: ${p2}${zh}${p2}`);
        guard(jsxRegex, (_, p1, p2) => `${p1}, ${p2}${zh}${p2}`);
        guard(htmlRegex, () => `>${zh}<`);
    }

    process.stdout.write('\n'); // 收尾换行

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
