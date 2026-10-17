// 通用客户端的核心：游戏本体不再烤进安装包，改成**运行时从所连的那台服务器取 + 本地缓存**。
//
// 为什么（docs/HANDSOFF.md §2）：今天每次上游发版要重发六个 800 MB 的安装包，而六份里五份是同一份游戏内容的
// 重复字节 —— 网页版之所以"永远是最新的"，正因为它从来不带本体，是从服务器取的。这里把网页版那个性质搬到
// 桌面壳上，同时补掉它的缺点：立绘每次重下（→ 缓存）、要联网（→ 离线退回已知最新的那份）。
//
// 版本怎么定：服务端早就算了一个 `build` 指纹（`server/http/buildTag.js`：它服务的那些文件的 size+mtime 的
// sha1，取 12 位），原本的用途是"你的页面过期了"。这里正好当**缓存目录名** —— 服务器发了新代码 → 指纹变 →
// 换目录 → 客户端自动看到新版，**不用发 installer**。
//
// 美术是例外：19,404 个文件 / 约 1 GB 逐个 HTTP 取是不行的，那一半继续走整包 + 指纹（updater.mjs 的
// `artDigest`）。这个文件管的是**代码**那一半（几百个文件、几 MB），那才是每次真的会变的。

import path from 'node:path';

/** `<userData>` 下的缓存根。 */
export const CACHE_DIR = 'cache';
/** 服务器没给指纹（老服 / 探针失败）时用的目录名：宁可一个"不知道版本"的目录，也不要把文件混进别的版本。 */
export const UNKNOWN_BUILD = 'unknown';
/** 每个 host 保留几份 build（LRU）。留 2 是为了"上一次那份"能当回退。 */
export const KEEP_BUILDS = 2;

/**
 * 缓存目录名：只留 `host_port` 里的安全字符。服务器地址是玩家在选择器里填的，
 * 里面出现 `/` `..` 之类的字符必须挡住 —— 否则一个地址就能写穿到缓存目录之外。
 */
export function hostDirName(serverUrl) {
  const s = String(serverUrl || '').trim().replace(/\/+$/, '');
  const m = /^[a-z]+:\/\/([^/]+)/i.exec(s);
  const authority = m ? m[1] : s;
  const safe = authority.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '');
  return safe || 'server';
}

/**
 * URL 的 pathname → 缓存里的相对路径；挡住目录穿越与查询串。
 * @returns {string|null} null = 这个请求不该进缓存
 */
export function safeRel(pathname) {
  const q = String(pathname || '').split(/[?#]/)[0];
  if (!q) return null;
  let raw = q;
  try { raw = decodeURIComponent(q); } catch { /* 畸形百分号转义：原样用 */ }
  const rel = raw.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) return null;           // 目录：这里只缓存文件
  const norm = path.normalize(rel);
  if (norm.startsWith('..') || path.isAbsolute(norm)) return null;
  return norm.split(path.sep).join('/');
}

/** 一个文件在缓存里的落点。 */
export function cachePathFor({ root, host, build, rel }) {
  return path.join(root, hostDirName(host), String(build || UNKNOWN_BUILD), rel);
}

/**
 * LRU 清理：同一 host 下保留最新的 `keep` 份 build，其余删。
 * 传进来的 `entries` 是 `[{ name, mtime }]`，返回**该删的那些名字** —— 删什么由调用方决定，这里只做判断，
 * 于是"只留 2 份""最新的那份绝不能删"这两条能被测试直接钉住。
 */
export function pruneBuilds(entries, keep = KEEP_BUILDS) {
  const sorted = [...entries].sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
  return sorted.slice(keep).map((e) => e.name);
}

/**
 * 问服务器它现在的 build 指纹。失败返回 '' —— 这时调用方退回已知最新的那份缓存，而不是报错。
 */
export async function probeBuild({ serverUrl, fetchImpl = globalThis.fetch, timeoutMs = 5_000 }) {
  try {
    const res = await fetchImpl(`${String(serverUrl).replace(/\/+$/, '')}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return '';
    const j = await res.json();
    return typeof j?.build === 'string' && j.build ? j.build : '';
  } catch {
    return '';
  }
}

/**
 * 取一个文件：命中缓存就直接用，没命中就回源并存盘。
 * @returns {Promise<{ ok: boolean, body: Buffer|null, from: 'cache'|'origin'|'' }>}
 */
export async function fetchInto({
  serverUrl, rel, dest, io, fetchImpl = globalThis.fetch, timeoutMs = 15_000,
}) {
  if (io.isFile(dest)) return { ok: true, body: io.readFile(dest), from: 'cache' };
  const url = `${String(serverUrl).replace(/\/+$/, '')}/${rel}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, body: null, from: '' };
    const body = Buffer.from(await res.arrayBuffer());
    io.writeFile(dest, body);
    return { ok: true, body, from: 'origin' };
  } catch {
    return { ok: false, body: null, from: '' };
  }
}

/**
 * 该用哪份 build：服务器说的优先；服务器连不上（或没给）就退回**本地已知最新的那份**。
 * 这一条是"服务器关了玩家还能不能玩"的唯一答案，所以它在日志里必须说得出来。
 */
export function chooseBuild({ probed, local, current = '' }) {
  if (probed) return { build: probed, source: '服务器' };
  if (current) return { build: current, source: '本地（连不上服务器，继续用这一份）' };
  if (local.length) return { build: local[0], source: '本地缓存（离线）' };
  return { build: UNKNOWN_BUILD, source: '（既连不上服务器也没有缓存 —— 这次必然什么都取不到）' };
}
