'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');

/**
 * DeepSeek 账户余额查询。
 *
 * 密钥不另存一份，直接沿用 dsh 自己的凭据：读得到就能查，读不到就明确告诉用户去哪儿填。
 * 查找顺序与 dsh-credentials-local 保持一致（启动环境 > 凭据文件 > DSH_HOME/.env）；
 * dsh 桌面端没有"项目目录"的概念，所以不查 `<cwd>/.env`。
 *
 * 密钥只进请求头，不写日志、不进任何落盘文件。
 */

/** 与 dsh 运行时同一个约定：$DEEPSEEK_BASE_URL 优先，否则官方地址。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const BALANCE_PATH = '/user/balance';
const DEFAULT_TIMEOUT_MS = 15000;

const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

/** 去掉 YAML / dotenv 里常见的成对引号。 */
function unquote(value) {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

/**
 * 取 `.credentials.yaml` 里 `refs:` 段的键值。
 * 只认顶层 `refs:` 下缩进一层的 `NAME: value`：API Key 不会是空值、也不会是多行值，
 * 为这点需求引一个 YAML 依赖不划算。
 */
function parseCredentialRefs(text) {
  const refs = {};
  let inRefs = false;
  for (const raw of String(text).split(/\r?\n/u)) {
    if (/^refs:\s*$/u.test(raw)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    // 回到顶层（records: 等）说明 refs 段结束了。
    if (/^\S/u.test(raw)) break;
    const matched = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(raw);
    if (matched === null) continue;
    refs[matched[1]] = unquote(matched[2].trim());
  }
  return refs;
}

/** 取 dotenv 文件里的键值（只认 `NAME=value`，忽略注释与空行）。 */
function parseEnvFile(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const matched = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (matched === null) continue;
    values[matched[1]] = unquote(matched[2].trim());
  }
  return values;
}

function readFileIfAny(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/** 找一次 API Key，返回 { value, source }；找不到返回 null。source 会展示给用户看。 */
function resolveApiKey() {
  const fromEnv = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (fromEnv !== '') return { value: fromEnv, source: '启动环境变量 DEEPSEEK_API_KEY' };

  const credentialsPath = path.join(config.dshHome(), '.credentials.yaml');
  const credentials = readFileIfAny(credentialsPath);
  if (credentials !== null) {
    const value = (parseCredentialRefs(credentials).DEEPSEEK_API_KEY ?? '').trim();
    if (value !== '') return { value, source: `凭据文件 ${credentialsPath}` };
  }

  const envPath = path.join(config.dshHome(), '.env');
  const envFile = readFileIfAny(envPath);
  if (envFile !== null) {
    const value = (parseEnvFile(envFile).DEEPSEEK_API_KEY ?? '').trim();
    if (value !== '') return { value, source: `环境文件 ${envPath}` };
  }

  return null;
}

/** `$DEEPSEEK_BASE_URL`（与 dsh 运行时一致）或官方地址，去掉结尾斜杠。 */
function baseUrl() {
  const configured = (process.env.DEEPSEEK_BASE_URL ?? '').trim();
  return (configured === '' ? DEFAULT_BASE_URL : configured).replace(/\/+$/u, '');
}

/** 把接口返回体转成展示用的结构；字段缺失只当空值，不抛错。 */
function parseBalanceResponse(payload) {
  if (payload === null || typeof payload !== 'object') throw new Error('接口返回的不是 JSON 对象');
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    // 只在明确返回 false 时才当"不可用"：字段缺失但查得到明细，不该报成账户异常。
    isAvailable: payload.is_available !== false,
    infos: infos.map((info) => ({
      currency: text(info?.currency),
      totalBalance: text(info?.total_balance),
      grantedBalance: text(info?.granted_balance),
      toppedUpBalance: text(info?.topped_up_balance),
    })),
  };
}

/** 金额带上币种符号；不认识的币种退回「金额 币种」。 */
function formatAmount(currency, amount) {
  if (amount === '') return '—';
  const symbol = CURRENCY_SYMBOLS[currency];
  if (symbol !== undefined) return `${symbol}${amount}`;
  return `${amount} ${currency}`.trim();
}

/** 弹窗标题行：一句话说清现在有多少钱。 */
function balanceSummary(result) {
  const first = result.balance.infos[0];
  if (first === undefined) {
    return result.balance.isAvailable ? '账户可用，但接口没有返回余额明细' : '账户不可用';
  }
  return `总余额 ${formatAmount(first.currency, first.totalBalance)}`;
}

/** 弹窗正文：每个币种一段，附上密钥来源与查询时间，便于自查"用的是哪把钥匙"。 */
function balanceDetail(result) {
  const lines = [`账户状态：${result.balance.isAvailable ? '可用' : '不可用（余额不足或账户异常）'}`];
  for (const info of result.balance.infos) {
    lines.push(
      `${info.currency || '未知币种'} 总余额 ${formatAmount(info.currency, info.totalBalance)}`,
      `    充值余额 ${formatAmount(info.currency, info.toppedUpBalance)}　赠金余额 ${formatAmount(info.currency, info.grantedBalance)}`,
    );
  }
  if (result.balance.infos.length === 0) lines.push('接口没有返回任何币种的余额信息。');
  lines.push('', `密钥来源：${result.keySource}`, `查询时间：${result.fetchedAt}`);
  return lines.join('\n');
}

/** 把 HTTP 状态码翻成用户能看懂的一句话。 */
function httpErrorMessage(status, body) {
  const snippet = String(body).slice(0, 200).replace(/\s+/gu, ' ').trim();
  if (status === 401) return '密钥无效或已过期（HTTP 401），请在 dsh 设置里重新填写 API Key。';
  if (status === 402) return '账户余额不足（HTTP 402）。';
  if (status === 403) return '这把密钥没有查询余额的权限（HTTP 403）。';
  if (status === 429) return '请求太频繁（HTTP 429），稍后再试。';
  return `接口返回 HTTP ${status}${snippet === '' ? '' : `：${snippet}`}`;
}

/**
 * 查一次余额。
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - 便于测试替换，默认用全局 fetch
 * @param {number} [options.timeoutMs]
 */
async function fetchBalance(options = {}) {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const resolved = resolveApiKey();
  if (resolved === null) {
    const error = new Error('没有找到 DeepSeek API Key');
    error.code = 'NO_KEY';
    throw error;
  }

  const url = `${baseUrl()}${BALANCE_PATH}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${resolved.value}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接 ${baseUrl()}：${reason}`);
  }

  const body = await response.text();
  if (!response.ok) throw new Error(httpErrorMessage(response.status, body));

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('接口返回的不是合法 JSON');
  }

  return {
    balance: parseBalanceResponse(payload),
    keySource: resolved.source,
    fetchedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
}

module.exports = {
  BALANCE_PATH,
  DEFAULT_BASE_URL,
  baseUrl,
  balanceDetail,
  balanceSummary,
  fetchBalance,
  formatAmount,
  parseBalanceResponse,
  parseCredentialRefs,
  parseEnvFile,
  resolveApiKey,
};
