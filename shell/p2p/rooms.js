// Decentralized lobby — the pure rules. No DOM, no socket, no storage: every export is a function of its inputs,
// which is what lets `node --test` pin the behaviour without a browser (same split as picker-core.js / picker.js).
//
// Why this module exists: the game's lobby/room/match lifecycle is server-authoritative (see the picker header in
// picker.js), so today the only way to reach another player is to know a server address. This is the *data* half of
// the alternative — peers advertise the address they are reachable at, and everyone merges what they hear into one
// list. The transport half is link.js. Address rules are imported from picker-core.js rather than re-implemented, so
// a typed address means exactly the same thing in both places.
//
// An advert is deliberately tiny: { address, name, at }. There is no server to vouch for who published what, so the
// merged list is a hint about who is around — never an authority, and never a reason to trust an address.

import { cleanName, rootWsUrl, serverName } from '../picker-core.js';

/**
 * Drop an advert nobody refreshed for this long. Peers re-publish well inside this window (link.js), so a value that
 * survives it means the peer is gone or its socket died — showing a dead server for minutes is worse than hiding it.
 */
export const ADVERT_TTL_MS = 90_000;

/** Cap the merged list: a hostile peer can publish adverts forever, and the UI has to stay bounded. */
export const MAX_ROOMS = 50;

/**
 * Dedup key for an address: the root-mounted socket URL. Two peers advertising `wss://h/play/ws` and `wss://h/ws`
 * are the same server, and listing it twice would make the list look busier than the network actually is.
 * @param {string} address
 * @returns {string} '' when there is nothing to normalise
 */
export function roomKey(address) {
  return rootWsUrl(String(address ?? '').trim());
}

/**
 * Normalise one advert, or null when it carries no usable address.
 * `at` is allowed to be absent (treated as "now") because a peer that cannot keep time should still be listed.
 * @param {{address?: string, name?: string, at?: number}} raw
 * @returns {{key: string, address: string, name: string, at: number}|null}
 */
export function makeAdvert(raw) {
  const key = roomKey(raw?.address);
  if (!key) return null;
  const at = Number(raw?.at);
  return {
    key,
    address: key,
    name: cleanName(raw?.name) || serverName({ address: key }),
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

/**
 * Merge everything heard from peers into one list: dedup by `roomKey`, keep the newest advert per key, drop what is
 * older than `ttlMs`, freshest first. Input order must not matter — adverts arrive in whatever order the sockets
 * deliver them, and two peers echoing each other's advert must not produce two entries.
 * @param {Array<{address?: string, name?: string, at?: number}>} adverts
 * @param {{now?: number, ttlMs?: number, max?: number}} [options]
 */
export function mergeAdverts(adverts, { now = Date.now(), ttlMs = ADVERT_TTL_MS, max = MAX_ROOMS } = {}) {
  const best = new Map();
  for (const raw of adverts ?? []) {
    const advert = makeAdvert(raw);
    if (!advert) continue;
    if (now - advert.at > ttlMs) continue;
    const seen = best.get(advert.key);
    if (!seen || advert.at >= seen.at) best.set(advert.key, advert);
  }
  return [...best.values()].sort(byFreshness).slice(0, max);
}

/** Freshest first; name breaks ties so an unstable clock cannot shuffle the list on every render. */
function byFreshness(a, b) {
  return b.at - a.at || a.name.localeCompare(b.name);
}

/**
 * Fold what the lobby heard into the picker's own list.
 *
 * The two sides normalise differently on purpose: the picker keys a remembered server by what the player typed
 * (`toWsUrl` keeps a pasted path, so `wss://h/play/ws` stays as typed), while an advert is already root-mounted
 * (`roomKey` → `wss://h/ws`). Comparing them raw would list one server twice — the exact failure the lobby list
 * itself is tested against — so both sides are compared through `roomKey`. A remembered entry always keeps its row:
 * the player's own name, and the fact that it is editable, must not be replaced by a stranger's advert.
 *
 * Nothing here is persisted, and that is the point: the merged list is a hint about who is around, so it dies with
 * the process instead of becoming one more dead row in the remembered list.
 *
 * @param {Array<{key: string}>} base entries from picker.js's serverList(), kept first and unchanged
 * @param {Array<{address?: string, name?: string}>} discovered what the lobby heard (`link.js`'s `state().rooms`)
 * @param {(wsUrl: string) => string} httpOf socket URL → the http URL the row displays (picker.js owns that rule)
 * @returns {Array<object>} base, then one entry per advert that names a server the list did not already have
 */
export function withDiscovered(base, discovered, httpOf) {
  const out = [...base];
  const seen = new Set(base.map((s) => roomKey(s.key)));
  for (const raw of discovered ?? []) {
    const key = roomKey(raw?.address);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      address: key,
      key,
      label: cleanName(raw?.name) || serverName({ address: key }),
      note: 'P2P 发现',
      http: httpOf(key),
    });
  }
  return out;
}
