'use strict';

/**
 * 把 assets/logo.png 转成 Windows 用的多尺寸 build/icon.ico。
 *
 * 为什么不直接改后缀：electron-builder 打包 Windows 安装包时必须拿到真正的
 * ICO（内含 16/32/48/64/128/256 多档位），否则任务栏与安装向导会糊。
 * 这里自带 PNG 解码与缩放，不引入额外依赖。
 *
 * 用法：node scripts/make-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const projectRoot = path.join(__dirname, '..');
const sourcePng = path.join(projectRoot, 'assets', 'logo.png');
const targetIco = path.join(projectRoot, 'build', 'icon.ico');
const ICON_SIZES = [256, 128, 64, 48, 32, 16];

/** 读取一块 IHDR 字段。 */
function readHeader(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

/**
 * 解码 PNG 为 RGBA 像素。
 * 只支持本仓库 logo 用到的 8 位真彩 + alpha（colorType 6）；遇到其它格式直接报错，
 * 而不是悄悄产出一张错图。
 */
function decodePng(buffer) {
  const header = readHeader(buffer);
  if (header.bitDepth !== 8 || header.colorType !== 6) {
    throw new Error(`仅支持 8 位 RGBA 的 PNG，当前 bitDepth=${header.bitDepth} colorType=${header.colorType}`);
  }
  if (header.interlace !== 0) throw new Error('不支持隔行扫描 PNG');

  const { width, height } = header;
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;

  const idat = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    if (type === 'IDAT') idat.push(buffer.subarray(start, start + length));
    if (type === 'IEND') break;
    offset = start + length + 4;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const pixels = Buffer.alloc(height * stride);
  let readOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[readOffset];
    readOffset += 1;
    const line = raw.subarray(readOffset, readOffset + stride);
    readOffset += stride;
    const outStart = y * stride;
    const priorStart = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? pixels[outStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[priorStart + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[priorStart + x - bytesPerPixel] : 0;
      let value = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += up;
          break;
        case 3:
          value += (left + up) >> 1;
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const dLeft = Math.abs(estimate - left);
          const dUp = Math.abs(estimate - up);
          const dUpLeft = Math.abs(estimate - upLeft);
          value += dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
          break;
        }
        default:
          throw new Error(`未知的 PNG 行过滤器：${filter}`);
      }
      pixels[outStart + x] = value & 0xff;
    }
  }

  return { width, height, pixels };
}

/**
 * 面积平均缩放：图标全部是缩小，按源像素覆盖率加权平均，
 * 比最近邻干净得多（边缘不会出现锯齿块）。
 */
function resize(source, size) {
  const output = Buffer.alloc(size * size * 4);
  const scaleX = source.width / size;
  const scaleY = source.height / size;

  for (let y = 0; y < size; y += 1) {
    const sourceTop = y * scaleY;
    const sourceBottom = Math.min((y + 1) * scaleY, source.height);
    for (let x = 0; x < size; x += 1) {
      const sourceLeft = x * scaleX;
      const sourceRight = Math.min((x + 1) * scaleX, source.width);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(sourceTop); sy < Math.ceil(sourceBottom); sy += 1) {
        const coverageY = Math.min(sy + 1, sourceBottom) - Math.max(sy, sourceTop);
        if (coverageY <= 0) continue;
        for (let sx = Math.floor(sourceLeft); sx < Math.ceil(sourceRight); sx += 1) {
          const coverageX = Math.min(sx + 1, sourceRight) - Math.max(sx, sourceLeft);
          if (coverageX <= 0) continue;
          const area = coverageX * coverageY;
          const index = (sy * source.width + sx) * 4;
          // 先乘 alpha 再平均，避免透明像素把颜色拉黑（预乘）。
          const alpha = source.pixels[index + 3];
          r += source.pixels[index] * alpha * area;
          g += source.pixels[index + 1] * alpha * area;
          b += source.pixels[index + 2] * alpha * area;
          a += alpha * area;
          weight += area;
        }
      }

      const outIndex = (y * size + x) * 4;
      if (weight === 0 || a === 0) continue;
      output[outIndex] = Math.round(r / a);
      output[outIndex + 1] = Math.round(g / a);
      output[outIndex + 2] = Math.round(b / a);
      output[outIndex + 3] = Math.round(a / weight);
    }
  }

  return output;
}

/** PNG 的 CRC32 查表，只算一次。 */
const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** 把 RGBA 像素编码成 PNG（Vista 起 ICO 允许直接内嵌 PNG）。 */
function encodePng(rgba, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([head.subarray(4), data])) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([head, data, tail]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let payloadOffset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    directory[entry] = image.size >= 256 ? 0 : image.size; // 256 记作 0
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // 调色板数
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4); // 色彩平面
    directory.writeUInt16LE(32, entry + 6); // 位深
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(payloadOffset, entry + 12);
    payloadOffset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

const source = decodePng(fs.readFileSync(sourcePng));
console.log(`源图 ${source.width}x${source.height}`);
const images = ICON_SIZES.map((size) => ({ size, png: encodePng(resize(source, size), size) }));
fs.mkdirSync(path.dirname(targetIco), { recursive: true });
fs.writeFileSync(targetIco, buildIco(images));
console.log(`已生成 ${targetIco}（${ICON_SIZES.join('/')}，共 ${(fs.statSync(targetIco).size / 1024).toFixed(1)} KB）`);

// 托盘图标要一张独立的 32x32 PNG：Tray 用 PNG 最省事，尺寸也正好贴合系统托盘。
// 必须放在 assets/ 下：electron-builder 只把 assets 打进包，build/ 是构建资源目录。
const trayIconPath = path.join(projectRoot, 'assets', 'icon-32.png');
fs.writeFileSync(trayIconPath, images.find((image) => image.size === 32).png);
console.log(`已生成托盘图标 ${trayIconPath}`);

// `--preview-256 <路径>`：导出 ICO 里最大的那一档，便于肉眼确认缩放结果没糊。
const previewIndex = process.argv.indexOf('--preview-256');
if (previewIndex !== -1) {
  const previewPath = process.argv[previewIndex + 1] || path.join(projectRoot, 'build', 'icon-preview-256.png');
  fs.writeFileSync(previewPath, images[0].png);
  console.log(`已导出预览：${previewPath}`);
}
