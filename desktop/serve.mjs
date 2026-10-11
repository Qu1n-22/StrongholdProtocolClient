// Minimal static file server for the packaged desktop client (desktop/main.mjs).
//
// tools/package-client.mjs already flattens the game server's mount layout into one directory (www/), so the
// Electron shell only has to serve plain files — no /data.js shim, no sim mount rules, no WebSocket. It binds
// loopback only: the packaged client is the sole consumer, and game traffic goes to the remote server instead.
//
// MIME / COMPRESSIBLE mirror server/index.js; test/packaging.test.js pins the two tables together so they cannot
// drift apart.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

/** Extension → Content-Type (same table as server/index.js MIME). */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
});

/**
 * Loopback port the desktop shell asks for. Chromium scopes localStorage (and the shell's own `sp.shell.*`
 * server choice) by *origin*, so the old `port: 0` — a fresh OS-assigned port every launch — meant every run
 * wrote to a different `http://127.0.0.1:<port>` and read back nothing: identity token, loadout, settings and
 * the remembered server were "lost" on every restart. A pinned port keeps the origin (and therefore the data).
 */
export const DEFAULT_PORT = 47821;
/** Consecutive ports tried when the preferred one is taken. The order is fixed, so the origin stays put anyway. */
export const PORT_SEARCH = 16;
/**
 * Bind errors that mean "this port is not usable *on this machine*", so the search should move on instead of
 * killing the shell. `EACCES` is the Windows case: Hyper-V / WSL2 / Docker Desktop reserve whole blocks of the
 * dynamic range (`netsh interface ipv4 show excludedportrange protocol=tcp`), and a bind into one of those answers
 * EACCES, not EADDRINUSE. Measured on windows-latest 2026-10-09 — the search from a busy 50000 died on
 * `listen EACCES: permission denied 127.0.0.1:50001` instead of trying 50002, which is the same shape as "the
 * desktop exe refuses to start on a player who happens to have a reservation over 47821..47836". The Tauri shell
 * already skipped every bind error (`tauri/src-tauri/src/server.rs`: `Err(_) => continue`); these two must agree.
 */
export const PORT_SKIP_CODES = new Set(['EADDRINUSE', 'EACCES', 'EPERM']);

/** First path segments under www/ that are content-addressed enough to cache for a day (server/index.js LONG_CACHE_DIRS). */
export const LONG_CACHE_DIRS = new Set(['assets', 'fonts', 'vendor', 'webfonts']);
export const LONG_CACHE = 'public, max-age=86400';
const NO_CACHE = 'no-cache';

/** The extension-less audio alias and the extensions it may resolve to (`shared/media.js`, served by server/index.js). */
export const MEDIA_PREFIX = '/media/';
export const AUDIO_EXTS = Object.freeze(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav']);
/** Where the real audio files live in the flattened payload. */
const AUDIO_ROOT_SEGMENTS = ['assets', 'audio'];

/**
 * `/media/bgm/act1` → `<root>/assets/audio/bgm/act1.mp3`.
 *
 * `public/js/media.js` rewrites every audio URL to this extension-less form so download managers (IDM / 迅雷) don't
 * grab each BGM, and only `server/index.js` knew how to resolve it back. The packaged shell is the only other host
 * of these files, so it has to answer the alias too — otherwise the desktop client plays nothing.
 *
 * @param {string} root absolute payload root
 * @param {string} rawUrl e.g. `/media/bgm/act1?v=3`
 * @returns {Promise<string|null>} absolute file path, or null when the request is not a media alias / matches nothing
 */
export async function resolveMediaPath(root, rawUrl) {
  const q = rawUrl.indexOf('?');
  let decoded;
  try { decoded = decodeURIComponent(q === -1 ? rawUrl : rawUrl.slice(0, q)); } catch { return null; }
  if (!decoded.startsWith(MEDIA_PREFIX)) return null;

  const rest = decoded.slice(MEDIA_PREFIX.length);
  const segments = rest.split('/').filter((s) => s.length > 0);
  // A trailing slash or an empty stem addresses a directory, and a dot-led/-ended segment could address something else.
  if (!segments.length || rest.endsWith('/')) return null;
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.') || s.endsWith('.'))) return null;

  const last = segments[segments.length - 1];
  const given = AUDIO_EXTS.find((e) => last.toLowerCase().endsWith(e)) || '';
  const stem = given ? last.slice(0, -given.length) : last;
  if (!stem) return null;

  const audioRoot = path.join(root, ...AUDIO_ROOT_SEGMENTS);
  const dir = path.join(audioRoot, ...segments.slice(0, -1));
  if (dir !== audioRoot && !dir.startsWith(audioRoot + path.sep)) return null;

  for (const ext of (given ? [given] : AUDIO_EXTS)) {
    const candidate = path.join(dir, stem + ext);
    try { if ((await fsp.stat(candidate)).isFile()) return candidate; } catch { /* try the next extension */ }
  }
  return null;
}

/** @param {string} ext @param {string[]} segments */
export function cacheControlFor(ext, segments) {
  if (ext === '.html' || ext === '.htm') return NO_CACHE;
  if (segments.length > 1 && LONG_CACHE_DIRS.has(segments[0])) return LONG_CACHE;
  return NO_CACHE;
}

/**
 * Decode and vet a request URL into path segments, or null when it must be rejected (traversal, dotfile, …).
 *
 * Split out from {@link resolveTarget} because a request may have to be tried against more than one root: the
 * payload is cut in two (`docs/AUTO-UPDATE.md` §1), an applied update carries the game code and the installer's copy
 * carries `assets/`. Whether a URL is *allowed* does not depend on which root answers it, so the check happens once
 * and the joining happens per root — that way a second root can never be the one that lets a `..` through.
 *
 * @param {string} rawUrl e.g. `/js/main.js?v=2`
 * @returns {string[]|null} segments ([] for `/`), or null when rejected
 */
export function urlSegments(rawUrl) {
  const q = rawUrl.indexOf('?');
  let decoded;
  try { decoded = decodeURIComponent(q === -1 ? rawUrl : rawUrl.slice(0, q)); } catch { return null; }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
  return segments;
}

/**
 * Resolve a request URL path to a file inside `root`, or null when it must be rejected (traversal, dotfile, …).
 * @param {string} root absolute
 * @param {string} rawUrl e.g. `/js/main.js?v=2`
 * @returns {string|null} absolute path (may not exist)
 */
export function resolveTarget(root, rawUrl) {
  const segments = urlSegments(rawUrl);
  if (!segments) return null;
  const target = path.join(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * The roots a request is tried against, best-first: the payload we chose to serve, then the copy inside the
 * installer. `base` is only consulted when the chosen payload does not have the file — which is the normal case for
 * everything under `assets/`, because the code pack deliberately excludes it.
 *
 * @param {string} root absolute
 * @param {string|undefined|null} base absolute, optional
 * @returns {string[]} 1 or 2 roots
 */
export function serverRoots(root, base) {
  const roots = [path.resolve(root)];
  if (base) {
    const b = path.resolve(base);
    // A base that *is* the root would just be the same lookup twice; two different roots must not nest, or the
    // relative path used for cache rules and the media alias could resolve differently in each.
    if (b !== roots[0]) roots.push(b);
  }
  return roots;
}

/** `bytes=a-b` → [start, end] clamped to the file, or null (ignored / unsatisfiable). */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return [start, Math.min(end, size - 1)];
}

/**
 * Start the loopback static server.
 *
 * `port > 0` is preferred and, if it is busy, the next PORT_SEARCH consecutive ports are tried before giving up
 * and letting the OS pick one (`port: 0`). The caller keeps the resulting origin stable by passing a fixed port
 * (see DEFAULT_PORT) — persistence in the page depends on it.
 *
 * `base` is the second root, consulted only when `root` has no such file. An applied update is a *code* pack
 * (`docs/AUTO-UPDATE.md` §1: everything except `assets/`), so without the fallback every spine, portrait and BGM
 * would 404 the moment a player updates — the payload would look updated and render nothing.
 *
 * @param {{ root: string, base?: string, host?: string, port?: number, log?: { warn?: Function, error?: Function } }} opts
 * @returns {Promise<{ url: string, port: number, server: http.Server, close: () => Promise<void> }>}
 */
export function createStaticServer({ root, base, host = '127.0.0.1', port = 0, log = console } = {}) {
  const roots = serverRoots(root, base);

  const finish = (req, res, status, headers, body) => {
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const notFound = (req, res, forbidden) => finish(
    req, res, forbidden ? 403 : 404,
    { 'Content-Type': 'text/plain; charset=utf-8' },
    forbidden ? 'forbidden' : 'not found',
  );

  /**
   * First root that really has this URL as a file, best-first. A directory answers with its `index.html` (a root
   * *is* a directory, so `/` has to). A root that has the directory but no `index.html` is a miss, not an answer —
   * otherwise a partially extracted overlay would shadow the installer's copy with a 404.
   *
   * `forbidden` is only reported when *no* root had the file: an unreadable file in the overlay must not be
   * reported as "not found", and it must not silently serve the older copy either.
   *
   * @returns {Promise<{ absPath: string, stat: import('node:fs').Stats, root: string } | { forbidden: true } | null>}
   */
  async function pick(rawUrl) {
    const isAlias = (rawUrl.split('?')[0] || '').startsWith(MEDIA_PREFIX);
    let denied = false;
    for (const r of roots) {
      // `/media/…` never names a real directory: it is the alias, or it is nothing. Falling through to a
      // `<root>/media/…` lookup would answer a request for music with whatever happens to sit there.
      const absPath = isAlias ? await resolveMediaPath(r, rawUrl) : resolveTarget(r, rawUrl);
      if (!absPath) continue;
      try {
        let stat = await fsp.stat(absPath);
        let file = absPath;
        if (stat.isDirectory()) {
          file = path.join(absPath, 'index.html');
          stat = await fsp.stat(file);
        }
        if (stat.isFile()) return { absPath: file, stat, root: r };
      } catch (e) {
        if (e && (e.code === 'EACCES' || e.code === 'EPERM')) denied = true;
      }
    }
    return denied ? { forbidden: true } : null;
  }

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      finish(req, res, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'method not allowed');
      return;
    }
    const rawUrl = req.url || '/';
    if (!urlSegments(rawUrl)) { notFound(req, res, true); return; }

    const hit = await pick(rawUrl);
    if (!hit) { notFound(req, res, false); return; }
    if (hit.forbidden) { notFound(req, res, true); return; }
    const { absPath, stat } = hit;

    // Cache rules are relative to the root that answered, so a file served out of the installer's copy is still
    // recognised as living under `assets/` and gets the long cache.
    const segments = path.relative(hit.root, absPath).split(path.sep);
    const ext = path.extname(absPath).toLowerCase();
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(ext, segments),
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }

    const range = parseRange(req.headers.range, stat.size);
    if (range) {
      const [start, end] = range;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = String(end - start + 1);
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(absPath, { start, end }).pipe(res);
      return;
    }
    if (req.headers.range) {
      headers['Content-Range'] = `bytes */${stat.size}`;
      res.writeHead(416, headers);
      res.end();
      return;
    }
    headers['Content-Length'] = String(stat.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(absPath).pipe(res);
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    handle(req, res).catch((e) => {
      log.error?.('[client] request failed', req.url, e);
      if (!res.headersSent) finish(req, res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'internal error');
      else res.end();
    });
  });

  const candidates = port > 0
    ? [...Array.from({ length: PORT_SEARCH }, (_, i) => port + i).filter((p) => p <= 65535), 0]
    : [0];

  const listen = (p) => new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, host);
  });

  return (async () => {
    let failure = null;
    for (let i = 0; i < candidates.length; i++) {
      const p = candidates[i];
      try {
        await listen(p);
        failure = null;
        break;
      } catch (e) {
        failure = e;
        if (!PORT_SKIP_CODES.has(e?.code)) throw e;
        if (candidates[i + 1] > 0) log.warn?.(`[client] loopback port ${p} is not usable here (${e?.code}) — trying ${candidates[i + 1]}`);
      }
    }
    if (failure) throw failure;
    server.on('error', (e) => log.error?.('[client] server error', e));
    const actual = server.address().port;
    return {
      url: `http://${host}:${actual}`,
      port: actual,
      server,
      close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); }),
    };
  })();
}
