// app/ai-worker.js
// Local-AI module worker. Loads one model from app/ai-models.js and
// streams generations back to the page. Used by shell.js and by
// harness/ai.html, so both exercise the same code.
//
// Protocol (page → worker):
//   { type: 'load', model }                 model = a MODELS entry
//   { type: 'generate', id, messages, images?, audios?, speech?, generationConfig? }
//   { type: 'stop' }
// Worker → page: progress, warmup, ready, token, complete (with stats),
// error, and speech (anyformer models asked for speech: 24 kHz PCM chunks).
// `images` is a list of URLs (data: URLs work) and `audios` a list of 16 kHz
// mono Float32Arrays; messages that use them carry `{ type: 'image' }` /
// `{ type: 'audio' }` parts in their content array, matched in order.

import { TRANSFORMERS_URL, ANYFORMER_URL } from './ai-models.js';

// anyformer's engines schedule work with requestAnimationFrame, which
// dedicated workers lack (LocalMind's engine-worker prelude does the same).
self.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 0);

// The listener is attached synchronously below and awaits this, so
// messages sent while the library downloads are not lost.
let T, stopping_criteria;
const ready = import(TRANSFORMERS_URL).then((m) => {
  T = m;
  T.env.allowLocalModels  = true;
  T.env.localModelPath    = '/models/';
  T.env.allowRemoteModels = true;
  stopping_criteria = new T.InterruptableStoppingCriteria();
});

let processor = null;
let tokenizer = null;
let model = null;
let spec = null;
let session = null;        // anyformer session (type 'anyformer')
let abort = null;          // AbortController for the running anyformer reply

const progressCallback = (p) => self.postMessage({ type: 'progress', data: p });

async function loadAnyformer(m) {
  const af = await import(ANYFORMER_URL);
  session = await af.load(af.MODELS.chat[m.catalog], {
    // Re-shape anyformer's progress into the transformers.js events the page reads.
    onProgress: (p) => progressCallback(p.loaded != null && p.total
      ? { status: 'progress_total', file: p.file || m.id, loaded: p.loaded, total: p.total }
      : { status: 'loading', file: p.file || p.status || m.id }),
  });
  self.postMessage({ type: 'ready' });
}

// anyformer chunks carry cumulative text; post the new part as a token.
async function generateAnyformer(id, messages, images, audios, speech, gc) {
  const t0 = performance.now();
  let tFirst = 0, sent = '', tokens = 0, chunks = 0;
  abort = new AbortController();
  try {
    let ni = 0, na = 0;
    const part = (b) => (b.type === 'image' ? { type: 'image', image: images?.[ni++] }
      : b.type === 'audio' ? { type: 'audio', audio: audios?.[na++] } : b);
    const msgs = messages.map((msg) => (Array.isArray(msg.content) ? { ...msg, content: msg.content.map(part) } : msg));
    const opts = { maxNewTokens: gc?.max_new_tokens || 1024, signal: abort.signal, ...(speech && { speech: true }) };
    for await (const c of session.generate(msgs, opts)) {
      if (!tFirst) tFirst = performance.now();
      chunks++;
      tokens = c.tokens ?? tokens;
      if (c.audio?.length) {
        // A copy: c.audio may be a view of the engine's buffer, which a transfer would detach.
        const pcm = Float32Array.from(c.audio);
        self.postMessage({ type: 'speech', id, pcm, sampleRate: c.sampleRate || 24000 }, [pcm.buffer]);
      }
      if (c.text.length > sent.length) {
        self.postMessage({ type: 'token', token: c.text.slice(sent.length), id });
        sent = c.text;
      }
    }
    const tEnd = performance.now();
    const decodeMs = tFirst ? tEnd - tFirst : 0;
    self.postMessage({
      type: 'complete', id,
      stats: {
        promptTokens: null,
        newTokens: tokens,
        totalMs: Math.round(tEnd - t0),
        firstTokenMs: tFirst ? Math.round(tFirst - t0) : null,
        decodeTokPerS: decodeMs > 0 && tokens > 1 ? +((tokens - 1) / (decodeMs / 1000)).toFixed(1) : null,
        streamedChunks: chunks,
      },
    });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message || String(err) });
    self.postMessage({ type: 'complete', id });
  } finally {
    abort = null;
  }
}

async function load(m) {
  spec = m;
  if (m.type === 'anyformer') return loadAnyformer(m);
  const opts = { dtype: m.dtype, device: 'webgpu', progress_callback: progressCallback };
  if (m.type === 'causal') {
    processor = null;
    tokenizer = await T.AutoTokenizer.from_pretrained(m.id, { progress_callback: progressCallback });
    model = await T.AutoModelForCausalLM.from_pretrained(m.id, opts);
  } else {
    processor = await T.AutoProcessor.from_pretrained(m.id, { progress_callback: progressCallback });
    tokenizer = processor.tokenizer;
    const cls = m.type === 'vlm' ? T.AutoModelForImageTextToText : T.Gemma4ForConditionalGeneration;
    model = await cls.from_pretrained(m.id, opts);
  }
  self.postMessage({ type: 'warmup' });
  await model.generate({ ...tokenizer('a'), max_new_tokens: 1 });
  self.postMessage({ type: 'ready' });
}

async function buildInputs(messages, images) {
  const tpl = { add_generation_prompt: true, ...(spec.chatTemplate || {}) };
  if (!processor) {
    return tokenizer.apply_chat_template(messages, { ...tpl, return_dict: true });
  }
  const prompt = processor.apply_chat_template(messages, tpl);
  const imgs = images?.length ? await Promise.all(images.map((u) => T.load_image(u))) : null;
  if (spec.type === 'vlm') {
    // The VLM processor needs an image; text-only prompts go to its tokenizer.
    return imgs
      ? processor(imgs.length === 1 ? imgs[0] : imgs, prompt, { add_special_tokens: false })
      : tokenizer(prompt, { add_special_tokens: false });
  }
  // Gemma 4 processor signature: (text, images, audio, options).
  return processor(prompt, imgs ? (imgs.length === 1 ? imgs[0] : imgs) : null, null, { add_special_tokens: false });
}

async function generate(id, messages, images, gc) {
  stopping_criteria.reset();
  const t0 = performance.now();
  let tFirst = 0;
  let chunks = 0;
  try {
    const inputs = await buildInputs(messages, images);
    const promptTokens = inputs.input_ids.dims.at(-1);
    const tPrefillStart = performance.now();
    const streamer = new T.TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => {
        chunks++;
        self.postMessage({ type: 'token', token: text, id });
      },
    });
    // The callback fires at word breaks, not per token, so time the first
    // token from put(): call 1 carries the prompt, call 2 the first new token.
    const put = streamer.put.bind(streamer);
    let puts = 0;
    streamer.put = (v) => { if (++puts === 2) tFirst = performance.now(); return put(v); };
    const doSample = gc?.do_sample ?? true;
    const out = await model.generate({
      ...inputs,
      max_new_tokens: gc?.max_new_tokens || 1024,
      do_sample: doSample,
      ...(doSample ? {
        temperature: gc?.temperature ?? 0.5,
        top_k: gc?.top_k ?? 40,
        top_p: gc?.top_p ?? 0.95,
      } : {}),
      repetition_penalty: gc?.repetition_penalty ?? 1.1,
      streamer,
      stopping_criteria,
    });
    const tEnd = performance.now();
    const seq = out.sequences ?? out;
    const newTokens = Math.max(0, seq.dims.at(-1) - promptTokens);
    const decodeMs = tFirst ? tEnd - tFirst : 0;
    self.postMessage({
      type: 'complete', id,
      stats: {
        promptTokens,
        newTokens,
        totalMs: Math.round(tEnd - t0),
        firstTokenMs: tFirst ? Math.round(tFirst - tPrefillStart) : null,
        decodeTokPerS: decodeMs > 0 && newTokens > 1 ? +((newTokens - 1) / (decodeMs / 1000)).toFixed(1) : null,
        streamedChunks: chunks,
      },
    });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message || String(err) });
    self.postMessage({ type: 'complete', id });
  }
}

self.addEventListener('message', async (e) => {
  const d = e.data;
  if (d.type === 'stop') { stopping_criteria?.interrupt(); abort?.abort(); return; }
  await ready;
  if (d.type === 'load') {
    try {
      await load(d.model);
    } catch (err) {
      self.postMessage({ type: 'error', message: 'Failed to load model: ' + (err.message || String(err)) });
    }
  } else if (d.type === 'generate') {
    if (spec?.type === 'anyformer') await generateAnyformer(d.id, d.messages, d.images, d.audios, d.speech, d.generationConfig);
    else await generate(d.id, d.messages, d.images, d.generationConfig);
  }
});
