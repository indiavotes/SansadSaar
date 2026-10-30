// app/ai-models.js
// Local-AI model registry. One source for the app (shell.js, Settings
// dropdown) and the test page (harness/ai.html).
//
// `type` drives the worker's load path (app/ai-worker.js):
//   causal     — AutoTokenizer + AutoModelForCausalLM (text only)
//   multimodal — AutoProcessor + Gemma4ForConditionalGeneration
//   vlm        — AutoProcessor + AutoModelForImageTextToText (per-part dtype)
//   anyformer  — anyformer's load() picks the engine; `catalog` names the
//                entry in anyformer's MODELS.chat (same path LocalMind uses)
// `chatTemplate` is passed to apply_chat_template; LFM3 models think by
// default, and a summary or answer needs the reply, not the reasoning.
// `contextSize` is what we budget against, not the model's maximum: LFM3
// accepts 256K tokens, but a browser tab cannot prefill that in useful time.

export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm';
export const ANYFORMER_URL = 'https://cdn.jsdelivr.net/npm/anyformer@0.4.15/index.js';

export const MODELS = {
  'gemma4-e2b': {
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    label: 'Gemma 4 E2B', size: '~1.5 GB', group: 'Gemma 4 (multimodal)',
    dtype: 'q4f16', type: 'multimodal', contextSize: 8192, vision: true,
    genConfig: { temperature: 0.5, top_k: 40, top_p: 0.95, max_new_tokens: 1024, repetition_penalty: 1.1 },
  },
  'gemma4-e4b': {
    id: 'onnx-community/gemma-4-E4B-it-ONNX',
    label: 'Gemma 4 E4B', size: '~4.9 GB', group: 'Gemma 4 (multimodal)',
    dtype: 'q4f16', type: 'multimodal', contextSize: 12288, vision: true,
    genConfig: { temperature: 0.5, top_k: 40, top_p: 0.95, max_new_tokens: 1024, repetition_penalty: 1.1 },
  },
  'lfm3-1.7b': {
    id: 'onnx-community/LFM3-1.7B-ONNX',
    label: 'LFM3 1.7B', size: '~1.1 GB', group: 'Liquid LFM3',
    dtype: 'q4f16', type: 'causal', contextSize: 32768,
    chatTemplate: { enable_thinking: false },
    genConfig: { temperature: 0.1, top_k: 50, top_p: 1.0, max_new_tokens: 1024, repetition_penalty: 1.1 },
  },
  'lfm3-vl-2b': {
    id: 'onnx-community/LFM3-VL-2B-ONNX',
    label: 'LFM3-VL 2B', size: '~1.3 GB', group: 'Liquid LFM3',
    dtype: { vision_encoder: 'q4f16', embed_tokens: 'q4f16', decoder_model_merged: 'q4f16' },
    type: 'vlm', contextSize: 32768, vision: true,
    chatTemplate: { enable_thinking: false },
    genConfig: { temperature: 0.1, top_k: 50, top_p: 1.0, max_new_tokens: 1024, repetition_penalty: 1.1 },
  },
  'lfm3-omni-2b': {
    // Transformers.js 4.3.2 has no lfm3_omni class; anyformer runs it on
    // diskformer's onnxruntime-web engine. Greedy, thinking off by default.
    id: 'LiquidAI/LFM3-Omni-2B-ONNX',
    label: 'LFM3-Omni 2B', size: '~2.1 GB', group: 'Liquid LFM3',
    type: 'anyformer', catalog: 'LFM3_OMNI_2B', contextSize: 32768, vision: true,
    // Hears 16 kHz speech (at most 30 s a clip) and can answer in speech
    // (24 kHz PCM); speech out fetches ~0.5 GB more on first use.
    voice: true,
    genConfig: { max_new_tokens: 1024 },
  },
  'bonsai-1.7b': {
    id: 'onnx-community/Ternary-Bonsai-1.7B-ONNX',
    label: 'Ternary Bonsai 1.7B', size: '~470 MB', group: 'Ternary Bonsai (Qwen3-derived, q2f16)',
    dtype: 'q2f16', type: 'causal', contextSize: 32768,
    genConfig: { temperature: 0.7, top_k: 20, top_p: 0.8, max_new_tokens: 1024, repetition_penalty: 1.05 },
  },
  'bonsai-4b': {
    id: 'onnx-community/Ternary-Bonsai-4B-ONNX',
    label: 'Ternary Bonsai 4B', size: '~1.1 GB', group: 'Ternary Bonsai (Qwen3-derived, q2f16)',
    dtype: 'q2f16', type: 'causal', contextSize: 32768,
    genConfig: { temperature: 0.7, top_k: 20, top_p: 0.8, max_new_tokens: 1024, repetition_penalty: 1.05 },
  },
  'bonsai-8b': {
    id: 'onnx-community/Ternary-Bonsai-8B-ONNX',
    label: 'Ternary Bonsai 8B', size: '~2.2 GB', group: 'Ternary Bonsai (Qwen3-derived, q2f16)',
    dtype: 'q2f16', type: 'causal', contextSize: 65536,
    genConfig: { temperature: 0.7, top_k: 20, top_p: 0.8, max_new_tokens: 1024, repetition_penalty: 1.05 },
  },
};

// Characters of document text a prompt may carry. Gazette and committee
// text mixes Devanagari and Latin, so we assume ~2.5 chars per token, and
// reserve room for the reply and the prompt scaffolding. Local prefill time
// grows with length, so local models are capped below what fits.
const LOCAL_CHAR_CAP = 16000;
const API_CHAR_CAP = 60000;
const PROMPT_OVERHEAD_TOKENS = 768;

export function contextChars(modelKey, mode = 'local') {
  if (mode !== 'local') return API_CHAR_CAP;
  const m = MODELS[modelKey];
  if (!m) return 12000;
  const tokens = m.contextSize - (m.genConfig.max_new_tokens || 1024) - PROMPT_OVERHEAD_TOKENS;
  return Math.max(4000, Math.min(LOCAL_CHAR_CAP, Math.floor(tokens * 2.5)));
}

export function truncateForContext(text, chars) {
  if (text.length <= chars) return text;
  return text.slice(0, chars) + '\n\n[...truncated for context window...]';
}
