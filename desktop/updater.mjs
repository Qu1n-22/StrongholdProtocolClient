// 自动更新的「取清单与下载」那一半 —— docs/AUTO-UPDATE.md §3 第 3 步。
//
// 前两步已经落地：payload 位置能被换（payload-path.mjs），overlay 能被选中与校验。缺的就是这里 ——
// 壳从来没去取过清单，所以线上那份 `stable.json` 目前没有人读。这一半的四条底线来自文档 §3/§4：
//
//   1. **全程后台、失败静默**：大陆连 GitHub 时好时坏（实测 Node 直连 ECONNRESET 而 curl 同一 URL 200），
//      所以每一步都可以失败，失败就接着玩现在这一份，绝不弹框、绝不挡启动。
//   2. **先验后解**：sha256 对不上就丢掉，绝不解包（文档 §3 第 4 条）。
//   3. **解到临时目录再原子换**：换不动就留在上一份。
//   4. **美术指纹不等就不吃增量**：代码增量里没有 `assets/`，它假设玩家手里的美术就是这一刀对应的那批；
//      假设不成立时只能回完整包，而不是装出一个立绘全空的客户端。
//
// 代码增量包不含 `assets/`（cut-payload 用 `--exclude=./assets` 打的），所以解出来的 overlay 需要自己
// 把美术接回来：这里用**目录链接**（Windows junction / POSIX symlink）指向现有美术目录，而不是拷 1 GB。
// 链接目标只取"装机就一直在、不会被本模块删掉"的那份，避免换 overlay 时把美术一起删了。
//
// IO 与 fetch 都是注入的：测试里换成一个 Map 就能断言「换指针失败时上一份还在」这种真正要命的路径，
// 而不必在磁盘上真的造一个 800 MB 的 payload。

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';

import { safeJoin, untarGzip } from './tar.mjs';
import { CURRENT_LINK, OVERLAY_DIR } from './payload-path.mjs';

/** 指针格式版本。不认的 schema 一律不应用（宁可不更）。 */
export const POINTER_SCHEMA_SUPPORTED = 1;
/** 这个壳自己支持的指针协议。指针要求 `minShell` 更高 → 壳太旧，得下完整安装包。 */
export const SHELL_PROTOCOL = 1;

export const DEFAULT_POINTER_URL = 'https://lain42.top/downloads/stronghold/stable.json';
export const POINTER_TIMEOUT_MS = 8_000;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
/** 代码增量是几 MB 量级。这条上限防的是"指针被写成指向整包"—— 那会让每个玩家都去下 800 MB。 */
export const MAX_CODE_BYTES = 256 * 1024 * 1024;
/** 缓存下来的美术指纹文件名（放在 `<userData>/payload/` 下）。 */
export const ART_CACHE_FILE = 'art-fingerprint.json';
/** 已应用那一刀的记名（写在 overlay 根，下次启动靠它判断"已经是这一份了"）。 */
export const APPLIED_FILE = 'update.json';

const HEX64 = /^[0-9a-f]{64}$/;

/** `sha256:abc…` 与裸 `abc…` 都收，统一成小写裸 hex；不合法就返回 ''。 */
export function normalizeSha(v) {
  const s = String(v ?? '').trim().replace(/^sha256:/i, '').toLowerCase();
  return HEX64.test(s) ? s : '';
}

/**
 * 校验一份指针。**返回 why 而不是抛错**：指针是远端数据，坏指针是常态而不是异常，
 * 调用方要的是"为什么没更"这一句话（它会被写进 client.log）。
 */
export function parsePointer(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, why: '指针不是对象' };
  const schema = Number(json.schema);
  if (!Number.isInteger(schema)) return { ok: false, why: '指针缺 schema' };
  if (schema !== POINTER_SCHEMA_SUPPORTED) return { ok: false, why: `指针 schema=${schema}（本壳只认 ${POINTER_SCHEMA_SUPPORTED}）` };
  const code = json.code;
  if (!code || typeof code !== 'object') return { ok: false, why: '指针缺 code' };
  if (!code.file) return { ok: false, why: '指针缺 code.file' };
  if (!normalizeSha(code.sha256)) return { ok: false, why: '指针的 code.sha256 不是 sha256 值' };
  const base = String(json.base || json.fallbackBase || '').replace(/\/+$/, '');
  if (!base) return { ok: false, why: '指针既没有 base 也没有 fallbackBase' };
  return {
    ok: true,
    pointer: {
      schema,
      channel: String(json.channel || 'stable'),
      cut: String(json.cut || ''),
      version: String(json.version || ''),
      game: json.game || null,
      base: String(json.base || '').replace(/\/+$/, ''),
      fallbackBase: String(json.fallbackBase || '').replace(/\/+$/, ''),
      code: { file: String(code.file), sha256: normalizeSha(code.sha256), bytes: Number(code.bytes) || 0, files: Number(code.files) || 0 },
      art: { digest: normalizeSha(json.art?.digest), files: Number(json.art?.files) || 0, bytes: Number(json.art?.bytes) || 0 },
      artFrom: String(json.artFrom || ''),
      minShell: Number(json.minShell) || 1,
    },
  };
}

/**
 * 要不要吃这一份增量。**每一条 skip 都带 why**，因为"我更新了没生效"唯一的排查入口就是 client.log。
 */
export function decide({ pointer, shellProtocol = SHELL_PROTOCOL, localArt = '', appliedCut = '' }) {
  if (!pointer) return { action: 'skip', why: '没有可用的指针' };
  if (pointer.minShell > shellProtocol) {
    return { action: 'skip', why: `这一刀要求壳协议 ${pointer.minShell}，本壳是 ${shellProtocol} —— 请下载完整安装包` };
  }
  if (appliedCut && appliedCut === pointer.cut) return { action: 'skip', why: `已经是这一刀（${pointer.cut}）` };
  if (!localArt) return { action: 'skip', why: '算不出本地美术指纹 —— 不能确认这份增量适用于手里的美术' };
  if (!pointer.art.digest) return { action: 'skip', why: '指针没带美术指纹 —— 不能确认增量与手里的美术配套' };
  if (localArt !== pointer.art.digest) {
    return { action: 'skip', why: `美术指纹不同（手里 ${localArt.slice(0, 12)}… vs 这一刀 ${pointer.art.digest.slice(0, 12)}…）—— 需要下完整包` };
  }
  return { action: 'apply', why: '' };
}

/** 指针的取址顺序：`SP_POINTER_URL` 覆盖 → 国内主源。指针本身只有一个源，包才有两个源。 */
export function pointerSources({ env = {} } = {}) {
  const out = [];
  if (env.SP_POINTER_URL) out.push(env.SP_POINTER_URL);
  out.push(DEFAULT_POINTER_URL);
  return out;
}

/** 代码包的两个源：主源（国内）+ 指针里带的备用源（GitHub）。 */
export function codeUrls(pointer) {
  const out = [];
  for (const b of [pointer.base, pointer.fallbackBase]) {
    if (b) out.push(`${b}/${encodeURIComponent(pointer.code.file)}`);
  }
  return out;
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 美术指纹：**名字 + 内容**，与 cut-payload 那句
 * `find assets -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum` 同形 ——
 * 也就是把 `sha256sum` 的输出（`<hex>  <相对路径>`，逐行、按路径排序）再 sha256 一次。
 * 用 mtime 做判据会把好包判成不同（解包/打包都会改 mtime），所以必须是内容。
 *
 * @param {{ rel: string, sha: string }[]} entries 相对路径以 `assets/` 开头
 */
export function artDigest(entries) {
  const lines = [...entries]
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((e) => `${e.sha}  ${e.rel}\n`)
    .join('');
  return createHash('sha256').update(lines, 'utf8').digest('hex');
}

/** 走一遍美术目录算出指纹。`io` 注入（真实 fs 或测试里的 Map）。 */
export function computeArtDigest({ artDir, io }) {
  const entries = [];
  const walk = (rel) => {
    for (const e of io.readdir(rel ? path.join(artDir, rel) : artDir)) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(childRel); continue; }
      if (!e.isFile()) continue;
      entries.push({ rel: `assets/${childRel}`, sha: io.hashFile(path.join(artDir, childRel)) });
    }
  };
  walk('');
  return { digest: artDigest(entries), files: entries.length };
}

/**
 * 本地美术指纹，带缓存。第一次要真读 1 GB（后台、只做一次），之后 `<userData>/payload/art-fingerprint.json`
 * 里记着"哪个目录、多少个文件" —— 对得上就直接用。
 */
export function localArtDigest({ artDir, cacheFile, io, env = {} }) {
  if (env.SP_ART_DIGEST) return { digest: normalizeSha(env.SP_ART_DIGEST), from: 'SP_ART_DIGEST' };
  if (!io.isDir(artDir)) return { digest: '', from: '' };
  const cached = io.readJsonIfExists(cacheFile);
  if (cached && cached.dir === artDir && cached.digest && cached.files > 0 && io.countFiles(artDir) === cached.files) {
    return { digest: normalizeSha(cached.digest), from: '缓存' };
  }
  const { digest, files } = computeArtDigest({ artDir, io });
  io.writeJson(cacheFile, { schema: 1, dir: artDir, digest, files, at: new Date().toISOString() });
  return { digest, from: files ? '现算' : '' };
}

/** 已应用的那一刀（overlay 根上的 update.json）。读不出来就是没应用过。 */
export function readAppliedCut({ overlayDir, io }) {
  const j = io.readJsonIfExists(path.join(overlayDir, APPLIED_FILE));
  return String(j?.cut || '');
}

/** 带超时的 JSON 取回。超时/非 2xx/不是 JSON 都返回一个原因字符串而不是抛。 */
export async function fetchJson(url, { timeoutMs = POINTER_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 带超时的字节取回，顺手挡住"指针指向了一个巨大的文件"。 */
export async function fetchBytes(url, { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_CODE_BYTES, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error(`声明 ${declared} 字节，超过代码增量的上限 ${maxBytes}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`实到 ${buf.length} 字节，超过上限 ${maxBytes}`);
  return buf;
}

/**
 * 把解出来的文件写进目标目录。`safeJoin` 挡 tar slip（`../../evil`），跳过的文件要数出来 ——
 * "少解了几个文件"是自动更新里最难查的坏法。
 */
export function extractInto({ files, dest, io }) {
  let written = 0;
  let skipped = 0;
  for (const f of files) {
    const target = safeJoin(f.name, dest);
    if (!target) { skipped++; continue; }
    io.mkdir(path.dirname(target));
    io.writeFile(target, f.data);
    written++;
  }
  return { written, skipped };
}

/**
 * 原子换 `current`：先把旧的挪到 `.old-<ts>`，再把 staging 挪成 `current`；
 * 第二步失败就把旧的挪回来。**换不动必须留在上一份** —— 这是"自动更新不能变成有人打不开游戏"的落点。
 */
export function publishStaged({ payloadDir, staged, current = CURRENT_LINK, io, tag = String(Date.now()) }) {
  const stagedPath = path.join(payloadDir, staged);
  const currentPath = path.join(payloadDir, current);
  const backup = path.join(payloadDir, `.old-${tag}`);
  let movedAway = false;
  if (io.exists(currentPath)) {
    io.rm(backup);
    io.rename(currentPath, backup);
    movedAway = true;
  }
  try {
    io.rename(stagedPath, currentPath);
  } catch (e) {
    if (movedAway) {
      try { io.rename(backup, currentPath); } catch { /* 到这里已经没办法了，交给下一次启动回落内置那份 */ }
    }
    return { ok: false, why: `换 current 失败：${e?.message || e}` };
  }
  if (movedAway) { try { io.rm(backup); } catch { /* 留个旧目录不致命，下次启动会清 */ } }
  return { ok: true, why: '' };
}

/** 真实文件系统。把这一层集中在一处，是为了让上面每个函数都能被测试用假 IO 跑。 */
export const fsIo = {
  exists: existsSync,
  isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  writeFile: (p, b) => writeFileSync(p, b),
  writeJson: (p, v) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); },
  readJsonIfExists: (p) => {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  },
  readdir: (p) => readdirSync(p, { withFileTypes: true }),
  rename: renameSync,
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  countFiles: (dir) => {
    let n = 0;
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else n++; } };
    try { walk(dir); } catch { return -1; }
    return n;
  },
  hashFile: (p) => createHash('sha256').update(readFileSync(p)).digest('hex'),
  linkDir: (target, linkPath) => symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir'),
};

/**
 * 一次完整的检查与应用。**永不抛错**：返回值里带着 status 与 why，调用方只管往日志里写。
 *
 * @param {object} o
 * @param {string} o.payloadDir  `<userData>/payload`
 * @param {string} o.artDir      现有美术目录（装机内置那份的 assets），overlay 会链接到它
 * @param {(s:string)=>void} [o.log]
 * @param {object} [o.io]        默认 fsIo
 * @param {typeof globalThis.fetch} [o.fetchImpl]
 * @param {Record<string,string>} [o.env]
 * @param {boolean} [o.enabled]
 */
export async function runUpdate({
  payloadDir,
  artDir,
  log = () => {},
  io = fsIo,
  fetchImpl = globalThis.fetch,
  env = {},
  enabled = true,
  shellProtocol = SHELL_PROTOCOL,
  now = () => Date.now(),
} = {}) {
  const done = (status, extra = {}) => ({ status, ...extra });
  if (!enabled) return done('disabled', { why: '自动更新被关掉了' });
  if (typeof fetchImpl !== 'function') return done('error', { why: '这个 Node 没有 fetch，跳过更新' });

  // ── 1. 取指针（每个源都可能是坏的：域名不通、CDN 缓存了旧的、JSON 半截） ──────────────────────────────
  let parsed = { ok: false, why: '' };
  let pointer = null;
  for (const url of pointerSources({ env })) {
    try {
      const json = await fetchJson(url, { fetchImpl });
      parsed = parsePointer(json);
      if (parsed.ok) { pointer = parsed.pointer; log(`[update] 指针来自 ${url}：${pointer.cut || pointer.version} code=${pointer.code.file}`); break; }
      log(`[update] ${url} 的指针不能用：${parsed.why}`);
    } catch (e) {
      log(`[update] 取不到指针 ${url}：${e?.message || e}`);
    }
  }
  if (!pointer) return done('no-pointer', { why: parsed.why || '所有指针源都取不到' });

  // ── 2. 判定：壳够不够新、是不是已经这一刀、美术对不对 ────────────────────────────────────────────────
  const cacheFile = path.join(payloadDir, ART_CACHE_FILE);
  const local = localArtDigest({ artDir, cacheFile, io, env });
  const appliedCut = readAppliedCut({ overlayDir: path.join(payloadDir, CURRENT_LINK), io });
  log(`[update] 本地美术指纹 ${local.digest ? `${local.digest.slice(0, 12)}…（${local.from}）` : '（算不出）'}；已应用 ${appliedCut || '（无）'}`);
  const verdict = decide({ pointer, shellProtocol, localArt: local.digest, appliedCut });
  if (verdict.action !== 'apply') {
    log(`[update] 不应用 ${pointer.cut}：${verdict.why}`);
    return done('skipped', { why: verdict.why, cut: pointer.cut });
  }

  // ── 3. 下载代码增量（主源不行就用备用源），先验 sha256 ──────────────────────────────────────────────
  let bytes = null;
  let from = '';
  for (const url of codeUrls(pointer)) {
    try {
      bytes = await fetchBytes(url, { fetchImpl });
      const got = sha256Hex(bytes);
      if (got !== pointer.code.sha256) {
        log(`[update] ${url} 的 sha256 是 ${got.slice(0, 12)}…，清单要的是 ${pointer.code.sha256.slice(0, 12)}… —— 丢掉`);
        bytes = null;
        continue;
      }
      from = url;
      break;
    } catch (e) {
      log(`[update] 下载失败 ${url}：${e?.message || e}`);
    }
  }
  if (!bytes) return done('download-failed', { why: '所有源都下载失败或校验不过', cut: pointer.cut });

  // ── 4. 解到 staging，校验它像个 payload，再把美术链接进来 ───────────────────────────────────────────
  const staged = `.staging-${pointer.cut}`;
  const stagedPath = path.join(payloadDir, staged);
  try {
    io.rm(stagedPath);
    io.mkdir(stagedPath);
    let files;
    try {
      files = untarGzip(bytes);
    } catch (e) {
      return done('bad-archive', { why: `解包失败：${e?.message || e}`, cut: pointer.cut });
    }
    const { written, skipped } = extractInto({ files, dest: stagedPath, io });
    log(`[update] 解出 ${written} 个文件${skipped ? `（跳过 ${skipped} 个越界路径）` : ''}，来自 ${from}`);
    if (skipped) return done('bad-archive', { why: `包里有 ${skipped} 个指向目录外的路径 —— 整个包不信任`, cut: pointer.cut });
    if (!io.isFile(path.join(stagedPath, 'index.html')) || !io.isFile(path.join(stagedPath, 'build.json'))) {
      return done('bad-archive', { why: '解出来不像 payload（缺 index.html 或 build.json）', cut: pointer.cut });
    }
    // 增量里没有美术：把它接回现在这份（装机内置那份不会被本模块删掉，所以链接它最稳）。
    if (io.isDir(artDir)) io.linkDir(artDir, path.join(stagedPath, 'assets'));
    io.writeJson(path.join(stagedPath, APPLIED_FILE), {
      schema: 1,
      cut: pointer.cut,
      version: pointer.version,
      channel: pointer.channel,
      game: pointer.game,
      art: { digest: pointer.art.digest, files: pointer.art.files, bytes: pointer.art.bytes },
      artFrom: pointer.artFrom,
      code: { file: pointer.code.file, sha256: `sha256:${pointer.code.sha256}`, files: pointer.code.files, bytes: pointer.code.bytes },
      appliedAt: new Date(now()).toISOString(),
    });
  } catch (e) {
    io.rm(stagedPath);
    return done('error', { why: `落地失败：${e?.message || e}`, cut: pointer.cut });
  }

  // ── 5. 原子换 current ──────────────────────────────────────────────────────────────────────────────
  const published = publishStaged({ payloadDir, staged, io, tag: String(now()) });
  if (!published.ok) {
    io.rm(stagedPath);
    return done('error', { why: published.why, cut: pointer.cut });
  }
  log(`[update] 已应用 ${pointer.cut}（${pointer.version}）—— 下次启动生效`);
  return done('applied', { cut: pointer.cut, version: pointer.version, files: pointer.code.files });
}

export { CURRENT_LINK, OVERLAY_DIR };
