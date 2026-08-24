#!/usr/bin/env node

/**
 * 生成 GitHub Release 上传用的发布包。
 *
 * 为什么不直接上传 macOS / Linux 裸二进制：
 * - 浏览器或 GitHub 下载裸文件时，经常不会保留 POSIX 可执行权限；
 * - macOS Finder 会把失去 +x 权限的文件显示为“文稿”，用户双击/终端运行都会失败；
 * - tar.gz 会保存文件权限，用户解压后仍是可执行文件。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const checksumFile = path.join(distDir, 'SHA256SUMS');

const artifacts = [
    {
        input: 'cursor-chinese-macos-arm64',
        output: 'cursor-chinese-macos-arm64.tar.gz',
        type: 'tar',
        executable: true,
        macos: true,
    },
    {
        input: 'cursor-chinese-macos-x64',
        output: 'cursor-chinese-macos-x64.tar.gz',
        type: 'tar',
        executable: true,
        macos: true,
    },
    {
        input: 'cursor-chinese-linux-arm64',
        output: 'cursor-chinese-linux-arm64.tar.gz',
        type: 'tar',
        executable: true,
    },
    {
        input: 'cursor-chinese-linux-x64',
        output: 'cursor-chinese-linux-x64.tar.gz',
        type: 'tar',
        executable: true,
    },
    {
        input: 'cursor-chinese-win-x64.exe',
        output: 'cursor-chinese-win-x64.zip',
        type: 'zip',
        executable: false,
    },
];

function ensureFile(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`缺少构建产物: ${filePath}`);
    }
}

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: distDir,
        stdio: 'inherit',
        // 避免 macOS tar/zip 写入 AppleDouble 或扩展属性文件，Release 包更干净。
        env: { ...process.env, COPYFILE_DISABLE: '1' },
    });

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} 执行失败`);
    }
}

function sha256(filePath) {
    return crypto
        .createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex');
}

function packageArtifact(artifact) {
    const inputPath = path.join(distDir, artifact.input);
    const outputPath = path.join(distDir, artifact.output);

    ensureFile(inputPath);

    if (artifact.macos && process.platform === 'darwin') {
        // ARM64 未签名时会在 macOS 启动前被 SIGKILL；打包前直接阻止错误产物进入 Release。
        run('codesign', ['--verify', '--verbose=2', inputPath]);
    }

    if (artifact.executable) {
        // 先修正本地权限，再进入 tar.gz；tar 会把这个权限保存到压缩包里。
        fs.chmodSync(inputPath, 0o755);
    }

    if (fs.existsSync(outputPath)) {
        fs.rmSync(outputPath);
    }

    if (artifact.type === 'tar') {
        run('tar', ['-czf', artifact.output, artifact.input]);
    } else if (artifact.type === 'zip') {
        run('zip', ['-j', '-q', artifact.output, artifact.input]);
    } else {
        throw new Error(`未知打包类型: ${artifact.type}`);
    }

    const stat = fs.statSync(outputPath);
    return {
        file: artifact.output,
        hash: sha256(outputPath),
        sizeMb: (stat.size / 1024 / 1024).toFixed(1),
    };
}

function main() {
    if (!fs.existsSync(distDir)) {
        throw new Error('缺少 dist 目录，请先运行 npm run build');
    }

    const results = artifacts.map(packageArtifact);
    const sums = results
        .map((item) => `${item.hash}  ${item.file}`)
        .join('\n') + '\n';

    fs.writeFileSync(checksumFile, sums, 'utf8');

    console.log('\n✅ Release 发布包已生成：');
    for (const item of results) {
        console.log(`  - dist/${item.file} (${item.sizeMb} MB)`);
    }
    console.log('  - dist/SHA256SUMS');
    console.log('\n上传 GitHub Release 时，请上传这些 .tar.gz / .zip 文件，不要上传 macOS/Linux 裸二进制。');
}

try {
    main();
} catch (err) {
    console.error(`\n❌ 生成发布包失败: ${err.message}`);
    process.exit(1);
}
