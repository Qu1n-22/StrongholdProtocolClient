// 解 `.tar.gz` —— 代码增量包就是它，而这一版刻意**不加 npm 依赖**：
// `desktop/package.json` 的 `build.files` 逐个列出要打进安装器的文件并排除了 `node_modules`，
// 加一个 `tar` 包就得把依赖树也一起放开。系统 `tar` 也不能指望（Windows 上有没有 `tar.exe` 随版本变）。
// 所以这里是 zlib（Node 内置）+ 一段 USTAR 解析：够用、可测、没有依赖。
//
// 输入与输出都是 Buffer / 纯数据 —— 不碰文件系统。写到哪里由 updater.mjs 决定，
// 于是「解出来对不对」可以在测试里直接断言，不必真的落盘。

import { gunzipSync } from 'node:zlib';
import { resolve, sep } from 'node:path';

export const HEADER_SIZE = 512;

/** Tar 的数值字段是八进制字符串（前导空格/0，可能带 NUL）。 */
export function readOctal(header, start, length) {
  const raw = header.subarray(start, start + length).toString('latin1').replace(/[^0-7]/g, '');
  if (!raw) return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

export function readString(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return (end === -1 ? raw : raw.subarray(0, end)).toString('utf8');
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/**
 * 解析一个未压缩的 tar 流。
 *
 * 认 USTAR 三件事：普通文件（typeflag `0` 或 `\0`）、GNU 长名（typeflag `L`）、
 * pax 扩展头（typeflag `x`）—— GNU tar 打长路径会用到后两种，只认标准 ustar 会把
 * 一部分文件静默丢掉，而"少解了几个文件"正是自动更新里最难查的坏法。
 * 目录（typeflag `5`）与其余类型跳过：解包时按文件路径 mkdir -p 就够了。
 *
 * @param {Buffer} buf 未压缩的 tar 字节
 * @returns {{ name: string, data: Buffer }[]} 只含普通文件
 */
export function untar(buf) {
  const out = [];
  let off = 0;
  let longName = '';
  let paxPath = '';

  while (off + HEADER_SIZE <= buf.length) {
    const header = buf.subarray(off, off + HEADER_SIZE);
    // tar 结尾是两个全零块；提前遇到就收（有些打包器不补齐，遇到就当结束）。
    if (isZeroBlock(header)) break;

    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]) || '\0';
    const prefix = readString(header, 345, 155);
    off += HEADER_SIZE;

    const data = buf.subarray(off, off + size);
    // 数据块按 512 对齐；size 为 0 时也要跳过头之后的 0 字节（对齐到下一块）。
    off += Math.ceil(size / HEADER_SIZE) * HEADER_SIZE;

    if (typeflag === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (typeflag === 'K') { continue; } // GNU 长链接名：我们不解软链
    if (typeflag === 'x' || typeflag === 'X') {
      // pax 记录形如 "30 path=js/main.js\n" —— 前面的数字是这个记录自身的长度。
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) paxPath = m[1];
      continue;
    }
    if (typeflag === 'g') { continue; } // pax 全局头

    const full = paxPath || longName || (prefix ? `${prefix}/${name}` : name);
    longName = '';
    paxPath = '';
    if (!full) continue;
    if (typeflag === '5') continue; // 目录：写文件时按需创建
    if (typeflag !== '0' && typeflag !== '\0') continue; // 硬链/软链/设备：这一版不需要

    out.push({ name: full, data: Buffer.from(data) });
  }
  return out;
}

/** 一步到位：`.tar.gz` 字节 → 文件列表。 */
export function untarGzip(gzBuf) {
  return untar(gunzipSync(gzBuf));
}

/**
 * 落盘前的路径安全检查：tar 里的名字可能被做成 `../../evil`，
 * 解包时若不拦，一个坏包就能写穿到 payload 目录之外（tar slip）。
 * @param {string} name tar 内的路径
 * @param {string} dest 目标根目录
 * @returns {string|null} 可以写的绝对路径；null = 应当跳过
 */
export function safeJoin(name, dest) {
  const target = resolve(dest, name);
  const root = resolve(dest);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}
