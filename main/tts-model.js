'use strict';
// Fetches the Kokoro voice model once. Downloads are parallel, resumable and
// checksummed, because a single stream can take many minutes on slow links and
// nobody should restart 326 MB from zero after a dropped connection.
//
// The model variant is deliberate. fp32 is the largest, but smaller ones fail:
// fp16 returned invalid audio for about 1 sentence in 8 of a test sample, which
// played as silence, and q8 is too slow on CPU (1.4x real time against 3x here).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const CONNECTIONS = 8;
const RETRY_DELAY_MS = 1500;
const MAX_FAILURES = 12;

const DTYPE = 'fp32';
const MODEL_FILE = 'onnx/model.onnx';
const MODEL_BYTES = 325532232;
const MODEL_SHA256 = '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb';
const SMALL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];

const urlOf = (file) => `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`;
const modelDir = (root) => path.join(root, REPO);
const sizeOf = (file) => fs.promises.stat(file).then((s) => s.size, () => 0);

async function isInstalled(root) {
  const dir = modelDir(root);
  const sizes = await Promise.all([MODEL_FILE, ...SMALL_FILES].map((f) => sizeOf(path.join(dir, f))));
  return sizes[0] === MODEL_BYTES && sizes.every((s) => s > 0);
}

async function fetchRange(url, start, end, file, onBytes, signal) {
  let failures = 0;
  for (;;) {
    const have = await sizeOf(file);
    if (start + have > end) return;
    try {
      const res = await fetch(url, { headers: { range: `bytes=${start + have}-${end}` }, signal });
      if (res.status !== 206) throw new Error(`Unexpected response ${res.status}`);
      const out = fs.createWriteStream(file, { flags: 'a' });
      try {
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          onBytes(chunk.length);
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      failures = 0;
    } catch (err) {
      if (signal?.aborted) throw err;
      failures += 1;
      if (failures >= MAX_FAILURES) throw new Error(`Download failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

async function fetchModel(target, onProgress, signal) {
  const part = (i) => `${target}.part${i}`;
  const span = Math.ceil(MODEL_BYTES / CONNECTIONS);
  const ranges = Array.from({ length: CONNECTIONS }, (_, i) => [i * span, Math.min(MODEL_BYTES, (i + 1) * span) - 1]);
  let done = 0;
  for (let i = 0; i < CONNECTIONS; i += 1) done += await sizeOf(part(i));
  onProgress(done, MODEL_BYTES);

  await Promise.all(ranges.map(([start, end], i) => fetchRange(urlOf(MODEL_FILE), start, end, part(i), (n) => {
    done += n;
    onProgress(done, MODEL_BYTES);
  }, signal)));

  const hash = crypto.createHash('sha256');
  const tmp = `${target}.tmp`;
  const out = fs.createWriteStream(tmp);
  for (let i = 0; i < CONNECTIONS; i += 1) {
    for await (const chunk of fs.createReadStream(part(i))) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  }
  await new Promise((r) => out.end(r));
  await Promise.all(ranges.map((_, i) => fsp.rm(part(i), { force: true })));
  if (hash.digest('hex') !== MODEL_SHA256) {
    await fsp.rm(tmp, { force: true });
    throw new Error('The downloaded voice model was corrupted. Please try again.');
  }
  await fsp.rename(tmp, target);
}

/** Calls onProgress(bytesDone, bytesTotal). Safe to call again after a failure. */
async function install(root, onProgress, signal) {
  const dir = modelDir(root);
  await fsp.mkdir(path.join(dir, 'onnx'), { recursive: true });
  for (const file of SMALL_FILES) {
    const target = path.join(dir, file);
    if (await sizeOf(target)) continue;
    const res = await fetch(urlOf(file), { signal });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    await fsp.writeFile(target, Buffer.from(await res.arrayBuffer()));
  }
  const model = path.join(dir, MODEL_FILE);
  if ((await sizeOf(model)) !== MODEL_BYTES) await fetchModel(model, onProgress, signal);
}

module.exports = { REPO, DTYPE, install, isInstalled, MODEL_BYTES };
