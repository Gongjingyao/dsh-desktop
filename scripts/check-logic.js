'use strict';

/**
 * 纯逻辑自检：不启动任何子进程，专门校验版本比较与 URL 识别这两处易错逻辑。
 * 用法：node scripts/check-logic.js
 */

const assert = require('node:assert');

// src/config 依赖 electron 的 app 对象，纯逻辑校验用桩顶上（也避免它去下载二进制）。
require('./stub-electron').install();

const { compareVersions } = require('../src/runtime');

const cases = [
  // [左, 右, 期望符号]
  ['0.1.5-rc.2', '0.1.5-rc.1', 1],
  ['0.1.5-rc.1', '0.1.5-rc.1', 0],
  ['0.1.5', '0.1.5-rc.1', 1],
  ['0.1.5-rc.1', '0.1.5', -1],
  ['0.1.6', '0.1.5', 1],
  ['0.2.0', '0.1.9', 1],
  ['1.0.0', '0.9.9', 1],
  ['0.1.5-rc.10', '0.1.5-rc.9', 1],
  ['0.1.5-rc.1', '0.1.5-alpha.9', 1],
  ['0.1.5-alpha.1', '0.1.5-alpha.1', 0],
];

let failed = 0;
for (const [left, right, expected] of cases) {
  const actual = Math.sign(compareVersions(left, right));
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  compare(${left}, ${right}) = ${actual}，期望 ${expected}`);
}

// 就绪行识别：dsh 打印的格式必须能被解析出干净 URL（token 不带尾部空格/括号）。
const WEB_URL_PATTERN = /dsh web:\s*(http:\/\/\S+)/;
const samples = [
  ['dsh web: http://127.0.0.1:51234/?token=abcDEF_-123', 'http://127.0.0.1:51234/?token=abcDEF_-123'],
  ['dsh web: http://127.0.0.1:51234/?token=abc (LAN: http://192.168.1.2:51234/?token=abc)', 'http://127.0.0.1:51234/?token=abc'],
];
for (const [line, expected] of samples) {
  const actual = WEB_URL_PATTERN.exec(line)?.[1] ?? '';
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  parse(${JSON.stringify(line.slice(0, 40))}…) = ${JSON.stringify(actual)}`);
}

// 运行时补丁：把上游「建进程时不隐藏控制台窗口」的文件改对，且必须可重复执行。
const { applyConsoleHidePatch, PATCH_MARKER } = require('../src/runtime-patch');

// 上游 dsh-win32-process 的真实形态（两处 STARTUPINFO + 一处结构体定义）。
const upstreamSource = [
  'import koffi from "koffi";',
  '/** Win32 code reporting a caller-provided buffer is too small. */',
  'const ERROR_INSUFFICIENT_BUFFER = 122;',
  'const STARTUPINFOW = koffi.struct("DSH_STARTUPINFOW", {',
  '\tcb: "uint32",',
  '\tdwFlags: "uint32",',
  '\twShowWindow: "uint16"',
  '});',
  'function spawnPipedProcess(api, options) {',
  '\tencodeStartupInfo(startupInfo, {',
  '\t\tcb: 104,',
  '\t\tdwFlags: 256,',
  '\t\thStdInput: stdIn.read',
  '\t});',
  '}',
  'function spawnJobProcess(api, options) {',
  '\tencodeStartupInfo(startupInfo, {',
  '\t\tcb: 104,',
  '\t\tdwFlags: 256,',
  '\t\thStdInput: stdio.stdin',
  '\t});',
  '}',
  '',
].join('\n');

const patchCases = [
  [
    '上游文件被改成隐藏窗口',
    () => {
      const first = applyConsoleHidePatch(upstreamSource);
      return (
        first.changed &&
        (first.text.match(/dwFlags: 256 \| STARTF_USESHOWWINDOW, wShowWindow: SW_HIDE,/g) ?? []).length === 2 &&
        first.text.includes('const STARTF_USESHOWWINDOW = 1;') &&
        // 结构体里的 dwFlags 类型定义不能被误伤
        first.text.includes('\tdwFlags: "uint32",')
      );
    },
  ],
  [
    '重复执行不再改动（幂等）',
    () => {
      const once = applyConsoleHidePatch(upstreamSource);
      const twice = applyConsoleHidePatch(once.text);
      return twice.changed === false && twice.reason === 'already' && twice.text === once.text;
    },
  ],
  [
    '没有 STARTUPINFO 的文件不动它',
    () => applyConsoleHidePatch('import koffi from "koffi";\nconst a = 1;\n').reason === 'no-startupinfo',
  ],
  [
    '陌生文件直接放弃',
    () => applyConsoleHidePatch('const a = 1;\n').reason === 'unrecognized',
  ],
  ['补丁标记存在', () => PATCH_MARKER === 'STARTF_USESHOWWINDOW'],
];
for (const [name, run] of patchCases) {
  const ok = run();
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  运行时补丁：${name}`);
}

// —— 「查看余额」的纯逻辑：凭据解析、密钥查找顺序、返回值格式化 ——
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const balance = require('../src/balance');

// 与 dsh-credentials-local 写出来的文档同形：refs 之外还有 records 段，不能被误读成密钥。
const credentialsSample = [
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-file-key',
  '  # 注释行要被忽略',
  "  OTHER_KEY: 'quoted-value'",
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      secret: should-not-be-read',
  '',
].join('\n');

const cnyInfo = {
  currency: 'CNY',
  total_balance: '49.22',
  granted_balance: '0.00',
  topped_up_balance: '49.22',
};

const balanceCases = [
  [
    '凭据文件只解析 refs 段',
    () => {
      const refs = balance.parseCredentialRefs(credentialsSample);
      return (
        refs.DEEPSEEK_API_KEY === 'sk-file-key' &&
        refs.OTHER_KEY === 'quoted-value' &&
        refs.secret === undefined &&
        Object.keys(refs).length === 2
      );
    },
  ],
  [
    'dotenv 解析（含 export 与引号）',
    () => {
      const values = balance.parseEnvFile('# 注释\nexport DEEPSEEK_API_KEY="sk-env-file"\nOTHER=1\n');
      return values.DEEPSEEK_API_KEY === 'sk-env-file' && values.OTHER === '1';
    },
  ],
  [
    '余额返回体解析',
    () => {
      const parsed = balance.parseBalanceResponse({ is_available: true, balance_infos: [cnyInfo] });
      return parsed.isAvailable && parsed.infos.length === 1 && parsed.infos[0].totalBalance === '49.22';
    },
  ],
  [
    '字段缺失不当成账户不可用',
    () => balance.parseBalanceResponse({ balance_infos: [] }).isAvailable === true,
  ],
  [
    'is_available:false 视为不可用',
    () => balance.parseBalanceResponse({ is_available: false, balance_infos: [] }).isAvailable === false,
  ],
  [
    '金额带币种符号',
    () =>
      balance.formatAmount('CNY', '49.22') === '¥49.22' &&
      balance.formatAmount('USD', '1.00') === '$1.00' &&
      balance.formatAmount('CNY', '') === '—',
  ],
  [
    '弹窗文案含总余额与明细',
    () => {
      const result = {
        balance: balance.parseBalanceResponse({ is_available: true, balance_infos: [cnyInfo] }),
        keySource: '凭据文件 <path>',
        fetchedAt: '2026-01-01 00:00:00',
      };
      const detail = balance.balanceDetail(result);
      return (
        balance.balanceSummary(result) === '总余额 ¥49.22' &&
        detail.includes('充值余额 ¥49.22') &&
        detail.includes('赠金余额 ¥0.00') &&
        detail.includes('密钥来源：凭据文件 <path>')
      );
    },
  ],
];
for (const [name, run] of balanceCases) {
  const ok = run();
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  余额：${name}`);
}

// 密钥查找顺序：启动环境变量 > 凭据文件 > DSH_HOME/.env（与 dsh-credentials-local 一致）。
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-balance-check-'));
const previousHome = process.env.DSH_DESKTOP_HOME;
const previousKey = process.env.DEEPSEEK_API_KEY;
try {
  process.env.DSH_DESKTOP_HOME = fakeHome;
  delete process.env.DEEPSEEK_API_KEY;
  fs.writeFileSync(path.join(fakeHome, '.env'), 'DEEPSEEK_API_KEY=sk-from-dotenv\n', 'utf8');
  const fromDotenv = balance.resolveApiKey();
  fs.writeFileSync(path.join(fakeHome, '.credentials.yaml'), credentialsSample, 'utf8');
  const fromFile = balance.resolveApiKey();
  process.env.DEEPSEEK_API_KEY = 'sk-from-env';
  const fromEnv = balance.resolveApiKey();
  fs.rmSync(path.join(fakeHome, '.credentials.yaml'));
  fs.rmSync(path.join(fakeHome, '.env'));
  delete process.env.DEEPSEEK_API_KEY;
  const none = balance.resolveApiKey();

  const ok =
    fromDotenv?.value === 'sk-from-dotenv' &&
    fromDotenv.source.includes('.env') &&
    fromFile?.value === 'sk-file-key' &&
    fromFile.source.includes('.credentials.yaml') &&
    fromEnv?.value === 'sk-from-env' &&
    none === null;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  余额：密钥查找顺序（环境变量 > 凭据文件 > .env > 无）`);
} finally {
  if (previousHome === undefined) delete process.env.DSH_DESKTOP_HOME;
  else process.env.DSH_DESKTOP_HOME = previousHome;
  if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = previousKey;
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

assert.strictEqual(failed, 0, `有 ${failed} 项逻辑校验失败`);
console.log('\n逻辑校验全部通过');
