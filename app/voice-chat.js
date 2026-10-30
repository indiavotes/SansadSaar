// app/voice-chat.js
// Voice chat for the report dialog's Ask tab. With a local model that hears
// and speaks (LFM3-Omni 2B, MODELS[*].voice), a mic button records a spoken
// question, the model hears it with the open record's text, and answers in
// speech; the reply's text lands in the chat thread like a typed answer.
//
// Each corpus calls attachVoice() at the end of its renderChatTab(). This
// module owns recording, resampling, playback and the thread updates; the
// corpus supplies the document text and how to persist its chat.

const IN_RATE = 16000;          // what LFM3-Omni hears
const MAX_SECONDS = 30;         // its per-clip limit
const MAX_REPLY_SLOTS = 480;    // text tokens + 80 ms speech frames (~30 s of speech)

let recorder = null;            // the one live recording, across corpora
let player = null;              // the SpeechPlayer for the current reply

// LFM3-Omni makes speech at about 0.5x real time in a browser tab, so
// playing each chunk as it lands stutters every second. SpeechPlayer waits
// for START_BUFFER seconds before it starts, and after each run-dry it
// waits for twice the previous amount (capped), so a slow reply pauses a
// few times at most. end() plays whatever is left.
const START_BUFFER = 2;
const MAX_BUFFER = 8;

export class SpeechPlayer {
  // ctx: an AudioContext, or any { currentTime, createBuffer,
  // createBufferSource, destination } (the tests pass a fake clock).
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = [];          // AudioBuffers not yet scheduled
    this.pendingSec = 0;
    this.nextTime = 0;          // when the scheduled audio runs out
    this.started = false;
    this.need = START_BUFFER;   // buffered seconds required to (re)start
    this.pauses = 0;
  }
  push(pcm, sampleRate) {
    const buf = this.ctx.createBuffer(1, pcm.length, sampleRate);
    buf.copyToChannel(pcm, 0);
    const now = this.ctx.currentTime;
    if (this.started && this.nextTime > now + 0.02) { this.schedule(buf); return; }
    if (this.started && !this.waiting) {     // ran dry since the last chunk
      this.waiting = true;
      this.pauses++;
      this.need = Math.min(MAX_BUFFER, this.need * 2);
    }
    this.pending.push(buf);
    this.pendingSec += buf.duration;
    if (this.pendingSec >= this.need) this.flush();
  }
  end() { this.flush(); }
  flush() {
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.05);
    for (const b of this.pending) this.schedule(b);
    this.pending = [];
    this.pendingSec = 0;
    this.started = this.started || this.nextTime > 0;
    this.waiting = false;
  }
  schedule(buf) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime + 0.05, this.nextTime);
    src.start(at);
    this.nextTime = at + buf.duration;
    this.started = true;
  }
}

/**
 * @param {Object}   o
 * @param {Object}   o.deps      Shell deps (`_deps`); uses deps.ai and deps.ui.
 * @param {Element}  o.row       The Ask tab's `.chat-input-row`; the button goes here.
 * @param {string}   o.docLabel  "gazette notification", "audit report", …
 * @param {Function} o.getText   async () => document text (already truncated), or null.
 * @param {Array}    o.chat      The corpus's state.dialogChat (mutated in place).
 * @param {Function} o.rerender  The corpus's renderChatTab.
 * @param {Function} o.save      Persists o.chat (IDB + cache) after a voice turn.
 */
export function attachVoice({ deps, row, docLabel, getText, chat, rerender, save }) {
  if (!row || !deps.ai.voiceReady?.() || !navigator.mediaDevices?.getUserMedia) return;
  const btn = document.createElement('button');
  btn.className = 'ghost sm voice-btn';
  btn.type = 'button';
  btn.title = `Ask out loud (up to ${MAX_SECONDS} s). Click to start, click again to send.`;
  btn.innerHTML = recorder ? '&#9632; Send' : '&#127908; Speak';
  if (deps.ai.streaming()) btn.disabled = true;
  row.insertBefore(btn, row.querySelector('#chatSendBtn'));
  btn.addEventListener('click', async () => {
    if (recorder) { recorder.stop(); return; }
    stopPlayback();
    try {
      await record(btn, (clip) => answer({ deps, docLabel, getText, chat, rerender, save, clip }));
    } catch (e) {
      deps.ui.toast(e.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Could not record: ' + e.message);
      recorder = null;
      rerender();
    }
  });
}

// Record until clicked again or MAX_SECONDS, then hand over 16 kHz mono PCM.
async function record(btn, onClip) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const parts = [];
  recorder = new MediaRecorder(stream);
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size) parts.push(e.data); });
  recorder.addEventListener('stop', async () => {
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    const clip = await toMono16k(new Blob(parts, { type: parts[0]?.type || 'audio/webm' }));
    if (clip.length < IN_RATE * 0.4) { btn.innerHTML = '&#127908; Speak'; return; }   // a stray click
    onClip(clip);
  });
  const timer = setTimeout(() => recorder?.state === 'recording' && recorder.stop(), MAX_SECONDS * 1000);
  recorder.start();
  btn.innerHTML = '&#9632; Send';
  btn.classList.add('recording');
}

export async function toMono16k(blob) {
  const raw = await blob.arrayBuffer();
  const decoded = await new AudioContext().decodeAudioData(raw);
  return resampleMono(decoded, IN_RATE);
}

// AudioBuffer (any rate, any channels) → Float32Array mono at `rate`.
export async function resampleMono(buffer, rate) {
  const frames = Math.ceil(buffer.duration * rate);
  const off = new OfflineAudioContext(1, frames, rate);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

export function voiceMessages(docLabel, text) {
  // LFM3-Omni speaks only under Liquid's speech line; it goes last in a short
  // system turn (a long instruction block in front made LocalMind's first
  // spoken reply wander, 2026-10-30). The document rides in the user turn.
  return [
    { role: 'system', content: `You answer spoken questions about one ${docLabel} from the Government of India, using only the document the user supplies. If the answer is not in it, say so. Answer in the language of the question, in two or three short sentences.\n\nRespond with interleaved text and audio.` },
    { role: 'user', content: [{ type: 'text', text: `DOCUMENT:\n${text}\n\nQUESTION (spoken):` }, { type: 'audio' }] },
  ];
}

async function answer({ deps, docLabel, getText, chat, rerender, save, clip }) {
  const text = await getText();
  if (!text) { deps.ui.toast('Full text not available for this record'); rerender(); return; }
  const secs = (clip.length / IN_RATE).toFixed(1);
  chat.push({ role: 'user', content: `(spoken question, ${secs} s)` });
  chat.push({ role: 'assistant', content: '' });
  rerender();
  const last = chat[chat.length - 1];
  try {
    await deps.ai.generate(voiceMessages(docLabel, text), (tok) => {
      last.content += tok;
      const el = document.querySelector('#chatThread .chat-msg.assistant:last-child');
      if (el) {
        el.textContent = last.content;
        const t = document.getElementById('chatThread');
        if (t) t.scrollTop = t.scrollHeight;
      }
    }, { audios: [clip], speech: true, onAudio: play, maxNewTokens: MAX_REPLY_SLOTS });
  } catch (e) {
    last.error = true;
    last.content = (last.content ? last.content + '\n\n' : '') + 'Error: ' + e.message;
  }
  player?.end();
  rerender();
  save();
}

function play(pcm, sampleRate) {
  if (!player) player = new SpeechPlayer(new AudioContext());
  player.push(pcm, sampleRate);
}

export function stopPlayback() {
  if (player) { player.ctx.close?.().catch(() => {}); player = null; }
}
