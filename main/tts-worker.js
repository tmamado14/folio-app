'use strict';
// Runs the neural voice in its own process, so heavy inference can never stall
// the app. Takes one sentence at a time; cancelled work is dropped unstarted.

const { REPO, DTYPE } = require('./tts-model');
const { isSpeech, toWav } = require('./tts-audio');

const port = process.parentPort;
let engine = null;
let queue = [];
let working = false;

function loadEngine() {
  engine ??= (async () => {
    const { env } = await import('@huggingface/transformers');
    env.localModelPath = `${process.env.FOLIO_TTS_ROOT}/`;
    env.allowRemoteModels = false;
    const { KokoroTTS } = await import('kokoro-js');
    return KokoroTTS.from_pretrained(REPO, { dtype: DTYPE, device: 'cpu' });
  })();
  return engine;
}

const tasks = {
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
      port.postMessage({ id: job.id, result: await tasks[job.task](job.payload) });
    } catch (err) {
      port.postMessage({ id: job.id, error: err.message });
    }
  }
  working = false;
}

port.on('message', ({ data }) => {
  if (data.task === 'cancel') {
    for (const job of queue) if (job.task === 'synth') port.postMessage({ id: job.id, cancelled: true });
    queue = queue.filter((job) => job.task !== 'synth');
    return;
  }
  queue.push(data);
  pump();
});
