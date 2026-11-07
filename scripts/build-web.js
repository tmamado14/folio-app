'use strict';
// Builds the website into docs/, ready for GitHub Pages or any static host.
// docs/ is committed on purpose, so hosting needs no build step.

const crypto = require('crypto');
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const ORT = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

// Only 'self' may run: books have no URL on this site (their files become blob:
// URLs), so nothing inside a book can load as a script, inline or otherwise.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' blob: data: https://huggingface.co https://*.huggingface.co https://*.hf.co",
  "frame-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
].join('; ');

const HEAD = `
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <meta name="theme-color" content="#1c1410">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Folio">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="apple-touch-icon" href="icons/icon-180.png">
  <link rel="stylesheet" href="css/web.css">
  <script src="js/folio-web.js"></script>`;

const MANIFEST = {
  name: 'Folio',
  short_name: 'Folio',
  description: 'Your bookshelf, with turnable pages and read-aloud.',
  start_url: '.',
  scope: '.',
  display: 'standalone',
  background_color: '#1c1410',
  theme_color: '#1c1410',
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

async function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'src'), OUT, { recursive: true });
  fs.cpSync(path.join(ROOT, 'web', 'icons'), path.join(OUT, 'icons'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'web', 'web.css'), path.join(OUT, 'css', 'web.css'));
  // Without this, GitHub Pages runs Jekyll, which drops files it doesn't recognise.
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'web', 'folio-web.js')],
    outfile: path.join(OUT, 'js', 'folio-web.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'safari16',
    minify: true,
    alias: { path: 'path-browserify' },
    define: { global: 'globalThis' },
  });
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'web', 'voice-worker.js')],
    outfile: path.join(OUT, 'js', 'voice-worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    // Node-only imports inside the voice library; never reached in a browser.
    external: ['fs', 'path', 'url', 'sharp', 'onnxruntime-node', 'fs/promises'],
    define: { global: 'globalThis' },
  });

  fs.mkdirSync(path.join(OUT, 'vendor', 'ort'), { recursive: true });
  for (const file of ORT_FILES) fs.copyFileSync(path.join(ORT, file), path.join(OUT, 'vendor', 'ort', file));

  const indexPath = path.join(OUT, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  fs.writeFileSync(indexPath, html.replace('<meta charset="utf-8">', `<meta charset="utf-8">${HEAD}`));
  fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify(MANIFEST, null, 2));

  const files = walk(OUT)
    .map((f) => path.relative(OUT, f).split(path.sep).join('/'))
    .filter((f) => !f.startsWith('vendor/') && f !== '.nojekyll');
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(fs.readFileSync(path.join(OUT, f)));
  const worker = fs.readFileSync(path.join(ROOT, 'web', 'sw.js'), 'utf8')
    .replace('__VERSION__', hash.digest('hex').slice(0, 12))
    .replace('__FILES__', JSON.stringify(['./', ...files]));
  fs.writeFileSync(path.join(OUT, 'sw.js'), worker);

  const bytes = walk(OUT).reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`Built docs/: ${walk(OUT).length} files, ${(bytes / 1e6).toFixed(1)} MB`);
}

build().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
