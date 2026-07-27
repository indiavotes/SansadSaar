// app/text-shards.js
//
// Shared text-shard loader. Each corpus's per-record text bodies are
// bundled at build time into key-addressed JSON shards
// (`texts-<bucket>-<band>.json`) with a small `texts-meta.json` manifest at
// `<dataBaseUrl>/<corpus>/`. This module fetches a record's text by:
//
//   1. Deriving the shard filename from the record's own composite key
//      (see shardFileFor) — no lookup map, no manifest round-trip needed
//      for resolution.
//   2. Fetching that shard JSON, parsed once and cached.
//   3. Returning either the inline string body or, if the shard stores
//      a `{"r2": true}` sentinel for that key, fetching from the
//      manifest's `r2_origin` URL.
//
// Manifests written before 2026-07-27 carry a `record_to_shard` map instead;
// that path is still honoured so the app works against un-rebuilt mirrors.
//
// Each corpus module owns its composite-key construction (drsc =
// `<committee>|<file_id>`, debates = `ls|<file_id>` or
// `rs|<base>|<version>`, etc.) and calls into here with the composite
// it built.
//
// Caches are scoped per corpus, in-memory only — IDB persistence of
// extracted texts is the per-corpus module's responsibility (it already
// caches the final text body by record key, independent of how the
// body was sourced).

import { idbGet, idbPut } from './deps.js';

// corpus → Promise<meta|null>
const _metaCache = new Map();

// "<corpus>|<shard_file>" → Promise<shardData|null>
const _shardCache = new Map();

// Bucket-stamped query string for cache busting on data URLs. CF edges
// cache by full URL — we want each 5-min window to look like a fresh
// resource so a cron commit gets picked up promptly.
function _cacheBuster() {
  const bucket = Math.floor(Date.now() / 300000);
  return `?v=${bucket}`;
}

// Drop any cached promise that resolved to null (a transient miss).
// Keeps successful hits and unresolved in-flight promises around.
function _evictNullResolved(cache, key, promise) {
  promise.then((v) => { if (v === null && cache.get(key) === promise) cache.delete(key); });
}

async function _fetchTextMeta(corpus, dataBaseUrl) {
  // Keyed on corpus AND origin. Keyed on corpus alone, reading one corpus
  // from two base URLs silently returns the first origin's manifest — which
  // during the 2026-07-27 schema migration produced a convincing false
  // "the compatibility fallback is broken" result and cost real debugging time.
  const corpusKey = `${corpus}|${dataBaseUrl}`;
  if (_metaCache.has(corpusKey)) return _metaCache.get(corpusKey);
  const p = (async () => {
    try {
      const res = await fetch(`${dataBaseUrl}${corpus}/texts-meta.json${_cacheBuster()}`, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn(`[text-shards] ${corpus}: meta fetch failed:`, e);
      return null;
    }
  })();
  _metaCache.set(corpusKey, p);
  _evictNullResolved(_metaCache, corpusKey, p);
  return p;
}

async function _fetchShard(corpus, shardFile, dataBaseUrl) {
  const cacheKey = `${corpus}|${shardFile}`;
  if (_shardCache.has(cacheKey)) return _shardCache.get(cacheKey);
  const p = (async () => {
    // Try IDB first — shards are big, so caching survives across reloads.
    try {
      const cached = await idbGet('blobs', `texts-shard|${cacheKey}`);
      if (cached) return cached;
    } catch {}
    try {
      const res = await fetch(`${dataBaseUrl}${corpus}/${shardFile}${_cacheBuster()}`, { cache: 'no-cache' });
      if (!res.ok) return null;
      const data = await res.json();
      idbPut('blobs', `texts-shard|${cacheKey}`, data).catch(() => {});
      return data;
    } catch (e) {
      console.warn(`[text-shards] ${corpus}/${shardFile}: fetch failed:`, e);
      return null;
    }
  })();
  _shardCache.set(cacheKey, p);
  _evictNullResolved(_shardCache, cacheKey, p);
  return p;
}

// ── Shard resolution ───────────────────────────────────────────────────────
//
// A record's shard is a pure function of its own key. Mirrors bucket_for()
// and fnv1a32() in parliamentwatch_text_shards.py — if you change one, change
// both.
//
// Before 2026-07-27 the manifest carried a `record_to_shard` map instead: one
// entry per record, 3.5 MB for questions, rewritten on every scrape run and
// downloaded by every session before any text could be read. Deriving the
// shard removes that download entirely.
//
// `record_to_shard` is still honoured when present so the app keeps working
// against mirrors that haven't been rebuilt yet (schema 1).

const _BUCKET_SPLIT = /[_|]/;
const _BUCKET_CLEAN = /[^A-Za-z0-9-]/g;

export function bucketFor(key) {
  const bar = key.indexOf('|');
  const house = bar === -1 ? '' : key.slice(0, bar);
  const body = bar === -1 ? key : key.slice(bar + 1);
  const parts = body.split(_BUCKET_SPLIT).filter(Boolean);
  const raw = [house, parts[0] || '', parts[1] || ''].filter(Boolean).join('-');
  return raw.replace(_BUCKET_CLEAN, '') || 'misc';
}

const _ORDINAL = /(\d+)\D*$/;
const _DEFAULT_STRIDE = 250;   // must match DEFAULT_SHARD_STRIDE in parliamentwatch_text_shards.py

/**
 * Shard filename holding `key`. Pure function of the key (plus the stride
 * recorded in the manifest). Mirrors shard_filename() in
 * parliamentwatch_text_shards.py — change one, change both.
 */
export function shardFileFor(key, stride = _DEFAULT_STRIDE) {
  const bucket = bucketFor(key);
  const m = _ORDINAL.exec(key);
  // No ordinal (e.g. RS date-keyed records) — the bucket is one sitting
  // already, so it is not banded.
  if (!m) return `texts-${bucket}.json`;
  const band = Math.floor(parseInt(m[1], 10) / stride);
  return `texts-${bucket}-${String(band).padStart(4, '0')}.json`;
}

/** Resolve the shard filename holding `compositeKey`, or null. */
function _shardFileFor(meta, compositeKey) {
  // Schema 1 — explicit map. Kept for mirrors not yet rebuilt.
  if (meta?.record_to_shard) {
    const idx = meta.record_to_shard[compositeKey];
    if (idx === undefined) return null;
    return meta.shards?.[idx]?.file ?? null;
  }
  return shardFileFor(compositeKey, meta?.shard_stride || _DEFAULT_STRIDE);
}

/**
 * Load a record's extracted text by composite key.
 *
 * @param {string} corpus       — 'drsc'|'cag'|'bills'|'lc'|'fc'|'debates'.
 * @param {string} compositeKey — corpus-specific composite (e.g. for drsc:
 *                                `agriculture|LS16_10`; for debates: `ls|LS18_S7_5372`).
 * @param {string} dataBaseUrl  — usually deps.config.dataBaseUrl.
 * @returns {Promise<string|null>} — body text, or null if not available.
 */
export async function loadTextFromShards(corpus, compositeKey, dataBaseUrl) {
  if (!corpus || !compositeKey || !dataBaseUrl) return null;
  const meta = await _fetchTextMeta(corpus, dataBaseUrl);
  if (!meta) return null;
  const shardFile = _shardFileFor(meta, compositeKey);
  if (!shardFile) return null;
  const shard = await _fetchShard(corpus, shardFile, dataBaseUrl);
  if (!shard) return null;
  const value = shard.records?.[compositeKey];
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value && value.r2) {
    // R2 fallback. r2_origin format: `https://pub-<hash>.r2.dev` (no
    // trailing slash). Object key mirrors the corpus / compositeKey
    // mapping the r2-sync workflow uses. For now this is a best-effort
    // path — when bundling-primary is in place, the threshold is set
    // high enough that this branch shouldn't fire on current corpora.
    const origin = meta.r2_origin;
    if (!origin) return null;
    // The sync workflow uploads with keys like `<corpus>/<original_url_path>`,
    // where original_url_path matches what `manifest.texts.<key>.url` held.
    // Composite key doesn't map cleanly to that path; the corpus module
    // can pass an `r2Key` via the optional `loadTextFromShardsOpts`
    // signature below if it needs a different key shape. For now,
    // strip composite separators to approximate the original filename.
    return await _fetchR2(origin, corpus, compositeKey);
  }
  return null;
}

/**
 * Variant of loadTextFromShards that lets the corpus pass an explicit
 * R2 key separately from the shard composite. Use when the composite
 * key doesn't naturally match the on-R2 object path (e.g. debates RS,
 * where the composite is `rs|<base>|<version>` but the R2 object was
 * uploaded under `debates/rs/<base>__<version>.txt`).
 */
export async function loadTextFromShardsWithR2Key(corpus, compositeKey, r2Key, dataBaseUrl) {
  const direct = await loadTextFromShards(corpus, compositeKey, dataBaseUrl);
  if (direct !== null) return direct;
  // direct came back null. Could mean: not in shard at all, or sentinel
  // hit but R2 lookup needs the explicit key. Re-resolve and retry.
  const meta = await _fetchTextMeta(corpus, dataBaseUrl);
  const shardFile = _shardFileFor(meta, compositeKey);
  if (!shardFile) return null;
  const shard = await _fetchShard(corpus, shardFile, dataBaseUrl);
  const value = shard?.records?.[compositeKey];
  if (!value || typeof value === 'string') return null;
  if (value.r2 && meta.r2_origin) {
    return await _fetchR2Raw(meta.r2_origin, r2Key);
  }
  return null;
}

async function _fetchR2(origin, corpus, compositeKey) {
  // Best-effort key reconstruction. Each corpus's r2-sync workflow
  // uploaded with key = `<corpus>/<original_relative_path>`. For the
  // sentinel branch in this generic helper, we don't know the original
  // path — use loadTextFromShardsWithR2Key from the caller when this
  // matters.
  return await _fetchR2Raw(origin, `${corpus}/${compositeKey.replace(/\|/g, '_')}.txt`);
}

async function _fetchR2Raw(origin, key) {
  try {
    const url = `${origin.replace(/\/$/, '')}/${key}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    console.warn(`[text-shards] R2 fetch failed for ${key}:`, e);
    return null;
  }
}

/**
 * Clear the in-memory caches for a corpus. Call from the corpus's
 * data-refresh path so a fresh `texts-meta.json` is fetched after a
 * mirror update. Does NOT clear IDB — those entries are byte-stable
 * by shard filename and a re-fetch will overwrite naturally.
 */
export function clearTextShardCache(corpus) {
  _metaCache.delete(corpus);
  for (const key of _shardCache.keys()) {
    if (key.startsWith(`${corpus}|`)) _shardCache.delete(key);
  }
}
