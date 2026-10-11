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

/** Why a directory is not a payload. Order matters: `index.html` first, then the provenance file. */
export function payloadProblem(dir, { isFile, join = path.join }) {
  if (!isFile(join(dir, 'index.html'))) return '缺 index.html';
  if (!isFile(join(dir, 'build.json'))) return '缺 build.json（这个目录不是 payload 根，或解包解了一半）';
  return '';
}

/**
 * The candidates, best-first. Kept a plain list so both shells and the tests can assert the *order*, not just the
 * members — `SP_WWW` beating an applied update is what makes the overlay debuggable, and the bundled copy coming
 * before the dev checkout is what keeps a stray `www/` in a working directory from shadowing the installed game.
 *
 * `base: true` marks the one candidate that is also the **fallback root**: an applied update is a *code* pack
 * (`docs/AUTO-UPDATE.md` §1 — everything except `assets/`), so the server has to answer for the art out of the copy
 * the installer left behind. Without it, a player who updates gets a payload that looks new and renders nothing.
 *
 * @param {{ env?: Record<string,string|undefined>, resourcesPath?: string, userData?: string,
 *           devDir?: string }} o
 * @returns {{ dir: string, source: string, base?: true }[]}
 */
export function wwwCandidates({ env = {}, resourcesPath, userData, devDir }) {
  const out = [];
  if (env.SP_WWW) out.push({ dir: env.SP_WWW, source: 'SP_WWW' });
  if (userData) {
    // Windows: %APPDATA%\<app>; macOS: ~/Library/Application Support/<app>; Linux: ~/.local/share/<app>.
    // `app.getPath('userData')` hands us the right one, so this module never derives it itself.
    out.push({ dir: path.join(userData, OVERLAY_DIR, CURRENT_LINK), source: '已应用的更新' });
  }
  if (resourcesPath) out.push({ dir: path.join(resourcesPath, 'www'), source: '安装包内置', base: true });
  if (devDir) out.push({ dir: path.join(devDir, 'build', 'client', 'www'), source: '仓库里的构建产物' });
  return out;
}

/**
 * Pick the payload to serve. `isFile` is injected rather than read here: the shells ask a real filesystem while the
 * tests ask a Map, and "is this a usable payload" is the one judgement both must make identically.
 *
 * `base` is the fallback root (see {@link wwwCandidates}) — the second root the server asks when the chosen payload
 * does not have a file. It is looked up from the candidate list rather than assumed, because a dev checkout or
 * `SP_WWW` can be the chosen payload while the installer's copy is still what has the art. It is `undefined` when
 * there is no such candidate, and the server then has exactly one root.
 *
 * @param {{ candidates: {dir:string, source:string, base?:true}[], isFile: (p:string)=>boolean }} o
 * @returns {{ dir: string|null, source: string, base: string|undefined,
 *             rejected: {dir:string, source:string, why:string}[] }}
 */
export function resolveWww({ candidates, isFile }) {
  const rejected = [];
  for (const c of candidates) {
    const why = payloadProblem(c.dir, { isFile });
    if (!why) {
      const fallback = candidates.find((x) => x.base);
      return { dir: c.dir, source: c.source, base: fallback?.dir, rejected };
    }
    rejected.push({ dir: c.dir, source: c.source, why });
  }
  return { dir: null, source: '', base: candidates.find((x) => x.base)?.dir, rejected };
}
