'use strict';

/**
 * 「查看余额」的真机校验：用本机 dsh 的凭据真的请求一次 /user/balance。
 * 只打印金额与来源，不打印密钥。用法：npm run check-balance
 */

require('./stub-electron').install();

const balance = require('../src/balance');

async function main() {
  const resolved = balance.resolveApiKey();
  if (resolved === null) {
    console.error('FAIL  没有找到 DEEPSEEK_API_KEY（启动环境变量 / <DSH_HOME>/.credentials.yaml / <DSH_HOME>/.env）');
    process.exitCode = 1;
    return;
  }
  console.log(`密钥来源：${resolved.source}（长度 ${resolved.value.length}，不回显）`);
  console.log(`查询地址：${balance.baseUrl()}${balance.BALANCE_PATH}`);

  let result;
  try {
    result = await balance.fetchBalance();
  } catch (error) {
    console.error(`FAIL  ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`PASS  ${balance.balanceSummary(result)}`);
  console.log(balance.balanceDetail(result).split('\n').map((line) => `      ${line}`).join('\n'));
  if (result.balance.infos.length === 0) {
    console.error('FAIL  接口没有返回任何币种的余额信息');
    process.exitCode = 1;
  }
}

void main();
