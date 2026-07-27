// app/disk-sync.js
// "Save to Disk" — Phase 1 — File System Access API integration for SansadSaar.
//
// What it does today:
//   • User clicks the "Save to Disk" pill in the header → picks a folder →
//     we write the Tier A snapshot (meta + reports/records + manifest +
//     audit + sharded bundles + sharded indexes) of every registered
//     corpus to that folder. The folder structure mirrors the CF mirror
//     exactly — `<root>/drsc/...`, `<root>/cag/...`, `<root>/bills/...`.
//     A user could serve the folder via `python3 -m http.server` and
//     point ?data=http://localhost:8000/ at it; it'd work as-is.
//
//   • On page reload: we silently `queryPermission` on the stored
//     directory handle. If granted, we re-attach. If 'prompt', we show
//     "Reconnect to Disk" — clicking it requests permission (which needs
//     a user gesture). If 'denied' or the handle is invalid, we wipe
//     and revert to the "Save to Disk" state.
//
//   • Manual "Sync now" — re-runs the snapshot, picking up any
//     fresher CF data.
//
// What it does NOT do (Phase 2 territory, intentionally deferred):
//   • Read from disk during corpus asset loads. The corpus modules
//     still fetch from CF. The disk copy is for portability + archive
//     value, not yet for offline browsing.
//   • Background sync on meta.json change. User has to click "Sync".
//   • Save text/<id>.txt files (would balloon to ~700 MB once corpora
//     are fully extracted — Tier A is the index-only ~60 MB slice).
//
// Browser support: Chrome / Edge / Brave / Opera on desktop. Falls back
// to a hidden pill on Safari, Firefox, and mobile — the rest of the app
// works fine without disk sync.
//
// See CONV.md "File System Access API" + "Save-to-Disk pattern".

import { idbGet, idbPut, mapPooled } from './deps.js';

const HANDLE_KEY = 'disk-handle';   // in 'blobs' store

// ── Pure helpers ──────────────────────────────────────────────────────────

const isSupported = typeof window !== 'undefined'
                  && typeof window.showDirectoryPicker === 'function';

async function writeFile(dirHandle, name, content) {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable   = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

// Path-traversal helpers — walk into nested subdirectories before writing /
// reading the leaf file. Used for paths like 'text/<id>.txt' or
// 'text/<committee>/<file_id>.txt'.
async function _getOrCreateDir(root, segments) {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

async function _getDirReadOnly(root, segments) {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg);
  }
  return dir;
}

// Each corpus's Tier A is its meta.json + the per-corpus-named primary
// + manifest + audit + the shards listed in meta.{search_bundle,search_index}.shards.
// Bills additionally has index-meta.json + index-*.json sharded by
// _shard_filename(). DRSC additionally has committees.json.
const CORPUS_ASSETS = {
  drsc:  ['meta.json', 'reports.json', 'manifest.json', 'audit.json', 'committees.json'],
  cag:   ['meta.json', 'reports.json', 'manifest.json', 'audit.json'],
  bills: ['meta.json', 'records.json', 'manifest.json', 'audit.json', 'index-meta.json'],
};

// ── Stateful module ───────────────────────────────────────────────────────

let _deps          = null;
let _dirHandle     = null;
let _state         = 'unsupported';      // unsupported|unsaved|connected|reconnect-needed
let _lastSyncAt    = null;
let _syncing       = false;
const _listeners   = new Set();

function notify() {
  for (const cb of _listeners) {
    try { cb(); } catch (e) { console.warn('disk-sync listener error', e); }
  }
}

function corpusIds() {
  // The shell registers corpora; we ask for what's currently registered.
  // Falls back to the static list above if the shell hasn't exposed an
  // enumerator yet (boot order shouldn't allow that, but be defensive).
  const product = _deps?.config?.product || 'sansadsaar';
  const api     = (typeof window !== 'undefined') && window[product];
  const dynamic = api?.corpora?.()?.map(c => c.id);
  return dynamic && dynamic.length ? dynamic : Object.keys(CORPUS_ASSETS);
}

async function syncCorpus(corpusId, root, onProgress) {
  const dataUrl = _deps.config.dataBaseUrlFor?.(corpusId) || _deps.config.dataBaseUrl;
  const sub = await root.getDirectoryHandle(corpusId, { create: true });

  // Fetch meta first; the shard lists tell us what else to pull.
  const metaText = await fetchText(`${dataUrl}${corpusId}/meta.json`);
  await writeFile(sub, 'meta.json', metaText);
  onProgress?.(`${corpusId}/meta.json`);
  const meta = JSON.parse(metaText);

  // Static assets (those that always exist for this corpus).
  const baseAssets = CORPUS_ASSETS[corpusId] || ['meta.json', 'manifest.json'];
  for (const asset of baseAssets) {
    if (asset === 'meta.json') continue;   // already written
    try {
      const content = await fetchText(`${dataUrl}${corpusId}/${asset}`);
      await writeFile(sub, asset, content);
      onProgress?.(`${corpusId}/${asset}`);
    } catch (e) {
      // Some assets may not exist for a given corpus yet (e.g. audit.json
      // for a brand-new mirror). Skip with a warn — don't fail the sync.
      console.warn(`[disk-sync] skipped ${corpusId}/${asset}: ${e.message}`);
    }
  }

  // Sharded search-bundle / search-index, listed in meta.
  const shardLists = [
    ...(meta.search_bundle?.shards || []),
    ...(meta.search_index?.shards  || []),
  ];
  // Pooled rather than serial: these lists run to four figures on the
  // proceedings corpora (questions ships ~1,200 bundle + ~1,200 index
  // shards), and one-at-a-time turns Save to Disk into a multi-minute stall.
  // Fetches are pooled; the write stays inside the worker so a slow disk
  // backpressures the fetches instead of buffering every shard in memory.
  let done = 0;
  await mapPooled(shardLists, async shard => {
    const content = await fetchText(`${dataUrl}${corpusId}/${shard}`);
    await writeFile(sub, shard, content);
    onProgress?.(`${corpusId}/${shard}`, ++done, shardLists.length);
  });

  // Bills has a sharded index-NN.json on top of the bundle/index.
  if (corpusId === 'bills') {
    try {
      const indexMetaText = await fetchText(`${dataUrl}${corpusId}/index-meta.json`);
      const indexMeta = JSON.parse(indexMetaText);
      const shards = indexMeta?.shards || [];
      // index-meta.json may list shard names directly or as objects with .name
      const shardNames = shards.map(s => typeof s === 'string' ? s : s?.name).filter(Boolean);
      for (const shard of shardNames) {
        const content = await fetchText(`${dataUrl}${corpusId}/${shard}`);
        await writeFile(sub, shard, content);
        onProgress?.(`${corpusId}/${shard}`);
      }
    } catch (e) {
      console.warn(`[disk-sync] bills index-* sharding skipped: ${e.message}`);
    }
  }
}

async function fullSync(onProgress) {
  if (!_dirHandle) throw new Error('No folder connected');
  _syncing = true;
  notify();
  try {
    for (const id of corpusIds()) {
      await syncCorpus(id, _dirHandle, onProgress);
    }
    _lastSyncAt = Date.now();
  } finally {
    _syncing = false;
    notify();
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export function getDiskSyncState() {
  return {
    state:      _state,
    supported:  isSupported,
    syncing:    _syncing,
    lastSyncAt: _lastSyncAt,
  };
}

export function onDiskSyncChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export async function initDiskSync(deps) {
  _deps = deps;
  if (!isSupported) {
    _state = 'unsupported';
    notify();
    return getDiskSyncState();
  }

  try {
    const stored = await idbGet('blobs', HANDLE_KEY);
    if (!stored) {
      _state = 'unsaved';
      notify();
      return getDiskSyncState();
    }
    // queryPermission is callable silently (no user gesture needed).
    let perm = 'denied';
    try {
      perm = await stored.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      // Handle is invalid (folder moved/deleted, or stored under a
      // different origin's quota — rare but observed). Wipe and restart.
      console.warn('[disk-sync] handle queryPermission threw — wiping', e);
      await idbPut('blobs', HANDLE_KEY, null);
      _state = 'unsaved';
      notify();
      return getDiskSyncState();
    }
    if (perm === 'granted') {
      _dirHandle = stored;
      _state     = 'connected';
      // Fire-and-forget staleness check — if the live mirror has updated
      // since the last sync, this brings the disk copy up to date without
      // requiring the user to click "Sync now". The pill briefly flips to
      // "Syncing..." then back to "Synced • just now".
      checkStalenessAndAutoSync().catch(e =>
        console.warn('[disk-sync] auto-sync on init failed:', e));
    } else if (perm === 'prompt') {
      _dirHandle = stored;   // keep so reconnect() can request without re-picking
      _state     = 'reconnect-needed';
    } else {
      // denied — wipe; user has to re-pick.
      await idbPut('blobs', HANDLE_KEY, null);
      _state = 'unsaved';
    }
  } catch (e) {
    console.warn('[disk-sync] init error', e);
    _state = 'unsaved';
  }
  notify();
  return getDiskSyncState();
}

/** First-time pick. Opens the folder picker, saves the handle, runs the
 *  initial snapshot sync. Must be called from a user gesture. */
export async function connectAndSync(onProgress) {
  if (!isSupported) throw new Error('File System Access API not supported in this browser');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  _dirHandle = handle;
  _state     = 'connected';
  await idbPut('blobs', HANDLE_KEY, handle);
  notify();
  await fullSync(onProgress);
  return getDiskSyncState();
}

/** Re-grant permission on the previously-stored handle. Must be called
 *  from a user gesture. */
export async function reconnect() {
  if (!_dirHandle) return getDiskSyncState();
  const perm = await _dirHandle.requestPermission({ mode: 'readwrite' });
  if (perm === 'granted') {
    _state = 'connected';
    notify();
    // Same auto-sync as on init — the user has probably been away long
    // enough for the mirror to have moved, so refresh in the background.
    checkStalenessAndAutoSync().catch(e =>
      console.warn('[disk-sync] auto-sync on reconnect failed:', e));
    return getDiskSyncState();
  }
  _state = 'reconnect-needed';
  notify();
  return getDiskSyncState();
}

/** Manual sync — re-writes Tier A from CF to disk. */
export async function syncNow(onProgress) {
  if (_state !== 'connected') throw new Error(`Cannot sync in state: ${_state}`);
  await fullSync(onProgress);
  return getDiskSyncState();
}

/** Forget the folder — clears handle from IDB, returns to unsaved state.
 *  Doesn't touch the user's actual folder on disk; it just stops syncing. */
export async function disconnect() {
  _dirHandle = null;
  _lastSyncAt = null;
  await idbPut('blobs', HANDLE_KEY, null);
  _state = isSupported ? 'unsaved' : 'unsupported';
  notify();
  return getDiskSyncState();
}

// ── Per-asset read / write (Phase 2) ──────────────────────────────────────
//
// The corpus modules call these after their normal fetch sites to lazily
// mirror to disk (write) or to fall back when network fails (read).
// Both are best-effort and silent on disconnect — corpora can call them
// optimistically without guarding `isConnected()` first.
//
// `path` is the relative path under `<root>/<corpusId>/`. It can contain
// `/` separators for nested subdirectories (e.g. `text/123.txt` or
// `text/rural_development/LS18_32.txt`).

export function diskIsConnected() {
  return _state === 'connected' && !!_dirHandle;
}

export async function diskWrite(corpusId, path, content) {
  if (!diskIsConnected()) return false;
  try {
    const sub = await _dirHandle.getDirectoryHandle(corpusId, { create: true });
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return false;
    const filename = parts.pop();
    const dir = await _getOrCreateDir(sub, parts);
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable   = await fileHandle.createWritable();
    await writable.write(body);
    await writable.close();
    return true;
  } catch (e) {
    // QuotaExceededError, write permission revoked mid-session, etc.
    // Don't block the caller — disk is opportunistic, not authoritative.
    console.warn(`[disk-sync] write ${corpusId}/${path} failed:`, e?.message || e);
    return false;
  }
}

export async function diskRead(corpusId, path) {
  if (!diskIsConnected()) return null;
  try {
    const sub = await _dirHandle.getDirectoryHandle(corpusId);
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return null;
    const filename = parts.pop();
    const dir = await _getDirReadOnly(sub, parts);
    const fileHandle = await dir.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (e) {
    // NotFoundError is the common path (file just not cached on disk yet).
    // Stay silent on that; only warn for other surprises.
    if (e?.name !== 'NotFoundError') {
      console.warn(`[disk-sync] read ${corpusId}/${path} failed:`, e?.message || e);
    }
    return null;
  }
}

// ── Auto-staleness check on init ─────────────────────────────────────────
//
// When we re-attach to a previously-saved folder on page load, we don't
// know if the live mirror has updated since the last sync. Compare each
// corpus's on-disk meta.json's `generated_at` against the live one; if
// they differ, kick off a background sync for that corpus. Quiet —
// surfaces via the pill changing to "Syncing..." then back to "Synced".

async function checkStalenessAndAutoSync() {
  if (!diskIsConnected()) return;
  const ids = corpusIds();
  const stale = [];
  for (const id of ids) {
    const dataUrl = _deps.config.dataBaseUrlFor?.(id) || _deps.config.dataBaseUrl;
    try {
      const cfText = await fetchText(`${dataUrl}${id}/meta.json`);
      const cfMeta = JSON.parse(cfText);
      const diskText = await diskRead(id, 'meta.json');
      if (!diskText) {
        stale.push(id);
        continue;
      }
      try {
        const diskMeta = JSON.parse(diskText);
        if (diskMeta.generated_at !== cfMeta.generated_at) stale.push(id);
      } catch {
        stale.push(id);
      }
    } catch (e) {
      // Network failure or CF down — skip this corpus's check, leave
      // the disk copy intact. The disk file is still useful as-is.
      console.info(`[disk-sync] staleness check for ${id} skipped: ${e?.message || e}`);
    }
  }
  if (!stale.length) return;
  console.info(`[disk-sync] re-syncing stale corpora: ${stale.join(', ')}`);
  _syncing = true;
  notify();
  try {
    for (const id of stale) {
      try {
        await syncCorpus(id, _dirHandle, () => {});
      } catch (e) {
        console.warn(`[disk-sync] re-sync of ${id} failed:`, e?.message || e);
      }
    }
    _lastSyncAt = Date.now();
  } finally {
    _syncing = false;
    notify();
  }
}
