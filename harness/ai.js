// harness/ai.js
// Local-AI test harness. For each selected model: start the app's own
// worker (app/ai-worker.js), load the model, run every case in cases.js
// with greedy decoding, check the replies, and record speed. Results show
// in a table and stay on window.harnessResults for scripted reads.

import { MODELS, contextChars, truncateForContext } from '../app/ai-models.js';
import { CASES, VOICE_CASE, visionImageDataURL } from './cases.js';
import { voiceMessages, resampleMono } from '../app/voice-chat.js';

const $ = (id) => document.getElementById(id);
const results = [];
let reqId = 0;
window.harnessResults = results;

function renderModelPicker() {
  $('models').innerHTML = Object.entries(MODELS).map(([k, m]) =>
    `<label><input type="checkbox" value="${k}" ${['gemma4-e2b', 'lfm3-1.7b', 'lfm3-vl-2b'].includes(k) ? 'checked' : ''}>
     ${m.label} <small>${m.size}${m.vision ? ' · vision' : ''}</small></label>`).join('');
}

function log(msg) {
  $('log').textContent += msg + '\n';
  $('log').scrollTop = $('log').scrollHeight;
}

function runInWorker(worker, msg, onToken) {
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const d = e.data;
      // Ignore replies to an earlier request (an error is followed by a
      // stray 'complete' for the same id).
      if (msg.type === 'generate' && d.id != null && d.id !== msg.id) return;
      if (d.type === 'progress' && d.data?.status === 'progress_total' && d.data.total) {
        $('status').textContent = `downloading ${Math.round(100 * d.data.loaded / d.data.total)}%`;
      } else if (d.type === 'token' && onToken) {
        onToken(d.token);
      } else if (d.type === 'speech' && msg.onSpeech) {
        msg.onSpeech(d.pcm, d.sampleRate);
      } else if (d.type === 'ready' && msg.type === 'load') {
        done(); resolve();
      } else if (d.type === 'error') {
        done(); reject(new Error(d.message));
      } else if (d.type === 'complete' && msg.type === 'generate') {
        done(); resolve(d.stats);
      }
    };
    const done = () => worker.removeEventListener('message', onMsg);
    worker.addEventListener('message', onMsg);
    const { onSpeech, ...post } = msg;
    worker.postMessage(post);
  });
}

async function runModel(key) {
  const m = MODELS[key];
  const fit = (t) => truncateForContext(t, contextChars(key, 'local'));
  const worker = new Worker(new URL('../app/ai-worker.js', import.meta.url), { type: 'module' });
  const row = { model: key, label: m.label, loadMs: null, error: null, cases: [] };
  results.push(row);
  log(`\n== ${m.label} (${m.id})`);
  const t0 = performance.now();
  try {
    await runInWorker(worker, { type: 'load', model: m });
    row.loadMs = Math.round(performance.now() - t0);
    log(`loaded in ${(row.loadMs / 1000).toFixed(1)} s`);
  } catch (e) {
    row.error = e.message;
    log(`LOAD FAILED: ${e.message}`);
    worker.terminate();
    render();
    return;
  }
  const maxNew = +$('maxNew').value || 400;
  for (const c of CASES) {
    if (c.vision && !m.vision) continue;
    $('status').textContent = `${m.label}: ${c.id}`;
    let out = '';
    const cr = { id: c.id, what: c.what, output: '', checks: {}, stats: null, error: null };
    try {
      cr.stats = await runInWorker(worker, {
        type: 'generate',
        id: ++reqId,
        messages: c.messages(fit),
        images: c.vision ? [visionImageDataURL()] : undefined,
        generationConfig: { ...m.genConfig, do_sample: false, max_new_tokens: maxNew },
      }, (tok) => { out += tok; });
    } catch (e) {
      cr.error = e.message;
    }
    cr.output = out;
    for (const [name, fn] of Object.entries(c.checks)) cr.checks[name] = !cr.error && fn(out);
    row.cases.push(cr);
    const passed = Object.values(cr.checks).filter(Boolean).length;
    log(`${c.id}: ${passed}/${Object.keys(cr.checks).length} checks` +
        (cr.stats ? ` · first token ${cr.stats.firstTokenMs} ms · ${cr.stats.decodeTokPerS} tok/s · ${cr.stats.promptTokens}→${cr.stats.newTokens} tok` : '') +
        (cr.error ? ` · ERROR ${cr.error}` : ''));
    render();
  }
  if (m.voice) await runVoiceCase(worker, m, row);
  worker.terminate();
}

// Generate one reply with speech; returns its text, joined PCM and level.
async function speak(worker, messages, audios, maxNew) {
  const parts = [];
  let text = '', rate = 24000, tFirstAudio = 0;
  const t0 = performance.now();
  const stats = await runInWorker(worker, {
    type: 'generate', id: ++reqId, messages, audios, speech: true,
    generationConfig: { max_new_tokens: maxNew },
    onSpeech: (pcm, sr) => { parts.push(pcm); rate = sr; tFirstAudio ||= performance.now() - t0; },
  }, (tok) => { text += tok; });
  const pcm = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { pcm.set(p, o); o += p.length; }
  let sq = 0; for (const x of pcm) sq += x * x;
  return { text, pcm, rate, seconds: +(pcm.length / rate).toFixed(2), rms: +Math.sqrt(sq / (pcm.length || 1)).toFixed(4),
    firstAudioMs: Math.round(tFirstAudio), stats };
}

async function runVoiceCase(worker, m, row) {
  const c = VOICE_CASE;
  $('status').textContent = `${m.label}: ${c.id}`;
  const cr = { id: c.id, what: c.what, output: '', checks: {}, stats: null, error: null };
  try {
    const q = await speak(worker, [
      { role: 'system', content: 'Respond with interleaved text and audio.' },
      { role: 'user', content: `Say exactly this sentence and nothing else: ${c.question}` },
    ], undefined, 120);
    const buf = new AudioBuffer({ length: q.pcm.length, sampleRate: q.rate, numberOfChannels: 1 });
    buf.copyToChannel(q.pcm, 0);
    const clip = await resampleMono(buf, 16000);
    const fit = truncateForContext(c.doc, contextChars(row.model, 'local'));
    const r = await speak(worker, voiceMessages('Gazette of India notification', fit), [clip], 480);
    cr.output = `[question spoken ${q.seconds} s: "${q.text.trim()}"]\n${r.text}`;
    cr.stats = { ...r.stats, firstAudioMs: r.firstAudioMs, speechSeconds: r.seconds, rms: r.rms };
    for (const [name, fn] of Object.entries(c.checks)) cr.checks[name] = fn(r);
    window.harnessAudio = { question: q, reply: r };
    addPlayer(`${m.label} — spoken question`, q.pcm, q.rate);
    addPlayer(`${m.label} — spoken answer`, r.pcm, r.rate);
  } catch (e) {
    cr.error = e.message;
    for (const name of Object.keys(c.checks)) cr.checks[name] = false;
  }
  row.cases.push(cr);
  log(`${c.id}: ${Object.values(cr.checks).filter(Boolean).length}/${Object.keys(c.checks).length} checks` +
      (cr.stats ? ` · first audio ${cr.stats.firstAudioMs} ms · ${cr.stats.speechSeconds} s speech · rms ${cr.stats.rms}` : '') +
      (cr.error ? ` · ERROR ${cr.error}` : ''));
  render();
}

// 16-bit mono WAV so the run's speech can be played back on the page.
function addPlayer(label, pcm, rate) {
  const b = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, t) => [...t].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); b.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVEfmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
  str(36, 'data'); b.setUint32(40, pcm.length * 2, true);
  pcm.forEach((x, i) => b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
  const div = document.createElement('div');
  div.innerHTML = `<small>${escape(label)}</small><br><audio controls src="${URL.createObjectURL(new Blob([b], { type: 'audio/wav' }))}"></audio>`;
  $('players').appendChild(div);
}

function render() {
  const rows = [];
  for (const r of results) {
    if (r.error) {
      rows.push(`<tr class="fail"><td>${r.label}</td><td colspan="5">load failed: ${escape(r.error)}</td></tr>`);
      continue;
    }
    for (const c of r.cases) {
      const total = Object.keys(c.checks).length;
      const passed = Object.values(c.checks).filter(Boolean).length;
      const failed = Object.entries(c.checks).filter(([, v]) => !v).map(([k]) => k);
      rows.push(`<tr class="${passed === total ? 'pass' : 'fail'}">
        <td>${r.label}</td><td title="${escape(c.what)}">${c.id}</td>
        <td>${passed}/${total}${failed.length ? `<br><small>${escape(failed.join('; '))}</small>` : ''}</td>
        <td>${c.stats?.firstTokenMs ?? '–'}</td><td>${c.stats?.decodeTokPerS ?? '–'}</td>
        <td><details><summary>${escape((c.error || c.output).slice(0, 80))}…</summary><pre>${escape(c.error || c.output)}</pre></details></td>
      </tr>`);
    }
  }
  $('results').innerHTML = rows.join('');
  const loads = results.map((r) => `${r.label}: ${r.error ? 'failed' : (r.loadMs / 1000).toFixed(1) + ' s'}`);
  $('loads').textContent = loads.length ? 'Load times — ' + loads.join(' · ') : '';
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function runAll() {
  if (!navigator.gpu) { log('No WebGPU in this browser.'); return; }
  $('run').disabled = true;
  results.length = 0;
  $('log').textContent = '';
  const keys = [...document.querySelectorAll('#models input:checked')].map((i) => i.value);
  for (const k of keys) await runModel(k);
  $('status').textContent = 'done';
  $('run').disabled = false;
  window.harnessDone = true;
}

function download() {
  const blob = new Blob([JSON.stringify({ at: new Date().toISOString(), ua: navigator.userAgent, results }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ai-harness-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`;
  a.click();
}

renderModelPicker();
$('run').addEventListener('click', runAll);
$('download').addEventListener('click', download);
const qs = new URLSearchParams(location.search);
if (qs.get('models')) {
  const want = qs.get('models').split(',');
  document.querySelectorAll('#models input').forEach((i) => { i.checked = want.includes(i.value); });
}
if (qs.get('max')) $('maxNew').value = qs.get('max');
if (qs.has('autorun')) runAll();
