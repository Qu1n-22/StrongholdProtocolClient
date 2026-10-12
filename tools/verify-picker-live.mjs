import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const text = readFileSync(new URL('../shell/picker.js', import.meta.url), 'utf8');
const match = text.match(/function probeOnce\(wsUrl, timeoutMs\) \{[\s\S]*?\n\}\n\n\/\*\*/);
if (!match) throw Error('probeOnce missing');
const source = match[0].slice(0, -'\n\n/**'.length);
const context = { WebSocket, fetch, Date, Promise, JSON, setTimeout, clearTimeout };
runInNewContext("const PONG_WAIT_MS=1200;const httpUrlOf=w=>w.replace(/^ws/,'http').replace(/\\/ws$/,'');\n" + source + "\nthis.runProbe=probeOnce;", context);
for (const target of ['wss://sp.lain42.top/ws', 'wss://wei.linxia.dev/ws']) {
  const x = await context.runProbe(target, 6500);
  console.log(JSON.stringify({ target, ok: x.ok, app: x.info?.app || null, rttMs: x.rttMs, connectTotalMs: x.ms }));
}
