// app/corpora/drsc/index.js
// DRSC = Departmentally Related Standing Committees of Indian Parliament.
// 24 committees, LS14–18, ~14,707 reports. Daily-mirrored from sansad.in
// via the parliamentwatch-data scraper (Pranay Kotasthane upstream).
//
// First registered corpus under SansadSaar. Owns its own data fetch, list +
// detail rendering, prompt construction, deep-search bookkeeping, and the
// "Deep search" + "Data" settings sections. Calls into shell via `deps`
// for AI / web search / toast / modal control / persistence.

import {
  idbGet, idbPut, idbCursor,
  escapeHtml, debounce,
  loadSettings, saveSettings,
  formatLocalTimestamp,
} from '../../deps.js';
import { streamWithPersistence } from '../../ai-streaming.js';
import {
  parseQuery, highlightMatches,
  loadSearchBundle as sharedLoadSearchBundle,
  loadSearchIndex  as sharedLoadSearchIndex,
  expandTokenToDocs,
} from '../../corpus-search.js';
import { hydrateFromIDB } from '../../corpus-data.js';
import { loadTextFromShards } from '../../text-shards.js';

// All corpus data lives under `<dataBaseUrl>/<CORPUS_PREFIX>/...` after
// v1.0a phase 2. The mirror moved DRSC's files into docs/drsc/ on the
// CF Workers side; we mirror that here. Future corpora set their own
// prefix in their corpus module — DRSC's "drsc/" stays.
const CORPUS_PREFIX = 'drsc/';

// ── Constants ───────────────────────────────────────────────────────────────

// 24 DRSCs — committee key → display name. Mirrors upstream parliamentwatch
// config but duplicated here so the page works even if committees.json is
// missing from the mirror.
const COMMITTEES = {
  agriculture:       { name: 'Agriculture, Animal Husbandry & Food Processing', house: 'L' },
  chemicals:         { name: 'Chemicals & Fertilizers',                          house: 'L' },
  coal:              { name: 'Coal, Mines and Steel',                            house: 'L' },
  defence:           { name: 'Defence',                                          house: 'L' },
  energy:            { name: 'Energy',                                           house: 'L' },
  external_affairs:  { name: 'External Affairs',                                 house: 'L' },
  finance:           { name: 'Finance',                                          house: 'L' },
  consumer_affairs:  { name: 'Consumer Affairs, Food & Public Distribution',     house: 'L' },
  communications:    { name: 'Communications & Information Technology',          house: 'L' },
  labour:            { name: 'Labour, Textiles & Skill Development',             house: 'L' },
  petroleum:         { name: 'Petroleum & Natural Gas',                          house: 'L' },
  railways:          { name: 'Railways',                                         house: 'L' },
  rural_development: { name: 'Rural Development & Panchayati Raj',               house: 'L' },
  social_justice:    { name: 'Social Justice & Empowerment',                     house: 'L' },
  housing:           { name: 'Housing & Urban Affairs',                          house: 'L' },
  water_resources:   { name: 'Water Resources',                                  house: 'L' },
  commerce:          { name: 'Commerce',                                         house: 'R' },
  health:            { name: 'Health & Family Welfare',                          house: 'R' },
  home_affairs:      { name: 'Home Affairs',                                     house: 'R' },
  education:         { name: 'Education, Women, Children, Youth & Sports',       house: 'R' },
  industry:          { name: 'Industry',                                         house: 'R' },
  personnel:         { name: 'Personnel, Public Grievances, Law & Justice',      house: 'R' },
  science:           { name: 'Science, Technology, Environment & Forests',       house: 'R' },
  transport:         { name: 'Transport, Tourism & Culture',                     house: 'R' },
};

// Title-pattern → category. First match wins; "Action Taken" before DFG
// because AT reports often quote a parent DFG report in their title.
const CATEGORY_PATTERNS = [
  { code: 'AT',     re: /\baction\s+taken\b/i,                          label: 'Action Taken' },
  { code: 'DFG',    re: /\bdemand[s]?\s+for\s+grants?\b|^\s*demand\b/i, label: 'Demand for Grants' },
  { code: 'BILL',   re: /\bbill\b|amendment.*bill/i,                    label: 'Bills' },
  { code: 'ASSURE', re: /\bassurance/i,                                 label: 'Assurances' },
];

const SUMMARY_PROMPT = `You are summarising a report from an Indian Parliamentary Standing Committee. Read the report excerpt below and produce a clear, plain-English briefing for a busy reader. Use this structure:

1. **What the report is about** (1 sentence)
2. **Key findings** (3-5 bullets)
3. **Recommendations** (3-5 bullets, if present)
4. **Why it matters** (1-2 sentences)

Keep it neutral, factual, and accessible to a non-specialist. Do not invent details that aren't in the text.

REPORT:
{TEXT}`;

// Builds the per-question Ask prompt. Pulls in the cached AI summary (if
// any) as a TOC-like overview, the truncated full text, and optional web
// search results.
function buildAskPrompt({ summary, text, searchResults, question }) {
  const parts = [
    'You are answering questions about a specific report from an Indian Parliamentary Standing Committee. Use only the supplied material below to answer. If the answer isn\'t in the supplied material, say so clearly.',
  ];
  if (summary) parts.push('', 'SUMMARY (previously generated by AI):', summary);
  parts.push('', 'REPORT:', text);
  if (searchResults && searchResults.length) {
    parts.push('', 'RECENT WEB CONTEXT (use cautiously, prefer the report itself when they conflict):');
    for (const r of searchResults) parts.push(`- ${r.title}\n  ${r.url}\n  ${r.snippet}`);
  }
  parts.push('', '---', '', 'QUESTION: ' + question);
  return parts.join('\n');
}

// ── Module-private state ────────────────────────────────────────────────────

const state = {
  data: { reports: {}, manifest: {}, committees: COMMITTEES, meta: null },
  filtered: [],
  selectedReport: null,
  filters: { search: '', committee: '', ls: '', category: '', sort: 'date_desc' },

  cache: {
    summaries: {},   // reportKey -> string (also live source during streaming)
    text:      {},   // reportKey -> string (in-memory; IDB-backed)
    chats:     {},   // reportKey -> [{role, content, error?}] (IDB-backed)
  },

  // Per-report dialog transient chat state. Cleared on each new report.
  // Each entry is {role:'user'|'assistant'|'system'|'error', content}.
  dialogChat: [],

  // Search bundle (v0.6 part B). docs/search-bundle.json from mirror —
  // title + first 5K chars per report. Used for substring + snippet preview.
  // Shape: {generated_at, head_chars, total, map: Map<key, {title, head}>}
  searchBundle: null,
  bundleLoading: false,
  bundleLoaded:  false,

  // Search index (v0.6 part C). docs/search-index.json from mirror —
  // inverted token index over the full body of every report. Closes the
  // 95% body-recall gap that bundle alone leaves.
  // Shape: {generated_at, vocab: [sorted tokens],
  //         postings: [delta-encoded sorted doc indices],
  //         report_keys: [...], reportKeyToIdx: Map<key, int>}
  searchIndex:  null,
  indexLoading: false,
  indexLoaded:  false,

  // Deep full-text search — opt-in. ON triggers both bundle + index loads.
  deepSearch: false,

  // Multi-token query semantics. Default AND (every token must hit a doc).
  // Toggle in the results-line flips to OR (any token wins).
  matchAny: false,

  // Tracks which dialog tab is currently streaming so renders mid-flight
  // can show partial output. {reportKey, tab:'summary'|'chat'} or null.
  streamingContext: null,
};

// `deps` is set on activate(). Kept module-scoped so render functions don't
// have to thread it through every call.
let _deps = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function reportKey(r) {
  return `${r.committee}|${r.lok_sabha || ''}|${r.report_number}`;
}

function safeReportNum(num) {
  return String(num ?? '').replace(/\//g, '-').replace(/\s+/g, '_');
}

// Manifest / on-disk file id is LS<lok_sabha>_<safe-num> — uniquely identifies
// a (committee, lok_sabha, report_number) tuple. Pre-v0.4 SansadLocal used
// just the number, which collapsed multi-LS variants into one file. v0.4
// migration renamed every file with this prefix.
function manifestKey(r) {
  if (r.lok_sabha == null) return safeReportNum(r.report_number);
  return `LS${r.lok_sabha}_${safeReportNum(r.report_number)}`;
}

function categoriseReport(r) {
  const t = (r.title || '').trim();
  if (!t) return null;
  for (const p of CATEGORY_PATTERNS) {
    if (p.re.test(t)) return p.code;
  }
  return 'SUBJ';
}

function reportDate(r) {
  // sansad.in dates can be '18-Mar-2026' or 'DD/MM/YYYY'. Best-effort to a
  // JS Date for sorting; falls back to lok_sabha + report_number ordering.
  const candidates = [r.date_of_presentation, r.presented_in_ls, r.laid_in_rs, r.date_of_adoption];
  for (const s of candidates) {
    if (!s) continue;
    const d = new Date(String(s).replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, '$3-$2-$1'));
    if (!isNaN(d)) return d;
    const m = String(s).match(/(\d{1,2})[\-\s]([A-Za-z]+)[\-\s](\d{4})/);
    if (m) {
      const d2 = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
      if (!isNaN(d2)) return d2;
    }
  }
  return null;
}

function formatDate(d) {
  if (!d) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Data fetching ───────────────────────────────────────────────────────────

async function fetchData(forceRefresh = false) {
  const splash    = document.getElementById('splash');
  const splashErr = document.getElementById('splashError');
  const dataUrl   = _deps.config.dataBaseUrl;

  // Try cache first.
  if (!forceRefresh) {
    try {
      const [reportsBlob, manifestBlob, metaBlob] = await Promise.all([
        idbGet('blobs', 'reports.json'),
        idbGet('blobs', 'manifest.json'),
        idbGet('blobs', 'meta.json'),
      ]);
      if (reportsBlob && manifestBlob) {
        state.data.reports  = reportsBlob;
        state.data.manifest = manifestBlob;
        state.data.meta     = metaBlob || null;
      }
    } catch (e) { console.warn('IDB cache miss', e); }
  }

  // Cloudflare caches our data files at the edge. cache:'no-cache' alone
  // isn't enough — CF can still return 304 from its stale cache if the
  // browser ETag matches. Bucket-stamped query string forces CF to treat
  // each 5-minute window as a fresh URL. Worst-case staleness ~5 min.
  const haveCache = Object.keys(state.data.reports).length > 0;
  const bucket = Math.floor(Date.now() / 300000);
  const v = forceRefresh ? `?v=${Date.now()}` : `?v=${bucket}`;
  const fetchOpts = { cache: 'no-cache' };

  try {
    const [reports, manifest, meta] = await Promise.all([
      fetch(dataUrl + CORPUS_PREFIX + 'reports.json'  + v, fetchOpts).then(r => r.ok ? r.json() : Promise.reject(`reports.json: ${r.status}`)),
      fetch(dataUrl + CORPUS_PREFIX + 'manifest.json' + v, fetchOpts).then(r => r.ok ? r.json() : { texts: {} }).catch(() => ({ texts: {} })),
      fetch(dataUrl + CORPUS_PREFIX + 'meta.json'     + v, fetchOpts).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    state.data.reports  = reports;
    state.data.manifest = manifest;
    state.data.meta     = meta;

    idbPut('blobs', 'reports.json',  reports).catch(() => {});
    idbPut('blobs', 'manifest.json', manifest).catch(() => {});
    if (meta) idbPut('blobs', 'meta.json', meta).catch(() => {});
  } catch (err) {
    console.error('Fetch failed', err);
    if (!haveCache) {
      splashErr.textContent = `Could not fetch data: ${err}. Check your connection — or pass ?data=URL to use a different mirror.`;
      splashErr.classList.add('show');
      return false;
    }
    _deps.ui.toast('Offline — using cached data');
  }

  splash.classList.add('hide');
  return true;
}

async function fetchReportText(report) {
  const key = reportKey(report);
  if (state.cache.text[key]) return state.cache.text[key];

  try {
    const cached = await idbGet('texts', key);
    if (cached) {
      state.cache.text[key] = cached;
      return cached;
    }
  } catch {}

  const mkey = manifestKey(report);
  const entry = state.data.manifest?.texts?.[report.committee]?.[mkey];
  if (!entry) return null;

  // Composite key for the bundled text-shards. DRSC's shard build emits
  // `<committee>|<file_id>` because file_ids repeat across committees.
  const compositeKey = `${report.committee}|${mkey}`;

  // Primary path: bundled text-shards (post-migration to texts-NN.json).
  try {
    const text = await loadTextFromShards('drsc', compositeKey, _deps.config.dataBaseUrl);
    if (text !== null) {
      state.cache.text[key] = text;
      idbPut('texts', key, text).catch(() => {});
      _deps.disk?.write?.('drsc', entry.url, text).catch(() => {});
      return text;
    }
  } catch (e) {
    console.warn('drsc: text-shard fetch failed, falling back to legacy URL', e);
  }

  // Legacy fallback: per-file text/<committee>/<file_id>.txt. Kept so
  // the app keeps working between the build-helper landing and the
  // first derive run that produces texts-meta.json + shards.
  try {
    const res = await fetch(_deps.config.dataBaseUrl + CORPUS_PREFIX + entry.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    state.cache.text[key] = text;
    idbPut('texts', key, text).catch(() => {});
    _deps.disk?.write?.('drsc', entry.url, text).catch(() => {});
    return text;
  } catch (e) {
    try {
      const fromDisk = await _deps.disk?.read?.('drsc', entry.url);
      if (fromDisk) {
        state.cache.text[key] = fromDisk;
        idbPut('texts', key, fromDisk).catch(() => {});
        return fromDisk;
      }
    } catch {}
    console.warn('Failed to fetch text', e);
    return null;
  }
}

// ── Filtering / list rendering ──────────────────────────────────────────────

function getAllReports() {
  const out = [];
  for (const [committee, list] of Object.entries(state.data.reports)) {
    for (const r of list) {
      out.push({ ...r, committee, _category: categoriseReport(r), _date: reportDate(r) });
    }
  }
  return out;
}

function applyFilters() {
  const all = getAllReports();
  const f = state.filters;
  const rawQ = f.search.trim();
  const parsedQ = rawQ ? parseQuery(rawQ) : null;
  const bundle = state.searchBundle;

  // Pre-compute one Set<reportKey> per query token for O(1) doc-membership
  // checks during the filter pass. expandTokenToDocs returns null when the
  // index isn't loaded — in that case the per-token check falls through to
  // substring paths (title / head / cached body).
  const tokenIndexSets = parsedQ
    ? parsedQ.tokens.map(t => expandTokenToDocs(state.searchIndex, t))
    : [];

  const filtered = all.filter(r => {
    if (f.committee && r.committee !== f.committee) return false;
    if (f.ls && String(r.lok_sabha) !== f.ls) return false;
    if (f.category && r._category !== f.category) return false;
    if (!parsedQ) return true;

    const key = reportKey(r);
    const titleLower  = (r.title || '').toLowerCase();
    const bundleEntry = bundle ? bundle.map.get(key) : null;
    const headLower   = bundleEntry ? bundleEntry.head.toLowerCase() : '';
    const cached      = state.cache.text[key];
    const cachedLower = cached ? cached.toLowerCase() : '';

    // tokenHits: index-prefix membership OR substring in title / head / cached.
    // Substring fallback is critical — keeps "PMAY" / "144" working even when
    // the index dropped them (numeric / freq cutoff / OCR edge case).
    function tokenHits(tok, indexSet) {
      if (indexSet && indexSet.has(key)) return true;
      if (titleLower.includes(tok)) return true;
      if (headLower && headLower.includes(tok)) return true;
      if (cachedLower && cachedLower.includes(tok)) return true;
      return false;
    }
    function phraseHits(phrase) {
      if (titleLower.includes(phrase)) return true;
      if (headLower && headLower.includes(phrase)) return true;
      if (cachedLower && cachedLower.includes(phrase)) return true;
      return false;
    }

    if (state.matchAny) {
      // OR mode: any token or phrase satisfies the query.
      const hit = parsedQ.tokens.some((t, i) => tokenHits(t, tokenIndexSets[i]))
              ||  parsedQ.phrases.some(phraseHits);
      if (!hit) return false;
    } else {
      // AND mode (default): every token and every phrase must match.
      if (!parsedQ.tokens.every((t, i) => tokenHits(t, tokenIndexSets[i]))) return false;
      if (!parsedQ.phrases.every(phraseHits)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => {
    switch (f.sort) {
      case 'date_asc':    return (a._date || 0) - (b._date || 0);
      case 'number_desc': return (b.report_number || 0) - (a.report_number || 0);
      case 'number_asc':  return (a.report_number || 0) - (b.report_number || 0);
      case 'committee':   return (a.committee || '').localeCompare(b.committee || '');
      case 'date_desc':
      default:            return (b._date || 0) - (a._date || 0);
    }
  });
  state.filtered = filtered;
  renderList();
  renderResultsLine();
}

function renderResultsLine() {
  const el = document.getElementById('resultsLine');
  if (!el) return;
  const total = getAllReports().length;
  const shown = state.filtered.length;
  const meta = state.data.meta;
  let metaLine = '';
  if (meta?.generated_at) {
    metaLine = `Mirror updated <b>${escapeHtml(formatLocalTimestamp(meta.generated_at))}</b>`;
  }

  let indexLine = '';
  const bundle = state.searchBundle;
  const idx = state.searchIndex;
  const mirrorWithText = Object.values(state.data.manifest?.texts || {}).reduce((s, c) => s + Object.keys(c).length, 0);
  const loading = state.bundleLoading || state.indexLoading;
  if (loading) {
    const what = state.bundleLoading && state.indexLoading
      ? 'bundle + index'
      : state.bundleLoading ? 'bundle' : 'index';
    indexLine = `<span class="indexing">Loading search ${what}…</span>`;
  } else if (state.deepSearch && state.bundleLoaded && bundle) {
    const tooltip = idx
      ? `Search hits titles + first ${bundle.head_chars} chars of every report, plus body-token presence across the corpus.`
      : `Search hits titles + first ${bundle.head_chars} chars of every report.`;
    indexLine = `<span title="${escapeHtml(tooltip)}">Full-text search · ${bundle.total} reports</span>`
              + ` · <label class="match-any-toggle"><input type="checkbox" id="matchAnyToggle"${state.matchAny ? ' checked' : ''}>match any</label>`;
  } else if (mirrorWithText === 0) {
    indexLine = '';
  } else {
    indexLine = `<span>Title search only · <b>${mirrorWithText}</b> reports with text · <a href="#" id="enableDeepLink" style="color:var(--accent)">enable deep search</a></span>`;
  }
  el.innerHTML = (shown > 0 && shown < total)
    ? `<div class="rl-primary">Showing <b>${shown}</b> of <b>${total}</b></div>`
    : '';

  // "enable deep search" inline link — flips the toggle, persists, kicks
  // off both bundle + index fetches. They run in parallel; the listing
  // updates as each finishes.
  const enableLink = document.getElementById('enableDeepLink');
  if (enableLink) {
    enableLink.addEventListener('click', (e) => {
      e.preventDefault();
      state.deepSearch = true;
      const s = loadSettings();
      s.deepSearch = true;
      saveSettings(s);
      renderResultsLine();
      Promise.all([loadSearchBundle(), loadSearchIndex()]).then(() => {
        renderResultsLine();
        if (state.filters.search) applyFilters();
      });
    });
  }
  const matchAnyToggle = document.getElementById('matchAnyToggle');
  if (matchAnyToggle) {
    matchAnyToggle.addEventListener('change', (e) => {
      state.matchAny = !!e.target.checked;
      const s = loadSettings();
      s.matchAny = state.matchAny;
      saveSettings(s);
      applyFilters();
    });
  }

  // Toolbar button states
  const sumBtn = document.getElementById('exportSummariesBtn');
  if (sumBtn) {
    const n = Object.keys(state.cache.summaries || {}).length;
    sumBtn.disabled = n === 0;
    sumBtn.textContent = n ? `⬇ Summaries (MD, ${n})` : '⬇ Summaries (MD)';
  }
}

function hasExtractedText(r) {
  const mkey = manifestKey(r);
  return !!state.data.manifest?.texts?.[r.committee]?.[mkey];
}

function hasSummary(r) {
  return !!state.cache.summaries[reportKey(r)];
}

function renderList() {
  const list = document.getElementById('reportsList');
  if (!list) return;
  if (!state.filtered.length) {
    list.innerHTML = `<div class="empty-state"><h3>No reports match</h3><p>Try clearing filters.</p></div>`;
    return;
  }
  // Cap initial render to 200 for perf.
  const slice = state.filtered.slice(0, 200);
  // Parse query once for highlight (renders match in title with <mark>).
  const rawQ = state.filters.search.trim();
  const parsedQ = rawQ ? parseQuery(rawQ) : null;
  list.innerHTML = slice.map(r => {
    const committee = COMMITTEES[r.committee]?.name || r.committee;
    const cat = r._category || 'SUBJ';
    const catLabel = (CATEGORY_PATTERNS.find(p => p.code === cat) || { label: 'Subject' }).label;
    const dateStr = formatDate(r._date);
    const num = r.report_number != null ? `#${escapeHtml(r.report_number)}` : '';
    const titleHTML = parsedQ ? highlightMatches(r.title || '(untitled report)', parsedQ)
                              : escapeHtml(r.title || '(untitled report)');
    return `
      <div class="report-row" data-key="${escapeHtml(reportKey(r))}">
        <div>
          <div class="report-title">${titleHTML}</div>
          <div class="report-meta">${escapeHtml(committee)} · LS${escapeHtml(r.lok_sabha || '?')} · ${num}</div>
        </div>
        <span class="house-pill house-${r.house || 'L'}">${r.house === 'R' ? 'RS' : 'LS'}</span>
        <span class="cat-badge cat-${cat}" title="${escapeHtml(catLabel)}">${cat}</span>
        <span class="report-meta">${escapeHtml(dateStr)}</span>
        <span class="text-status ${hasSummary(r) ? 'summary' : (hasExtractedText(r) ? 'ok' : '')}">
          ${hasSummary(r) ? 'summary' : (hasExtractedText(r) ? 'text' : 'metadata')}
        </span>
      </div>
    `;
  }).join('');
  if (state.filtered.length > 200) {
    list.insertAdjacentHTML('beforeend',
      `<div class="empty-state" style="padding:18px"><p>Showing first 200 of ${state.filtered.length} matches — refine filters to narrow further.</p></div>`);
  }
}

function renderHeaderStats() {
  const el = document.getElementById('headerStats');
  if (!el) return;
  const all = getAllReports();
  const extracted = Object.values(state.data.manifest?.texts || {}).reduce((sum, c) => sum + Object.keys(c).length, 0);
  el.innerHTML = `
    <span><b>${all.length}</b> reports</span>
    <span><b>${Object.keys(state.data.reports).length}</b> committees</span>
    <span><b>${extracted}</b> with text</span>
  `;
}

function populateFilters() {
  const cSel = document.getElementById('filterCommittee');
  if (cSel) {
    cSel.innerHTML = '<option value="">All committees</option>' +
      Object.entries(COMMITTEES)
        .filter(([k]) => state.data.reports[k]?.length)
        .sort((a, b) => a[1].name.localeCompare(b[1].name))
        .map(([k, v]) => `<option value="${k}">${escapeHtml(v.name)}${v.house === 'R' ? ' (RS)' : ''}</option>`)
        .join('');
  }
  const lsSel = document.getElementById('filterLS');
  if (lsSel) {
    const lsSet = new Set();
    for (const list of Object.values(state.data.reports)) for (const r of list) if (r.lok_sabha) lsSet.add(r.lok_sabha);
    const lsSorted = [...lsSet].sort((a, b) => b - a);
    lsSel.innerHTML = '<option value="">All Lok Sabhas</option>' +
      lsSorted.map(ls => `<option value="${ls}">LS ${ls}</option>`).join('');
  }

  // Re-apply persisted state values so corpus-switch round-trips show the
  // active selection in the dropdown UI (not just in state.filters).
  if (cSel)  cSel.value  = state.filters.committee || '';
  if (lsSel) lsSel.value = state.filters.ls        || '';
}

// ── Report dialog ───────────────────────────────────────────────────────────

function openReportByKey(key) {
  const all = getAllReports();
  const r = all.find(x => reportKey(x) === key);
  if (!r) return;
  // Stop any in-flight generation tied to a *different* report so we don't
  // corrupt the new dialog's chat.
  if (_deps.ai.streaming() && state.streamingContext?.reportKey !== key) {
    _deps.ai.stop();
    state.streamingContext = null;
  }
  state.selectedReport = r;
  state.dialogChat = state.cache.chats[key] ? [...state.cache.chats[key]] : [];
  document.getElementById('reportTitle').textContent = r.title || '(untitled)';
  renderDetailsTab(r);
  switchReportTab('details');
  document.getElementById('reportModal').classList.add('open');
}

function renderDetailsTab(r) {
  const committee = COMMITTEES[r.committee]?.name || r.committee;
  const upstream = `https://github.com/pranaykotas/parliamentwatch`;
  document.getElementById('detailsTab').innerHTML = `
    <dl class="meta-grid">
      <dt>Committee</dt><dd>${escapeHtml(committee)} <span class="house-pill house-${r.house || 'L'}">${r.house === 'R' ? 'RS' : 'LS'}</span></dd>
      <dt>Report no.</dt><dd>${escapeHtml(r.report_number ?? '—')}</dd>
      <dt>Lok Sabha</dt><dd>${escapeHtml(r.lok_sabha ?? '—')}</dd>
      <dt>Category</dt><dd><span class="cat-badge cat-${r._category}">${r._category}</span></dd>
      <dt>Date of presentation</dt><dd>${escapeHtml(r.date_of_presentation || r.presented_in_ls || r.laid_in_rs || '—')}</dd>
      <dt>Date of adoption</dt><dd>${escapeHtml(r.date_of_adoption || '—')}</dd>
      ${r.pdf_url ? `<dt>PDF (English)</dt><dd><a href="${escapeHtml(r.pdf_url)}" target="_blank" rel="noopener">${escapeHtml(r.pdf_url.split('/').pop())}</a></dd>` : ''}
      ${r.pdf_url_hindi ? `<dt>PDF (Hindi)</dt><dd><a href="${escapeHtml(r.pdf_url_hindi)}" target="_blank" rel="noopener">${escapeHtml(r.pdf_url_hindi.split('/').pop())}</a></dd>` : ''}
      <dt>Source</dt><dd><a href="https://sansad.in" target="_blank">sansad.in</a> via <a href="${upstream}" target="_blank">ParliamentWatch</a></dd>
    </dl>
    <p style="margin-top:14px; font-size:0.82rem; color:var(--muted)">
      ${hasExtractedText(r)
        ? 'Full text has been extracted by the mirror — see the "Full text" tab or generate an AI summary.'
        : 'Full text has not yet been extracted by the mirror. The daily Action picks reports up incrementally — check back, or open the PDF directly.'}
    </p>
  `;
}

async function loadTextTab() {
  const r = state.selectedReport;
  const tab = document.getElementById('textTab');
  if (!r) { tab.innerHTML = ''; return; }
  if (!hasExtractedText(r)) {
    tab.innerHTML = `<p>Full text hasn't been extracted yet. Open the PDF link from the Details tab.</p>`;
    return;
  }
  tab.innerHTML = `<p style="color:var(--muted)">Loading…</p>`;
  const text = await fetchReportText(r);
  if (!text) { tab.innerHTML = `<p>Could not load the extracted text.</p>`; return; }
  tab.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
  // Cached text now usable for search — refresh badges.
  renderList();
}

function switchReportTab(name) {
  // Multi-corpus guard — bail if DRSC isn't the active corpus, otherwise
  // we'd stomp another corpus's rendered tab. See CONV.md "Multi-corpus
  // shared-DOM guard".
  if (_deps.activeCorpus?.() !== 'drsc') return;
  document.querySelectorAll('#reportModal .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('#reportModal .tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById(name + 'Tab').classList.add('active');
  if (name === 'text')    loadTextTab();
  if (name === 'summary') renderSummaryTab();
  if (name === 'chat')    renderChatTab();
}

function renderSummaryTab() {
  const tab = document.getElementById('summaryTab');
  const r = state.selectedReport;
  if (!r) { tab.innerHTML = ''; return; }
  if (!_deps.ai.isUsable()) {
    tab.innerHTML = _deps.ai.notReadyHTML();
    _deps.ai.bindNotReadyCTA(tab);
    return;
  }
  const key = reportKey(r);
  const cached = state.cache.summaries[key];
  const isStreaming = state.streamingContext?.reportKey === key
                  &&  state.streamingContext?.tab === 'summary';

  if (isStreaming) {
    tab.innerHTML = `
      <div class="summary-actions">
        <span class="label">Generating summary… (streams in below)</span>
        <button class="ghost sm" id="stopSummaryBtn">Stop</button>
      </div>
      <div class="summary-box" id="summaryBox">${escapeHtml(cached || '')}</div>
    `;
    document.getElementById('stopSummaryBtn').addEventListener('click', () => {
      _deps.ai.stop();
      state.streamingContext = null;
    });
    return;
  }

  tab.innerHTML = `
    <div class="summary-actions">
      <span class="label">Generate a plain-English summary using your configured AI:</span>
      <button class="primary" id="generateSummaryBtn">${cached ? 'Regenerate' : 'Generate'}</button>
      <button class="ghost sm" id="copySummaryBtn" ${cached ? '' : 'style="display:none"'}>Copy</button>
    </div>
    <div class="summary-box" id="summaryBox">${cached ? escapeHtml(cached) : 'No summary yet.'}</div>
  `;
  document.getElementById('generateSummaryBtn').addEventListener('click', generateSummary);
  document.getElementById('copySummaryBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('summaryBox').textContent || '');
    _deps.ui.toast('Copied');
  });
}

function renderChatTab() {
  const tab = document.getElementById('chatTab');
  const r = state.selectedReport;
  if (!r) { tab.innerHTML = ''; return; }
  if (!_deps.ai.isUsable()) {
    tab.innerHTML = _deps.ai.notReadyHTML();
    _deps.ai.bindNotReadyCTA(tab);
    return;
  }
  const key = reportKey(r);
  const isStreaming = state.streamingContext?.reportKey === key
                  &&  state.streamingContext?.tab === 'chat';

  const messages = state.dialogChat.length
    ? state.dialogChat
    : [{ role: 'system', content: 'Ask anything about this report. Your question + the report text are sent to the AI you configured (local Gemma or BYOK).' }];

  const threadHTML = messages.map(m => {
    const cls = `chat-msg ${m.role}${m.error ? ' error' : ''}`;
    return `<div class="${cls}">${escapeHtml(m.content)}</div>`;
  }).join('');

  const searchOn = _deps.search.isConfigured();
  tab.innerHTML = `
    <div class="chat-thread" id="chatThread">${threadHTML}</div>
    <div class="chat-input-row">
      <textarea id="chatInput" rows="2" placeholder="Ask a question about this report..." ${isStreaming ? 'disabled' : ''}></textarea>
      ${searchOn ? `<button class="ghost sm" id="chatSearchSendBtn" title="Search the web AND Send (uses your configured search provider)" ${isStreaming ? 'disabled' : ''}>&#127760;</button>` : ''}
      <button class="primary" id="chatSendBtn" ${isStreaming ? 'disabled' : ''}>Send</button>
      <button class="ghost sm" id="chatStopBtn" ${isStreaming ? '' : 'style="display:none"'}>Stop</button>
    </div>
  `;
  document.getElementById('chatSendBtn').addEventListener('click', () => chatSend({}));
  if (searchOn) document.getElementById('chatSearchSendBtn').addEventListener('click', () => chatSend({ withSearch: true }));
  document.getElementById('chatStopBtn').addEventListener('click', () => {
    _deps.ai.stop();
    state.streamingContext = null;
  });
  document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend({}); }
  });
  const t = document.getElementById('chatThread');
  if (t) t.scrollTop = t.scrollHeight;
}

// Local Gemma E2B has 8K context — leave room for prompt + output. ~6K
// input chars (~1500 tokens). API providers have more room — cap at 60K.
function _truncateForContext(text) {
  const limit = _deps.ai.mode() === 'local' ? 12000 : 60000;
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n\n[...truncated for context window...]';
}

async function generateSummary() {
  const r = state.selectedReport;
  if (!r) return;
  const text = await fetchReportText(r);
  if (!text) {
    _deps.ui.toast('Full text not available — extract pending');
    return;
  }
  const key = reportKey(r);
  const prompt = SUMMARY_PROMPT.replace('{TEXT}', _truncateForContext(text));
  const messages = [
    { role: 'system', content: 'You are a careful, accurate summariser of policy documents.' },
    { role: 'user',   content: prompt },
  ];

  // Stream via the shared helper. See app/ai-streaming.js + CONV.md
  // "Streaming AI persistence pattern".
  const previousCached = state.cache.summaries[key] || '';
  state.streamingContext = { reportKey: key, tab: 'summary' };
  renderSummaryTab();
  try {
    const result = await streamWithPersistence({
      generate: _deps.ai.generate,
      messages,
      onText: (full) => {
        if (state.streamingContext?.reportKey === key) {
          const box = document.getElementById('summaryBox');
          if (box) box.textContent = full;
        }
      },
    });
    if (result.ok) {
      state.cache.summaries[key] = result.text;
      idbPut('summaries', key, result.text).catch(() => {});
      if (_deps.disk?.saveAi?.() && _deps.disk?.isConnected?.()) {
        // DRSC report keys are <committee>|<ls>|<num>; write under
        // ai/<committee>/LS<n>_<num>.summary.md to mirror the text/ layout.
        const file_id = `LS${r.lok_sabha}_${String(r.report_number).replace(/\//g, '-').replace(/ /g, '_')}`;
        _deps.disk.write('drsc', `ai/${r.committee}/${file_id}.summary.md`, result.text).catch(() => {});
      }
    } else {
      state.cache.summaries[key] = previousCached;
      _deps.ui.toast('Summary generation failed: ' + result.error.message);
    }
  } finally {
    state.streamingContext = null;
    renderSummaryTab();
    renderList();
  }
}

async function chatSend(opts) {
  opts = opts || {};
  const r = state.selectedReport;
  if (!r) return;
  const input = document.getElementById('chatInput');
  const q = input.value.trim();
  if (!q) return;
  if (_deps.ai.streaming()) { _deps.ui.toast('Already responding…'); return; }

  const text = await fetchReportText(r);
  if (!text) { _deps.ui.toast('Full text not available'); return; }

  // From here on, state.dialogChat is mutated. Wrap in try/finally so
  // EVERY exit path persists the conversation to IDB — including early
  // returns from the search-config branch. See CONV.md "Streaming AI
  // persistence pattern".
  const k = reportKey(r);
  state.dialogChat.push({ role: 'user', content: q });
  try {
    let searchResults = null;
    if (opts.withSearch) {
      if (!_deps.search.isConfigured()) {
        state.dialogChat.push({ role: 'system', content: 'Web search not configured. Open Settings → Web search to add a provider.' });
        input.value = '';
        renderChatTab();
        return;
      }
      state.dialogChat.push({ role: 'system', content: `Searching the web for "${q}"…` });
      renderChatTab();
      try {
        searchResults = await _deps.search.run(q);
        const resultLine = searchResults.length
          ? `Found ${searchResults.length} result${searchResults.length === 1 ? '' : 's'}: ${searchResults.map(x => x.title).slice(0, 3).join(' · ')}${searchResults.length > 3 ? '…' : ''}`
          : 'No web results.';
        state.dialogChat[state.dialogChat.length - 1] = { role: 'system', content: resultLine };
      } catch (e) {
        state.dialogChat[state.dialogChat.length - 1] = { role: 'system', content: 'Search failed: ' + e.message };
        searchResults = null;
      }
    }

    state.dialogChat.push({ role: 'assistant', content: '' });
    state.streamingContext = { reportKey: reportKey(r), tab: 'chat' };
    input.value = '';
    renderChatTab();

    const summary = state.cache.summaries[reportKey(r)];
    const userPrompt = buildAskPrompt({
      summary: summary || null,
      text: _truncateForContext(text),
      searchResults,
      question: q,
    });
    const messages = [
      { role: 'system', content: 'You answer questions about Indian Parliamentary Standing Committee reports. Use only the supplied material. If the answer is not present, say so.' },
      { role: 'user',   content: userPrompt },
    ];

    const result = await streamWithPersistence({
      generate: _deps.ai.generate,
      messages,
      onText: (full) => {
        const last = state.dialogChat[state.dialogChat.length - 1];
        last.content = full;
        const lastEl = document.querySelector('#chatThread .chat-msg.assistant:last-child');
        if (lastEl) {
          lastEl.textContent = full;
          const t = document.getElementById('chatThread');
          if (t) t.scrollTop = t.scrollHeight;
        }
      },
    });
    const last = state.dialogChat[state.dialogChat.length - 1];
    if (result.ok) {
      last.content = result.text;
    } else {
      last.error = true;
      last.content = 'Error: ' + result.error.message;
    }
  } finally {
    state.streamingContext = null;
    renderChatTab();
    state.cache.chats[k] = [...state.dialogChat];
    idbPut('chats', k, state.dialogChat).catch(() => {});
    if (_deps.disk?.saveAi?.() && _deps.disk?.isConnected?.()) {
      const file_id = `LS${r.lok_sabha}_${String(r.report_number).replace(/\//g, '-').replace(/ /g, '_')}`;
      _deps.disk.write('drsc', `ai/${r.committee}/${file_id}.chat.json`, JSON.stringify(state.dialogChat, null, 2)).catch(() => {});
    }
  }
}

// ── Search bundle (v0.6) ────────────────────────────────────────────────────
//
// Fetches docs/search-bundle.json once, caches in IDB, parses entries into a
// Map<key, {title, head}>. Used by applyFilters when deep search is on so
// the user gets substring matching across the first 5K chars of every
// extracted report without paying the ~177 MB fan-out the SansadLocal-era
// "deep search" used to do.
//
// Offline-first: IDB cache lights up the search instantly on return visits;
// network fetch runs in parallel and replaces the in-memory bundle if the
// mirror has a newer one (compared via generated_at). 5-min CF edge cache
// means re-visits within a window pay zero origin cost.

// _parseBundle takes a "merged" cache shape (entries flattened across all
// shards) and builds the in-memory Map<key, {title, head}>. The cache shape
// is flat so future shard re-shuffles on the mirror side don't invalidate
// existing IDB caches by key changes.
// Bundle + index loaders are thin wrappers around app/corpus-search.js,
// which owns the actual mechanism (parse, IDB cache, sharded fetch,
// in-flight dedupe). DRSC just supplies the legacy unprefixed IDB keys
// (preserved across the v1.0a rename to avoid invalidating existing
// users' IDB caches) and the corpus-specific state-update hooks.

async function loadSearchBundle() {
  return sharedLoadSearchBundle({
    state,
    corpusId:    'drsc',
    idbKey:      'search-bundle.json',     // legacy unprefixed — preserve
    urlPath:     CORPUS_PREFIX,
    meta:        state.data.meta,
    deps:        _deps,
    onChange:    renderResultsLine,
    onAfterLoad: () => { if (state.filters.search) applyFilters(); },
  });
}

async function loadSearchIndex() {
  return sharedLoadSearchIndex({
    state,
    corpusId:    'drsc',
    idbKey:      'search-index.json',     // legacy unprefixed — preserve
    urlPath:     CORPUS_PREFIX,
    meta:        state.data.meta,
    deps:        _deps,
    onChange:    renderResultsLine,
    onAfterLoad: () => { if (state.filters.search) applyFilters(); },
  });
}


// ── Export ──────────────────────────────────────────────────────────────────

function _csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function _downloadBlob(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

function _ts() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function exportMetadataCSV() {
  const rows = state.filtered;
  if (!rows.length) { _deps.ui.toast('No reports to export'); return; }
  const headers = [
    'committee_key', 'committee_name', 'house', 'lok_sabha',
    'report_number', 'title', 'category', 'date_of_presentation',
    'date_of_adoption', 'pdf_url', 'pdf_url_hindi', 'has_text', 'has_summary',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const cm = COMMITTEES[r.committee]?.name || r.committee;
    lines.push([
      r.committee, cm, r.house || 'L', r.lok_sabha,
      r.report_number, r.title, r._category,
      r.date_of_presentation || r.presented_in_ls || r.laid_in_rs || '',
      r.date_of_adoption || '',
      r.pdf_url || '', r.pdf_url_hindi || '',
      hasExtractedText(r) ? 'yes' : 'no',
      hasSummary(r) ? 'yes' : 'no',
    ].map(_csvCell).join(','));
  }
  const csv = lines.join('\n') + '\n';
  _downloadBlob(`sansadsaar-metadata-${_ts()}.csv`, 'text/csv', csv);
  _deps.ui.toast(`Exported ${rows.length} reports`);
}

function exportSummariesMD() {
  const all = getAllReports();
  const out = [];
  out.push(`# SansadSaar — AI summaries`);
  out.push('');
  out.push(`Exported ${new Date().toLocaleString('en-IN')}. Source: <https://sansadsaar.naklitechie.com>.`);
  out.push('');
  let n = 0;
  for (const r of all) {
    const key = reportKey(r);
    const summary = state.cache.summaries[key];
    if (!summary) continue;
    n++;
    const cm = COMMITTEES[r.committee]?.name || r.committee;
    out.push('---');
    out.push('');
    out.push(`## ${r.title || '(untitled)'}`);
    out.push('');
    out.push(`*${cm} · LS${r.lok_sabha} · Report #${r.report_number}*`);
    if (r.pdf_url) out.push(`*PDF: <${r.pdf_url}>*`);
    out.push('');
    out.push(summary);
    out.push('');
  }
  if (!n) { _deps.ui.toast('No summaries cached yet'); return; }
  _downloadBlob(`sansadsaar-summaries-${_ts()}.md`, 'text/markdown', out.join('\n'));
  _deps.ui.toast(`Exported ${n} summaries`);
}

// ── IDB hydration ──────────────────────────────────────────────────────────

// IDB hydration — mechanism lives in app/corpus-data.js. DRSC's text
// hydration is special: pre-v0.4 sessions stored text keyed by
// committee|<ls>|<num> for every LS variant of a number (file paths
// weren't LS-namespaced). After v0.4 only one variant has a file on the
// mirror; the others are stale orphans. We use the `validate` callback
// to evict them in-place via 'readwrite' mode.

async function loadCachedSummaries() {
  // No key filter — DRSC was the original corpus, its summary keys have
  // no prefix. Other corpora's keys (cag|*, bills|*) get loaded too but
  // never read by DRSC, so it's harmless if a touch wasteful on memory.
  // Caller is responsible for any post-hydration re-render — silent
  // preloads (cross-corpus search warmup) must NOT touch the visible DOM,
  // so renderList() is gated at the call site, not here.
  await hydrateFromIDB({ store: 'summaries', target: state.cache.summaries });
}

async function loadCachedChats() {
  await hydrateFromIDB({ store: 'chats', target: state.cache.chats });
}

async function loadCachedTexts() {
  const { added, dropped } = await hydrateFromIDB({
    store: 'texts',
    target: state.cache.text,
    mode: 'readwrite',   // allow validate() to evict orphans in-place
    validate: (key) => {
      const [committee, ls, num] = String(key).split('|');
      const safeNum = String(num ?? '').replace(/\//g, '-').replace(/\s+/g, '_');
      const mkey = ls ? `LS${ls}_${safeNum}` : safeNum;
      return !!state.data.manifest?.texts?.[committee]?.[mkey];
    },
  });
  // Kept as a deliberate diagnostic (console.info, not log) — a nonzero drop
  // count is the signal that cached texts have drifted from the manifest.
  if (dropped) console.info(`drsc loadCachedTexts: hydrated ${added}, dropped ${dropped} stale orphan entries`);
  return added;
}

// ── Handlers ────────────────────────────────────────────────────────────────

// Injects the DRSC filter row HTML into the shared #filtersContainer. Each
// corpus owns its own filter UI; `renderFilterRow` is idempotent and gets
// called every time the corpus is shown so the row stays consistent even
// when the user has switched away to another corpus and back.
function renderFilterRow() {
  const container = document.getElementById('filtersContainer');
  if (!container) return;
  container.innerHTML = `
    <input type="search" id="filterSearch" placeholder="Search title or full text..." autocomplete="off">
    <select id="filterCommittee"><option value="">All committees</option></select>
    <select id="filterLS"><option value="">All Lok Sabhas</option></select>
    <select id="filterCategory">
      <option value="">All categories</option>
      <option value="DFG">Demand for Grants</option>
      <option value="AT">Action Taken</option>
      <option value="BILL">Bills</option>
      <option value="ASSURE">Assurances</option>
      <option value="SUBJ">Subjects</option>
    </select>
    <select id="filterSort">
      <option value="date_desc">Newest first</option>
      <option value="date_asc">Oldest first</option>
      <option value="number_desc">Report no. (high→low)</option>
      <option value="number_asc">Report no. (low→high)</option>
      <option value="committee">Committee A→Z</option>
    </select>
    <button class="ghost sm" id="resetFiltersBtn" title="Reset filters">&times;</button>
  `;
  // Re-apply persisted/current filter values so a corpus-switch round-trip
  // doesn't lose what the user had typed.
  document.getElementById('filterSearch').value    = state.filters.search    || '';
  document.getElementById('filterCommittee').value = state.filters.committee || '';
  document.getElementById('filterLS').value        = state.filters.ls        || '';
  document.getElementById('filterCategory').value  = state.filters.category  || '';
  document.getElementById('filterSort').value      = state.filters.sort      || 'date_desc';
}

function attachHandlers() {
  const debouncedSearch = debounce(() => { state.filters.search = document.getElementById('filterSearch').value; applyFilters(); }, 200);
  document.getElementById('filterSearch').addEventListener('input', debouncedSearch);
  document.getElementById('filterCommittee').addEventListener('change', e => { state.filters.committee = e.target.value; applyFilters(); });
  document.getElementById('filterLS').addEventListener('change',        e => { state.filters.ls        = e.target.value; applyFilters(); });
  document.getElementById('filterCategory').addEventListener('change',  e => { state.filters.category  = e.target.value; applyFilters(); });
  document.getElementById('filterSort').addEventListener('change',      e => { state.filters.sort      = e.target.value; applyFilters(); });
  document.getElementById('resetFiltersBtn').addEventListener('click', () => {
    state.filters = { search: '', committee: '', ls: '', category: '', sort: 'date_desc' };
    document.getElementById('filterSearch').value = '';
    document.getElementById('filterCommittee').value = '';
    document.getElementById('filterLS').value = '';
    document.getElementById('filterCategory').value = '';
    document.getElementById('filterSort').value = 'date_desc';
    applyFilters();
  });

  // Reports list (event delegation).
  document.getElementById('reportsList').addEventListener('click', e => {
    const row = e.target.closest('.report-row');
    if (row) openReportByKey(row.dataset.key);
  });

  // Report dialog frame.
  const closeBtn = document.getElementById('reportCloseBtn');
  if (closeBtn && !closeBtn.dataset._wired) {
    closeBtn.dataset._wired = '1';
    closeBtn.addEventListener('click', () => _deps.ui.closeModal('reportModal'));
  }
  document.querySelectorAll('#reportModal .tab-btn').forEach(b => {
    if (b.dataset._drscWired) return;   // already attached
    b.dataset._drscWired = '1';
    b.addEventListener('click', () => switchReportTab(b.dataset.tab));
  });

  // Toolbar exports.
  document.getElementById('exportMetaBtn').addEventListener('click', exportMetadataCSV);
  document.getElementById('exportSummariesBtn').addEventListener('click', exportSummariesMD);
}

// ── Status (for shell's per-corpus status pill) ─────────────────────────────

async function fetchStatus() {
  // Already have meta in state.data.meta after fetchData; expose it cheaply.
  const meta = state.data.meta;
  const withText = Object.values(state.data.manifest?.texts || {}).reduce((s, c) => s + Object.keys(c).length, 0);
  if (!meta) return { lastUpdate: null, items: getAllReports().length, withText, error: null };
  return {
    lastUpdate: meta.generated_at || null,
    items: meta.total_reports || getAllReports().length,
    withText,
    error: null,
  };
}

// ── Settings section (DRSC-specific UI inside shell's settings modal) ───────

function renderSettingsSection(container) {
  // Renders the "Search" (deep search) + "Data" sections — DRSC-specific
  // because both are about the DRSC corpus's manifest + report files.
  // Shell calls this inside its settings modal alongside shell-level sections.
  const meta = state.data.meta;
  const bundle = state.searchBundle;
  const manifestEntries = Object.values(state.data.manifest?.texts || {}).reduce((s, c) => s + Object.keys(c).length, 0);
  const bundleStats = meta?.search_bundle;   // {total, head_chars, size_bytes, truncated} or null

  // Two-file estimate: search-bundle (snippet + first 5K chars per report)
  // + search-index (token presence across full body). Both cache in IDB.
  const indexStats = meta?.search_index;
  let estimateLine;
  if (state.bundleLoaded && state.indexLoaded && bundle && state.searchIndex) {
    estimateLine = `Search bundle + body index loaded: ${bundle.total} reports, ${state.searchIndex.vocab_size.toLocaleString()} tokens indexed. Cached locally — no new bandwidth.`;
  } else if (state.bundleLoaded && bundle) {
    estimateLine = `Bundle loaded (${bundle.total} reports). Body index will load next; substring + first-5K-chars search active now.`;
  } else if (bundleStats?.size_bytes && indexStats?.size_bytes) {
    const totalMB = ((bundleStats.size_bytes + indexStats.size_bytes) / (1024 * 1024)).toFixed(1);
    estimateLine = `~${totalMB} MB total (CF gzip serves ~30%, cached locally after). Bundle covers titles + first ${bundleStats.head_chars} chars; body index covers token presence across the full corpus.`;
  } else {
    estimateLine = `Single download per file, cached locally after. Bundle covers first 5,000 chars per report; body index covers token presence across the full body.`;
  }

  container.innerHTML = `
    <div class="settings-section">
      <h3>Search (Standing Committees)</h3>
      <p>By default, search matches report titles plus any reports you've already opened. Enable deep search to fetch the search bundle (title + first 5K chars per report) and the body index (token presence across the full body) — both cached locally after first load.</p>
      <p style="font-size:0.82rem; color:var(--muted); margin-bottom:6px;">Tip: wrap a phrase in double quotes (<code>"section 144"</code>) for an exact-substring match. Toggle "match any" in the results line to switch from AND to OR semantics across multiple words.</p>
      <div class="settings-row">
        <label for="deepSearch">Deep search</label>
        <div>
          <label style="display:inline-flex; align-items:center; gap:6px; font-size:0.86rem; color:var(--text)">
            <input type="checkbox" id="deepSearch" ${state.deepSearch ? 'checked' : ''} style="width:auto"> Enable full-text search across all extracted reports
          </label>
          <p id="deepSearchEstimate" style="font-size:0.78rem; color:var(--muted); margin-top:4px">${escapeHtml(estimateLine)}</p>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Data (Standing Committees)</h3>
      <p id="dataInfo">${meta
        ? `${_deps.ui.stalenessIndicatorHTML('drsc', meta)} · ${escapeHtml(String(meta.total_reports))} reports total · text limit ${escapeHtml(String(meta.text_limit_per_committee || '?'))} per committee`
        : `Source: ${escapeHtml(_deps.config.dataBaseUrl)}`}</p>
      <button class="sm" id="refreshDataBtn">Refresh from mirror</button>
    </div>
  `;
  _deps.ui.bindStalenessIndicators(container);

  document.getElementById('refreshDataBtn').addEventListener('click', async () => {
    _deps.ui.toast('Refreshing…');
    await fetchData(true);
    populateFilters();
    renderHeaderStats();
    applyFilters();
    _deps.broadcast('drsc:data-refreshed');
    // Re-render this section to refresh "Last updated" line.
    renderSettingsSection(container);
    _deps.ui.toast('Data refreshed');
  });
}

// Called by shell after settings save — picks up any toggled deep-search state
// and kicks off the indexer if newly enabled.
function applySettingsFromUI() {
  const wasDeep = state.deepSearch;
  const cbox = document.getElementById('deepSearch');
  if (cbox) state.deepSearch = !!cbox.checked;
  const s = loadSettings();
  s.deepSearch = state.deepSearch;
  saveSettings(s);
  if (state.deepSearch && !wasDeep) {
    loadSearchBundle();
    loadSearchIndex();
  }
}

// ── Activation / lifecycle ──────────────────────────────────────────────────

// Tracks whether the heavy one-time setup (data fetch, IDB hydration) has
// already run for this session. Subsequent activate() calls skip it but
// still re-render the filter row + list — necessary when user switches
// back to DRSC from another corpus that overwrote `#filtersContainer`.
let _activated = false;

async function activate(deps, { silent = false } = {}) {
  _deps = deps;

  // ALWAYS (when not silent) — re-render filter row + handlers + applied
  // filters so a corpus-switch round-trip restores DRSC's UI even if CAG
  // or Bills replaced the DOM in `#filtersContainer`. Silent mode (used
  // by shell to preload non-active corpora for cross-corpus search)
  // skips DOM mutation entirely so it doesn't fight the currently-active
  // corpus's render.
  if (!silent) {
    renderFilterRow();
    attachHandlers();
  }

  if (!_activated) {
    _activated = true;
    // Load DRSC-specific settings slice.
    const settings = loadSettings();
    state.deepSearch = !!settings.deepSearch;
    state.matchAny   = !!settings.matchAny;

    const ok = await fetchData();
    if (!ok) return false;
    if (!silent) {
      populateFilters();
      renderHeaderStats();
      applyFilters();
    }

    loadCachedSummaries().then(() => { if (!silent) renderList(); });
    loadCachedChats();
    loadCachedTexts().then((n) => {
      if (n && !silent) {
        renderList();
        renderResultsLine();
      }
      // Light up the bundle + index if the user has deep search on. IDB
      // cache hits first per file, network fetches newer copies in the
      // background. They run in parallel.
      if (state.deepSearch) {
        loadSearchBundle();
        loadSearchIndex();
      }
    });
  } else if (!silent) {
    // Re-mount: data already fetched, just refresh the visible UI.
    populateFilters();
    renderHeaderStats();
    applyFilters();
  }

  return true;
}

// Called by shell when AI state transitions (model loaded, mode switched, etc.)
// so DRSC can re-render the open dialog's Summary / Chat tabs.
function refreshAIDependentTabs() {
  if (!state.selectedReport) return;
  const sumActive  = document.getElementById('summaryTab')?.classList.contains('active');
  const chatActive = document.getElementById('chatTab')?.classList.contains('active');
  if (sumActive)  renderSummaryTab();
  if (chatActive) renderChatTab();
}

// ── JS API surface ─────────────────────────────────────────────────────────

const api = {
  // List reports, optionally filtered. Returns the raw report objects with
  // committee + _category + _date computed.
  list({ committee, lokSabha, category } = {}) {
    return getAllReports().filter(r => {
      if (committee && r.committee !== committee) return false;
      if (lokSabha != null && String(r.lok_sabha) !== String(lokSabha)) return false;
      if (category && r._category !== category) return false;
      return true;
    });
  },
  // Look up a single report by reportKey ('committee|ls|num').
  get(key) {
    return getAllReports().find(r => reportKey(r) === key) || null;
  },
  // Mirrors the app-bar search semantics: parses tokens + quoted phrases,
  // applies AND-by-default (or OR via opts.any), uses bundle + index when
  // loaded for body recall, falls back to substring on title / head /
  // cached body. opts.deep — if true, kicks off bundle + index load (and
  // awaits) so the search reflects full corpus, not just title hits.
  async search(query, opts = {}) {
    if (opts.deep && (!state.bundleLoaded || !state.indexLoaded)) {
      state.deepSearch = true;
      await Promise.all([loadSearchBundle(), loadSearchIndex()]);
    }
    const parsedQ = parseQuery(query);
    if (!parsedQ.tokens.length && !parsedQ.phrases.length) return getAllReports();
    const bundle = state.searchBundle;
    const tokenIndexSets = parsedQ.tokens.map(t => expandTokenToDocs(state.searchIndex, t));
    const anyMode = !!opts.any;
    return getAllReports().filter(r => {
      const key = reportKey(r);
      const titleLower = (r.title || '').toLowerCase();
      const bundleEntry = bundle ? bundle.map.get(key) : null;
      const headLower = bundleEntry ? bundleEntry.head.toLowerCase() : '';
      const cached = state.cache.text[key];
      const cachedLower = cached ? cached.toLowerCase() : '';
      const tokHit = (t, idxSet) => (idxSet && idxSet.has(key))
        || titleLower.includes(t)
        || (headLower && headLower.includes(t))
        || (cachedLower && cachedLower.includes(t));
      const phHit = p => titleLower.includes(p)
        || (headLower && headLower.includes(p))
        || (cachedLower && cachedLower.includes(p));
      if (anyMode) {
        return parsedQ.tokens.some((t, i) => tokHit(t, tokenIndexSets[i]))
            || parsedQ.phrases.some(phHit);
      }
      return parsedQ.tokens.every((t, i) => tokHit(t, tokenIndexSets[i]))
          && parsedQ.phrases.every(phHit);
    });
  },
  // Programmatically open a report dialog. Returns true if found.
  open(key) {
    const r = api.get(key);
    if (!r) return false;
    openReportByKey(reportKey(r));
    return true;
  },
  /** Cross-corpus search adapter — see CAG's identical contract. */
  async searchForGlobal(query, { deep = true, limit = 10 } = {}) {
    const items = await api.search(query, { deep });
    const subs = (r) => {
      const parts = [];
      const cm = COMMITTEES[r.committee];
      if (cm?.name)        parts.push(cm.name);
      if (r.lok_sabha)     parts.push(`LS${r.lok_sabha}`);
      if (r.report_number) parts.push(`#${r.report_number}`);
      if (r._category)     parts.push(r._category);
      return parts.join(' · ');
    };
    return items.slice(0, limit).map(r => ({
      key:      reportKey(r),
      title:    r.title || '(untitled)',
      subtitle: subs(r),
    }));
  },
  // Constants useful to programmatic consumers.
  committees: () => COMMITTEES,
  categories: () => CATEGORY_PATTERNS.map(p => ({ code: p.code, label: p.label })),
};

// ── Export the corpus contract ─────────────────────────────────────────────

export const DRSCCorpus = {
  id:          'drsc',
  label:       'Standing Committees',
  shortLabel:  'DRSC',
  macroGroup:  'oversight',
  primaryUnit: 'report',

  fetchStatus,
  activate,

  api,
  renderSettingsSection,
  applySettingsFromUI,
  refreshAIDependentTabs,
};
