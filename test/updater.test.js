// The half of auto-update that actually goes out to the network (docs/AUTO-UPDATE.md §3 step 3).
//
// Everything here runs against an in-memory filesystem and a fake `fetch`: the paths that matter are the ones where
// a player ends up worse than before — a delta applied on the wrong art, a sha256 mismatch that was extracted
// anyway, a half-swapped `current` — and none of those can be reached by running the happy path against a real disk.
// `tar.mjs` is covered here too rather than in a file of its own: it exists to unpack these deltas, and the round
// trip through a real gzip stream is what proves the parser reads what `tar -czf` writes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { safeJoin, untar, untarGzip } from '../desktop/tar.mjs';
import {
  APPLIED_FILE, DEFAULT_POINTER_URL, MAX_CODE_BYTES, SHELL_PROTOCOL,
  artDigest, codeUrls, computeArtDigest, decide, extractInto, localArtDigest, normalizeSha,
  parsePointer, pointerSources, publishStaged, readAppliedCut, runUpdate, sha256Hex,
} from '../desktop/updater.mjs';

// 带盘符：Windows 上 `path.resolve('/U/payload')` 会补成盘符路径（`D:\U\payload`），测试里的假文件系统与
// safeJoin 走的是同一个 path 模块，两边必须用同一种写法才对得上。
const PAYLOAD = 'C:/U/payload';
const ART = 'C:/W/www/assets';
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// ── a real gzip'd tar, so the parser is checked against what `tar -czf` emits ──────────────────────────────────────
function tarHeader({ name, size, typeflag = '0' }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'utf8');
  h.write('0000000\0', 108, 8, 'utf8');
  h.write('0000000\0', 116, 8, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  h.write('00000000000\0', 136, 12, 'utf8');
  h.write('        ', 148, 8, 'utf8');
  h.write(typeflag, 156, 1, 'utf8');
  h.write('ustar\0', 257, 6, 'utf8');
  h.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return h;
}

/** @param {Record<string,string>} files 路径 → 内容 */
function makeTarGz(files) {
  const parts = [];
  for (const [name, body] of Object.entries(files)) {
    const buf = Buffer.from(body, 'utf8');
    parts.push(tarHeader({ name, size: buf.length }), buf);
    const pad = (512 - (buf.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // tar 的结尾两个全零块
  return gzipSync(Buffer.concat(parts));
}

// ── an in-memory filesystem ───────────────────────────────────────────────────────────────────────────────────────
function makeIo() {
  const dirs = new Set(['/']);
  const files = new Map();
  const links = new Map();
  const norm = (p) => path.normalize(p).replace(/\\/g, '/');
  const parent = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
  const mkdir = (p) => { for (let c = norm(p); ; c = parent(c)) { dirs.add(c); if (c === '/') break; } };

  const io = {
    dirs, files, links,
    exists: (p) => dirs.has(norm(p)) || files.has(norm(p)) || links.has(norm(p)),
    isDir: (p) => dirs.has(norm(p)) || links.has(norm(p)),
    isFile: (p) => files.has(norm(p)),
    mkdir,
    writeFile: (p, b) => { const q = norm(p); mkdir(parent(q)); files.set(q, Buffer.isBuffer(b) ? b : Buffer.from(String(b))); },
    writeJson: (p, v) => io.writeFile(p, `${JSON.stringify(v, null, 2)}\n`),
    readJsonIfExists: (p) => {
      const b = files.get(norm(p));
      if (!b) return null;
      try { return JSON.parse(b.toString('utf8')); } catch { return null; }
    },
    readdir: (p) => {
      const q = norm(p);
      const out = new Map();
      for (const f of files.keys()) if (parent(f) === q) out.set(f.slice(q.length + 1), 'file');
      for (const d of dirs) if (d !== q && parent(d) === q && !out.has(d.slice(q.length + 1))) out.set(d.slice(q.length + 1), 'dir');
      for (const l of links.keys()) if (parent(l) === q && !out.has(l.slice(q.length + 1))) out.set(l.slice(q.length + 1), 'dir');
      return [...out].map(([name, kind]) => ({ name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir' }));
    },
    rename: (a, b) => {
      const from = norm(a);
      const to = norm(b);
      if (links.has(from)) { links.set(to, links.get(from)); links.delete(from); return; }
      if (!dirs.has(from)) throw new Error(`ENOENT: ${from}`);
      dirs.delete(from);
      dirs.add(to);
      for (const key of [...files.keys()]) if (key === from || key.startsWith(`${from}/`)) { const v = files.get(key); files.delete(key); files.set(to + key.slice(from.length), v); }
      for (const d of [...dirs]) if (d.startsWith(`${from}/`)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
      for (const l of [...links.keys()]) if (l.startsWith(`${from}/`)) { const v = links.get(l); links.delete(l); links.set(to + l.slice(from.length), v); }
    },
    rm: (p) => {
      const q = norm(p);
      for (const k of [...files.keys()]) if (k === q || k.startsWith(`${q}/`)) files.delete(k);
      for (const d of [...dirs]) if (d === q || d.startsWith(`${q}/`)) dirs.delete(d);
      for (const l of [...links.keys()]) if (l === q || l.startsWith(`${q}/`)) links.delete(l);
    },
    countFiles: (d) => { const q = norm(d); let n = 0; for (const f of files.keys()) if (f.startsWith(`${q}/`)) n++; return n; },
    hashFile: (p) => createHash('sha256').update(files.get(norm(p)) ?? Buffer.alloc(0)).digest('hex'),
    linkDir: (target, linkPath) => { links.set(norm(linkPath), norm(target)); },
  };
  return io;
}

/** 一份三文件的美术目录。指纹是"名字+内容"，改任何一处都必须换值。 */
function seedArt(io, dir = ART) {
  io.writeFile(path.posix.join(dir, 'char', 'a.png'), 'A');
  io.writeFile(path.posix.join(dir, 'char', 'b.png'), 'B');
  io.writeFile(path.posix.join(dir, 'ui', 'c.png'), 'C');
}

function codePayload(extra = {}) {
  return {
    'index.html': '<html></html>',
    'build.json': '{"game":{"app":"0.3.0"}}',
    'js/main.js': 'console.log(1)',
    ...extra,
  };
}

/** 一份指针，字段与线上 stable.json 同形。 */
function pointer({
  schema = 1,
  cut = 'payload-v0.3.0-c46',
  artDigest: d = sha('art'),
  codeSha = sha('code'),
  base = 'https://d.example/v1',
  fallback = 'https://gh.example/v1',
  minShell = 1,
} = {}) {
  return {
    schema, channel: 'stable', cut, version: '0.3.0',
    game: { app: '0.3.0', commit: 'abc' },
    updatedAt: '2026-10-17T08:22:58Z',
    base, manifest: 'sp-client-manifest-v0.3.0-c46.json',
    code: { file: 'sp-client-code-v0.3.0-c46.tar.gz', sha256: `sha256:${codeSha}`, bytes: 100, files: 3 },
    art: { digest: `sha256:${d}`, files: 3, bytes: 300 },
    artFrom: 'payload-v0.2.5-c44',
    minShell,
    fallbackBase: fallback,
  };
}

/** 按 URL 回答的假 fetch；每次调用都记下来，好断言"这一路根本没去下载"。 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error(`ENOTFOUND ${url}`);
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(r.body ? r.body.length : 0) },
      json: async () => r.json,
      arrayBuffer: async () => { const u = new Uint8Array(r.body); return u.buffer; },
    };
  };
  return { impl, calls };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('.tar.gz 解包（updater 底下那一层）', () => {
  test('round trip: what makeTarGz writes, untarGzip reads back', () => {
    const files = untarGzip(makeTarGz(codePayload({ 'js/deep/nested.js': 'x' })));
    assert.deepEqual(files.map((f) => f.name).sort(), ['build.json', 'index.html', 'js/deep/nested.js', 'js/main.js']);
    assert.equal(files.find((f) => f.name === 'js/main.js').data.toString(), 'console.log(1)');
  });

  test('the reader stops at the end-of-archive block instead of reading trailing bytes', () => {
    // 结尾两个全零块之后还跟着垃圾：那些字节必须被丢掉，不能变成文件。
    const withTail = Buffer.concat([gunzipSync(makeTarGz({ 'a.txt': 'hello' })), Buffer.alloc(600, 0x41)]);
    assert.equal(untar(withTail).length, 1);
  });

  test('an empty archive yields no files rather than throwing', () => {
    assert.deepEqual(untar(Buffer.alloc(1024)), []);
    assert.deepEqual(untarGzip(makeTarGz({})), []);
  });

  test('a path that escapes the destination is refused, not written', () => {
    assert.equal(safeJoin('../../evil.txt', 'C:/dest/payload'), null);
    assert.equal(safeJoin('assets/a.png', 'C:/dest/payload'), path.resolve('C:/dest/payload', 'assets/a.png'));
    assert.equal(safeJoin('a/../../b', 'C:/dest/payload'), null, '先下去再上来也算越界');
  });

  test('extractInto writes under the destination and counts what it refused', () => {
    const io = makeIo();
    const r = extractInto({
      files: [{ name: 'index.html', data: Buffer.from('<html>') }, { name: '../evil.txt', data: Buffer.from('x') }],
      dest: 'C:/dest/payload',
      io,
    });
    assert.equal(r.written, 1);
    assert.equal(r.skipped, 1);
    assert.equal(io.isFile('C:/dest/payload/index.html'), true);
    assert.equal(io.exists('C:/dest/evil.txt'), false);
  });
});

describe('指针解析：远端数据只能是"能用"或"为什么不能用"', () => {
  test('a real pointer parses, and sha256: prefixes are normalised away', () => {
    const p = parsePointer(pointer({ artDigest: sha('art'), codeSha: sha('code') }));
    assert.equal(p.ok, true);
    assert.equal(p.pointer.code.sha256, sha('code'));
    assert.equal(p.pointer.art.digest, sha('art'));
    assert.equal(p.pointer.cut, 'payload-v0.3.0-c46');
  });

  test('an unknown schema is refused rather than half-understood', () => {
    const p = parsePointer(pointer({ schema: 2 }));
    assert.equal(p.pointer?.schema ?? null, null);
    assert.equal(p.ok, false);
    assert.match(p.why, /schema=2/);
  });

  for (const [name, mutate] of [
    ['不是对象', () => 'nope'],
    ['缺 schema', (o) => { delete o.schema; }],
    ['缺 code', (o) => { delete o.code; }],
    ['缺 code.file', (o) => { delete o.code.file; }],
    ['sha256 不是 sha256 值', (o) => { o.code.sha256 = 'sha256:不是 hex'; }],
    ['两个下载源都没有', (o) => { o.base = ''; o.fallbackBase = ''; }],
  ]) {
    test(`拒掉${name}`, () => {
      const o = pointer();
      const r = mutate(o);
      const p = parsePointer(r === undefined ? o : r);
      assert.equal(p.ok, false, `${name} 竟然被接受了`);
      assert.ok(p.why.length > 0);
    });
  }

  test('normalizeSha accepts both forms and rejects anything else', () => {
    assert.equal(normalizeSha(`sha256:${sha('x')}`), sha('x'));
    assert.equal(normalizeSha(sha('x').toUpperCase()), sha('x'));
    assert.equal(normalizeSha(''), '');
    assert.equal(normalizeSha('sha256:zz'), '');
  });

  test('the code delta has two sources: the domestic one first, GitHub as the backup', () => {
    assert.deepEqual(codeUrls(pointer()), [
      'https://d.example/v1/sp-client-code-v0.3.0-c46.tar.gz',
      'https://gh.example/v1/sp-client-code-v0.3.0-c46.tar.gz',
    ]);
    assert.deepEqual(codeUrls(pointer({ fallback: '' })).length, 1, '没有备用源就只试一个');
  });

  test('SP_POINTER_URL overrides the built-in pointer source', () => {
    assert.deepEqual(pointerSources({}), [DEFAULT_POINTER_URL]);
    assert.deepEqual(pointerSources({ env: { SP_POINTER_URL: 'http://127.0.0.1:9/p.json' } }),
      ['http://127.0.0.1:9/p.json', DEFAULT_POINTER_URL]);
  });
});

describe('美术指纹：名字 + 内容', () => {
  test('order of walk does not matter — the entries are sorted by path', () => {
    const a = artDigest([{ rel: 'assets/b.png', sha: '2' }, { rel: 'assets/a.png', sha: '1' }]);
    const b = artDigest([{ rel: 'assets/a.png', sha: '1' }, { rel: 'assets/b.png', sha: '2' }]);
    assert.equal(a, b);
    assert.equal(a, sha256Hex(Buffer.from(`1  assets/a.png\n2  assets/b.png\n`, 'utf8')),
      '与 cut-payload 那句 `sha256sum | sha256sum` 同形：每行 "<hex>  相对路径"');
  });

  test('changing one byte of one file changes the digest', () => {
    const before = artDigest([{ rel: 'assets/a.png', sha: sha('A') }]);
    const after = artDigest([{ rel: 'assets/a.png', sha: sha('B') }]);
    assert.notEqual(before, after);
  });

  test('computeArtDigest walks nested directories and keeps the assets/ prefix', () => {
    const io = makeIo();
    seedArt(io);
    const { digest, files } = computeArtDigest({ artDir: ART, io });
    assert.equal(files, 3);
    assert.equal(digest, artDigest([
      { rel: 'assets/char/a.png', sha: sha('A') },
      { rel: 'assets/char/b.png', sha: sha('B') },
      { rel: 'assets/ui/c.png', sha: sha('C') },
    ]));
  });

  test('the second launch reuses the cached digest instead of hashing a gigabyte again', () => {
    const io = makeIo();
    seedArt(io);
    let hashed = 0;
    const counting = { ...io, hashFile: (p) => { hashed++; return io.hashFile(p); } };
    const first = localArtDigest({ artDir: ART, cacheFile: `${PAYLOAD}/art-fingerprint.json`, io: counting });
    assert.equal(first.from, '现算');
    assert.equal(hashed, 3);
    const second = localArtDigest({ artDir: ART, cacheFile: `${PAYLOAD}/art-fingerprint.json`, io: counting });
    assert.equal(second.from, '缓存');
    assert.equal(second.digest, first.digest);
    assert.equal(hashed, 3, '缓存命中就不该再读一遍美术');
    // 文件数变了（玩家自己动了美术目录）→ 缓存作废，重新算。
    io.writeFile(path.posix.join(ART, 'char', 'd.png'), 'D');
    const third = localArtDigest({ artDir: ART, cacheFile: `${PAYLOAD}/art-fingerprint.json`, io: counting });
    assert.equal(third.from, '现算');
    assert.notEqual(third.digest, first.digest);
  });

  test('SP_ART_DIGEST overrides everything (how a test or an ops run forces a match)', () => {
    const io = makeIo();
    seedArt(io);
    const r = localArtDigest({ artDir: ART, cacheFile: `${PAYLOAD}/art-fingerprint.json`, io, env: { SP_ART_DIGEST: sha('Z') } });
    assert.equal(r.digest, sha('Z'));
    assert.equal(r.from, 'SP_ART_DIGEST');
  });

  test('no art directory means no digest — and that must read as "cannot prove", not as "matches"', () => {
    const io = makeIo();
    assert.equal(localArtDigest({ artDir: ART, cacheFile: `${PAYLOAD}/art-fingerprint.json`, io }).digest, '');
  });
});

describe('判定：不更也要说清为什么', () => {
  const P = parsePointer(pointer({ artDigest: sha('art'), codeSha: sha('code') })).pointer;

  test('art matches → apply', () => {
    assert.equal(decide({ pointer: P, localArt: sha('art') }).action, 'apply');
  });

  for (const [name, o, why] of [
    ['美术指纹不同', { localArt: sha('别的美术') }, /美术指纹不同/],
    ['本地指纹算不出', { localArt: '' }, /算不出本地美术指纹/],
    ['指针没带指纹', { localArt: sha('art'), pointer: parsePointer(pointer({ artDigest: '' })).pointer }, /不能确认/],
    ['已经是这一刀', { localArt: sha('art'), appliedCut: P.cut }, /已经是这一刀/],
    ['壳太旧', { localArt: sha('art'), pointer: parsePointer(pointer({ artDigest: sha('art'), minShell: SHELL_PROTOCOL + 1 })).pointer }, /完整安装包/],
    ['没有指针', { localArt: sha('art'), pointer: null }, /没有可用的指针/],
  ]) {
    test(`${name} → skip，并且 why 进日志`, () => {
      const r = decide({ pointer: P, ...o });
      assert.equal(r.action, 'skip');
      assert.match(r.why, why);
    });
  }
});

describe('原子换 current：换不动必须留在上一份', () => {
  test('nothing to replace: staging simply becomes current', () => {
    const io = makeIo();
    io.mkdir(`${PAYLOAD}/.staging-x`);
    io.writeFile(`${PAYLOAD}/.staging-x/index.html`, 'new');
    const r = publishStaged({ payloadDir: PAYLOAD, staged: '.staging-x', io, tag: '1' });
    assert.equal(r.ok, true);
    assert.equal(io.isFile(`${PAYLOAD}/current/index.html`), true);
  });

  test('an existing current is moved aside and then dropped', () => {
    const io = makeIo();
    io.writeFile(`${PAYLOAD}/current/index.html`, 'old');
    io.writeFile(`${PAYLOAD}/.staging-x/index.html`, 'new');
    const r = publishStaged({ payloadDir: PAYLOAD, staged: '.staging-x', io, tag: '1' });
    assert.equal(r.ok, true);
    assert.equal(io.files.get(`${PAYLOAD}/current/index.html`).toString(), 'new');
    assert.equal(io.exists(`${PAYLOAD}/.old-1`), false, '换成功就把旧的那份清掉');
  });

  test('a failed swap leaves the previous version in place — this is the whole safety story', () => {
    const io = makeIo();
    io.writeFile(`${PAYLOAD}/current/index.html`, 'old');
    io.writeFile(`${PAYLOAD}/current/build.json`, '{}');
    io.writeFile(`${PAYLOAD}/.staging-x/index.html`, 'new');
    const broken = {
      ...io,
      // 只把"staging → current"这一下弄坏（现实里是杀软/占用让 rename 失败）；
      // 回退那一下必须还能成功，否则测的就不是"换不动"而是"两头都动不了"。
      rename: (a, b) => {
        if (a.includes('.staging-')) throw new Error('EPERM: 被占用');
        return io.rename(a, b);
      },
    };
    const r = publishStaged({ payloadDir: PAYLOAD, staged: '.staging-x', io: broken, tag: '1' });
    assert.equal(r.ok, false);
    assert.match(r.why, /EPERM/);
    assert.equal(io.isFile(`${PAYLOAD}/current/index.html`), true, '上一份必须还在');
    assert.equal(io.files.get(`${PAYLOAD}/current/index.html`).toString(), 'old', '而且是上一份的内容，不是空的');
    assert.equal(io.isFile(`${PAYLOAD}/current/build.json`), true);
  });
});

describe('runUpdate 端到端', () => {
  /** 把一份代码增量打成 tar.gz，并按它的真 sha256 生成指针。 */
  function fixture({ files = codePayload(), pointerArt = null, cut = 'payload-v0.3.0-c46' } = {}) {
    const io = makeIo();
    seedArt(io);
    const art = computeArtDigest({ artDir: ART, io }).digest;
    const body = makeTarGz(files);
    const codeSha = sha256Hex(body);
    const p = pointer({ cut, codeSha, artDigest: pointerArt ?? art });
    const { impl, calls } = fakeFetch({
      [DEFAULT_POINTER_URL]: { json: p },
      [`https://d.example/v1/${p.code.file}`]: { body },
    });
    return { io, body, codeSha, pointer: p, art, fetch: impl, calls };
  }

  test('applies: overlay gets index.html + build.json, keeps a link to the art, and records which cut it is', async () => {
    const f = fixture();
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: f.io, fetchImpl: f.fetch, now: () => 1 });
    assert.equal(r.status, 'applied');
    assert.equal(r.cut, 'payload-v0.3.0-c46');
    assert.equal(f.io.isFile(`${PAYLOAD}/current/index.html`), true);
    assert.equal(f.io.isFile(`${PAYLOAD}/current/build.json`), true);
    assert.equal(f.io.links.get(`${PAYLOAD}/current/assets`), ART, '增量里没有美术 —— 必须把现有的那份接回来');
    const applied = f.io.readJsonIfExists(path.posix.join(PAYLOAD, 'current', APPLIED_FILE));
    assert.equal(applied.cut, 'payload-v0.3.0-c46');
    assert.equal(applied.code.sha256, `sha256:${f.codeSha}`);
    assert.equal(readAppliedCut({ overlayDir: `${PAYLOAD}/current`, io: f.io }), 'payload-v0.3.0-c46');
  });

  test('a second run with the same cut does nothing and downloads nothing', async () => {
    const f = fixture();
    await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: f.io, fetchImpl: f.fetch, now: () => 1 });
    const n = f.calls.length;
    const again = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: f.io, fetchImpl: f.fetch, now: () => 2 });
    assert.equal(again.status, 'skipped');
    assert.match(again.why, /已经是这一刀/);
    assert.equal(f.calls.filter((u) => u.includes('.tar.gz')).length, 1, '第二遍不该再下一次包');
    assert.ok(f.calls.length === n + 1, '只多了一次取指针');
  });

  test('art digest mismatch: no download at all, and the reason says "full package"', async () => {
    const f = fixture({ pointerArt: sha('别的美术') });
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: f.io, fetchImpl: f.fetch });
    assert.equal(r.status, 'skipped');
    assert.match(r.why, /美术指纹不同/);
    assert.equal(f.calls.some((u) => u.includes('.tar.gz')), false, '美术不对就不该去下载');
    assert.equal(f.io.exists(`${PAYLOAD}/current`), false);
  });

  test('sha256 mismatch: the bytes are dropped, never extracted', async () => {
    const f = fixture();
    const liar = fakeFetch({
      [DEFAULT_POINTER_URL]: { json: f.pointer },
      [`https://d.example/v1/${f.pointer.code.file}`]: { body: makeTarGz({ 'index.html': '被换掉的' }) },
    });
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: f.io, fetchImpl: liar.impl });
    assert.equal(r.status, 'download-failed');
    assert.equal(f.io.exists(`${PAYLOAD}/current`), false);
    const landed = [...f.io.files.keys()].filter((k) => k.startsWith(`${PAYLOAD}/`) && !k.endsWith('art-fingerprint.json'));
    assert.deepEqual(landed, [], '校验不过就一个字节都不落地（美术指纹缓存除外，那个是本地产物）');
  });

  test('the backup source is used when the domestic one is unreachable', async () => {
    const f = fixture();
    const routes = {
      [DEFAULT_POINTER_URL]: { json: f.pointer },
      [`https://gh.example/v1/${f.pointer.code.file}`]: { body: f.body },
    };
    const { impl, calls } = fakeFetch(routes);
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: f.io, fetchImpl: impl, now: () => 1 });
    assert.equal(r.status, 'applied');
    assert.ok(calls.some((u) => u.startsWith('https://gh.example/')));
  });

  test('a delta with a path outside the payload is refused whole', async () => {
    const f = fixture({ files: { 'index.html': 'x', 'build.json': '{}', '../../evil.txt': 'pwn' } });
    const routes = {
      [DEFAULT_POINTER_URL]: { json: f.pointer },
      [`https://d.example/v1/${f.pointer.code.file}`]: { body: f.body },
    };
    const { impl } = fakeFetch(routes);
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: f.io, fetchImpl: impl });
    assert.equal(r.status, 'bad-archive');
    assert.match(r.why, /指向目录外/);
    assert.equal(f.io.exists(`${PAYLOAD}/current`), false, '宁可不更，也不能让一个包写穿出去');
  });

  test('an archive that is not a payload (no index.html) is not published', async () => {
    const f = fixture({ files: { 'js/main.js': '1' } });
    const { impl } = fakeFetch({
      [DEFAULT_POINTER_URL]: { json: f.pointer },
      [`https://d.example/v1/${f.pointer.code.file}`]: { body: f.body },
    });
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: f.io, fetchImpl: impl });
    assert.equal(r.status, 'bad-archive');
    assert.match(r.why, /不像 payload/);
    assert.equal(f.io.exists(`${PAYLOAD}/current`), false);
  });

  test('no pointer reachable: silent skip, the game keeps running what it has', async () => {
    const { impl } = fakeFetch({});
    const io = makeIo();
    seedArt(io);
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io, fetchImpl: impl });
    assert.equal(r.status, 'no-pointer');
    assert.ok(r.why.length > 0);
  });

  test('a pointer that is not JSON is a skip, not a crash', async () => {
    const { impl } = fakeFetch({ [DEFAULT_POINTER_URL]: { json: 'not json at all' } });
    const io = makeIo();
    seedArt(io);
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io, fetchImpl: impl });
    assert.equal(r.status, 'no-pointer');
    assert.match(r.why, /指针不是对象/);
  });

  test('disabled → nothing is fetched', async () => {
    const { impl, calls } = fakeFetch({});
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: makeIo(), fetchImpl: impl, enabled: false });
    assert.equal(r.status, 'disabled');
    assert.equal(calls.length, 0);
  });

  test('a swap failure leaves the previous overlay playable', async () => {
    const f = fixture();
    await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: f.io, fetchImpl: f.fetch, now: () => 1 });
    assert.equal(f.io.files.get(`${PAYLOAD}/current/index.html`).toString(), '<html></html>');
    // 第二次（换一刀）时把 rename 弄坏：旧的那份必须原样留下。
    const second = fixture({ cut: 'payload-v0.3.1-c47', files: codePayload({ 'index.html': '<html>new</html>' }) });
    const merged = { ...second.io, files: f.io.files, dirs: f.io.dirs, links: f.io.links };
    merged.rename = (a, b) => {
      if (b.includes(`${PAYLOAD}/current`)) throw new Error('EPERM');
      return f.io.rename(a, b);
    };
    const r = await runUpdate({ payloadDir: PAYLOAD, artDir: ART, io: merged, fetchImpl: second.fetch, now: () => 2 });
    assert.equal(r.status, 'error');
    assert.equal(f.io.isFile(`${PAYLOAD}/current/index.html`), true, '换失败后 current 还在');
    assert.equal(f.io.files.get(`${PAYLOAD}/current/index.html`).toString(), '<html></html>', '还是旧那份');
  });
});
