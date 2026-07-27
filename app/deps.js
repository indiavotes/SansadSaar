// app/deps.js
// Shared services + persistence primitives. Imported by shell.js and re-exposed
// to corpus modules via the deps object. Pure-ish — no DOM mutation here, no
// AI client (that lives in shell.js where it owns its worker lifecycle).
//
// Persistence keys are kept at their **legacy** SansadLocal names so an
// existing user's IDB / localStorage carries over silently after the v1.0a
// rename. Migration would only buy us cosmetic alignment in DevTools and
// would risk destroying summaries / chats / cached texts. See persistence.md
// for the full inventory and rename plan (none, ever).

export const IDB_NAME    = 'sansadlocal';   // legacy — DO NOT RENAME
export const IDB_VERSION = 2;
export const SETTINGS_KEY    = 'sansadlocal.settings.v1';   // legacy — DO NOT RENAME
export const INTRO_SEEN_KEY  = 'sansadlocal.introSeen';     // legacy — DO NOT RENAME

// ── IndexedDB ──────────────────────────────────────────────────────────────

export function openIDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, IDB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      // Idempotent — old DBs already have the v1 stores; v2 added 'chats'.
      if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries');
      if (!db.objectStoreNames.contains('texts'))     db.createObjectStore('texts');
      if (!db.objectStoreNames.contains('blobs'))     db.createObjectStore('blobs');   // reports.json + manifest.json
      if (!db.objectStoreNames.contains('chats'))     db.createObjectStore('chats');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror   = () => reject(r.error);
  });
}

export function idbGet(store, key) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}

export function idbPut(store, key, value) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  }));
}

// Cursor over a store. Used at boot to bulk-hydrate caches. `onEntry` is
// called with (key, value, cursor) — return falsy to advance, return
// 'delete' to drop the entry as we go (used to prune stale orphans).
export function idbCursor(store, mode, onEntry) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode || 'readonly');
    const req = tx.objectStore(store).openCursor();
    let count = 0;
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) { resolve(count); return; }
      const action = onEntry(c.key, c.value, c);
      if (action === 'delete') c.delete();
      count++;
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
}

// ── Settings (single localStorage blob, schema unchanged from SansadLocal) ──
//
// Returns the parsed object or {} if the key is missing / malformed. Each
// caller (shell, corpus modules) reads / writes its own keys. We don't
// validate or namespace beyond what was already in SansadLocal — the
// settings JSON is small and well-known.

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveSettings(obj) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
}

// ── Bounded concurrency ─────────────────────────────────────────────────────
//
// Every shard family in this app is fetched as "the whole list, at startup":
// reports shards, search-bundle shards, search-index shards. Fanning those out
// with a bare `Promise.all(list.map(fetch))` works right up until the list
// gets long, and then it doesn't work at all — the browser caps in-flight
// requests per origin and rejects the excess with a bare "Failed to fetch",
// which reads like a network outage rather than a self-inflicted burst.
//
// That is not hypothetical. On 2026-07-27 a data rebuild took the reports
// shard count from ~100 to ~1,500 and questions + debates went down on the
// live site for exactly this reason. Shard counts are a property of the DATA,
// not of the app, so any call site that fans out over a manifest-supplied list
// must be bounded — the app cannot assume the list stays short.
//
// The limit is MEASURED, not guessed. Against the live mirror over questions'
// 1,208 search-bundle shards:
//
//     limit  16 -> 36.6s      limit  64 ->  7.3s
//     limit  32 -> 13.8s      limit 128 ->  5.8s
//     unbounded -> 18.0s, and the cliff
//
// 64 sits just past the knee — 128 buys ~1.5s more and gives back headroom
// for no good reason. An earlier guess of 16 was ~5x slower than 64 and
// slower than no pooling at all, which is the trap here: too low a limit
// serialises a workload HTTP/2 is happy to multiplex.
//
// Note the unbounded run did NOT fail at 1,208 in isolation. The production
// failure was ~3,300 in flight (two corpora activating together, plus meta
// and IDB traffic). So the cliff is a function of TOTAL concurrency, not of
// any one list's length — which is exactly why every fan-out needs a bound
// rather than a per-site judgement about whether its list is "short enough".

export const DEFAULT_FETCH_LIMIT = 64;

/**
 * Map `items` through async `fn` with at most `limit` in flight.
 * Results keep input order. The first rejection propagates (matching
 * Promise.all semantics) — callers that want partial results should catch
 * inside `fn`.
 *
 * @param {Array} items
 * @param {(item: any, index: number) => Promise<any>} fn
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function mapPooled(items, fn, limit = DEFAULT_FETCH_LIMIT) {
  const list = Array.from(items || []);
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker)
  );
  return out;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Format a timestamp like 'updated 3 hours ago'. `iso` may be a Date or an
// ISO string. Returns 'just now' for <60s, 'X minutes ago' for <60m, etc.
// Used by the corpus status pill.
export function relativeTime(iso) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d)) return null;
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + ' min ago';
  const hours = Math.floor(secs / 3600);
  if (hours < 24) return hours === 1 ? '1 hour ago' : hours + ' hours ago';
  const days = Math.floor(secs / 86400);
  if (days < 2) return 'a day ago';
  return days + ' days ago';
}

// Format an ISO timestamp in the viewer's local timezone, preserving the
// existing "YYYY-MM-DD HH:MM:SS TZ" shape that the UTC version used. The TZ
// abbreviation comes from Intl.DateTimeFormat (e.g. 'IST', 'GMT+5:30', 'PST'
// depending on browser/locale); we just append whatever it returns so users
// know it's local, not UTC.
export function formatLocalTimestamp(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  let tz = '';
  try {
    tz = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(d)
      .find(p => p.type === 'timeZoneName')?.value || '';
  } catch {}
  return tz ? `${date} ${time} ${tz}` : `${date} ${time}`;
}

// Severity bucket for a corpus status pill. Drives the colour: ready=green,
// stale=amber (>3 days), error=red.
export function statusBucket(iso) {
  if (!iso) return 'error';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d)) return 'error';
  const days = (Date.now() - d.getTime()) / 86400000;
  if (days > 7) return 'error';
  if (days > 3) return 'stale';
  return 'ready';
}
