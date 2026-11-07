'use strict';
// Builds dist\Folio-win32-x64\Folio.exe.

const { packager } = require('@electron/packager');
const path = require('path');

const ENGLISH_VOICE = /^[ab][fm]_/;

const IGNORE = [
  /\.epub$/i,
  /^\/(test|dist|scripts)($|\/)/,
  /^\/README\.md$/,
  // The voice engine runs natively on Windows; other platforms and the browser
  // build would add about 250 MB that nothing here loads.
  /\/onnxruntime-web($|\/)/,
  /\/onnxruntime-node\/bin\/napi-v\d+\/(darwin|linux)($|\/)/,
  /\/@huggingface\/transformers\/dist\/.*\.wasm$/,
];

function ignore(file) {
  const voice = file.match(/\/kokoro-js\/voices\/([^/]+)$/);
  if (voice) return !ENGLISH_VOICE.test(voice[1]);
  return IGNORE.some((pattern) => pattern.test(file));
}

(async () => {
  const [out] = await packager({
    dir: path.join(__dirname, '..'),
    name: 'Folio',
    platform: 'win32',
    arch: 'x64',
    out: path.join(__dirname, '..', 'dist'),
    overwrite: true,
    prune: true,
    ignore,
    // Native libraries can't be loaded from inside an archive.
    asar: { unpack: '**/*.{node,dll}' },
  });
  console.log(`Built ${out}`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
