'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 引导页只需要三件事：订阅状态、上报日志、触发动作。
 * 不向渲染进程暴露任何 Node 能力。
 */
contextBridge.exposeInMainWorld('dshDesktop', {
  /** 主进程推送的引导状态。 */
  onState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('boot:state', wrapped);
    return () => ipcRenderer.removeListener('boot:state', wrapped);
  },
  /** 引导过程中的日志行。 */
  onLog: (listener) => {
    const wrapped = (_event, line) => listener(line);
    ipcRenderer.on('boot:log', wrapped);
    return () => ipcRenderer.removeListener('boot:log', wrapped);
  },
  /** 用户点击「重试 / 立即更新 / 跳过」。 */
  action: (name) => ipcRenderer.invoke('boot:action', name),
  /** 读取版本与路径信息，用于「关于」。 */
  info: () => ipcRenderer.invoke('boot:info'),
});
