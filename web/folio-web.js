// The browser's version of window.folio, the interface the app uses for everything
// outside the page. Books stay on this device: they live in IndexedDB and are never
// uploaded anywhere, because the site itself is only code.

import { openEpub } from '../main/epub.js';

const SCRIPT_URL = document.currentScript.src;
const DB_NAME = 'folio';
const LIBRARY_KEY = 'library';
const MODEL_BYTES = 325532232;
const READY_FLAG = 'folio.voice.ready';
const LOADING_FLAG = 'folio.voice.loading';
const DEVICE_KEY = 'folio.voice.device';
const SLOW_KEY = 'folio.voice.slow';
const ISOLATION_RELOAD = 'folio.isolation.reload';
// How long loading may go with no sign of progress before it counts as stuck.
const STALL_LIMIT_MS = 240000;
const VOICE_LIST_WAIT_MS = 1200;
const MAX_OPEN_BOOKS = 2;
const PATCHABLE = new Set(['progress', 'bookmarks', 'highlights', 'collections', 'lastOpened', 'pageCount']);

const MIME = {
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', css: 'text/css', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};
const mimeOf = (name) => MIME[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

// Storage

const database = new Promise((resolve, reject) => {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    for (const store of ['meta', 'files', 'covers']) open.result.createObjectStore(store);
  };
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});

async function request(store, mode, run) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = run(tx.objectStore(store));
    const fail = () => reject(tx.error ?? req?.error ?? new Error('This device could not save your book'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onabort = fail;
    tx.onerror = fail;
  });
}
const read = (store, key) => request(store, 'readonly', (s) => s.get(key));
const write = (store, key, value) => request(store, 'readwrite', (s) => s.put(value, key));
const remove = (store, key) => request(store, 'readwrite', (s) => s.delete(key));

// Library

let data = null;
const coverUrls = new Map();
const openBooks = new Map();

async function loadData() {
  data ??= (await read('meta', LIBRARY_KEY)) ?? { version: 1, books: {}, collections: [], settings: {} };
  return data;
}
const save = () => write('meta', LIBRARY_KEY, data);

async function coverUrl(book) {
  if (!book.cover) return null;
  if (!coverUrls.has(book.id)) {
    const stored = await read('covers', book.id);
    coverUrls.set(book.id, stored ? URL.createObjectURL(new Blob([stored.bytes], { type: stored.type })) : null);
  }
  return coverUrls.get(book.id);
}

async function snapshot() {
  await loadData();
  const books = {};
  for (const book of Object.values(data.books)) books[book.id] = { ...book, coverUrl: await coverUrl(book) };
  return { ...data, books };
}

async function bookId(buffer) {
  const digest = await crypto.subtle.digest('SHA-1', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function importFile(file) {
  await loadData();
  const buffer = await file.arrayBuffer();
  const id = await bookId(buffer);
  if (data.books[id]) return true;

  const book = await openEpub(buffer);
  let cover = null;
  if (book.coverPath) {
    cover = book.coverPath;
    const bytes = await book.zip.file(book.coverPath).async('arraybuffer');
    await write('covers', id, { bytes, type: mimeOf(book.coverPath) });
  }
  // Raw bytes rather than Blobs: Blobs in IndexedDB have been unreliable in Safari.
  await write('files', id, buffer);
  data.books[id] = {
    id, ...book.metadata, cover, fileName: file.name, fileSize: buffer.byteLength,
    addedAt: Date.now(), lastOpened: 0, progress: null, bookmarks: [], highlights: [], collections: [],
  };
  await save();
  return false;
}

async function importFiles(files) {
  const result = { added: 0, duplicates: 0, failed: [] };
  for (const file of files) {
    try {
      if (await importFile(file)) result.duplicates += 1;
      else result.added += 1;
    } catch (err) {
      const reason = err?.name === 'QuotaExceededError' ? 'There is not enough storage left on this device' : err?.message ?? 'This book could not be saved';
      result.failed.push({ file: file.name, reason });
    }
  }
  // Asks the browser not to clear books under storage pressure; it may decline.
  navigator.storage?.persist?.().catch(() => {});
  return result;
}

function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.epub,application/epub+zip';
    input.addEventListener('change', async () => resolve(await importFiles([...input.files])), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

async function getOpenBook(id) {
  if (openBooks.has(id)) return openBooks.get(id);
  await loadData();
  if (!data.books[id]) return null;
  const buffer = await read('files', id);
  if (!buffer) return null;
  const book = openEpub(buffer);
  openBooks.set(id, book);
  if (openBooks.size > MAX_OPEN_BOOKS) openBooks.delete(openBooks.keys().next().value);
  return book;
}

async function readBookFile(id, path) {
  const book = await getOpenBook(id);
  const entry = book && (await book).resolve(path);
  if (!entry) return null;
  const bytes = await (await book).zip.file(entry).async('arraybuffer');
  return new Blob([bytes], { type: mimeOf(entry) });
}

// Voices

let worker = null;
let nextId = 1;
const pending = new Map();
const progressHandlers = [];
let downloading = false;
let watchdog = null;

function failPending(message) {
  for (const job of pending.values()) job.reject(new Error(message));
  pending.clear();
  worker = null;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('voice-worker.js', SCRIPT_URL), { type: 'module' });
  worker.onmessage = ({ data: message }) => {
    if (message.progress) {
      watchdog?.();
      progressHandlers.forEach((fn) => fn(message.progress));
      return;
    }
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error));
    else job.resolve(message.result ?? null);
  };
  worker.onerror = (e) => failPending(e.message || 'The voice engine stopped unexpectedly');
  return worker;
}

function call(task, payload) {
  return new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, task, payload });
  });
}

/** Stops the engine outright. A worker stuck inside the GPU can't be asked nicely. */
function stopWorker(reason) {
  worker?.terminate();
  failPending(reason);
}

const flag = {
  get: (key) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } },
  set: (key, on) => {
    try {
      if (on) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch { /* These flags are only conveniences. */ }
  },
};

async function systemVoices() {
  const synth = window.speechSynthesis;
  if (!synth) return [];
  let list = synth.getVoices();
  if (!list.length) {
    await new Promise((resolve) => {
      synth.addEventListener('voiceschanged', resolve, { once: true });
      setTimeout(resolve, VOICE_LIST_WAIT_MS);
    });
    list = synth.getVoices();
  }
  return list.filter((v) => /^en[-_]/i.test(v.lang)).map((v) => ({
    id: `system:${v.voiceURI}`, name: v.name.replace(/\s*\(.*\)$/, ''), language: 'system', meta: v.lang.replace('_', '-'),
  }));
}

const stored = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* Only a convenience. */ } },
};

// Reported on Apple devices: Kokoro's GPU path exhausts Safari's per-page memory
// limit, so the page hangs or reloads right after the download finishes, while the
// same model loads with the GPU path off. Chrome here can't reproduce this.
const isSafariEngine = () => /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);

async function chooseDevice() {
  const saved = stored.get(DEVICE_KEY);
  if (saved) return saved;
  if (isSafariEngine()) return 'wasm';
  return (await navigator.gpu?.requestAdapter().catch(() => null)) ? 'webgpu' : 'wasm';
}

function loadOn(device) {
  return new Promise((resolve, reject) => {
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stopWorker('The natural voice took too long to start on this device'), STALL_LIMIT_MS);
    };
    watchdog = arm;
    arm();
    call('load', { device }).then(resolve, reject).finally(() => {
      clearTimeout(timer);
      watchdog = null;
    });
  });
}

/** Loads the model, recording the attempt: a tab killed for memory can't report it. */
async function loadEngine() {
  const device = await chooseDevice();
  flag.set(LOADING_FLAG, true);
  try {
    await loadOn(device);
    flag.set(READY_FLAG, true);
    // One core managed under half of real time in testing; four managed about 1.7x.
    stored.set(SLOW_KEY, device === 'wasm' && !crossOriginIsolated ? '1' : '');
  } catch (err) {
    if (device === 'webgpu') {
      stored.set(DEVICE_KEY, 'wasm');
      return loadEngine();
    }
    flag.set(READY_FLAG, false);
    throw err;
  } finally {
    flag.set(LOADING_FLAG, false);
  }
}

window.folio = {
  platform: 'web',
  library: {
    get: snapshot,
    importPaths: importFiles,
    pickFiles,
    pickFolder: async () => null,
    remove: async (id) => {
      await loadData();
      delete data.books[id];
      openBooks.delete(id);
      await Promise.all([remove('files', id), remove('covers', id)]);
      await save();
    },
    patchBook: async (id, patch) => {
      await loadData();
      const book = data.books[id];
      if (!book) return;
      for (const [key, value] of Object.entries(patch)) if (PATCHABLE.has(key)) book[key] = value;
      await save();
    },
    setCollections: async (collections) => {
      await loadData();
      data.collections = collections;
      const known = new Set(collections.map((c) => c.id));
      for (const book of Object.values(data.books)) book.collections = book.collections.filter((c) => known.has(c));
      await save();
    },
    onChanged: () => {},
  },
  settings: {
    patch: async (patch) => {
      await loadData();
      data.settings = { ...data.settings, ...patch };
      await save();
    },
  },
  book: {
    manifest: async (id) => (await (await getOpenBook(id)))?.manifest ?? null,
    read: readBookFile,
  },
  tts: {
    status: async () => ({
      installed: flag.get(READY_FLAG),
      downloading,
      bytes: MODEL_BYTES,
      crashed: flag.get(LOADING_FLAG),
      systemVoices: (await systemVoices()).length > 0,
      slow: Boolean(stored.get(SLOW_KEY)),
    }),
    install: async () => {
      downloading = true;
      try {
        await loadEngine();
      } finally {
        downloading = false;
      }
    },
    voices: async () => {
      const local = await systemVoices();
      if (!flag.get(READY_FLAG)) return local;
      await loadEngine();
      return [...(await call('voices')), ...local];
    },
    synth: (text, voice) => call('synth', { text, voice }),
    cancel: async () => { worker?.postMessage({ task: 'cancel' }); },
    stop: async () => {
      stopWorker('stopped');
      flag.set(LOADING_FLAG, false);
    },
    onProgress: (fn) => progressHandlers.push(fn),
  },
  pathForFile: (file) => file,
  openExternal: async (url) => { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener'); },
  window: {
    setChrome: async () => {},
    toggleFullscreen: async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen?.();
    },
  },
};

document.documentElement.classList.add('web');
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('../sw.js', SCRIPT_URL)).catch((err) => console.warn('Offline support unavailable', err));
  // The multi-core headers only apply to pages the service worker served, so the
  // first ever visit reloads itself once when the worker takes over.
  navigator.serviceWorker.ready.then(() => {
    const tried = sessionStorage.getItem(ISOLATION_RELOAD);
    if (crossOriginIsolated || tried) return;
    sessionStorage.setItem(ISOLATION_RELOAD, '1');
    if (navigator.serviceWorker.controller) location.reload();
    else navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  });
}
