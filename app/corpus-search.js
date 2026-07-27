// app/corpus-search.js
// Shared search machinery for every corpus module — query parsing, highlight
// rendering, sharded-bundle + sharded-index loading, vocab lookup, posting
// decode. All corpora use the same code path; what differs per corpus is
// just the IDB key, the URL path prefix, and the meta object that lists
// the shards.
//
// Why this is a separate module:
//   • DRSC, CAG, and Bills had ~310 lines of nearly-identical search code
//     each (loader + parser + decoder + query + highlight). One good
//     implementation beats three copy-pasted ones, and any improvement
//     to the search machinery (cross-corpus search, ranking, snippet
//     generation) now lives in one place.
//
//   • Cross-corpus search (planned next) is straightforward once every
//     corpus runs its index through the same lookup functions. The shell
//     can fan a single query out to every loaded corpus's bundle+index
//     and merge the result sets, ranking by an aggregated score.
//
// Corpus contract for state fields (defaults — overrideable via `fields`):
//   state.searchBundle / state.bundleLoading / state.bundleLoaded
//   state.searchIndex  / state.indexLoading  / state.indexLoaded
//
// The loaders mutate these directly while running, so live UI hooks like
// `renderResultsLine()` see consistent "loading…" → "loaded N" transitions
// without each corpus having to re-implement the dance.

import { idbGet, idbPut, escapeHtml, mapPooled } from './deps.js';

// ── Query parsing + highlight rendering ───────────────────────────────────

/**
 * Parse a raw search string into tokens + phrases.
 *   "audit report" "fiscal year" cag  →  tokens=['cag'], phrases=['audit report', 'fiscal year']
 * Quoted segments become phrases (substring match); unquoted words become
 * tokens (prefix-matched against the body-token index).
 */
export function parseQuery(raw) {
  const tokens = [];
  const phrases = [];
  let rem = String(raw || '');
  rem = rem.replace(/"([^"]+)"/g, (_, p) => {
    const cleaned = p.trim().toLowerCase();
    if (cleaned) phrases.push(cleaned);
    return ' ';
  });
  for (const word of rem.split(/\s+/)) {
    const w = word.toLowerCase().replace(/^[\W_]+|[\W_]+$/g, '');
    if (w) tokens.push(w);
  }
  return { tokens, phrases };
}

function _escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wrap query matches in <mark> tags. Tokens match word-boundary + any
 * trailing stem (so "audit" lights up "auditing" and "audits"), phrases
 * match the literal phrase. Returns HTML-escaped output safe for innerHTML.
 */
export function highlightMatches(text, parsedQ) {
  const safeText = String(text ?? '');
  if (!parsedQ) return escapeHtml(safeText);
  const tokens  = parsedQ.tokens.filter(Boolean);
  const phrases = parsedQ.phrases.filter(Boolean);
  if (!tokens.length && !phrases.length) return escapeHtml(safeText);
  const phrasePats = [...phrases].sort((a, b) => b.length - a.length).map(_escapeRegex);
  const tokenPats  = tokens.map(t => `\\b${_escapeRegex(t)}\\w*`);
  let pattern;
  try {
    pattern = new RegExp('(' + [...phrasePats, ...tokenPats].join('|') + ')', 'gi');
  } catch {
    return escapeHtml(safeText);
  }
  return safeText.split(pattern).map((part, i) => (i % 2 === 1)
    ? `<mark>${escapeHtml(part)}</mark>`
    : escapeHtml(part)
  ).join('');
}

// ── Bundle + index parsing ────────────────────────────────────────────────

/**
 * Parse the merged bundle (all shards concatenated) into the live shape
 * the app consumes:
 *   { generated_at, head_chars, total, map: Map<reportKey, {title, head}> }
 */
export function parseBundle(rawBundle) {
  const map = new Map();
  for (const e of (rawBundle.entries || [])) {
    map.set(e.key, { title: e.title, head: e.head });
  }
  return {
    generated_at: rawBundle.generated_at,
    head_chars:   rawBundle.head_chars,
    total:        rawBundle.total,
    map,
  };
}

/**
 * Parse the raw multi-shard index (the on-disk format: `{shards: [...]}`)
 * into the live shape with summary stats + a per-instance postings cache.
 * Returns null if shards is empty (signals "no index available").
 */
export function parseIndex(rawIndex) {
  const shards = rawIndex.shards || [];
  if (!shards.length) return null;
  const vocab = shards[0].vocab || [];
  let report_count = 0;
  let generated_at = '';
  for (const s of shards) {
    report_count += (s.report_keys || []).length;
    if (s.generated_at && s.generated_at > generated_at) generated_at = s.generated_at;
  }
  return {
    generated_at,
    report_count,
    vocab_size:    vocab.length,
    vocab,
    shards,
    _postingsCache: new Map(),   // session-local — reset on each index reparse
  };
}

// ── Index lookup (stateless given a parsed index) ─────────────────────────

/**
 * Decode the delta-encoded posting list at (shardIdx, vocabIdx) into a
 * sorted array of report-key indices. Caches per-index — the cache lives
 * on the parsed index object so multiple indices don't share entries.
 */
export function decodePostings(index, shardIdx, vi) {
  if (!index || !index.shards[shardIdx]) return [];
  const cache = index._postingsCache || (index._postingsCache = new Map());
  const cacheKey = shardIdx + ':' + vi;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const delta = index.shards[shardIdx].postings?.[vi];
  if (!delta || !delta.length) return [];
  const out = new Array(delta.length);
  let acc = delta[0] | 0;
  out[0] = acc;
  for (let i = 1; i < delta.length; i++) {
    acc += delta[i] | 0;
    out[i] = acc;
  }
  cache.set(cacheKey, out);
  return out;
}

/** Binary search for the range of vocab indices whose tokens start with `prefix`. */
export function expandPrefix(index, prefix) {
  if (!index || !index.vocab.length || !prefix) return [];
  const vocab = index.vocab;
  let lo = 0, hi = vocab.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (vocab[mid] < prefix) lo = mid + 1; else hi = mid;
  }
  const out = [];
  for (let i = lo; i < vocab.length && vocab[i].startsWith(prefix); i++) out.push(i);
  return out;
}

/**
 * Set of reportKeys whose body contains a token starting with `tokenStr`.
 * Returns null if the index isn't loaded; empty Set if no matches.
 */
export function expandTokenToDocs(index, tokenStr) {
  if (!index || !index.shards || !index.shards.length) return null;
  const vis = expandPrefix(index, tokenStr);
  if (!vis.length) return new Set();
  const out = new Set();
  for (let si = 0; si < index.shards.length; si++) {
    const shard = index.shards[si];
    const shardKeys = shard.report_keys || [];
    for (const vi of vis) {
      for (const localIdx of decodePostings(index, si, vi)) {
        out.add(shardKeys[localIdx]);
      }
    }
  }
  return out;
}

// ── Bundle + index loaders ────────────────────────────────────────────────
//
// The corpus passes its `state` object directly; we mutate the documented
// fields (searchBundle, bundleLoading, bundleLoaded; same shape for index)
// during the load so live UI hooks see consistent transitions. The
// in-flight guard prevents two concurrent loads for the same corpus.
//
// Idempotent: re-running while already loaded just re-checks the network
// and updates state if a newer generated_at lands. Same pattern as the
// IDB-first read most corpora already use.

const DEFAULT_BUNDLE_FIELDS = {
  bundle:  'searchBundle',
  loading: 'bundleLoading',
  loaded:  'bundleLoaded',
};
const DEFAULT_INDEX_FIELDS = {
  index:   'searchIndex',
  loading: 'indexLoading',
  loaded:  'indexLoaded',
};

export async function loadSearchBundle({
  state,                    // corpus state — mutated in place
  corpusId,                 // 'cag', 'drsc', 'bills' — only used for logging
  idbKey,                   // 'cag-search-bundle.json' etc
  urlPath,                  // 'cag/' etc — relative to dataBaseUrl, must end with /
  meta,                     // current parsed meta (must have search_bundle.shards array)
  deps,                     // shell deps (for config.dataBaseUrl)
  fields = DEFAULT_BUNDLE_FIELDS,
  onChange,                 // optional — called on every state mutation for UI refresh
  onAfterLoad,              // optional — called once after the load resolves
}) {
  if (state[fields.loading]) return state[fields.bundle];
  state[fields.loading] = true;
  onChange?.();

  try {
    try {
      const cached = await idbGet('blobs', idbKey);
      if (cached) {
        state[fields.bundle] = parseBundle(cached);
        state[fields.loaded] = true;
        onChange?.();
      }
    } catch {}

    const shardList = meta?.search_bundle?.shards;
    if (!shardList || !shardList.length) {
      console.info(`${corpusId}: search_bundle.shards missing from meta; skipping fetch`);
      return state[fields.bundle];
    }
    const dataUrl = deps.config.dataBaseUrl;
    const bucket  = Math.floor(Date.now() / 300000);
    // Bounded — shard count is a property of the data, not the app. See
    // mapPooled in deps.js.
    const shards = await mapPooled(shardList, async name => {
      const r = await fetch(dataUrl + urlPath + name + '?v=' + bucket, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      return r.json();
    });

    let head_chars   = 5000;
    let generated_at = '';
    const entries    = [];
    for (const s of shards) {
      head_chars = s.head_chars || head_chars;
      if (s.generated_at && s.generated_at > generated_at) generated_at = s.generated_at;
      if (s.entries) entries.push(...s.entries);
    }
    const merged = { generated_at, head_chars, total: entries.length, entries };
    const cachedAt = state[fields.bundle]?.generated_at;
    if (!cachedAt || (generated_at && generated_at > cachedAt)) {
      state[fields.bundle] = parseBundle(merged);
      state[fields.loaded] = true;
      idbPut('blobs', idbKey, merged).catch(() => {});
    }
  } catch (e) {
    console.warn(`${corpusId}: search-bundle fetch failed`, e);
  } finally {
    state[fields.loading] = false;
    onChange?.();
    onAfterLoad?.();
  }
  return state[fields.bundle];
}

export async function loadSearchIndex({
  state,
  corpusId,
  idbKey,
  urlPath,
  meta,
  deps,
  fields = DEFAULT_INDEX_FIELDS,
  onChange,
  onAfterLoad,
}) {
  if (state[fields.loading]) return state[fields.index];
  state[fields.loading] = true;
  onChange?.();

  try {
    try {
      const cached = await idbGet('blobs', idbKey);
      if (cached && cached.shards) {
        state[fields.index]  = parseIndex(cached);
        state[fields.loaded] = true;
        onChange?.();
      }
    } catch {}

    const shardList = meta?.search_index?.shards;
    if (!shardList || !shardList.length) {
      console.info(`${corpusId}: search_index.shards missing from meta; skipping fetch`);
      return state[fields.index];
    }
    const dataUrl = deps.config.dataBaseUrl;
    const bucket  = Math.floor(Date.now() / 300000);
    // Bounded — see loadSearchBundle above.
    const shards = await mapPooled(shardList, async name => {
      const r = await fetch(dataUrl + urlPath + name + '?v=' + bucket, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      return r.json();
    });

    let generated_at = '';
    for (const s of shards) {
      if (s.generated_at && s.generated_at > generated_at) generated_at = s.generated_at;
    }
    const cachedAt = state[fields.index]?.generated_at;
    if (!cachedAt || (generated_at && generated_at > cachedAt)) {
      const blob = { shards };
      state[fields.index]  = parseIndex(blob);    // resets _postingsCache
      state[fields.loaded] = true;
      idbPut('blobs', idbKey, blob).catch(() => {});
    }
  } catch (e) {
    console.warn(`${corpusId}: search-index fetch failed`, e);
  } finally {
    state[fields.loading] = false;
    onChange?.();
    onAfterLoad?.();
  }
  return state[fields.index];
}
