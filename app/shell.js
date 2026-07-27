// app/shell.js
// SansadSaar shell — corpus registry, AI worker management, BYOK providers,
// web search, settings + help UI, AI pill chrome, chip switcher, per-corpus
// status display, JS API surface (window.sansadsaar), cross-tab postMessage,
// and app init.
//
// What's NOT here: anything corpus-specific (DRSC report rendering, filters,
// exports, prompts). Those live in app/corpora/<id>/index.js. Shell is
// corpus-agnostic — adding CAG in v1.0b means dropping in another corpus
// module and registering it; no shell changes needed for the second chip.

import {
  loadSettings, saveSettings,
  escapeHtml, debounce,
  relativeTime, statusBucket,
  INTRO_SEEN_KEY,
  setNotifier, installGlobalErrorSurface,
} from './deps.js';
import { DRSCCorpus }    from './corpora/drsc/index.js';
import { CAGCorpus }     from './corpora/cag/index.js';
import { BillsCorpus }   from './corpora/bills/index.js';
import { LCCorpus }      from './corpora/lc/index.js';
import { FCCorpus }      from './corpora/fc/index.js';
import { DebatesCorpus } from './corpora/debates/index.js';
import { QuestionsCorpus } from './corpora/questions/index.js';
import { GazettesCorpus } from './corpora/gazettes/index.js';
import {
  initDiskSync, getDiskSyncState, onDiskSyncChange,
  connectAndSync, reconnect, syncNow,
  diskIsConnected, diskRead, diskWrite,
} from './disk-sync.js';
import { initGlobalSearch } from './global-search.js';

// ── Constants ───────────────────────────────────────────────────────────────

const PRODUCT = 'sansadsaar';
const VERSION = '1.0a-phase1';

// Data mirror URL. ?data=ghpages or ?data=<url> overrides for local dev /
// alternate origin testing. Default = sansadsaar-data.naklitechie.com (CF
// Workers + Static Assets, post-phase-3). sansad-files.naklitechie.com
// continues to serve the same Worker as a legacy alias — pass
// ?data=https://sansad-files.naklitechie.com/ to use it explicitly.
const DATA_BASE_URL = (() => {
  const u = new URL(window.location.href);
  const override = u.searchParams.get('data');
  if (override === 'ghpages') return 'https://naklitechie.github.io/parliamentwatch-data/';
  return override || 'https://sansadsaar-data.naklitechie.com/';
})();

// Per-corpus data-origin overrides. Some corpora live in their own repos
// + CF Pages projects (split 2026-05-14 to keep parliamentwatch-data
// under the 20K-files cap). Update these URLs when CF Pages custom
// domains are wired up. The default `?data=...` URL override only
// affects the main DATA_BASE_URL; corpora listed here ignore it.
const CORPUS_DATA_BASE_URLS = {
  // Gazettes: sansadsaar-gazettes repo (private), served via CF Worker
  // Static Assets at sansadsaar-gazettes.naklitechie.com.
  gazettes:  'https://sansadsaar-gazettes.naklitechie.com/',
  // Debates + Questions: sansadsaar-proceedings-data repo (private),
  // both corpora served from one Worker at sansadsaar-proceedings.naklitechie.com.
  // Update this when the custom domain is wired.
  debates:   'https://sansadsaar-proceedings.naklitechie.com/',
  questions: 'https://sansadsaar-proceedings.naklitechie.com/',
};

// Per-corpus expected interval between data updates visible on the
// live mirror, in minutes. Used by the staleness indicator in the
// settings modal.
//
// This is the SCRAPE cadence + the CF-DEPLOY-SYNC cadence, because
// scrape commits sit on `main` until the cf-sync workflow promotes
// them to `cf-deploy` and CF rebuilds. The sync runs every 4 hours
// (cf-sync.yml in each data repo), so even an hourly-scraped corpus
// will only show new data on the mirror at most every ~4h. See
// CONV.md "Multi-corpus derive in one repo" → "Audit by
// meta.generated_at, not workflow run history" for the deeper
// rationale.
//
// Effective cadence = scrape_cadence + 240 (sync lag).
const CORPUS_CADENCE_MINUTES = {
  drsc:      480,  //  4h scrape + 4h sync
  cag:       300,  //  1h backfill + 4h sync
  fc:        480,  //  4h scrape + 4h sync
  bills:     480,  //  4h backfill + 4h sync
  lc:        480,  //  4h scrape + 4h sync
  debates:   360,  //  2h scrape + 4h sync
  questions: 300,  //  1h scrape + 4h sync
  gazettes:  300,  //  1h scrape + 4h sync
};

// Per-corpus source-data repository for the "View workflow runs" link
// in the staleness indicator's expanded details.
const CORPUS_REPO_URL = {
  drsc:      'https://github.com/NakliTechie/parliamentwatch-data',
  cag:       'https://github.com/NakliTechie/parliamentwatch-data',
  fc:        'https://github.com/NakliTechie/parliamentwatch-data',
  bills:     'https://github.com/NakliTechie/parliamentwatch-data',
  lc:        'https://github.com/NakliTechie/parliamentwatch-data',
  debates:   'https://github.com/NakliTechie/sansadsaar-proceedings-data',
  questions: 'https://github.com/NakliTechie/sansadsaar-proceedings-data',
  gazettes:  'https://github.com/NakliTechie/sansadsaar-gazettes',
};

// ── Staleness indicator helpers (used by each corpus's settings section) ──

function humanAge(minutes) {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h ago`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} d ago`;
}

function humanCadence(minutes) {
  if (minutes < 60) return `every ${minutes} minutes`;
  const hours = minutes / 60;
  if (hours === 1) return 'every hour';
  if (hours < 24) return `every ${hours} hours`;
  return `every ${Math.round(hours / 24)} days`;
}

// Returns descriptor for a corpus's freshness given its meta.json.
// level: 'fresh' | 'stale' | 'broken' | 'unknown'
function freshnessFor(corpusId, meta) {
  const cadence = CORPUS_CADENCE_MINUTES[corpusId];
  const ts = meta?.generated_at || meta?.last_update;
  if (!cadence || !ts) return { level: 'unknown', ageText: 'unknown' };
  const ageMs = Date.now() - Date.parse(ts);
  if (isNaN(ageMs) || ageMs < 0) return { level: 'unknown', ageText: 'unknown' };
  const ageMin = ageMs / 60000;
  let level;
  if      (ageMin < cadence * 2) level = 'fresh';
  else if (ageMin < cadence * 6) level = 'stale';
  else                           level = 'broken';
  return {
    level,
    ageText: humanAge(ageMin),
    ageMinutes: ageMin,
    cadenceMinutes: cadence,
    cadenceText: humanCadence(cadence),
    repoUrl: CORPUS_REPO_URL[corpusId] || null,
    generatedAtIso: ts,
  };
}

// HTML snippet for inline use in a corpus's settings "Data (...)" section.
// Renders: ● Updated 4 h ago  (clickable to expand details panel).
// Returns plain text when meta is missing.
function stalenessIndicatorHTML(corpusId, meta) {
  const f = freshnessFor(corpusId, meta);
  if (f.level === 'unknown') {
    return `<span class="staleness staleness-unknown"><span class="staleness-dot" aria-hidden="true"></span><span class="staleness-age">${escapeHtml(f.ageText)}</span></span>`;
  }
  const statusEmoji = f.level === 'fresh' ? '✓' : (f.level === 'stale' ? '⚠' : '✗');
  const statusText  = f.level === 'fresh'
    ? 'Fresh — within expected update window'
    : f.level === 'stale'
      ? `Overdue — last update is past the expected ${f.cadenceText.replace(/^every /, '')} window`
      : `Likely broken — last update is far past the expected ${f.cadenceText.replace(/^every /, '')} window`;
  const detailsId = `stalenessDetails-${corpusId}`;
  const repoLink = f.repoUrl
    ? `<a href="${f.repoUrl}/actions" target="_blank" rel="noopener">View workflow runs ↗</a>`
    : '';
  return `
    <span class="staleness staleness-${f.level}" data-corpus="${escapeHtml(corpusId)}" data-details-id="${detailsId}" role="button" tabindex="0" aria-expanded="false" title="Click for details"><span class="staleness-dot" aria-hidden="true"></span><span class="staleness-age">Updated ${escapeHtml(f.ageText)}</span></span><span class="staleness-details" id="${detailsId}" hidden><span class="staleness-row"><b>Status:</b> ${statusEmoji} ${escapeHtml(statusText)}</span><span class="staleness-row"><b>Last update:</b> ${escapeHtml(f.generatedAtIso)}</span><span class="staleness-row"><b>Expected:</b> ${escapeHtml(f.cadenceText)}</span>${repoLink ? `<span class="staleness-row">${repoLink}</span>` : ''}</span>
  `.trim();
}

// Wire click-to-expand behavior on staleness indicators inside `scope`
// (default: document). Call AFTER inserting stalenessIndicatorHTML output
// into the DOM. Safe to call multiple times — uses a sentinel attribute
// so the listener doesn't double-bind.
function bindStalenessIndicators(scope) {
  const root = scope || document;
  root.querySelectorAll('.staleness[data-details-id]').forEach(el => {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    const toggle = () => {
      const details = root.querySelector('#' + el.dataset.detailsId)
                   || document.getElementById(el.dataset.detailsId);
      if (!details) return;
      const willShow = details.hasAttribute('hidden');
      if (willShow) details.removeAttribute('hidden');
      else          details.setAttribute('hidden', '');
      el.setAttribute('aria-expanded', willShow ? 'true' : 'false');
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

// Local-AI model registry. Multimodal uses AutoProcessor +
// Gemma4ForConditionalGeneration; causal uses AutoTokenizer +
// AutoModelForCausalLM. The 'type' field drives the worker's load path.
const MODELS = {
  'gemma4-e2b': {
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    label: 'Gemma 4 E2B', size: '~1.5 GB',
    dtype: 'q4f16', type: 'multimodal', contextSize: 8192,
    genConfig: { temperature: 0.5, top_k: 40, top_p: 0.95, max_new_tokens: 1024, repetition_penalty: 1.1 },
  },
  'gemma4-e4b': {
    id: 'onnx-community/gemma-4-E4B-it-ONNX',
    label: 'Gemma 4 E4B', size: '~4.9 GB',
    dtype: 'q4f16', type: 'multimodal', contextSize: 12288,
    genConfig: { temperature: 0.5, top_k: 40, top_p: 0.95, max_new_tokens: 1024, repetition_penalty: 1.1 },
  },
  'bonsai-1.7b': {
    id: 'onnx-community/Ternary-Bonsai-1.7B-ONNX',
    label: 'Ternary Bonsai 1.7B', size: '~470 MB',
    dtype: 'q2f16', type: 'causal', contextSize: 32768,
    genConfig: { temperature: 0.7, top_k: 20, top_p: 0.8, max_new_tokens: 1024, repetition_penalty: 1.05 },
  },
  'bonsai-4b': {
    id: 'onnx-community/Ternary-Bonsai-4B-ONNX',
    label: 'Ternary Bonsai 4B', size: '~1.1 GB',
    dtype: 'q2f16', type: 'causal', contextSize: 32768,
    genConfig: { temperature: 0.7, top_k: 20, top_p: 0.8, max_new_tokens: 1024, repetition_penalty: 1.05 },
  },
  'bonsai-8b': {
    id: 'onnx-community/Ternary-Bonsai-8B-ONNX',
    label: 'Ternary Bonsai 8B', size: '~2.2 GB',
    dtype: 'q2f16', type: 'causal', contextSize: 65536,
    genConfig: { temperature: 0.7, top_k: 20, top_p: 0.8, max_new_tokens: 1024, repetition_penalty: 1.05 },
  },
};

// BYOK provider defaults. style determines the request shape (Anthropic
// has its own format; everything else is OpenAI-compatible).
const PROVIDER_DEFAULTS = {
  anthropic:  { url: 'https://api.anthropic.com/v1/messages',                model: 'claude-sonnet-4-5',     style: 'anthropic' },
  openai:     { url: 'https://api.openai.com/v1/chat/completions',           model: 'gpt-4o-mini',           style: 'openai' },
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash', style: 'openai' },
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',      model: 'llama-3.3-70b-versatile', style: 'openai' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',        model: 'meta-llama/llama-3.3-70b-instruct:free', style: 'openai' },
  ollama:     { url: 'http://localhost:11434/v1/chat/completions',           model: 'llama3.2',              style: 'openai', noAuth: true },
  custom:     { url: '',                                                     model: '',                      style: 'openai' },
};

// ── Shell state (private) ───────────────────────────────────────────────────

const ai = {
  mode: 'local',                       // 'local' | 'api'
  localModel: 'gemma4-e2b',            // currently SELECTED (UI/state)
  loadedModel: null,                   // model key actually warm in the worker
  worker: null,
  workerReady: false,
  workerLoading: false,
  apiProvider: 'anthropic',
  apiKey: '',
  apiModel: '',
  apiBaseUrl: '',
  streaming: false,
  abortController: null,               // for fetch-based API streaming
  msgIdCounter: 0,
  pendingResolvers: new Map(),         // msgId → { onToken, onDone, onErr }
};

const search = { provider: 'none', apiKey: '', baseUrl: '' };

// Disk-sync user preferences — independent of whether a folder is currently
// connected. `saveAiToDisk` is the user-controlled checkbox in Settings:
// when on, generateSummary and chatSend (in every corpus) write the result
// to <folder>/<corpus>/ai/ alongside the index files. Default off — AI
// artifacts are user-private and shouldn't auto-leave IDB without opt-in.
const diskPrefs = { saveAi: false };

// Corpus registry — Map<id, corpus>.
const corpora = new Map();
let activeCorpusId = null;

// ── UI helpers (toast, modal control) ───────────────────────────────────────

function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// ── Cross-tab postMessage (BroadcastChannel) ────────────────────────────────
//
// Same-origin only — different origins can't share a BroadcastChannel. The
// dual-app-URL setup means a user with tabs open at sansadsaar.naklitechie.com
// AND sansadlocal.naklitechie.com won't see cross-broadcasts (separate
// origins). Within a single origin, any tab broadcasting changes is heard
// by all other tabs. Used for settings sync + corpus activation hints.

const bc = ('BroadcastChannel' in window) ? new BroadcastChannel(PRODUCT) : null;
const broadcastListeners = new Set();

function broadcast(type, payload) {
  if (!bc) return;
  bc.postMessage({ type, payload, ts: Date.now() });
}

function onBroadcast(cb) {
  broadcastListeners.add(cb);
  return () => broadcastListeners.delete(cb);
}

if (bc) {
  bc.addEventListener('message', (e) => {
    for (const cb of broadcastListeners) {
      try { cb(e.data); } catch (err) { console.warn('broadcast listener error', err); }
    }
  });
}

// ── AI: local worker ────────────────────────────────────────────────────────

function createLocalWorker() {
  // Blob-URL ES module — same shape as LocalMind/VaultMind. The fetch
  // intercept layer is omitted (no resumable downloads needed for v1).
  const code = `
let env, AutoTokenizer, AutoModelForCausalLM, AutoProcessor, Gemma4ForConditionalGeneration, TextStreamer, InterruptableStoppingCriteria;
let stopping_criteria;

const __modReady = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4/+esm').then(m => {
  env = m.env;
  AutoTokenizer = m.AutoTokenizer;
  AutoModelForCausalLM = m.AutoModelForCausalLM;
  AutoProcessor = m.AutoProcessor;
  Gemma4ForConditionalGeneration = m.Gemma4ForConditionalGeneration;
  TextStreamer = m.TextStreamer;
  InterruptableStoppingCriteria = m.InterruptableStoppingCriteria;
  env.allowLocalModels  = true;
  env.localModelPath    = '/models/';
  env.allowRemoteModels = true;
  stopping_criteria = new InterruptableStoppingCriteria();
});

let processor = null;
let tokenizer = null;
let model = null;

const progressCallback = (p) => self.postMessage({ type: 'progress', data: p });

async function loadMultimodal(modelId, dtype) {
  processor = await AutoProcessor.from_pretrained(modelId, { progress_callback: progressCallback });
  tokenizer = processor.tokenizer;
  model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
    dtype, device: 'webgpu', progress_callback: progressCallback,
  });
  self.postMessage({ type: 'warmup' });
  const warmupInputs = tokenizer('a');
  await model.generate({ ...warmupInputs, max_new_tokens: 1 });
  self.postMessage({ type: 'ready' });
}

async function loadCausal(modelId, dtype) {
  processor = null;
  tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback: progressCallback });
  model = await AutoModelForCausalLM.from_pretrained(modelId, {
    dtype, device: 'webgpu', progress_callback: progressCallback,
  });
  self.postMessage({ type: 'warmup' });
  const warmupInputs = tokenizer('a');
  await model.generate({ ...warmupInputs, max_new_tokens: 1 });
  self.postMessage({ type: 'ready' });
}

async function generate(messages, id, gc) {
  stopping_criteria.reset();
  try {
    let inputs, streamerTok;
    if (processor) {
      const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
      inputs = await processor(prompt, null, null, { add_special_tokens: false });
      streamerTok = processor.tokenizer;
    } else {
      inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true });
      streamerTok = tokenizer;
    }
    const streamer = new TextStreamer(streamerTok, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => self.postMessage({ type: 'token', token: text, id }),
    });
    await model.generate({
      ...inputs,
      max_new_tokens: gc?.max_new_tokens || 1024,
      do_sample: true,
      temperature: gc?.temperature ?? 0.5,
      top_k: gc?.top_k ?? 40,
      top_p: gc?.top_p ?? 0.95,
      repetition_penalty: gc?.repetition_penalty ?? 1.1,
      streamer,
      stopping_criteria,
    });
    self.postMessage({ type: 'complete', id });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message || String(err) });
    self.postMessage({ type: 'complete', id });
  }
}

self.addEventListener('message', async (e) => {
  await __modReady;
  const { type, modelId, modelType, dtype, messages, id, generationConfig } = e.data;
  if (type === 'load') {
    try {
      if (modelType === 'causal') await loadCausal(modelId, dtype);
      else await loadMultimodal(modelId, dtype);
    } catch (err) {
      self.postMessage({ type: 'error', message: 'Failed to load model: ' + (err.message || String(err)) });
    }
  } else if (type === 'generate') {
    await generate(messages, id, generationConfig);
  } else if (type === 'stop') {
    stopping_criteria?.interrupt();
  }
});
`;
  const blob = new Blob([code], { type: 'application/javascript' });
  const w = new Worker(URL.createObjectURL(blob), { type: 'module' });

  // Without this, blob-URL module workers fail completely silently — no
  // console, no network, nothing. Lesson learned the hard way in BabelLocal.
  w.addEventListener('error', (e) => {
    console.error('Worker error:', e.message, e);
    setLocalStatus('error', 'Worker error: ' + (e.message || 'unknown'));
  });

  w.addEventListener('message', (e) => {
    const d = e.data;
    if (d.type === 'progress') {
      handleLoadProgress(d.data);
    } else if (d.type === 'warmup') {
      setLoadProgress(98, 'Compiling WebGPU shaders...');
    } else if (d.type === 'ready') {
      const wasLoading = ai.workerLoading;
      ai.workerReady = true;
      ai.workerLoading = false;
      ai.loadedModel = ai.localModel;
      setLoadProgress(100, '');
      hideLoadProgress();
      setLocalStatus('ready', MODELS[ai.loadedModel].label + ' ready');
      const pill = document.getElementById('aiPill');
      pill?.classList.add('pulse');
      setTimeout(() => pill?.classList.remove('pulse'), 3200);
      if (wasLoading) {
        toast('AI ready — open any report and try the AI summary or Ask tab', 4000);
      }
    } else if (d.type === 'token') {
      const r = ai.pendingResolvers.get(d.id);
      if (r) r.onToken(d.token);
    } else if (d.type === 'complete') {
      const r = ai.pendingResolvers.get(d.id);
      if (r) {
        r.onDone();
        ai.pendingResolvers.delete(d.id);
      }
      ai.streaming = false;
    } else if (d.type === 'error') {
      const r = d.id != null ? ai.pendingResolvers.get(d.id) : null;
      if (r) {
        r.onErr(new Error(d.message));
        ai.pendingResolvers.delete(d.id);
      } else {
        setLocalStatus('error', d.message);
      }
      ai.streaming = false;
    }
  });
  return w;
}

// ── AI: status pill + load progress ────────────────────────────────────────

function setLocalStatus(kind, text) {
  const pill = document.getElementById('localStatus');
  if (!pill) return;
  pill.classList.remove('ready', 'loading', 'error');
  if (kind) pill.classList.add(kind);
  document.getElementById('localStatusText').textContent = text;
  refreshAIPill();
  notifyCorporaOfAIChange();
}

function refreshAIPill() {
  const pill = document.getElementById('aiPill');
  const txt  = document.getElementById('aiPillText');
  if (!pill || !txt) return;
  pill.classList.remove('ready', 'loading', 'error', 'api');
  if (ai.mode === 'api') {
    const cfg = getApiConfig();
    if (!cfg.apiKey && !cfg.noAuth) {
      txt.textContent = 'BYOK · set key';
    } else {
      pill.classList.add('api', 'ready');
      const labels = { anthropic:'Anthropic', openai:'OpenAI', gemini:'Gemini', groq:'Groq', openrouter:'OpenRouter', ollama:'Ollama', custom:'Custom' };
      txt.textContent = 'BYOK: ' + (labels[ai.apiProvider] || ai.apiProvider);
    }
    return;
  }
  if (!navigator.gpu) {
    pill.classList.add('error');
    txt.textContent = 'No WebGPU';
    return;
  }
  if (ai.workerReady) {
    pill.classList.add('ready');
    txt.textContent = MODELS[ai.localModel].label + ' ready';
    return;
  }
  if (ai.workerLoading) {
    pill.classList.add('loading');
    txt.textContent = 'Loading model…';
    return;
  }
  txt.textContent = 'AI off';
}

function notifyCorporaOfAIChange() {
  for (const c of corpora.values()) {
    try { c.refreshAIDependentTabs?.(); } catch (e) { console.warn('corpus refresh error', e); }
  }
}

function showLoadProgress() { document.getElementById('loadProgress')?.classList.add('visible'); }
function hideLoadProgress() { document.getElementById('loadProgress')?.classList.remove('visible'); }
function setLoadProgress(pct, label) {
  const fill = document.getElementById('loadProgressFill');
  const text = document.getElementById('loadProgressText');
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = label || '';
}

let _currentDownloadFile = '';
function handleLoadProgress(p) {
  showLoadProgress();
  const fileName = p.file ? String(p.file).split('/').pop() : '';
  if (fileName) _currentDownloadFile = fileName;
  if (p.status === 'initiate') {
    setLoadProgress(2, `Fetching ${fileName}...`);
  } else if (p.status === 'progress_total' && p.loaded && p.total) {
    const pct = Math.min(96, Math.round((p.loaded / p.total) * 100));
    const mb = (p.loaded / 1048576).toFixed(0);
    const tot = (p.total / 1048576).toFixed(0);
    const label = _currentDownloadFile ? ` ${_currentDownloadFile}` : '';
    setLoadProgress(pct, `Downloading${label} — ${mb}/${tot} MB (${pct}%)`);
  } else if (p.status === 'loading') {
    setLoadProgress(96, `Loading ${fileName} into memory...`);
  }
}

// ── AI: model lifecycle ────────────────────────────────────────────────────

async function loadLocalModel() {
  if (!navigator.gpu) {
    setLocalStatus('error', 'WebGPU not available — switch to BYOK mode');
    return;
  }
  if (ai.workerLoading) return;
  if (ai.workerReady && ai.loadedModel === ai.localModel) {
    setLocalStatus('ready', MODELS[ai.localModel].label + ' ready');
    return;
  }
  // Different model selected — tear down existing worker.
  if (ai.worker) { try { ai.worker.terminate(); } catch {} ai.worker = null; }
  ai.workerReady = false;
  ai.loadedModel = null;
  ai.workerLoading = true;
  setLocalStatus('loading', 'Starting worker...');
  showLoadProgress();
  setLoadProgress(1, 'Initialising...');

  ai.worker = createLocalWorker();
  const m = MODELS[ai.localModel];
  ai.worker.postMessage({ type: 'load', modelId: m.id, modelType: m.type, dtype: m.dtype });
}

async function isModelCached(modelId) {
  try {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      if (keys.some(req => req.url.includes(modelId))) return true;
    }
  } catch {}
  return false;
}

async function clearModelCache() {
  if (!confirm('Clear cached model weights? Next load will re-download.')) return;
  try {
    const names = await caches.keys();
    for (const name of names) await caches.delete(name);
    setLocalStatus('', 'Cache cleared — load again');
    ai.workerReady = false;
    ai.loadedModel = null;
    if (ai.worker) { ai.worker.terminate(); ai.worker = null; }
    toast('Model cache cleared');
  } catch (e) {
    toast('Could not clear cache');
  }
}

// ── AI: BYOK providers ──────────────────────────────────────────────────────

function getApiConfig() {
  const provider = ai.apiProvider;
  const def = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    style: def.style,
    url: ai.apiBaseUrl || def.url,
    model: ai.apiModel || def.model,
    apiKey: ai.apiKey,
    noAuth: !!def.noAuth,
  };
}

async function generateApi(messages, onToken, signal) {
  const cfg = getApiConfig();
  if (!cfg.apiKey && !cfg.noAuth) throw new Error('Set an API key in Settings first.');
  if (!cfg.url) throw new Error('Set a Base URL in Settings (custom provider).');

  if (cfg.style === 'anthropic') return generateAnthropic(messages, onToken, signal, cfg);
  return generateOpenAICompatible(messages, onToken, signal, cfg);
}

async function generateAnthropic(messages, onToken, signal, cfg) {
  let system = '';
  const turns = [];
  for (const m of messages) {
    if (m.role === 'system') system = (system ? system + '\n\n' : '') + m.content;
    else turns.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
  }
  const body = {
    model: cfg.model, system: system || undefined, messages: turns, max_tokens: 1024, stream: true,
  };
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': cfg.apiKey,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 240)}`);

  await streamSSE(res, (line) => {
    try {
      const j = JSON.parse(line);
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta?.text) {
        onToken(j.delta.text);
      }
    } catch {}
  });
}

async function generateOpenAICompatible(messages, onToken, signal, cfg) {
  const body = { model: cfg.model, messages, stream: true, max_tokens: 1024 };
  const headers = { 'Content-Type': 'application/json' };
  if (!cfg.noAuth) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'SansadSaar';
  }
  const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${(await res.text()).slice(0, 240)}`);

  await streamSSE(res, (line) => {
    if (line === '[DONE]') return;
    try {
      const j = JSON.parse(line);
      const tok = j.choices?.[0]?.delta?.content;
      if (tok) onToken(tok);
    } catch {}
  });
}

async function streamSSE(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const ln of lines) {
      if (ln.startsWith('data: ')) onLine(ln.slice(6).trim());
    }
  }
}

// ── AI: unified generate / stop ────────────────────────────────────────────

async function aiGenerate(messages, onToken) {
  if (ai.streaming) throw new Error('Already generating — wait or stop.');
  ai.streaming = true;
  try {
    if (ai.mode === 'api') {
      ai.abortController = new AbortController();
      try {
        await generateApi(messages, onToken, ai.abortController.signal);
      } finally {
        ai.abortController = null;
      }
    } else {
      if (!navigator.gpu) throw new Error('WebGPU not available — switch to BYOK mode in Settings.');
      if (!ai.workerReady) throw new Error('Local model not loaded. Open Settings → Load.');
      const id = ++ai.msgIdCounter;
      const m = MODELS[ai.localModel];
      await new Promise((resolve, reject) => {
        ai.pendingResolvers.set(id, { onToken, onDone: resolve, onErr: reject });
        ai.worker.postMessage({ type: 'generate', messages, id, generationConfig: m.genConfig });
      });
    }
  } finally {
    ai.streaming = false;
  }
}

function aiStop() {
  if (ai.mode === 'api' && ai.abortController) {
    ai.abortController.abort();
  } else if (ai.worker) {
    ai.worker.postMessage({ type: 'stop' });
  }
  ai.streaming = false;
}

function isAIUsable() {
  if (ai.mode === 'api') {
    const cfg = getApiConfig();
    return !!cfg.apiKey || !!cfg.noAuth;
  }
  return ai.workerReady;
}

function aiNotReadyHTML() {
  const reason = (() => {
    if (ai.mode === 'api') {
      return 'No API key set. Open <b>Settings</b> to add a key for your chosen provider — free options include Gemini, Groq, OpenRouter, and Ollama (local).';
    }
    if (!navigator.gpu) {
      return 'WebGPU isn\'t available in this browser. Switch <b>Settings → AI mode</b> to <b>BYOK</b> and add an API key (Gemini, Groq, OpenRouter all have free tiers).';
    }
    if (ai.workerLoading) {
      return 'Local model is loading — this can take a minute on first run while shaders compile. The pill at the top right tracks progress.';
    }
    return 'Local model not loaded yet. Open <b>Settings</b> to load Gemma 4 (~1.5 GB the first time, instant after that), or switch to <b>BYOK</b> mode.';
  })();
  return `<div class="ai-empty">
    <p>${reason}</p>
    <div class="ai-empty-cta"><button class="primary sm" data-action="open-settings">Open Settings</button></div>
  </div>`;
}

// Wires up the "Open Settings" button rendered by aiNotReadyHTML. Replaces
// the inline onclick that was in SansadLocal — friendlier to a future CSP.
function bindAINotReadyCTA(container) {
  const btn = container.querySelector('[data-action="open-settings"]');
  if (btn) btn.addEventListener('click', () => {
    renderSettings();
    openModal('settingsModal');
  });
}

// ── "Save to Disk" pill (File System Access API) ────────────────────────────
//
// State machine + DOM live in app/disk-sync.js; shell just renders the pill
// and dispatches clicks based on the current state. Browsers without FSA
// (Safari, Firefox, iOS) see no pill at all — the rest of the app is
// unaffected.

function refreshDiskPill() {
  const pill = document.getElementById('diskPill');
  const txt  = document.getElementById('diskPillText');
  if (!pill || !txt) return;
  const { state, supported, syncing, lastSyncAt } = getDiskSyncState();

  if (!supported) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.classList.remove('connected', 'reconnect', 'syncing');

  if (syncing) {
    pill.classList.add('syncing');
    txt.textContent = 'Syncing…';
    pill.disabled = true;
    return;
  }
  pill.disabled = false;

  if (state === 'connected') {
    pill.classList.add('connected');
    const age = lastSyncAt ? relativeTime(new Date(lastSyncAt).toISOString()) : 'just now';
    txt.textContent = lastSyncAt ? `Synced • ${age}` : 'Synced';
    pill.title = 'Click to re-sync the index from the mirror to your folder';
  } else if (state === 'reconnect-needed') {
    pill.classList.add('reconnect');
    txt.textContent = 'Reconnect to Disk';
    pill.title = 'Browser dropped permission to your saved folder — click to re-grant';
  } else {
    txt.textContent = 'Save to Disk';
    pill.title = 'Save the index to a folder you control (Tier A: meta + reports + bundle + index, ~60 MB total)';
  }
}

async function onDiskPillClick() {
  const { state, supported, syncing } = getDiskSyncState();
  if (!supported || syncing) return;
  const onProgress = (path) => {
    const txt = document.getElementById('diskPillText');
    if (txt) txt.textContent = 'Syncing… ' + path;
  };
  try {
    if (state === 'unsaved') {
      toast('Pick a folder — we\'ll write the index there now and reconnect on each visit');
      await connectAndSync(onProgress);
      toast('Saved. Folder is now your portable mirror of SansadSaar.');
    } else if (state === 'reconnect-needed') {
      await reconnect();
      const after = getDiskSyncState();
      if (after.state === 'connected') {
        toast('Reconnected. Syncing fresh data…');
        await syncNow(onProgress);
        toast('Synced.');
      } else {
        toast('Permission not granted — try again or pick a new folder');
      }
    } else if (state === 'connected') {
      toast('Re-syncing from the mirror…');
      await syncNow(onProgress);
      toast('Synced.');
    }
  } catch (e) {
    // AbortError is the user dismissing the directory picker — silent.
    if (e?.name !== 'AbortError') {
      console.warn('[disk-sync] click handler error', e);
      toast('Disk sync failed: ' + e.message);
    }
  } finally {
    refreshDiskPill();
  }
}

// ── Web search providers ────────────────────────────────────────────────────

function isSearchConfigured() {
  const p = search.provider;
  if (!p || p === 'none') return false;
  if (p === 'searxng') return !!search.baseUrl;
  return !!search.apiKey;
}

const SearchProviders = {
  async tavily(query, apiKey) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic' }),
    });
    if (!res.ok) throw new Error('Tavily ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return (j.results || []).map(r => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 600) }));
  },
  async brave(query, apiKey) {
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query), {
      headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error('Brave ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return (j.web?.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: (r.description || '').slice(0, 600) }));
  },
  async searxng(query, baseUrl) {
    const url = baseUrl.replace(/\/$/, '') + '/search?q=' + encodeURIComponent(query) + '&format=json';
    const res = await fetch(url);
    if (!res.ok) throw new Error('SearXNG ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return (j.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 600) }));
  },
};

async function runSearch(query) {
  if (search.provider === 'tavily')  return SearchProviders.tavily(query, search.apiKey);
  if (search.provider === 'brave')   return SearchProviders.brave(query, search.apiKey);
  if (search.provider === 'searxng') return SearchProviders.searxng(query, search.baseUrl);
  throw new Error('No web search provider configured');
}

// ── Settings UI ────────────────────────────────────────────────────────────

function renderSettings() {
  document.getElementById('aiMode').value        = ai.mode;
  document.getElementById('localModel').value    = ai.localModel;
  document.getElementById('apiProvider').value   = ai.apiProvider;
  document.getElementById('apiKey').value        = ai.apiKey || '';
  document.getElementById('apiModel').value      = ai.apiModel || '';
  document.getElementById('apiBaseUrl').value    = ai.apiBaseUrl || '';
  const diskSaveAi = document.getElementById('diskSaveAi');
  if (diskSaveAi) diskSaveAi.checked = !!diskPrefs.saveAi;
  document.getElementById('searchProvider').value = search.provider || 'none';
  document.getElementById('searchApiKey').value   = search.apiKey || '';
  document.getElementById('searchBaseUrl').value  = search.baseUrl || '';

  toggleAISections();
  toggleProviderRows();
  toggleSearchRows();

  // Mount each registered corpus's settings section.
  const corpusContainer = document.getElementById('corpusSettingsSections');
  if (corpusContainer) {
    corpusContainer.innerHTML = '';
    for (const c of corpora.values()) {
      if (typeof c.renderSettingsSection !== 'function') continue;
      const wrap = document.createElement('div');
      wrap.dataset.corpus = c.id;
      corpusContainer.appendChild(wrap);
      try { c.renderSettingsSection(wrap); } catch (e) { console.warn('corpus settings render error', c.id, e); }
    }
  }

  // Status pill
  if (ai.workerReady)        setLocalStatus('ready', MODELS[ai.localModel].label + ' ready');
  else if (ai.workerLoading) setLocalStatus('loading', 'Loading…');
  else if (!navigator.gpu)   setLocalStatus('error', 'WebGPU not available');
  else                       setLocalStatus('', 'Not loaded');

  isModelCached(MODELS[ai.localModel].id).then(cached => {
    if (!ai.workerReady && !ai.workerLoading) {
      setLocalStatus('', cached ? 'Cached — click Load to enable' : 'Not loaded');
    }
  });
}

function toggleAISections() {
  const mode = document.getElementById('aiMode').value;
  document.getElementById('localAISection').style.display = mode === 'local' ? '' : 'none';
  document.getElementById('apiAISection').style.display   = mode === 'api'   ? '' : 'none';
}

function toggleProviderRows() {
  const p = document.getElementById('apiProvider').value;
  document.getElementById('baseUrlRow').style.display = (p === 'ollama' || p === 'custom') ? '' : 'none';
  const def = PROVIDER_DEFAULTS[p];
  document.getElementById('apiModel').placeholder = def.model;
  document.getElementById('apiBaseUrl').placeholder = def.url;
}

function toggleSearchRows() {
  const p = document.getElementById('searchProvider').value;
  document.getElementById('searchKeyRow').style.display = (p === 'tavily' || p === 'brave') ? '' : 'none';
  document.getElementById('searchUrlRow').style.display = (p === 'searxng') ? '' : 'none';
}

function applyShellSettingsFromUI() {
  ai.mode        = document.getElementById('aiMode').value;
  ai.localModel  = document.getElementById('localModel').value;
  ai.apiProvider = document.getElementById('apiProvider').value;
  ai.apiKey      = document.getElementById('apiKey').value.trim();
  ai.apiModel    = document.getElementById('apiModel').value.trim();
  ai.apiBaseUrl  = document.getElementById('apiBaseUrl').value.trim();
  search.provider = document.getElementById('searchProvider').value;
  search.apiKey   = document.getElementById('searchApiKey').value.trim();
  search.baseUrl  = document.getElementById('searchBaseUrl').value.trim();
  const diskSaveAi = document.getElementById('diskSaveAi');
  if (diskSaveAi) diskPrefs.saveAi = diskSaveAi.checked;

  // Persist into the single legacy settings JSON (preserves existing keys).
  const s = loadSettings();
  s.aiMode         = ai.mode;
  s.localModel     = ai.localModel;
  s.apiProvider    = ai.apiProvider;
  s.apiKey         = ai.apiKey;
  s.apiModel       = ai.apiModel;
  s.apiBaseUrl     = ai.apiBaseUrl;
  s.searchProvider = search.provider;
  s.searchApiKey   = search.apiKey;
  s.searchBaseUrl  = search.baseUrl;
  s.diskSaveAi     = diskPrefs.saveAi;
  saveSettings(s);
}

function loadShellSettings() {
  const s = loadSettings();
  if (s.aiMode)         ai.mode        = s.aiMode;
  if (s.localModel)     ai.localModel  = s.localModel;
  if (s.apiProvider)    ai.apiProvider = s.apiProvider;
  if (s.apiKey)         ai.apiKey      = s.apiKey;
  if (s.apiModel)       ai.apiModel    = s.apiModel;
  if (s.apiBaseUrl)     ai.apiBaseUrl  = s.apiBaseUrl;
  if (s.searchProvider) search.provider = s.searchProvider;
  if (s.searchApiKey)   search.apiKey   = s.searchApiKey;
  if (s.searchBaseUrl)  search.baseUrl  = s.searchBaseUrl;
  diskPrefs.saveAi = !!s.diskSaveAi;   // default false
}

// ── Chip switcher + per-corpus status pill ──────────────────────────────────

function renderCorpusChips() {
  const el = document.getElementById('corpusChips');
  if (!el) return;
  // Group chips by macroGroup. With one corpus this is trivial; future
  // corpora will fan out under their group headings.
  const groups = new Map();   // macroGroup → [corpus]
  for (const c of corpora.values()) {
    const g = c.macroGroup || 'other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }

  // Single-group case: skip the group label so v1.0a phase 1 isn't visually
  // noisier than necessary. When a second group lands the labels appear.
  const showGroupLabels = groups.size > 1;

  const html = [];
  for (const [g, list] of groups) {
    if (showGroupLabels) {
      html.push(`<span class="corpus-group-label">${escapeHtml(g)}</span>`);
    }
    for (const c of list) {
      const active = c.id === activeCorpusId;
      html.push(`<button class="corpus-chip${active ? ' active' : ''}"
                          data-corpus="${escapeHtml(c.id)}"
                          role="tab"
                          aria-selected="${active}"
                          tabindex="${active ? '0' : '-1'}"
                          title="${escapeHtml(c.label)}">${escapeHtml(c.shortLabel)}</button>`);
    }
  }
  el.innerHTML = html.join(' ');

  // Click + keyboard
  el.querySelectorAll('.corpus-chip').forEach(btn => {
    btn.addEventListener('click', () => activate(btn.dataset.corpus));
  });

  // Mobile compact picker — same data, rendered as a <select> with
  // <optgroup>s per macroGroup. CSS hides one or the other based on
  // viewport; the change listener routes through the same activate()
  // path as a chip click.
  const sel = document.getElementById('corpusSelect');
  if (sel) {
    const opts = [];
    for (const [g, list] of groups) {
      const labelAttr = showGroupLabels ? ` label="${escapeHtml(g.charAt(0).toUpperCase() + g.slice(1))}"` : '';
      if (showGroupLabels) opts.push(`<optgroup${labelAttr}>`);
      for (const c of list) {
        const selected = c.id === activeCorpusId ? ' selected' : '';
        opts.push(`<option value="${escapeHtml(c.id)}"${selected}>${escapeHtml(c.shortLabel)}</option>`);
      }
      if (showGroupLabels) opts.push(`</optgroup>`);
    }
    sel.innerHTML = opts.join('');
    // Idempotent — replace previous listener by cloning. Simpler than
    // tracking handle to remove.
    const clone = sel.cloneNode(true);
    sel.replaceWith(clone);
    clone.addEventListener('change', (e) => activate(e.target.value));
  }
}

async function refreshCorpusStatus() {
  const el = document.getElementById('corpusStatus');
  if (!el) return;
  const c = corpora.get(activeCorpusId);
  if (!c) { el.textContent = ''; return; }

  let status;
  try {
    status = await c.fetchStatus?.();
  } catch (e) {
    status = { lastUpdate: null, error: e?.message || 'fetch failed' };
  }

  // Trailing caret is only visible on mobile (CSS) — advertises the
  // tap-to-expand affordance that toggles `body.stats-expanded`.
  const caret = '<span class="corpus-status-caret" aria-hidden="true">&#9662;</span>';

  el.classList.remove('ready', 'stale', 'error');
  if (!status || status.error || !status.lastUpdate) {
    el.classList.add('error');
    el.innerHTML = `<span class="dot"></span><span>${escapeHtml(c.shortLabel)}: data unavailable</span>${caret}`;
    return;
  }
  const bucket = statusBucket(status.lastUpdate);
  el.classList.add(bucket);
  const rel = relativeTime(status.lastUpdate) || 'unknown';
  el.innerHTML = `<span class="dot"></span><span>${escapeHtml(c.shortLabel)}: updated ${escapeHtml(rel)}</span>${caret}`;
}

// ── Mobile chrome: stats pill expansion + filters toggle ─────────────────────
//
// Wired once at boot. Both target chrome that's only visible on mobile —
// desktop CSS ignores the `body.stats-expanded` and `.filters-wrap.expanded`
// classes via @media gating, so these handlers are harmless on wide viewports.

function wireMobileChrome() {
  const pill = document.getElementById('corpusStatus');
  pill?.addEventListener('click', () => {
    const expanded = document.body.classList.toggle('stats-expanded');
    pill.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });

  const toggle = document.getElementById('filtersToggleBtn');
  const wrap   = document.getElementById('filtersWrap');
  toggle?.addEventListener('click', () => {
    const expanded = wrap.classList.toggle('expanded');
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });

  // Update the toggle label on any filter interaction. Delegation covers
  // every corpus's filter row without each corpus needing to know. We also
  // recount on clicks (deferred via microtask) — clicking the corpus-owned
  // "Reset filters" × button mutates select values programmatically, which
  // doesn't fire 'change'. The microtask runs after that handler completes.
  const fc = document.getElementById('filtersContainer');
  ['input', 'change'].forEach(evt =>
    fc?.addEventListener(evt, () => updateFiltersAppliedCount(), { passive: true }));
  fc?.addEventListener('click', () =>
    Promise.resolve().then(updateFiltersAppliedCount), { passive: true });
}

// Count "applied" filters by walking #filtersContainer. Heuristic:
// - search/text inputs count when non-empty
// - selects whose first <option> has an empty value count when their
//   current value is non-empty (this excludes sort-order dropdowns like
//   "Newest first" whose options never have an empty value).
// Updates #filtersToggleLabel to "Filters" or "Filters · N applied" with
// a small badge. Idempotent — safe to call whenever.
function updateFiltersAppliedCount() {
  const labelEl = document.getElementById('filtersToggleLabel');
  if (!labelEl) return;
  const container = document.getElementById('filtersContainer');
  if (!container) { labelEl.textContent = 'Filters'; return; }

  let n = 0;
  container.querySelectorAll('input, select').forEach(el => {
    if (el.tagName === 'INPUT' && (el.type === 'search' || el.type === 'text')) {
      if ((el.value || '').trim()) n++;
    } else if (el.tagName === 'SELECT') {
      const first = el.options[0];
      if (first && first.value === '' && el.value !== '') n++;
    } else if (el.type === 'checkbox' && el.checked) {
      n++;
    }
  });

  labelEl.innerHTML = n > 0
    ? `Filters <span class="applied-count">${n}</span>`
    : `Filters`;
}

// Each corpus is responsible for making its own `activate()` idempotent —
// shell calls it on every chip click. Corpora typically gate heavy one-time
// work (data fetch, IDB hydration) behind a private `_activated` flag and
// always re-render their filter row / list, so a multi-corpus switch
// round-trip restores the right UI in `#filtersContainer` and `#reportsList`.
async function activate(corpusId) {
  const c = corpora.get(corpusId);
  if (!c) return;
  const isSameAsActive = activeCorpusId === corpusId;
  activeCorpusId = corpusId;
  renderCorpusChips();
  if (!isSameAsActive) {
    const resultsLineEl = document.getElementById('resultsLine');
    if (resultsLineEl) resultsLineEl.innerHTML = '';
  }
  if (typeof c.activate === 'function') {
    const ok = await c.activate(depsForCorpus(corpusId));
    if (ok === false) return;
  }
  if (!isSameAsActive) await refreshCorpusStatus();
  // Refresh the mobile filters-toggle label — each corpus's renderFilterRow
  // injects different inputs/selects, so the applied count needs a recount
  // on every activation.
  updateFiltersAppliedCount();
  broadcast('corpus-activated', { corpus: corpusId });
}

// ── deps factory — what corpus modules see ──────────────────────────────────

// Returns a per-corpus deps object with the right dataBaseUrl. Corpora
// in CORPUS_DATA_BASE_URLS get their own origin; everything else uses
// the global DATA_BASE_URL.
function depsForCorpus(corpusId) {
  const override = CORPUS_DATA_BASE_URLS[corpusId];
  if (!override) return deps;
  return {
    ...deps,
    config: { ...deps.config, dataBaseUrl: override },
  };
}

const deps = {
  config: {
    dataBaseUrl: DATA_BASE_URL,
    // Per-corpus lookup for callers (like disk-sync) that iterate
    // corpora and need to know the right origin for each. Corpora
    // listed in CORPUS_DATA_BASE_URLS get their own origin; the rest
    // fall back to DATA_BASE_URL.
    dataBaseUrlFor: (corpusId) => CORPUS_DATA_BASE_URLS[corpusId] || DATA_BASE_URL,
    version: VERSION,
    product: PRODUCT,
  },

  ai: {
    generate: aiGenerate,
    stop:     aiStop,
    isUsable: isAIUsable,
    streaming: () => ai.streaming,
    mode: () => ai.mode,
    notReadyHTML: aiNotReadyHTML,
    bindNotReadyCTA: bindAINotReadyCTA,
  },

  search: {
    run:          runSearch,
    isConfigured: isSearchConfigured,
  },

  ui: {
    toast,
    openModal,
    closeModal,
    escapeHtml,
    debounce,
    // Cron staleness indicator (Settings modal). See CONV.md
    // "Multi-corpus derive in one repo" for the audit-by-staleness
    // rationale and the cadence map at top-of-file.
    stalenessIndicatorHTML,
    bindStalenessIndicators,
    freshnessFor,
  },

  // Which corpus is currently active in the shell. Each corpus uses this
  // to guard handlers on shared DOM (most notably the report-dialog
  // tab buttons): every corpus binds its own click listener at activate
  // time, so without the guard a click would fan out to all corpora and
  // the last-to-fire would stomp the active corpus's render. Each
  // corpus's switchReportTab early-returns if `deps.activeCorpus() !== <id>`.
  activeCorpus: () => activeCorpusId,

  // "Save to Disk" hooks for opt-in disk caching. Each corpus calls
  // `deps.disk?.write?.(corpusId, path, content)` after a successful
  // network fetch to lazily mirror new content to the user's folder, and
  // `deps.disk?.read?.(corpusId, path)` as an offline fallback when
  // network fails. Both are best-effort and silent when no folder is
  // connected — corpora can call them optimistically without guards.
  // See CONV.md "Save-to-Disk pattern".
  disk: {
    isConnected: diskIsConnected,
    read:        diskRead,
    write:       diskWrite,
    // User preference (Settings → Save to Disk → AI artifacts). When true
    // AND a folder is connected, corpora write summaries + chats to
    // <folder>/<corpus>/ai/ alongside the index. Default false — AI
    // artifacts stay in IDB unless the user opts in.
    saveAi:      () => diskPrefs.saveAi,
  },

  broadcast,
  onBroadcast,
};

// ── JS API surface (window.sansadsaar) ──────────────────────────────────────
//
// Stable surface for power users / external scripts / cross-tab sync.
// Each registered corpus contributes `api: { list, get, search, ... }` —
// the shell aggregates onto window.sansadsaar.<corpusId>. Plus shell-level
// helpers and broadcast channel access.

function buildJSAPI() {
  const api = {
    version: VERSION,
    product: PRODUCT,
    corpora: () => [...corpora.values()].map(c => ({
      id: c.id, label: c.label, shortLabel: c.shortLabel, macroGroup: c.macroGroup, primaryUnit: c.primaryUnit,
    })),
    active: () => activeCorpusId,
    setActive: (id) => activate(id),
    broadcast,
    onBroadcast,
    toast,
    ai: {
      mode:     () => ai.mode,
      isUsable: isAIUsable,
      generate: aiGenerate,
      stop:     aiStop,
    },
  };
  for (const c of corpora.values()) {
    if (c.api) api[c.id] = c.api;
  }
  window[PRODUCT] = api;
}

// ── Init ────────────────────────────────────────────────────────────────────

function attachShellHandlers() {
  // Settings modal
  document.getElementById('settingsBtn').addEventListener('click', () => { renderSettings(); openModal('settingsModal'); });
  document.getElementById('settingsCloseBtn').addEventListener('click', () => closeModal('settingsModal'));
  document.getElementById('aiMode').addEventListener('change',         toggleAISections);
  document.getElementById('apiProvider').addEventListener('change',    toggleProviderRows);
  document.getElementById('searchProvider').addEventListener('change', toggleSearchRows);
  document.getElementById('loadModelBtn').addEventListener('click', () => { applyShellSettingsFromUI(); loadLocalModel(); });
  document.getElementById('clearCacheBtn').addEventListener('click', clearModelCache);
  document.getElementById('saveSettingsBtn').addEventListener('click', () => {
    applyShellSettingsFromUI();
    // Each corpus reads its own form fields and persists what it owns.
    for (const c of corpora.values()) {
      try { c.applySettingsFromUI?.(); } catch (e) { console.warn('corpus settings apply error', c.id, e); }
    }
    refreshAIPill();
    notifyCorporaOfAIChange();
    closeModal('settingsModal');
    toast('Settings saved');
    broadcast('settings-saved');
  });

  // AI pill → opens settings
  document.getElementById('aiPill').addEventListener('click', () => {
    renderSettings();
    openModal('settingsModal');
  });

  // Help modal
  document.getElementById('helpBtn').addEventListener('click', () => openModal('helpModal'));
  document.getElementById('helpCloseBtn').addEventListener('click', () => closeModal('helpModal'));
  document.querySelectorAll('#helpModal .tab-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#helpModal .tab-btn').forEach(x => x.classList.toggle('active', x === b));
      document.querySelectorAll('#helpModal .tab-pane').forEach(p => p.classList.remove('active'));
      const id = { about: 'hAbout', browse: 'hBrowse', ai: 'hAI', privacy: 'hPrivacy', credits: 'hCredits' }[b.dataset.htab];
      document.getElementById(id)?.classList.add('active');
    });
  });

  // Modal backdrop close + Escape
  document.querySelectorAll('.modal-bg').forEach(bg => {
    bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('open'); });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-bg.open').forEach(m => m.classList.remove('open'));
    }
  });

  // Cross-tab sync — when settings change in one tab, refresh AI pill in others.
  onBroadcast((data) => {
    if (!data) return;
    if (data.type === 'settings-saved') {
      loadShellSettings();
      refreshAIPill();
      notifyCorporaOfAIChange();
    }
  });
}

async function init() {
  loadShellSettings();

  // Register corpora before anything else so renderSettings can iterate
  // them and JS API can be built once. activeCorpusId stays null until
  // activate() sets it — that's what gates _activated bookkeeping.
  corpora.set(DRSCCorpus.id,    DRSCCorpus);
  corpora.set(CAGCorpus.id,     CAGCorpus);
  corpora.set(BillsCorpus.id,   BillsCorpus);
  corpora.set(LCCorpus.id,      LCCorpus);
  corpora.set(FCCorpus.id,      FCCorpus);
  corpora.set(DebatesCorpus.id, DebatesCorpus);
  corpora.set(QuestionsCorpus.id, QuestionsCorpus);
  corpora.set(GazettesCorpus.id, GazettesCorpus);

  attachShellHandlers();
  wireMobileChrome();
  buildJSAPI();
  refreshAIPill();

  // Wire the "Save to Disk" pill. initDiskSync() is silent — it just
  // queries permission on any stored handle and sets the initial state.
  // The pill click handler dispatches based on that state.
  document.getElementById('diskPill')?.addEventListener('click', onDiskPillClick);
  onDiskSyncChange(refreshDiskPill);
  initDiskSync(deps).then(refreshDiskPill);

  // Wire the global Cmd+K search modal. Each corpus exposes
  // api.searchForGlobal() for the fan-out; this just plumbs the input
  // and keyboard handlers. See CONV.md "Cross-corpus search modal".
  initGlobalSearch({ deps, corpora, activate });

  // Activate the first corpus — this also renders chips and fetches data.
  await activate(DRSCCorpus.id);

  // Background preload of the other corpora so cross-corpus search has
  // their data ready. `silent: true` runs the corpus's data-fetch path
  // without touching the visible DOM (filter row / list / chips are
  // owned by the active corpus). See CONV.md "Cross-corpus search".
  for (const c of corpora.values()) {
    if (c.id === DRSCCorpus.id) continue;
    if (typeof c.activate !== 'function') continue;
    c.activate(depsForCorpus(c.id), { silent: true }).catch(e =>
      console.warn(`[shell] silent preload of ${c.id} failed:`, e));
  }

  // First-visit hint: auto-open Help once. Per-machine flag, separate from
  // the settings JSON so toggling settings doesn't reset it.
  try {
    if (!localStorage.getItem(INTRO_SEEN_KEY)) {
      document.querySelectorAll('#helpModal .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.htab === 'about'));
      document.querySelectorAll('#helpModal .tab-pane').forEach(p => p.classList.toggle('active', p.id === 'hAbout'));
      openModal('helpModal');
      localStorage.setItem(INTRO_SEEN_KEY, '1');
    }
  } catch {}

  // Auto-load AI if its weights are already cached.
  if (ai.mode === 'local' && navigator.gpu) {
    isModelCached(MODELS[ai.localModel].id).then(cached => {
      if (cached) loadLocalModel();
    });
  }
}

// Wire the error surface before anything else can fail, on BOTH boot paths —
// this module is loaded as a deferred ES module, so readyState is often
// already past 'loading' and the else-branch is the live one. Until
// 2026-07-27 an exception in a handler, or a rejected promise, produced no
// visible trace at all — see deps.js installGlobalErrorSurface.
setNotifier(msg => toast(msg, 6000));
installGlobalErrorSurface();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
