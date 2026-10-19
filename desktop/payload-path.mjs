// Where the payload lives — one chain for both desktop shells.
//
// The shell and the payload are separate releases: the shell (Electon/Tauri + the ~800 MB of art) is installed once,
// while the game code changes on every upstream sync. `docs/AUTO-UPDATE.md` §1 is the split, and this module is §3
// step 1: making "an outside payload copy" selectable at all. Nothing here downloads anything — it only answers
// "which directory do we serve this run", because that single decision is where an auto-updater can hurt a player.
//
// The rule that shapes the order: **a broken overlay must never cost a player the game.** The overlay is tried first
// (it is the thing that is newer), but if it fails the check we fall through to the copy that shipped inside the
// installer and record *why* — the reason goes to `<userData>/client.log`, which is the file a player sends us.
//
// What counts as a usable payload is deliberately two files, not "the directory exists": `index.html` (the page) and
// `build.json` (the packer's provenance). A half-extracted or half-deleted overlay has one and not the other, and
// both shells ask the same question so the answer can't drift apart.

import path from 'node:path';

/** Relative to `userData`: where an applied update lives, and which one is active. */
export const OVERLAY_DIR = 'payload';
export const CURRENT_LINK = 'current';
/** The candidate `source` label of the applied update — the one candidate the version / art rules govern. */
export const OVERLAY_SOURCE = '已应用的更新';

/** Why a directory is not a payload. Order matters: `index.html` first, then the provenance file. */
export function payloadProblem(dir, { isFile, join = path.join }) {
  if (!isFile(join(dir, 'index.html'))) return '缺 index.html';
  if (!isFile(join(dir, 'build.json'))) return '缺 build.json（这个目录不是 payload 根，或解包解了一半）';
  return '';
}

/**
 * Why a payload cannot serve a game with art. An update overlay is **code-only**: its `assets/` is a link back to
 * the installed copy (updater.mjs §4), so a payload whose `assets/` is missing or whose link dangled serves a game
 * with no art at all — exactly the "素材没加载 / 只剩头像" reports. Checked for the overlay only: `$SP_WWW` is a
 * developer override (their choice), and the bundled copy ships the art inside the installer.
 */
export function artProblem(dir, { isDir, isFile, join = path.join }) {
  if (!isDir(join(dir, 'assets'))) return '缺 assets/（更新的代码增量没接到美术，或美术链接断了）';
  if (!isFile(join(dir, 'data', 'assets.json'))) return '缺 data/assets.json（美术清单不在，素材加载不出来）';
  return '';
}

/** '0.3.1' → [0,3,1]；读不出来（缺文件、不是版本号）就是 null，规则对它不生效。 */
export function parseVersion(s) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

/** 负数 = a 更旧；只比较 parseVersion 认得的两个。 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  return 0;
}

/**
 * The candidates, best-first. Kept a plain list so both shells and the tests can assert the *order*, not just the
 * members — `SP_WWW` beating an applied update is what makes the overlay debuggable, and the bundled copy coming
 * before the dev checkout is what keeps a stray `www/` in a working directory from shadowing the installed game.
 *
 * @param {{ env?: Record<string,string|undefined>, resourcesPath?: string, userData?: string,
 *           devDir?: string }} o
 * @returns {{ dir: string, source: string }[]}
 */
export function wwwCandidates({ env = {}, resourcesPath, userData, devDir }) {
  const out = [];
  if (env.SP_WWW) out.push({ dir: env.SP_WWW, source: 'SP_WWW' });
  if (userData) {
    // Windows: %APPDATA%\<app>; macOS: ~/Library/Application Support/<app>; Linux: ~/.local/share/<app>.
    // `app.getPath('userData')` hands us the right one, so this module never derives it itself.
    out.push({ dir: path.join(userData, OVERLAY_DIR, CURRENT_LINK), source: OVERLAY_SOURCE });
  }
  if (resourcesPath) out.push({ dir: path.join(resourcesPath, 'www'), source: '安装包内置' });
  if (devDir) out.push({ dir: path.join(devDir, 'build', 'client', 'www'), source: '仓库里的构建产物' });
  return out;
}

/**
 * Pick the payload to serve. `isFile` / `isDir` / `versionOf` are injected rather than read here: the shells ask a
 * real filesystem while the tests ask a Map, and the judgements both must make identically live in this module.
 *
 * `isDir` / `versionOf` are optional; without them the pick is the plain usability chain. With them two extra rules
 * protect a player who reinstalls:
 *
 *  * **版本规则**（`versionOf`）：重装/升级了更完整的安装包之后，`<userData>/payload/current` 里上一份安装
 *    留下的更新残留不能反过来盖住新包 —— 否则新装 0.3.1 的玩家跑的是旧 overlay 里的 0.3.0 代码
 *    （2026-10-19「素材没匹配上」的根因）。只对 overlay 生效，版本读不出（null）就当不适用。
 *  * **美术规则**（`isDir`）：overlay 是纯代码增量，assets/ 是链接回安装包的一条链接；链接断了就等于
 *    「素材没加载」。缺美术的 overlay 跳过，落到安装包内置那份。
 *
 * @param {{ candidates: {dir:string, source:string}[], isFile: (p:string)=>boolean,
 *           isDir?: (p:string)=>boolean, versionOf?: (dir:string)=>string }} o
 * @returns {{ dir: string|null, source: string, rejected: {dir:string, source:string, why:string}[] }}
 */
export function resolveWww({ candidates, isFile, isDir, versionOf }) {
  const rejected = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const isOverlay = c.source === OVERLAY_SOURCE;
    // 版本规则：overlay 比任何一个排在它后面的候选（安装包内置 / 仓库构建）都旧 → 跳过。
    if (isOverlay && versionOf) {
      const mine = parseVersion(versionOf(c.dir));
      if (mine) {
        const newerIdx = candidates.findIndex((o, k) => {
          if (k <= i) return false;
          const v = parseVersion(versionOf(o.dir));
          return v && compareVersions(versionOf(c.dir), versionOf(o.dir)) < 0;
        });
        if (newerIdx >= 0) {
          rejected.push({ dir: c.dir, source: c.source, why: `比安装包内置的旧（${versionOf(c.dir)} < ${versionOf(candidates[newerIdx].dir)}）—— 重装过完整包，旧更新残留不再生效` });
          continue;
        }
      }
    }
    let why = payloadProblem(c.dir, { isFile });
    if (!why && isOverlay && isDir) why = artProblem(c.dir, { isDir, isFile });
    if (!why) return { dir: c.dir, source: c.source, rejected };
    rejected.push({ dir: c.dir, source: c.source, why });
  }
  return { dir: null, source: '', rejected };
}
