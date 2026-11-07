// Runs the neural voice off the main thread, on the device the page asks for, and
// proves the audio is real before trusting it: some model and hardware pairings
// return invalid numbers, which would otherwise play as silence.

import { KokoroTTS, env } from '../node_modules/kokoro-js/dist/kokoro.web.js';
import { isSpeech, toWav } from '../main/tts-audio.js';

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MODEL_FILE = 'onnx/model.onnx';
const TEST_LINE = 'Reading is ready.';
const TEST_VOICE = 'af_heart';

env.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;

let engine = null;
let queue = [];
let working = false;

function reportDownload(event) {
  if (event.status === 'progress' && event.file === MODEL_FILE) {
    self.postMessage({ progress: { done: event.loaded, total: event.total } });
  } else if (event.status === 'done' && event.file === MODEL_FILE) {
    self.postMessage({ progress: { stage: 'preparing' } });
  }
}

async function createEngine(device) {
  const tts = await KokoroTTS.from_pretrained(REPO, { dtype: 'fp32', device, progress_callback: reportDownload });
  self.postMessage({ progress: { stage: 'testing' } });
  const { audio } = await tts.generate(TEST_LINE, { voice: TEST_VOICE });
  if (!isSpeech(audio)) throw new Error(`${device} produced invalid audio`);
  return tts;
}

function loadEngine(device) {
  engine ??= createEngine(device).catch((err) => {
    engine = null;
    throw err;
  });
  return engine;
}

const tasks = {
  async load({ device }) {
    await loadEngine(device);
  },
  async voices() {
    const tts = await loadEngine();
    return Object.entries(tts.voices).map(([id, v]) => ({
      id, name: v.name, language: v.language, gender: v.gender, grade: v.overallGrade,
    }));
  },
  async synth({ text, voice }) {
    const tts = await loadEngine();
    const { audio, sampling_rate: rate } = await tts.generate(text, { voice });
    if (!isSpeech(audio)) throw new Error('the voice could not read this sentence');
    return toWav(audio, rate);
  },
};

async function pump() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      const result = await tasks[job.task](job.payload);
      self.postMessage({ id: job.id, result }, result instanceof ArrayBuffer ? [result] : []);
    } catch (err) {
      self.postMessage({ id: job.id, error: err.message });
    }
  }
  working = false;
}

self.onmessage = ({ data }) => {
  if (data.task === 'cancel') {
    for (const job of queue) if (job.task === 'synth') self.postMessage({ id: job.id });
    queue = queue.filter((job) => job.task !== 'synth');
    return;
  }
  queue.push(data);
  pump();
};
