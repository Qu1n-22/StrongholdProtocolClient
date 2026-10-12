import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../shell/picker.js', import.meta.url), 'utf8');
const match = source.match(/function probeOnce\(wsUrl, timeoutMs\) \{[\s\S]*?\n\}\n\n\/\*\*/);
assert.ok(match, 'probeOnce source must remain extractable for a browser-like smoke test');
const code = match[0].slice(0, -'\n\n/**'.length);

function harness({ welcome, health, pong = true, wsDelay = 0, healthDelay = 0 } = {}) {
  const sent = [];
  const sockets = [];
  class WebSocket {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sockets.push(this);
      setTimeout(() => this.onopen?.(), wsDelay);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      sent.push(msg);
      if (msg.t === 'hello' && welcome !== undefined) {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(welcome) }), 0);
      }
      if (msg.t === 'ping' && pong) {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: 'pong', c: msg.c }) }), 2);
      }
    }
    close() { this.closed = true; }
  }
  const fetch = () => new Promise((resolve, reject) => setTimeout(() => {
    if (health === null) reject(new Error('CORS'));
    else resolve({ ok: true, json: async () => health ?? { ok: true } });
  }, healthDelay));
  const context = { WebSocket, fetch, Date, JSON, Promise, setTimeout, clearTimeout };
  runInNewContext("const PONG_WAIT_MS = 1200; const httpUrlOf = (ws) => ws.replace(/^ws/, 'http').replace(/\\/ws$/, '');\n" + code + "\nthis.probe = probeOnce;", context);
  return { run: (timeout = 100) => context.probe('wss://test.example/ws', timeout), sent, sockets };
}

test('a reverse proxy that responds 101 but never answers hello is NOT a valid game server', async () => {
  const t = harness({ health: { app: '0.2.4' } });
  const r = await t.run(35);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.info.app, '0.2.4');
  assert.deepEqual(t.sent.map(m => m.t), ['hello']);
});

test('welcome + pong validates game protocol and reports application RTT, not HTTP upgrade time', async () => {
  const t = harness({ welcome: { t: 'welcome', playerId: 'p1', app: '0.2.4-mod' }, health: { app: '0.2.3', rooms: 3 }, wsDelay: 12 });
  const r = await t.run(120);
  assert.equal(r.ok, true);
  assert.equal(r.info.app, '0.2.4-mod', 'welcome.app wins over healthz');
  assert.equal(r.info.rooms, 3);
  assert.equal(typeof r.rttMs, 'number');
  assert.ok(r.ms >= r.rttMs, 'elapsed connection time and gameplay RTT differ');
  assert.deepEqual(t.sent.map(m => m.t), ['hello', 'ping']);
  assert.deepEqual(t.sent[0], { t: 'hello', rid: 1, name: '探针', version: 1 });
  assert.ok(t.sockets[0].closed);
});

test('modded server without welcome.app falls back to healthz.app, even if health arrives after pong', async () => {
  const t = harness({ welcome: { t: 'welcome', playerId: 'p2' }, health: { app: '0.2.4', rooms: 2 }, healthDelay: 23 });
  const r = await t.run(160);
  assert.equal(r.ok, true);
  assert.equal(r.info.app, '0.2.4');
  assert.equal(r.info.rooms, 2);
  assert.ok(Number.isFinite(r.rttMs));
});

test('legacy server without pong remains joinable with RTT unknown, without pretending it responded', async () => {
  const t = harness({ welcome: { t: 'welcome', playerId: 'p3' }, health: { app: '0.2.4' }, pong: false });
  const r = await t.run(45);
  assert.equal(r.ok, true);
  assert.equal(r.rttMs, null);
});

test('page renders measured protocol RTT explicitly and preserves user-selected server', () => {
  assert.match(source, /RTT\s*\$\{st\.rttMs\}ms/);
  assert.match(source, /rttMs:\s*result\.rttMs/);
  assert.match(source, /writeItem\(K_SERVER,\s*address,\s*'localStorage'\)/);
  assert.doesNotMatch(source, /sort\(\(a,\s*b\)\s*=>\s*a\.rttMs/);
});
