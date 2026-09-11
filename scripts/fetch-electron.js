'use strict';

/**
 * 显式下载并解压 Electron 运行时到 build/electron-dist。
 *
 * 为什么不用 npm 的 postinstall：受限环境下 @electron/get 会静默失败，
 * 而且它的缓存写在用户目录。这里把二进制放进工程内，构建可重复、可离线复用。
 *
 * 用法：node scripts/fetch-electron.js [版本] [平台架构]
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const version = process.argv[2] || require(path.join(projectRoot, 'package.json')).devDependencies.electron;
const target = process.argv[3] || 'win32-x64';
const distDir = path.join(projectRoot, 'build', 'electron-dist');
const zipPath = path.join(projectRoot, 'build', `electron-v${version}-${target}.zip`);

const MIRRORS = [
  `https://registry.npmmirror.com/-/binary/electron/${version}/electron-v${version}-${target}.zip`,
  `https://npmmirror.com/mirrors/electron/${version}/electron-v${version}-${target}.zip`,
  `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${target}.zip`,
];

function sevenZip() {
  const candidates = [
    path.join(projectRoot, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(projectRoot, 'node_modules', '7zip-bin', 'win', '7za.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function download() {
  if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 100 * 1024 * 1024) {
    console.log(`已存在安装包，跳过下载：${zipPath}`);
    return;
  }
  let lastError = null;
  for (const url of MIRRORS) {
    try {
      console.log(`下载 ${url}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(1800000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(zipPath), { recursive: true });
      fs.writeFileSync(zipPath, buffer);
      console.log(`已保存 ${(buffer.length / 1024 / 1024).toFixed(1)} MB → ${zipPath}`);
      return;
    } catch (error) {
      lastError = error;
      console.log(`该镜像失败：${error.message}`);
    }
  }
  throw new Error(`下载 Electron 失败：${lastError?.message ?? '未知错误'}`);
}

function extract() {
  if (fs.existsSync(path.join(distDir, 'electron.exe'))) {
    console.log(`已解压，跳过：${distDir}`);
    return;
  }
  const sevenZipPath = sevenZip();
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  if (sevenZipPath !== null) {
    const result = spawnSync(sevenZipPath, ['x', zipPath, `-o${distDir}`, '-y'], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`7za 解压失败，退出码 ${result.status}`);
  } else {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${distDir}' -Force`],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) throw new Error(`Expand-Archive 解压失败，退出码 ${result.status}`);
  }

  if (!fs.existsSync(path.join(distDir, 'electron.exe'))) throw new Error('解压后未找到 electron.exe');
  console.log(`Electron ${version} 已就绪：${distDir}`);
}

(async () => {
  await download();
  extract();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
