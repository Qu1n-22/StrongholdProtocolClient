import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hook = readFileSync(resolve(ROOT, 'mobile/android/app/src/main/res/raw/stronghold_export_bridge.js'), 'utf8');
const native = readFileSync(resolve(ROOT, 'mobile/android/app/src/main/java/site/starst/stronghold/JsonExportBridge.java'), 'utf8');

function fixture({ hostname = 'localhost', response = '{"skins":{"char_1":"skin_2"}}' } = {}) {
  const saved = [], alerts = [], errors = [];
  let listener;
  const ctx = {
    location: { hostname },
    StrongholdSaveBridge: { saveJson: (...args) => saved.push(args) },
    document: { addEventListener: (name, cb, capture) => {
      assert.equal(name, 'click');
      assert.equal(capture, true);
      listener = cb;
    } },
    fetch: async url => {
      assert.equal(url, 'blob:https://localhost/blob-1');
      return { ok: true, text: async () => response };
    },
    console: { error: (...args) => errors.push(args) },
    alert: text => alerts.push(text),
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(hook, ctx);
  const dispatch = (name = 'stronghold-loadout-20261012-0930.json', url = 'blob:https://localhost/blob-1') => {
    let prevented = false;
    const anchor = { href: url, getAttribute: attr => attr === 'download' ? name : null };
    listener?.({ target: { closest: sel => sel === 'a[download]' ? anchor : null }, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { ctx, dispatch, saved, alerts, errors, get listener() { return listener; } };
}

test('installed Android: a Blob JSON export opens the native document picker with full skin payload', async () => {
  const t = fixture();
  assert.equal(t.dispatch(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(t.saved, [['stronghold-loadout-20261012-0930.json', '{"skins":{"char_1":"skin_2"}}']]);
  assert.equal(t.alerts.length, 0);
});

test('Android export handles ownership, DIY and stats; never takes unrelated downloads', async () => {
  const t = fixture();
  for (const type of ['ownership', 'diy', 'stats']) assert.equal(t.dispatch(`stronghold-${type}-20261012-0930.json`), true);
  assert.equal(t.dispatch('archive.zip'), false);
  assert.equal(t.dispatch('stronghold-loadout-20261012-0930.json', 'https://external.invalid/file'), false);
  assert.equal(t.dispatch('../../escape.json'), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.saved.length, 3);
});

test('Android export hook is local-page only and idempotent', () => {
  const t = fixture({ hostname: 'attacker.example' });
  assert.equal(t.listener, undefined);
  const local = fixture();
  const listener = local.listener;
  vm.runInNewContext(hook, local.ctx);
  assert.equal(local.listener, listener);
});

test('Android export rejects oversized payloads before calling the native bridge', async () => {
  const t = fixture({ response: 'X'.repeat(1_000_001) });
  assert.equal(t.dispatch(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.saved.length, 0);
  assert.equal(t.alerts.length, 1);
  assert.equal(t.errors.length, 1);
});

test('Android native bridge limits bridge authority to constrained JSON and a system file picker', () => {
  assert.match(native, /@JavascriptInterface/);
  assert.match(native, /new ActivityResultContracts\.CreateDocument\("application\/json"\)/);
  assert.match(native, /MAX_TEXT_LENGTH = 1_000_000/);
  assert.match(native, /NAME\.matcher\(filename\)\.matches\(\)/);
  assert.match(native, /openOutputStream\(uri, "wt"\)/);
  assert.doesNotMatch(native, /MANAGE_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/);
});
