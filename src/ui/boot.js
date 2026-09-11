'use strict';

/**
 * 引导页渲染逻辑：只做状态展示，不做任何决策。
 * 所有状态与日志都由主进程通过 preload 暴露的接口推过来。
 */

const elements = {
  subtitle: document.getElementById('subtitle'),
  bar: document.getElementById('bar'),
  barFill: document.getElementById('bar-fill'),
  percent: document.getElementById('percent'),
  message: document.getElementById('message'),
  detail: document.getElementById('detail'),
  error: document.getElementById('error'),
  versionDsh: document.getElementById('version-dsh'),
  versionApp: document.getElementById('version-app'),
  btnRetry: document.getElementById('btn-retry'),
  btnCloseAction: document.getElementById('btn-close-action'),
  btnLogs: document.getElementById('btn-logs'),
  btnDetails: document.getElementById('btn-details'),
  log: document.getElementById('log'),
};

let logLines = [];

function show(element, visible) {
  element.hidden = !visible;
}

function render(state) {
  const percent = typeof state.percent === 'number' ? Math.max(0, Math.min(100, state.percent)) : 0;
  elements.barFill.style.width = `${percent}%`;
  elements.percent.textContent = `${Math.round(percent)}%`;
  // 只有真正拿到进度百分比时才显示确定进度，否则用滚动条纹表示"还在推进"。
  elements.bar.classList.toggle('indeterminate', percent <= 0);

  show(elements.error, Boolean(state.error));
  show(elements.detail, Boolean(state.detail));
  show(elements.btnRetry, state.status === 'failed');

  if (state.message) elements.message.textContent = state.message;
  if (state.detail) elements.detail.textContent = state.detail;
  if (state.error) elements.error.textContent = state.error;

  if (state.installedVersion) elements.versionDsh.textContent = `dsh：${state.installedVersion}`;
  else if (state.status === 'installing') elements.versionDsh.textContent = 'dsh：安装中…';
  if (state.appVersion) elements.versionApp.textContent = `客户端：${state.appVersion}`;

  if (state.status === 'ready') {
    elements.subtitle.textContent = '运行环境已就绪，正在载入界面…';
    elements.message.textContent = state.message || '正在打开界面…';
  }
}

/** 日志区只在展开时更新，避免长日志拖慢引导页。 */
function renderLog() {
  if (elements.log.hidden) return;
  elements.log.textContent = logLines.slice(-400).join('\n');
  elements.log.scrollTop = elements.log.scrollHeight;
}

window.dshDesktop.onState(render);
window.dshDesktop.onLog((line) => {
  logLines.push(line);
  renderLog();
});

elements.btnRetry.addEventListener('click', () => window.dshDesktop.action('retry'));
elements.btnCloseAction.addEventListener('click', () => window.dshDesktop.action('choose-close-action'));
elements.btnLogs.addEventListener('click', () => window.dshDesktop.action('open-logs'));
elements.btnDetails.addEventListener('click', () => {
  elements.log.hidden = !elements.log.hidden;
  elements.btnDetails.textContent = elements.log.hidden ? '显示日志' : '隐藏日志';
  renderLog();
});

window.dshDesktop.info().then((info) => {
  elements.versionDsh.textContent = `dsh：${info.dshVersion ?? '未安装'}`;
  elements.versionApp.textContent = `客户端：${info.appVersion}`;
  elements.subtitle.textContent = `数据目录：${info.dataRoot}`;
});
