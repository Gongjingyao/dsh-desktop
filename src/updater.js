'use strict';

const config = require('./config');
const runtime = require('./runtime');

/** 应用自身的更新源：留空表示未配置，此时只检查 dsh 运行时更新。 */
const APP_UPDATE_FEED = process.env.DSH_DESKTOP_UPDATE_FEED || '';

function appVersion() {
  return config.appVersion();
}

/**
 * 检查 dsh 运行时是否有新版本。
 * 未安装时同样返回结果，调用方据此决定是否走首次安装流程。
 */
async function checkRuntime() {
  const current = runtime.installedVersion();
  const { version: latest, registry } = await runtime.fetchLatestVersion();
  const updateAvailable = current === null || runtime.compareVersions(latest, current) > 0;
  return { current, latest, registry, updateAvailable };
}

/**
 * 检查桌面客户端自身是否有新版本。
 * 模板走通用 HTTP 源，需要发布方托管 `latest.yml`；未配置时返回 configured:false，不报错。
 */
async function checkApp() {
  const current = appVersion();
  if (APP_UPDATE_FEED === '') {
    return { configured: false, current, latest: null, updateAvailable: false };
  }
  const feedUrl = `${APP_UPDATE_FEED.replace(/\/$/, '')}/latest.yml`;
  const response = await fetch(feedUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`更新源返回 HTTP ${response.status}`);
  const text = await response.text();
  const match = /^version:\s*(.+)$/m.exec(text);
  const latest = match?.[1]?.trim() ?? null;
  if (latest === null) throw new Error('更新源缺少 version 字段');
  return {
    configured: true,
    current,
    latest,
    updateAvailable: runtime.compareVersions(latest, current) > 0,
    feedUrl,
  };
}

/**
 * 执行一次完整检查：运行时 + 客户端。
 * @param {(line:string)=>void} onLine
 */
async function checkAll(onLine) {
  const result = { app: null, runtime: null, errors: [] };
  try {
    result.runtime = await checkRuntime();
  } catch (error) {
    result.errors.push(`检查 dsh 版本失败：${error.message}`);
  }
  try {
    result.app = await checkApp();
  } catch (error) {
    result.errors.push(`检查客户端版本失败：${error.message}`);
  }
  for (const line of result.errors) onLine?.(line);
  return result;
}

module.exports = { APP_UPDATE_FEED, checkRuntime, checkApp, checkAll };
