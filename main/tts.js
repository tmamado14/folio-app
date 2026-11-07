'use strict';
// The main process's side of the voice engine: installs the model and relays
// work to the background process, restarting it if it ever dies.

const { utilityProcess } = require('electron');
const path = require('path');
const model = require('./tts-model');

class Tts {
  constructor(root, onProgress) {
    this.root = root;
    this.onProgress = onProgress;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.download = null;
  }

  async status() {
    return {
      installed: await model.isInstalled(this.root),
      downloading: this.download !== null,
      bytes: model.MODEL_BYTES,
    };
  }

  install() {
    this.download ??= (async () => {
      this.abort = new AbortController();
      try {
        await model.install(this.root, (done, total) => this.onProgress({ done, total }), this.abort.signal);
      } finally {
        this.download = null;
      }
    })();
    return this.download;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = utilityProcess.fork(path.join(__dirname, 'tts-worker.js'), [], {
      serviceName: 'Folio Voice',
      env: { ...process.env, FOLIO_TTS_ROOT: this.root },
    });
    worker.on('message', ({ id, result, error, cancelled }) => {
      const job = this.pending.get(id);
      if (!job) return;
      this.pending.delete(id);
      if (cancelled) job.resolve(null);
      else if (error) job.reject(new Error(error));
      else job.resolve(result);
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null;
      for (const job of this.pending.values()) {
        if (this.disposed) job.resolve(null);
        else job.reject(new Error('The voice engine stopped unexpectedly'));
      }
      this.pending.clear();
    });
    this.worker = worker;
    return worker;
  }

  call(task, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, { resolve, reject });
      this.ensureWorker().postMessage({ id, task, payload });
    });
  }

  voices() {
    return this.call('voices');
  }

  synth(text, voice) {
    return this.call('synth', { text, voice });
  }

  cancel() {
    this.worker?.postMessage({ task: 'cancel' });
  }

  dispose() {
    this.disposed = true;
    this.abort?.abort();
    this.worker?.kill();
  }
}

module.exports = { Tts };
