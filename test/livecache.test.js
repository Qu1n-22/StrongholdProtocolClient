// 通用客户端的缓存层（docs/HANDSOFF.md §2）。三件事必须钉住，因为它们各自的坏法都是静默的：
//  1. 服务器地址被做成路径 → 写穿到缓存目录之外（玩家填的地址是外部输入）
//  2. build 指纹变了却还在读旧目录 → "服务器更新了客户端没跟上"，而这正是这一整套存在的理由
//  3. 服务器连不上 → 必须退回本地那份，而不是"打不开游戏"
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  CACHE_DIR, KEEP_BUILDS, UNKNOWN_BUILD,
  cachePathFor, chooseBuild, fetchInto, hostDirName, probeBuild, pruneBuilds, safeRel,
} from '../desktop/livecache.mjs';

describe('服务器地址 → 缓存目录名', () => {
  test('host 与端口留下，协议与路径不要', () => {
    assert.equal(hostDirName('http://150.158.38.174:3000/'), '150.158.38.174_3000');
    assert.equal(hostDirName('https://game.starst.site'), 'game.starst.site');
  });

  test('一个想写穿出去的地址被压成普通名字（玩家填的地址是外部输入）', () => {
    // 只认 authority 那一段（`://` 之后到第一个 `/`），所以 `../../evil` 里的斜杠根本进不来；
    // 剩下的 `..` 又被"不许以点开头"这一条吃掉，最后落到兜底名。要钉的是结果里没有 / 也没有前导点。
    const evil = hostDirName('http://../../evil/x');
    assert.ok(!evil.includes('/'), `结果里不能有斜杠：${evil}`);
    assert.ok(!evil.startsWith('.'), `结果不能以点开头（会变成隐藏目录）：${evil}`);
    assert.equal(hostDirName('http://a/b/../../c'), 'a', '路径那一段不参与命名');
    assert.equal(hostDirName(''), 'server', '空地址也有个去处，不能变成根目录');
  });
});

describe('pathname → 缓存相对路径', () => {
  test('查询串与协议前缀都剥掉', () => {
    assert.equal(safeRel('/js/main.js'), 'js/main.js');
    assert.equal(safeRel('/js/main.js?v=2'), 'js/main.js');
    assert.equal(safeRel('/assets/char/a.png?x=1#y'), 'assets/char/a.png');
  });

  test('目录穿越一律拒绝', () => {
    assert.equal(safeRel('/../../etc/passwd'), null);
    assert.equal(safeRel('/a/../../../b'), null);
    assert.equal(safeRel('/'), null);
    assert.equal(safeRel('/assets/'), null, '目录不进缓存');
    assert.equal(safeRel(''), null);
  });
});

describe('LRU 清理', () => {
  test('只留最新的两份，最新的那份绝不能删', () => {
    const entries = [
      { name: 'old1', mtime: 1 },
      { name: 'newest', mtime: 3 },
      { name: 'old2', mtime: 2 },
    ];
    // 三份留两份 → 只删最老的那一份；"最新的那份绝不能删"由 newest 不出现在结果里来钉。
    assert.deepEqual(pruneBuilds(entries), ['old1']);
    assert.equal(KEEP_BUILDS, 2);
    assert.deepEqual(pruneBuilds([...entries, { name: 'old0', mtime: 0 }]).sort(), ['old0', 'old1']);
  });

  test('不足两份时一份都不删', () => {
    assert.deepEqual(pruneBuilds([{ name: 'only', mtime: 1 }]), []);
    assert.deepEqual(pruneBuilds([]), []);
  });
});

describe('build 指纹从哪来', () => {
  test('服务器给了就用服务器的 —— 这正是"不用发安装包就能更新"的那一环', async () => {
    const impl = async () => ({ ok: true, json: async () => ({ build: 'a57d9c93c77a' }) });
    assert.equal(await probeBuild({ serverUrl: 'http://s:3000', fetchImpl: impl }), 'a57d9c93c77a');
  });

  for (const [name, impl] of [
    ['HTTP 非 2xx', async () => ({ ok: false, json: async () => ({}) })],
    ['没有 build 字段', async () => ({ ok: true, json: async () => ({ ok: true }) })],
    ['连不上', async () => { throw new Error('ECONNREFUSED'); }],
  ]) {
    test(`${name} → ''（调用方据此退回本地缓存）`, async () => {
      assert.equal(await probeBuild({ serverUrl: 'http://s:3000', fetchImpl: impl }), '');
    });
  }

  test('选哪一份：服务器说的 > 正在用的 > 本地最新的', () => {
    assert.deepEqual(chooseBuild({ probed: 'new', local: ['old'], current: 'cur' }), { build: 'new', source: '服务器' });
    const offline = chooseBuild({ probed: '', local: ['old'], current: 'cur' });
    assert.equal(offline.build, 'cur', '连不上服务器就继续用正在用的那份');
    assert.match(offline.source, /连不上服务器/);
    const cold = chooseBuild({ probed: '', local: ['old'], current: '' });
    assert.equal(cold.build, 'old', '冷启动连不上：用本地缓存里最新的');
    assert.match(cold.source, /离线/);
    assert.equal(chooseBuild({ probed: '', local: [], current: '' }).build, UNKNOWN_BUILD);
  });
});

describe('取文件：命中缓存 / 回源存盘 / 拿不到', () => {
  function io() {
    const files = new Map();
    return {
      files,
      isFile: (p) => files.has(p),
      readFile: (p) => files.get(p),
      writeFile: (p, b) => files.set(p, b),
    };
  }

  test('命中缓存就不发请求', async () => {
    const store = io();
    const dest = cachePathFor({ root: 'C:/U/cache', host: 'http://s:3000', build: 'b1', rel: 'js/main.js' });
    store.writeFile(dest, Buffer.from('cached'));
    let asked = 0;
    const impl = async () => { asked++; throw new Error('不该回源'); };
    const r = await fetchInto({ serverUrl: 'http://s:3000', rel: 'js/main.js', dest, io: store, fetchImpl: impl });
    assert.equal(r.ok, true);
    assert.equal(r.from, 'cache');
    assert.equal(r.body.toString(), 'cached');
    assert.equal(asked, 0);
  });

  test('没命中就回源并落盘', async () => {
    const store = io();
    const dest = cachePathFor({ root: 'C:/U/cache', host: 'http://s:3000', build: 'b1', rel: 'js/main.js' });
    const impl = async (url) => ({ ok: true, arrayBuffer: async () => new Uint8Array(Buffer.from(`from ${url}`)).buffer });
    const r = await fetchInto({ serverUrl: 'http://s:3000/', rel: 'js/main.js', dest, io: store, fetchImpl: impl });
    assert.equal(r.from, 'origin');
    assert.equal(r.body.toString(), 'from http://s:3000/js/main.js', '多个斜杠不能叠进去');
    assert.equal(store.isFile(dest), true, '取到就得存下来，否则下次还是回源');
  });

  test('回源失败不抛 —— 调用方要的是"没有"，不是异常', async () => {
    const store = io();
    const dest = cachePathFor({ root: 'C:/U/cache', host: 'http://s:3000', build: 'b1', rel: 'js/main.js' });
    for (const impl of [async () => ({ ok: false }), async () => { throw new Error('ENOTFOUND'); }]) {
      const r = await fetchInto({ serverUrl: 'http://s:3000', rel: 'js/main.js', dest, io: store, fetchImpl: impl });
      assert.equal(r.ok, false);
      assert.equal(r.body, null);
      assert.equal(r.from, '');
    }
  });
});

describe('缓存落点', () => {
  test('root/host/build/rel 四层，换服务器互不污染', () => {
    const a = cachePathFor({ root: 'C:/U/cache', host: 'http://150.158.38.174:3000', build: 'b1', rel: 'js/main.js' });
    const b = cachePathFor({ root: 'C:/U/cache', host: 'http://game.starst.site', build: 'b1', rel: 'js/main.js' });
    assert.notEqual(a, b);
    assert.ok(a.startsWith(path.join('C:/U/cache', '150.158.38.174_3000', 'b1')));
  });

  test('build 换掉就是另一份 —— 这就是"更新"本身', () => {
    const one = cachePathFor({ root: 'C:/U/cache', host: 'http://s', build: 'b1', rel: 'index.html' });
    const two = cachePathFor({ root: 'C:/U/cache', host: 'http://s', build: 'b2', rel: 'index.html' });
    assert.notEqual(one, two);
  });

  test('缓存根的目录名写死在这里，两个壳不能各叫各的', () => {
    assert.equal(CACHE_DIR, 'cache');
  });
});
