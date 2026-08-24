#!/usr/bin/env node

/**
 * 为 macOS 发布产物添加 ad-hoc 签名。
 *
 * Apple Silicon 要求独立分发的 Mach-O 可执行文件带有代码签名，
 * 即使是本地工具也可以使用 ad-hoc 签名（`-`）。没有签名时，
 * macOS 可能在进程启动前直接以 SIGKILL 终止程序。
 */

const fs = require('fs');
const { spawnSync } = require('child_process');

const outputs = process.argv.slice(2);

if (outputs.length === 0) {
    console.error('用法: node scripts/sign-macos.js <macOS 可执行文件> [...]');
    process.exit(1);
}

if (process.platform !== 'darwin') {
    console.warn('⚠️ 当前不是 macOS，跳过本地 codesign。请在 macOS 上构建 ARM64 发布包，或使用 ldid 签名。');
    process.exit(0);
}

for (const output of outputs) {
    if (!fs.existsSync(output)) {
        console.error(`❌ 找不到 macOS 构建产物: ${output}`);
        process.exit(1);
    }

    const result = spawnSync('codesign', ['--force', '--sign', '-', output], {
        stdio: 'inherit',
    });
    if (result.error || result.status !== 0) {
        console.error(`❌ 无法为 macOS 构建产物签名: ${output}`);
        process.exit(result.status || 1);
    }
}

console.log(`✅ 已为 ${outputs.length} 个 macOS 构建产物添加 ad-hoc 签名。`);
