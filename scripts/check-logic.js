'use strict';

/**
 * 纯逻辑自检：不启动任何子进程，专门校验版本比较与 URL 识别这两处易错逻辑。
 * 用法：node scripts/check-logic.js
 */

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

// src/runtime 会间接加载 src/config，而 config 依赖 electron 的 app 对象。
// 纯逻辑校验不需要真的 Electron，用桩顶上即可（也避免它去下载二进制）。
const projectRoot = path.join(__dirname, '..');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getVersion: () => require(path.join(projectRoot, 'package.json')).version,
        getPath: () => projectRoot,
        getAppPath: () => projectRoot,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

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

assert.strictEqual(failed, 0, `有 ${failed} 项逻辑校验失败`);
console.log('\n逻辑校验全部通过');
