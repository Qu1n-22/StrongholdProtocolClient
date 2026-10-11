// Which payload directory a desktop shell serves. The order is the product decision; the tests exist because the
// failure mode is silent: pick the wrong directory and the player either sees an old game after "updating" or sees
// nothing at all, with nothing on screen saying why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { payloadProblem, resolveWww, wwwCandidates } from '../desktop/payload-path.mjs';

const FILES = (...p) => new Set(p.map((x) => path.normalize(x)));
const isFileIn = (set) => (p) => set.has(path.normalize(p));

const USER_DATA = path.join('U', 'AppData');
const RES = path.join('R', 'resources');
const DEV = path.join('D', 'repo');
const overlay = (f) => path.join(USER_DATA, 'payload', f);
const bundled = (f) => path.join(RES, 'www', f);
const dev = (f) => path.join(DEV, 'build', 'client', 'www', f);
const envDir = (f) => path.join('E', 'www', f);

const cands = (env = {}) => wwwCandidates({ env, resourcesPath: RES, userData: USER_DATA, devDir: DEV });

test('the chain is: $SP_WWW, then an applied update, then the bundled copy, then a repo build', () => {
  assert.deepEqual(cands().map((c) => c.source), ['已应用的更新', '安装包内置', '仓库里的构建产物']);
  assert.deepEqual(cands({ SP_WWW: path.join('E', 'www') }).map((c) => c.source),
    ['SP_WWW', '已应用的更新', '安装包内置', '仓库里的构建产物']);
  // 一个躺在工作目录里的 www/ 不该盖掉装好的那份，所以 dev 永远排最后。
  assert.ok(cands().at(-1).source === '仓库里的构建产物');
});

test('an applied update wins over the bundled copy', () => {
  const files = FILES(overlay('current/index.html'), overlay('current/build.json'), bundled('index.html'), bundled('build.json'));
  const r = resolveWww({ candidates: cands(), isFile: isFileIn(files) });
  assert.equal(r.source, '已应用的更新');
  assert.equal(r.dir, overlay('current'));
  assert.deepEqual(r.rejected, []);
});

test('a half-extracted update is skipped, the bundled game still runs, and the reason survives', () => {
  // 只有 index.html 没有 build.json 正是"解包解了一半"的形状 —— 用它服务会白屏。
  const files = FILES(overlay('current/index.html'), bundled('index.html'), bundled('build.json'));
  const r = resolveWww({ candidates: cands(), isFile: isFileIn(files) });
  assert.equal(r.source, '安装包内置', '更新坏了必须还能玩内置那份，而不是起一个空目录');
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].source, '已应用的更新');
  assert.match(r.rejected[0].why, /build\.json/);
  assert.ok(r.rejected[0].dir.includes('current'), '被跳过的是哪个目录要说得出来（client.log 里就靠它）');
});

test('a directory that is not a payload root at all is reported as such', () => {
  const empty = FILES();
  const r = resolveWww({ candidates: cands(), isFile: isFileIn(empty) });
  assert.equal(r.dir, null);
  assert.deepEqual(r.rejected.map((x) => x.why), ['缺 index.html', '缺 index.html', '缺 index.html']);
});

test('a bad $SP_WWW does not break the launch', () => {
  const files = FILES(bundled('index.html'), bundled('build.json'));
  const r = resolveWww({ candidates: cands({ SP_WWW: path.join('E', 'www') }), isFile: isFileIn(files) });
  assert.equal(r.source, '安装包内置');
  assert.equal(r.rejected[0].source, 'SP_WWW');
});

test('packaged and dev runs differ only by which candidates exist', () => {
  const packaged = wwwCandidates({ env: {}, resourcesPath: RES, userData: USER_DATA });
  assert.deepEqual(packaged.map((c) => c.source), ['已应用的更新', '安装包内置']);
  const fromRepo = wwwCandidates({ env: {}, userData: USER_DATA, devDir: DEV });
  assert.deepEqual(fromRepo.map((c) => c.source), ['已应用的更新', '仓库里的构建产物']);
});

test('payloadProblem names the missing file instead of a bare false', () => {
  assert.match(payloadProblem('X', { isFile: () => false }), /index\.html/);
  assert.match(payloadProblem('X', { isFile: (p) => p.endsWith('index.html') }), /build\.json/, '只有 index.html 时缺的是 build.json');
  assert.equal(payloadProblem('X', { isFile: (p) => p.endsWith('index.html') || p.endsWith('build.json') }), '', '两个文件都在才算合格');
});

// ---- 回落根（第二个根） -------------------------------------------------------------------------------------
//
// 已应用的更新是**代码包**（docs/AUTO-UPDATE.md §1：除 assets/ 外的全部），所以服务端必须拿安装目录那份接住
// 美术请求。这里钉的是"回落根是谁"这个决定本身 —— 选错了玩家看到的是"更新成功、画面全空"。

test('the installed copy is marked as the fallback root, and it is the only one', () => {
  const packaged = wwwCandidates({ env: {}, resourcesPath: RES, userData: USER_DATA, devDir: DEV });
  assert.deepEqual(packaged.filter((c) => c.base).map((c) => c.source), ['安装包内置']);
  // $SP_WWW 与 dev checkout 都不是回落根：一个是被测的那份，一个是开发机上的构建产物，都不该成为玩家的素材来源。
  assert.equal(packaged.find((c) => c.source === 'SP_WWW'), undefined);
  assert.equal(wwwCandidates({ env: { SP_WWW: 'E' }, resourcesPath: RES, userData: USER_DATA }).filter((c) => c.base).length, 1);
});

test('an applied update comes with the installed copy as its fallback', () => {
  const files = FILES(
    overlay('current/index.html'), overlay('current/build.json'),
    bundled('index.html'), bundled('build.json'), bundled('assets/portrait.png'),
  );
  const r = resolveWww({ candidates: cands(), isFile: isFileIn(files) });
  assert.equal(r.source, '已应用的更新');
  assert.equal(r.base, path.join(RES, 'www'), '代码包里没有 assets/，所以回落根必须是安装目录那份');
  assert.notEqual(r.base, r.dir, '自己给自己当回落根等于没有回落');
});

test('with no update applied the fallback collapses onto the chosen payload', () => {
  // 没有更新时 dir 与 base 是同一个目录 —— 服务端会把它去掉，只剩一个根。这条是"没有更新就别多查一次"的契约。
  const files = FILES(bundled('index.html'), bundled('build.json'));
  const r = resolveWww({ candidates: cands(), isFile: isFileIn(files) });
  assert.equal(r.source, '安装包内置');
  assert.equal(r.base, r.dir);
});

test('a dev checkout still falls back to the installed copy for the art it lacks', () => {
  const files = FILES(dev('index.html'), dev('build.json'), bundled('index.html'), bundled('build.json'));
  const r = resolveWww({ candidates: wwwCandidates({ env: {}, userData: USER_DATA, devDir: DEV }), isFile: isFileIn(files) });
  assert.equal(r.source, '仓库里的构建产物');
  assert.equal(r.base, undefined, '开发跑没有安装目录候选，所以没有回落根 —— 不能凭空编一个');
});

test('no candidate at all still reports the fallback it would have used', () => {
  const r = resolveWww({ candidates: cands(), isFile: isFileIn(FILES()) });
  assert.equal(r.dir, null);
  assert.equal(r.base, path.join(RES, 'www'), '启动日志要说得清"本来会回落到哪"');
});
