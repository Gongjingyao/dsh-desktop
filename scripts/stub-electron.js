'use strict';

/**
 * 给纯逻辑脚本用的 Electron 桩。
 * src/config 等模块依赖 electron 的 app 对象；这里顶上一个假的，
 * 脚本就不必真的启动（或下载）Electron。用法：require('./stub-electron').install()
 */

const Module = require('node:module');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

function install() {
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
}

module.exports = { install, projectRoot };
