// app/corpora/questions/index.js
// Parliamentary Questions — LS (Phase A) and RS (Phase B) — THIN MODULE.
//
// SansadSaar's role for this corpus is intentionally narrow: metadata
// search + click-through to the original PDF on sansad.in. No body
// extraction load (the data origin DOES ship texts-*.json shards, but
// this app skips them), no AI summary, no chat. The richer per-MP
// analytic experience for debates + questions is the Netas Explorer's
// scope.
//
// Why thin: questions are high-volume (~280K LS records at full backfill)
// and individually low-density (formulaic Q + boilerplate A). Aggregate
// signal (per-MP, per-ministry, per-topic) lives in a person-centric app,
// not in SansadSaar's document-centric one. See SansadLocal/plan/
// questions-recon-001.md §"Architectural decisions" for the full rationale.
//
// Macro group: `proceedings` — joins debates. Both have `house` as a
// primary filter and share the LS/RS conceptual axis. Bundling them in
// one group keeps the chip switcher readable.
//
// Independence Principle: no imports from cag, lc, fc, drsc, bills, or
// debates corpus modules. Composite reportKey shape:
//   `questions|ls|<lok_sabha>|<session>|<TYPE>|<qno>`
// (and later `questions|rs|<session>|<YYYY-MM-DD>|<TYPE>` for the per-PDF
// RS records).

import {
  idbGet, idbPut,
  escapeHtml, debounce,
  loadSettings, saveSettings,
  formatLocalTimestamp,
  mapPooled,
} from '../../deps.js';
import {
  parseQuery, highlightMatches,
} from '../../corpus-search.js';

const CORPUS_PREFIX = 'questions/';

// ── Constants ───────────────────────────────────────────────────────────────

const HOUSES = {
  ls: { short: 'LS', long: 'Lok Sabha' },
  rs: { short: 'RS', long: 'Rajya Sabha' },
};

const HOUSE_PILL_CLASS = {
  ls: 'L',   // orange
  rs: 'R',   // navy
};

const TYPE_INFO = {
  STARRED:   { short: 'S', label: 'Starred',   class: 'AT' },        // teal
  UNSTARRED: { short: 'U', label: 'Unstarred', class: 'ASSURE' },    // grey
};

// ── Module-private state ────────────────────────────────────────────────────

const state = {
  // reports is house-keyed dict of record arrays, matching the on-disk
  // sharded shape after merge.
  data: { reports: { ls: [], rs: [] }, meta: null },

  filtered: [],
  selectedReport: null,

  filters: {
    search:    '',
    house:     '',
    lok_sabha: '',
    session:   '',
    type:      '',
    ministry:  '',
    sort:      'date_desc',
  },
};

let _deps = null;
let _activated = false;

// ── Helpers ─────────────────────────────────────────────────────────────────

function reportKey(r) {
  if (r.house === 'ls') {
    return `questions|ls|${r.lok_sabha}|${r.session}|${r.type}|${r.question_no}`;
  }
  // RS shape (Phase B): per-PDF records keyed by (session, date_iso, type).
  return `questions|rs|${r.session}|${r.date_iso || r.date}|${r.type}`;
}

function reportDate(r) {
  // LS dates upstream are DD.MM.YYYY (e.g. "03.02.2025"). Parse defensively.
  const s = r.date;
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2]}-${m[1]}`);
    if (!isNaN(d)) return d;
  }
  // ISO YYYY-MM-DD fallback (RS records use this in date_iso)
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function formatDate(d) {
  if (!d) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function typeInfo(r) {
  return TYPE_INFO[r.type] || { short: '?', label: r.type || 'Unknown', class: 'ASSURE' };
}

function membersDisplay(r) {
  const ms = r.members || [];
  if (!ms.length) return '';
  if (ms.length === 1) return ms[0];
  if (ms.length === 2) return `${ms[0]}, ${ms[1]}`;
  return `${ms[0]} + ${ms.length - 1} others`;
}

function getAllReports() {
  const out = [];
  for (const house of ['ls', 'rs']) {
    for (const r of (state.data.reports[house] || [])) {
      out.push({ ...r, _date: reportDate(r), _typeInfo: typeInfo(r) });
    }
  }
  return out;
}

// ── Data fetching ───────────────────────────────────────────────────────────

// Sharded reports fetcher. Reads reports-meta.json + per-house shards
// (the post-2026-05-14 shape). Returns canonical { ls: [...], rs: [...] }.
async function fetchReports(dataUrl, v, fetchOpts) {
  const metaResp = await fetch(dataUrl + CORPUS_PREFIX + 'reports-meta.json' + v, fetchOpts);
  if (!metaResp.ok) throw new Error(`reports-meta.json: ${metaResp.status}`);
  const reportsMeta = await metaResp.json();
  const shardsByHouse = reportsMeta?.shards || {};
  const merged = { ls: [], rs: [] };
  const tasks = [];
  for (const [house, entries] of Object.entries(shardsByHouse)) {
    merged[house] = [];
    // Order comes from the manifest's entry order, NOT from an index inside
    // the shard payload. Shards are now named for their natural bucket, and
    // an ordinal baked into the payload would change for every shard each
    // time a new session appeared — the same cascade that blew up the repo.
    entries.forEach((entry, i) => {
      tasks.push({ house, idx: i, file: entry.file });
    });
  }
  // Fetch with a bounded pool. Bucket-named shards mean ~1.5k reports files
  // instead of ~100, and firing them all at once exhausts the browser's
  // connection pool — every request fails with a bare "Failed to fetch".
  const shardResults = await mapPooled(tasks, async t => {
        const r = await fetch(dataUrl + CORPUS_PREFIX + t.file + v, fetchOpts);
        if (!r.ok) throw new Error(`${t.file}: ${r.status}`);
        const payload = await r.json();
        return { house: t.house, idx: t.idx, records: payload?.records || [] };
      });
  shardResults.sort((a, b) =>
    a.house === b.house ? a.idx - b.idx : a.house.localeCompare(b.house));
  for (const { house, records } of shardResults) {
    merged[house].push(...records);
  }
  return merged;
}

async function fetchData(forceRefresh = false) {
  const splash  = document.getElementById('splash');
  const dataUrl = _deps.config.dataBaseUrl;

  if (!forceRefresh) {
    try {
      const [reportsBlob, metaBlob] = await Promise.all([
        idbGet('blobs', 'questions-reports.json'),
        idbGet('blobs', 'questions-meta.json'),
      ]);
      if (reportsBlob) {
        state.data.reports = reportsBlob;
        state.data.meta    = metaBlob || null;
      }
    } catch (e) { console.warn('questions IDB cache miss', e); }
  }

  const haveCache = Object.values(state.data.reports).some(v => Array.isArray(v) && v.length);
  const bucket = Math.floor(Date.now() / 300000);
  const v = forceRefresh ? `?v=${Date.now()}` : `?v=${bucket}`;
  const fetchOpts = { cache: 'no-cache' };

  try {
    const [reports, meta] = await Promise.all([
      fetchReports(dataUrl, v, fetchOpts),
      fetch(dataUrl + CORPUS_PREFIX + 'meta.json' + v, fetchOpts).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    state.data.reports = reports;
    state.data.meta    = meta;

    idbPut('blobs', 'questions-reports.json', reports).catch(() => {});
    if (meta) idbPut('blobs', 'questions-meta.json', meta).catch(() => {});
  } catch (err) {
    console.error('questions fetch failed', err);
    if (!haveCache) {
      _deps.ui.toast('Could not fetch questions data — see console for details');
      return false;
    }
    _deps.ui.toast('Questions offline — using cached data');
  }

  splash?.classList.add('hide');
  return true;
}

// ── Filtering / list rendering ──────────────────────────────────────────────

function applyFilters() {
  const all = getAllReports();
  const f = state.filters;
  const rawQ = f.search.trim();
  const parsedQ = rawQ ? parseQuery(rawQ) : null;

  const filtered = all.filter(r => {
    if (f.house && r.house !== f.house) return false;
    if (f.lok_sabha && String(r.lok_sabha || '') !== f.lok_sabha) return false;
    if (f.session && String(r.session || '') !== f.session) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.ministry && r.ministry !== f.ministry) return false;
    if (!parsedQ) return true;

    const subjectLower = (r.subject || '').toLowerCase();
    const ministryLower = (r.ministry || '').toLowerCase();
    const membersLower = (r.members || []).join(' ').toLowerCase();
    function tokenHits(tok) {
      return subjectLower.includes(tok)
          || ministryLower.includes(tok)
          || membersLower.includes(tok);
    }
    function phraseHits(p) { return tokenHits(p); }

    return parsedQ.tokens.every(tokenHits)
        && parsedQ.phrases.every(phraseHits);
  });

  filtered.sort((a, b) => {
    switch (f.sort) {
      case 'date_asc':  return (a._date || 0) - (b._date || 0);
      case 'qno_asc':   return (a.question_no || 0) - (b.question_no || 0);
      case 'qno_desc':  return (b.question_no || 0) - (a.question_no || 0);
      case 'date_desc':
      default:          return (b._date || 0) - (a._date || 0);
    }
  });

  state.filtered = filtered;
  renderList();
  renderResultsLine();
}

function renderHeaderStats() {
  const el = document.getElementById('headerStats');
  if (!el) return;
  const total = getAllReports().length;
  const lsTotal = state.data.reports.ls?.length || 0;
  const rsTotal = state.data.reports.rs?.length || 0;
  el.innerHTML = `
    <span><b>${total}</b> questions</span>
    ${lsTotal ? `<span><b>${lsTotal}</b> LS</span>` : ''}
    ${rsTotal ? `<span><b>${rsTotal}</b> RS</span>` : ''}
  `;
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
  el.innerHTML = (shown > 0 && shown < total)
    ? `<div class="rl-primary">Showing <b>${shown}</b> of <b>${total}</b></div>`
    : '';
}

function renderList() {
  const list = document.getElementById('reportsList');
  if (!list) return;
  if (!state.filtered.length) {
    list.innerHTML = `<div class="empty-state"><h3>No questions match</h3><p>Try clearing filters.</p></div>`;
    return;
  }
  const slice = state.filtered.slice(0, 200);
  const rawQ = state.filters.search.trim();
  const parsedQ = rawQ ? parseQuery(rawQ) : null;
  list.innerHTML = slice.map(r => {
    const subjectHTML = parsedQ
      ? highlightMatches(r.subject || '(untitled)', parsedQ)
      : escapeHtml(r.subject || '(untitled)');
    const ti = r._typeInfo;
    const hp = HOUSE_PILL_CLASS[r.house] || 'L';
    const houseShort = HOUSES[r.house]?.short || r.house?.toUpperCase() || '?';
    const sessLabel = r.session ? `${houseShort}${r.lok_sabha || ''} · S${r.session}` : houseShort;
    const qno = r.question_no != null ? `Q ${r.question_no}` : '';
    const subline = [
      `${sessLabel}${qno ? ' · ' + qno : ''}`,
      r.ministry ? escapeHtml(r.ministry) : '',
      r.date ? escapeHtml(r.date) : '',
    ].filter(Boolean).join(' · ');
    const members = membersDisplay(r);
    const memberLine = members ? `<div class="report-meta">${escapeHtml(members)}</div>` : '';
    return `
      <div class="report-row" data-key="${escapeHtml(reportKey(r))}">
        <div>
          <div class="report-title">${subjectHTML}</div>
          <div class="report-meta">${subline}</div>
          ${memberLine}
        </div>
        <span class="house-pill house-${hp}" title="${escapeHtml(HOUSES[r.house]?.long || '')}">${escapeHtml(houseShort)}</span>
        <span class="cat-badge cat-${ti.class}" title="${escapeHtml(ti.label + ' question')}">${escapeHtml(ti.short)}</span>
        <span class="text-status">metadata</span>
      </div>
    `;
  }).join('');
  if (state.filtered.length > 200) {
    list.insertAdjacentHTML('beforeend',
      `<div class="empty-state" style="padding:18px"><p>Showing first 200 of ${state.filtered.length} matches — refine filters to narrow further.</p></div>`);
  }
}

function populateFilters() {
  const all = getAllReports();
  const lsTermSet = new Set();
  const sessionSet = new Set();
  const ministrySet = new Set();
  for (const r of all) {
    if (r.lok_sabha != null) lsTermSet.add(r.lok_sabha);
    if (r.session != null)   sessionSet.add(r.session);
    if (r.ministry)          ministrySet.add(r.ministry);
  }

  const lsSel = document.getElementById('filterLokSabha');
  if (lsSel) {
    lsSel.innerHTML = '<option value="">All Lok Sabhas</option>' +
      [...lsTermSet].sort((a, b) => b - a).map(t =>
        `<option value="${t}">LS-${t}</option>`).join('');
    lsSel.value = state.filters.lok_sabha || '';
  }

  const sesSel = document.getElementById('filterSession');
  if (sesSel) {
    sesSel.innerHTML = '<option value="">All sessions</option>' +
      [...sessionSet].sort((a, b) => b - a).map(s =>
        `<option value="${s}">Session ${s}</option>`).join('');
    sesSel.value = state.filters.session || '';
  }

  const minSel = document.getElementById('filterMinistry');
  if (minSel) {
    minSel.innerHTML = '<option value="">All ministries</option>' +
      [...ministrySet].sort().map(m =>
        `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    minSel.value = state.filters.ministry || '';
  }
}

function renderFilterRow() {
  const c = document.getElementById('filtersContainer');
  if (!c) return;
  c.innerHTML = `
    <input type="search" id="filterSearch" placeholder="Search subject / member / ministry…"
           value="${escapeHtml(state.filters.search)}" />
    <select id="filterHouse" title="Filter by house">
      <option value="">All houses</option>
      <option value="ls"${state.filters.house === 'ls' ? ' selected' : ''}>Lok Sabha</option>
      <option value="rs"${state.filters.house === 'rs' ? ' selected' : ''}>Rajya Sabha</option>
    </select>
    <select id="filterLokSabha" title="Filter by LS term"></select>
    <select id="filterSession" title="Filter by session"></select>
    <select id="filterType" title="Filter by question type">
      <option value="">All types</option>
      <option value="STARRED"${state.filters.type === 'STARRED' ? ' selected' : ''}>Starred</option>
      <option value="UNSTARRED"${state.filters.type === 'UNSTARRED' ? ' selected' : ''}>Unstarred</option>
    </select>
    <select id="filterMinistry" title="Filter by ministry"></select>
    <select id="filterSort" title="Sort">
      <option value="date_desc"${state.filters.sort === 'date_desc' ? ' selected' : ''}>Date · newest</option>
      <option value="date_asc"${state.filters.sort === 'date_asc' ? ' selected' : ''}>Date · oldest</option>
      <option value="qno_asc"${state.filters.sort === 'qno_asc' ? ' selected' : ''}>Q# ascending</option>
      <option value="qno_desc"${state.filters.sort === 'qno_desc' ? ' selected' : ''}>Q# descending</option>
    </select>
  `;
}

function attachHandlers() {
  const search = document.getElementById('filterSearch');
  if (search) {
    search.addEventListener('input', debounce(() => {
      state.filters.search = search.value;
      applyFilters();
    }, 200));
  }
  const wireSelect = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      state.filters[key] = el.value;
      applyFilters();
    });
  };
  wireSelect('filterHouse',     'house');
  wireSelect('filterLokSabha',  'lok_sabha');
  wireSelect('filterSession',   'session');
  wireSelect('filterType',      'type');
  wireSelect('filterMinistry',  'ministry');
  wireSelect('filterSort',      'sort');

  // Delegated click for list rows.
  const list = document.getElementById('reportsList');
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.report-row');
      if (!row) return;
      const key = row.dataset.key;
      if (key) openReportByKey(key);
    });
  }

  // Tab handlers — shared DOM, gated by activeCorpus.
  for (const btn of document.querySelectorAll('#reportModal .tab-btn')) {
    btn.addEventListener('click', () => switchReportTab(btn.dataset.tab));
  }
}

// ── Detail dialog ──────────────────────────────────────────────────────────

function openReportByKey(key) {
  const r = getAllReports().find(x => reportKey(x) === key);
  if (!r) return;
  state.selectedReport = r;
  const titleEl = document.getElementById('reportTitle');
  if (titleEl) titleEl.textContent = r.subject || '(untitled)';
  renderDetailsTab(r);
  // Reset to Details tab on open. Other tabs render placeholders on click.
  for (const btn of document.querySelectorAll('#reportModal .tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === 'details');
  }
  for (const pane of document.querySelectorAll('#reportModal .tab-pane')) {
    pane.classList.toggle('active', pane.id === 'detailsTab');
  }
  _deps.ui.openModal('reportModal');
}

function renderDetailsTab(r) {
  const pane = document.getElementById('detailsTab');
  if (!pane) return;
  const ti = typeInfo(r);
  const house = HOUSES[r.house] || { short: '?', long: r.house };
  const members = (r.members || []).map(m => `<li>${escapeHtml(m)}</li>`).join('');
  const pdfBlock = r.pdf_url
    ? `<a href="${escapeHtml(r.pdf_url)}" target="_blank" rel="noopener" class="primary-action-link">View original PDF on sansad.in →</a>`
    : `<span class="report-meta">PDF link not available</span>`;
  const pdfHindi = r.pdf_url_hindi
    ? `<div style="margin-top:6px"><a href="${escapeHtml(r.pdf_url_hindi)}" target="_blank" rel="noopener">हिंदी PDF →</a></div>`
    : '';
  pane.innerHTML = `
    <dl class="kv">
      <dt>Subject</dt><dd>${escapeHtml(r.subject || '—')}</dd>
      <dt>House</dt><dd>${escapeHtml(house.long)}${r.lok_sabha ? ' · LS-' + r.lok_sabha : ''}</dd>
      <dt>Session</dt><dd>${r.session != null ? 'Session ' + r.session : '—'}</dd>
      <dt>Type</dt><dd>${escapeHtml(ti.label)} Question${r.question_no != null ? ' · Q-No ' + r.question_no : ''}</dd>
      <dt>Date</dt><dd>${escapeHtml(r.date || '—')}</dd>
      <dt>Ministry</dt><dd>${escapeHtml(r.ministry || '—')}</dd>
      <dt>Members</dt><dd>${members ? `<ul style="margin:0;padding-left:18px">${members}</ul>` : '—'}</dd>
      ${r.supplementary ? '<dt>Supplementary</dt><dd>Yes</dd>' : ''}
    </dl>
    <div style="margin-top:18px">
      ${pdfBlock}
      ${pdfHindi}
    </div>
    <div style="margin-top:18px;padding:12px;border:1px dashed var(--border);border-radius:6px;font-size:0.9rem">
      <strong>Looking for per-MP analytics?</strong>
      SansadSaar surfaces individual questions for search and click-through. The richer per-MP view — how many questions an MP asked, by ministry, by topic — lives in <em>Netas Explorer</em> (coming soon).
    </div>
  `;
}

function renderPlaceholderTab(paneId, title, body) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  const r = state.selectedReport;
  const pdfHref = r?.pdf_url ? `<a href="${escapeHtml(r.pdf_url)}" target="_blank" rel="noopener">View the original PDF on sansad.in →</a>` : '';
  pane.innerHTML = `
    <div style="padding:24px;text-align:center;color:var(--text-muted)">
      <h3 style="margin:0 0 8px;color:var(--text)">${escapeHtml(title)}</h3>
      <p style="margin:0 0 14px">${escapeHtml(body)}</p>
      ${pdfHref}
    </div>
  `;
}

function switchReportTab(name) {
  if (_deps.activeCorpus?.() !== 'questions') return;   // multi-corpus DOM guard
  const r = state.selectedReport;
  if (!r) return;
  for (const btn of document.querySelectorAll('#reportModal .tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll('#reportModal .tab-pane')) {
    pane.classList.toggle('active', pane.id === `${name}Tab`);
  }
  if (name === 'details') renderDetailsTab(r);
  else if (name === 'text')    renderPlaceholderTab('textTab', 'Full text not in SansadSaar', 'SansadSaar shows question metadata only. The question + answer text is in the original PDF on sansad.in.');
  else if (name === 'summary') renderPlaceholderTab('summaryTab', 'AI summary for Questions lives in Netas', 'Per-MP and per-question AI analytics are part of Netas Explorer (coming soon). The original PDF is one click away.');
  else if (name === 'chat')    renderPlaceholderTab('chatTab', 'Ask is not available for Questions', 'The AI-Ask experience for questions will land in Netas Explorer. The original PDF is one click away.');
}

// ── Settings section (mounted by shell) ─────────────────────────────────────

function renderSettingsSection(container) {
  if (!container) return;
  const meta = state.data.meta;
  const totalsObj = meta?.totals || {};
  const totalCount = (totalsObj.ls || 0) + (totalsObj.rs || 0);
  container.innerHTML = `
    <div class="settings-section">
      <h3>Parliamentary Questions</h3>
      <p style="font-size:0.9rem;color:var(--muted);margin:0 0 8px">
        SansadSaar shows questions as a searchable metadata corpus. The richer
        per-MP and per-topic analytic experience for questions + debates lives
        in <em>Netas Explorer</em> (coming soon).
      </p>
      <p id="questionsDataInfo" style="font-size:0.82rem; color:var(--muted)">${meta
        ? `${_deps.ui.stalenessIndicatorHTML('questions', meta)}${totalCount ? ` · ${totalCount.toLocaleString()} questions total` : ''}`
        : `Source: ${escapeHtml(_deps?.config?.dataBaseUrl || '')}questions/`}</p>
    </div>
  `;
  _deps.ui.bindStalenessIndicators(container);
}

function applySettingsFromUI() { /* no settings to apply */ }

function refreshAIDependentTabs() { /* no AI tabs */ }

// ── Status (chip pill) ──────────────────────────────────────────────────────

async function fetchStatus() {
  const meta = state.data.meta;
  if (!meta) return { lastUpdate: null, items: getAllReports().length, error: null };
  const totalsObj = meta.totals || {};
  const total = (totalsObj.ls || 0) + (totalsObj.rs || 0);
  return {
    lastUpdate: meta.generated_at || null,
    items: total || getAllReports().length,
    error: null,
  };
}

// ── Activation ──────────────────────────────────────────────────────────────

async function activate(deps, { silent = false } = {}) {
  _deps = deps;
  if (!silent) {
    renderFilterRow();
    attachHandlers();
  }
  if (!_activated) {
    _activated = true;
    const ok = await fetchData();
    if (!ok) return false;
    if (!silent) {
      populateFilters();
      renderHeaderStats();
      applyFilters();
    }
  } else if (!silent) {
    populateFilters();
    renderHeaderStats();
    applyFilters();
  }
  return true;
}

// ── JS API surface ─────────────────────────────────────────────────────────

const api = {
  list({ house, lok_sabha, session, type, ministry } = {}) {
    return getAllReports().filter(r => {
      if (house && r.house !== house) return false;
      if (lok_sabha != null && String(r.lok_sabha) !== String(lok_sabha)) return false;
      if (session != null && String(r.session) !== String(session)) return false;
      if (type && r.type !== type) return false;
      if (ministry && r.ministry !== ministry) return false;
      return true;
    });
  },
  get(key) {
    return getAllReports().find(r => reportKey(r) === key) || null;
  },
  async search(query) {
    const parsedQ = parseQuery(query);
    if (!parsedQ.tokens.length && !parsedQ.phrases.length) return getAllReports();
    return getAllReports().filter(r => {
      const subjectLower = (r.subject || '').toLowerCase();
      const ministryLower = (r.ministry || '').toLowerCase();
      const membersLower = (r.members || []).join(' ').toLowerCase();
      const hit = (t) => subjectLower.includes(t)
                     || ministryLower.includes(t)
                     || membersLower.includes(t);
      return parsedQ.tokens.every(hit) && parsedQ.phrases.every(hit);
    });
  },
  open(key) {
    const r = api.get(key);
    if (!r) return false;
    openReportByKey(reportKey(r));
    return true;
  },
  /**
   * Cross-corpus search adapter. Returns {key, title, subtitle} per hit.
   * Note `deep` is accepted for API uniformity but no-op here — questions
   * use metadata-only search (subject + ministry + members).
   */
  async searchForGlobal(query, { deep = true, limit = 10 } = {}) { // eslint-disable-line no-unused-vars
    const items = await api.search(query);
    return items.slice(0, limit).map(r => {
      const houseShort = HOUSES[r.house]?.short || r.house?.toUpperCase() || '?';
      const ti = typeInfo(r);
      const parts = [
        `${houseShort}${r.lok_sabha ? '-' + r.lok_sabha : ''}`,
        `S${r.session || '?'}`,
        ti.short,
        r.question_no != null ? `Q${r.question_no}` : '',
        r.ministry || '',
      ].filter(Boolean);
      return {
        key:      reportKey(r),
        title:    r.subject || '(untitled)',
        subtitle: parts.join(' · '),
      };
    });
  },
};

// ── Export the corpus contract ─────────────────────────────────────────────

export const QuestionsCorpus = {
  id:          'questions',
  label:       'Parliamentary Questions',
  shortLabel:  'Questions',
  macroGroup:  'proceedings',   // joins debates
  primaryUnit: 'question',

  fetchStatus,
  activate,

  api,
  renderSettingsSection,
  applySettingsFromUI,
  refreshAIDependentTabs,
};
