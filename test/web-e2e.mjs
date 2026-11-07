// Tests the built website in a real browser, emulating an iPad and served from the
// same sub-path GitHub Pages uses. Run: node test/web-e2e.mjs [webkit|chromium] [shots-dir]

import { chromium, devices, webkit } from 'playwright-core';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'docs');
const base = '/folio-app/';
const engine = process.argv[2] ?? 'webkit';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const temp = mkdtempSync(path.join(tmpdir(), 'folio-web-'));
const books = readdirSync(root).filter((f) => f.endsWith('.epub')).map((f) => path.join(root, f));
assert.ok(books.length, 'Put at least one .epub in the project folder to run this test');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};

const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(site, url.startsWith(base) ? url.slice(base.length) : '__missing__');
  const target = file.endsWith(path.sep) || file === site ? path.join(site, 'index.html') : file;
  try {
    if (!statSync(target).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
    res.end(readFileSync(target));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
const url = `http://127.0.0.1:${server.address().port}${base}`;

const step = (name) => console.log(`  ok  ${name}`);
const browser = await (engine === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome' }));
const device = devices['iPad Pro 11 landscape'];
const context = await browser.newContext({
  ...device, viewport: { width: 1180, height: 820 }, defaultBrowserType: undefined, serviceWorkers: 'allow',
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
});
const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `web-${engine}-${name}.png`) }); };

const info = () => page.evaluate(() => document.getElementById('r-info').textContent);
const pageText = () => page.evaluate(() => [...document.querySelectorAll('.page.on iframe')]
  .map((f) => f.contentDocument?.body.innerText.slice(0, 50)).join(' | '));
const waitMeasured = () => page.waitForFunction(
  () => /Page \d+ of \d+/.test(document.getElementById('r-info').textContent), null, { timeout: 60000, polling: 250 });
const settle = () => page.waitForTimeout(900);

async function addBooks(files) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#add-books').click();
  await (await chooser).setFiles(files);
}

async function openBook(n = 0) {
  await page.locator('.book-item').nth(n).click();
  await page.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 30000 });
  await waitMeasured();
  await settle();
}

async function closeBook() {
  await page.evaluate(() => document.getElementById('r-back').click());
  await page.waitForSelector('#shelf-view:not([hidden])');
  await page.waitForTimeout(300);
}

async function openContents(pick) {
  await page.evaluate(() => document.getElementById('r-contents').click());
  await page.waitForTimeout(350);
  const count = await page.locator('.toc-item').count();
  await page.locator('.toc-item').nth(pick(count)).click();
  await settle();
  await page.evaluate(() => document.getElementById('stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await page.waitForTimeout(350);
}

const renderedSize = () => page.evaluate(() => {
  const sizes = {};
  for (const f of document.querySelectorAll('.page.on iframe')) {
    const d = f.contentDocument;
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.data.trim()) {
        const size = parseFloat(d.defaultView.getComputedStyle(n.parentElement).fontSize);
        sizes[size] = (sizes[size] ?? 0) + n.length;
      }
    }
  }
  return Number(Object.entries(sizes).sort((a, b) => b[1] - a[1])[0][0]);
});

async function hostileBook() {
  const body = `
    <p>An ordinary looking paragraph of a perfectly ordinary looking book.</p>
    <script>top.pwned = 'inline script';</script>
    <script src="evil.js"></script>
    <img src="missing.jpg" onerror="top.pwned = 'onerror'"/>
    <svg xmlns="http://www.w3.org/2000/svg" onload="top.pwned = 'svg onload'"><script>top.pwned = 'svg script'</script></svg>
    <a id="bad" href="javascript:top.pwned='link'">Click me</a>
    <iframe srcdoc="&lt;script&gt;top.pwned='nested frame'&lt;/script&gt;"></iframe>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>AAA Hostile</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>');
  zip.file('c.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body onload="top.pwned='body onload'">${body}</body></html>`);
  zip.file('evil.js', "top.pwned = 'external script';");
  const file = path.join(temp, 'hostile.epub');
  writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));

  await addBooks([file]);
  await page.waitForFunction((n) => document.querySelectorAll('.book-item').length === n, books.length + 1);
  await page.selectOption('#shelf-sort', 'title');
  await page.waitForTimeout(300);
  await page.locator('.book-item').first().click();
  await page.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 30000 });
  await page.waitForTimeout(900);
  assert.ok((await pageText()).includes('ordinary'), 'The book still displays');
  assert.equal(await page.evaluate(() => window.pwned), undefined, 'Sanitized book content ran code');
  step('hostile book displays and runs nothing');

  // Second layer: the raw markup, bypassing the sanitizer entirely.
  await page.evaluate((markup) => new Promise((resolve) => {
    const frame = document.querySelector('.page.on iframe');
    frame.addEventListener('load', resolve, { once: true });
    frame.srcdoc = `<!doctype html><body onload="top.pwned='body onload'">${markup}`;
  }), body);
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.pwned), undefined, 'The content policy let book code run');
  step('content policy alone also stops unsanitized book code');
}

try {
  await page.goto(url);
  await page.waitForSelector('.bookcase');
  await page.waitForFunction(() => document.documentElement.classList.contains('web'));
  await page.waitForTimeout(400);
  await shot('01-empty');
  assert.equal(await page.locator('#add-folder').isVisible(), false, 'No folder picker on the web');
  step(`site loads from ${base}`);

  await addBooks(books);
  await page.waitForFunction((n) => document.querySelectorAll('.book-item').length === n, books.length, { timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.book-face img')].every((i) => i.complete && i.naturalWidth), null, { timeout: 15000 });
  await page.waitForTimeout(600);
  await shot('02-shelf');
  step(`added ${books.length} books, with their covers`);

  await openBook();
  await shot('03-cover');
  const opened = await info();
  const before = await pageText();
  const stage = await page.locator('#book').boundingBox();
  await page.touchscreen.tap(stage.x + stage.width * 0.9, stage.y + stage.height / 2);
  await settle();
  const turned = await pageText();
  assert.notEqual(turned, before, 'Tapping the right side turns the page');
  await page.touchscreen.tap(stage.x + stage.width * 0.1, stage.y + stage.height / 2);
  await settle();
  assert.equal(await pageText(), before, 'Tapping the left side goes back');
  step(`tap to turn works: ${opened}`);

  const touchMode = await page.evaluate(() => matchMedia('(hover: none)').matches);
  if (touchMode) {
    await page.waitForFunction(() => !document.getElementById('reader-view').classList.contains('chrome'), null, { timeout: 8000, polling: 200 });
    await page.touchscreen.tap(stage.x + stage.width * 0.5, stage.y + stage.height * 0.6);
    await page.waitForSelector('#reader-view.chrome', { state: 'attached', timeout: 2000 });
    step('tapping the middle shows the toolbar');
  } else {
    console.log('  --  touch-only checks skipped: this browser build reports a mouse');
  }

  await openContents((n) => Math.floor(n / 2));
  const middle = await info();
  await shot('04-spread');

  if (touchMode && engine === 'chromium') {
    const cdp = await context.newCDPSession(page);
    const y = stage.y + stage.height / 2;
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', stage.x + stage.width * 0.7);
    // Paced like a finger: moves sent all at once get merged and the swipe is lost.
    for (let f = 0.65; f > 0.4; f -= 0.05) {
      await touch('touchMove', stage.x + stage.width * f);
      await page.waitForTimeout(16);
    }
    await touch('touchEnd');
    await settle();
    assert.notEqual(await info(), middle, 'Swiping turns the page');
    step('swiping turns the page');
  }

  const framesFit = await page.evaluate(() => [...document.querySelectorAll('.page.on iframe')].every((f) => {
    const box = f.parentElement.getBoundingClientRect();
    const own = f.getBoundingClientRect();
    return own.width <= box.width + 1 && own.height <= box.height + 1;
  }));
  assert.ok(framesFit, 'Frames stay inside their pages');

  const hasImages = await page.evaluate(() => [...document.querySelectorAll('.page iframe')].some((f) => f.contentDocument?.styleSheets.length > 1));
  assert.ok(hasImages, "The book's own styles load");

  const size = await renderedSize();
  await page.evaluate(() => { for (let i = 0; i < 3; i += 1) document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true })); });
  await page.waitForTimeout(1200);
  assert.equal(await renderedSize(), size + 3, 'Text size changes');
  await page.evaluate(() => { for (let i = 0; i < 3; i += 1) document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })); });
  await page.waitForTimeout(1000);
  step(`text size changes: ${size}px`);

  await page.evaluate(() => {
    const frame = document.querySelector('.page.on iframe');
    const doc = frame.contentDocument;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && node.length < 20) node = walker.nextNode();
    doc.getSelection().setBaseAndExtent(node, 0, node, 18);
  });
  await page.waitForSelector('#sel-pop:not([hidden])', { timeout: 3000 });
  await shot('05-selection');
  await page.locator('.swatch.yellow').click();
  await page.waitForTimeout(200);
  const painted = await page.evaluate(() => [...document.querySelectorAll('.page.on iframe')]
    .some((f) => f.contentWindow.CSS.highlights.get('folio-yellow')?.size > 0));
  assert.ok(painted, 'The highlight is painted');
  step('selecting text brings up highlighting, and it paints');

  const place = (await info()).replace(/ of \d+/, '');
  await settle();
  await page.reload();
  await page.waitForSelector('.book-item', { timeout: 20000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.book-item').count(), books.length, 'Books survive a reload');
  await openBook();
  assert.equal((await info()).replace(/ of \d+/, ''), place, 'Reading position survives a reload');
  step(`books and position survive a reload: ${place}`);
  await closeBook();

  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 }).catch(() => {});
  const offlineReady = await page.evaluate(async () => (await caches.keys()).some((k) => k.startsWith('folio-')));
  if (offlineReady) {
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('.book-item', { timeout: 20000 });
    await openBook();
    await closeBook();
    await context.setOffline(false);
    step('works with no connection');
  } else {
    console.log('  --  offline check skipped: this browser build has no service workers');
  }

  assert.deepEqual(errors, [], 'No errors in the console');
  step('no console errors');

  // Last, because blocking this book's attacks is meant to log errors.
  await hostileBook();
  console.log(`\nAll web checks passed in ${engine}`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  console.error('Console errors:', errors);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
