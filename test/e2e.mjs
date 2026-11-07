// Drives the real app against real books. Run with: node test/e2e.mjs [screenshot-dir]
// Sets FOLIO_DATA so your own library is never touched.

import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const data = mkdtempSync(path.join(tmpdir(), 'folio-'));
const books = readdirSync(root).filter((f) => f.endsWith('.epub')).map((f) => path.join(root, f));
assert.ok(books.length, 'Put at least one .epub in the project folder to run this test');

const launchFresh = (args, extraEnv = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'folio-check-'));
  const started = electron.launch({ args: ['.', ...args], cwd: root, env: { ...process.env, FOLIO_DATA: dir, ...extraEnv } });
  return { started, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const openBookAt = async (page, title) => {
  await page.locator('.book-item', { hasText: title }).first().click().catch(() => page.locator('.book-item').first().click());
  await page.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 20000 });
  await waitMeasured(page);
  await settle(page);
};

const openContentsEntry = async (page, pick) => {
  await page.keyboard.press('c');
  await page.waitForTimeout(250);
  const count = await page.locator('.toc-item').count();
  await page.locator('.toc-item').nth(pick(count)).click();
  await settle(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
};

/** The size most of the visible text is really rendered at. */
const renderedSize = (page) => page.evaluate(() => {
  const sizes = {};
  for (const f of document.querySelectorAll('.page.on iframe')) {
    const d = f.contentDocument;
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.data.trim()) {
        const size = parseFloat(getComputedStyle(n.parentElement).fontSize);
        sizes[size] = (sizes[size] ?? 0) + n.length;
      }
    }
  }
  return Number(Object.entries(sizes).sort((a, b) => b[1] - a[1])[0][0]);
});

/** Publishers pin sizes in different ways, so check every book, not just one. */
async function textSizeCheck() {
  const { started, cleanup } = launchFresh(books);
  const checkApp = await started;
  try {
    const page = await checkApp.firstWindow();
    await page.waitForFunction((n) => document.querySelectorAll('.book-item').length === n, books.length, { timeout: 30000 });
    await page.waitForTimeout(400);
    for (let i = 0; i < books.length; i += 1) {
      const name = await page.locator('.label-title').nth(i).textContent();
      await page.locator('.book-item').nth(i).click();
      await page.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 20000 });
      await waitMeasured(page);
      await openContentsEntry(page, (n) => Math.floor(n / 2));
      const before = await renderedSize(page);
      for (let k = 0; k < 4; k += 1) await page.keyboard.press('=');
      await page.waitForTimeout(1200);
      const after = await renderedSize(page);
      assert.ok(after >= before + 3, `${name}: text went from ${before}px to ${after}px after four steps up`);
      for (let k = 0; k < 4; k += 1) await page.keyboard.press('-');
      await page.waitForTimeout(900);
      assert.equal(await renderedSize(page), before, `${name}: stepping back restores the size`);
      step(`text size changes in ${name}: ${before}px to ${after}px`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('#shelf-view:not([hidden])');
      await page.waitForTimeout(300);
    }
  } finally {
    await checkApp.close().catch(() => {});
    cleanup();
  }
}

async function sentenceCheck() {
  const { started, cleanup } = launchFresh([]);
  const checkApp = await started;
  try {
    const page = await checkApp.firstWindow();
    await page.waitForSelector('.bookcase');
    const result = await page.evaluate(async () => {
      const { splitSentences } = await import('app://local/js/sentences.js');
      const long = `${'This clause goes on and on, '.repeat(30)}and finally ends.`;
      const html = `<!doctype html><html><head><style>p{color:red}</style></head><body>
        <h1>CHAPTER 30</h1><p>Dr. Brooks waited. Mr. Busoni said, “Hurry!” Then he ran.</p>
        <p>* * *</p><p>${long}</p></body></html>`;
      const body = new DOMParser().parseFromString(html, 'text/html').body.textContent;
      const s = splitSentences(html);
      return {
        texts: s.map((x) => x.text),
        slices: s.map((x) => body.slice(x.start, x.end).trim()),
        longest: Math.max(...s.map((x) => x.text.length)),
        blocks: s.map((x) => x.block),
      };
    });
    assert.equal(result.texts[0], 'Chapter 30', 'Headings stand alone, in normal case');
    assert.equal(result.texts[1], 'Dr. Brooks waited.', 'An abbreviation does not end a sentence');
    assert.equal(result.slices[1], 'Dr. Brooks waited.', 'Offsets point at the same text on the page');
    assert.ok(result.texts[2].startsWith('Mr. Busoni said'), result.texts[2]);
    assert.ok(!result.texts.some((t) => t.includes('* *')), 'Decorative breaks are not read out');
    assert.ok(result.longest <= 380, `Long sentences are split; longest was ${result.longest}`);
    step('sentences split cleanly and map back to the page');
  } finally {
    await checkApp.close().catch(() => {});
    cleanup();
  }
}

const voiceRoot = process.env.FOLIO_TTS_ROOT
  ?? path.join(process.env.APPDATA ?? '', 'Folio', 'voices');

/** Reads the sentence highlighted for narration, in order of the visible pages. */
const narrated = (page) => page.evaluate(() => {
  for (const f of document.querySelectorAll('.page.on iframe')) {
    for (const range of f.contentWindow.CSS.highlights.get('folio-tts') ?? []) return range.toString();
  }
  return null;
});
const untilNarrationChanges = async (page, from, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const now = await narrated(page);
    if (now && now !== from) return now;
    await page.waitForTimeout(150);
  }
  throw new Error(`Narration stayed on: ${from}`);
};

/** Selects the last line of the right-hand page and starts listening there. */
async function listenFromPageEnd(page) {
  const box = await page.locator('.page.on iframe').last().boundingBox();
  const y = box.y + box.height - 16;
  await page.mouse.move(box.x + 30, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, y, { steps: 5 });
  await page.mouse.up();
  await page.locator('#sel-pop .pop-btn', { hasText: 'Listen' }).click();
}

async function readAloudCheck() {
  if (!existsSync(path.join(voiceRoot, 'onnx-community'))) {
    console.log('  --  read-aloud checks skipped: the voice model is not installed');
    return;
  }
  const { started, cleanup } = launchFresh([books[0]], { FOLIO_TTS_ROOT: voiceRoot });
  const checkApp = await started;
  try {
    const page = await checkApp.firstWindow();
    await page.waitForSelector('.book-item', { timeout: 20000 });
    await page.waitForTimeout(400);
    await page.locator('.book-item').first().click();
    await page.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 20000 });
    await waitMeasured(page);
    await openContentsEntry(page, (n) => Math.floor(n / 2));

    // A silent clip still plays and ends, so only the samples themselves can prove
    // speech. Spread across the book, since failures depended on the sentence.
    const audio = await page.evaluate(async (count) => {
      const { Book } = await import('app://local/js/book.js');
      const { books: all } = await window.folio.library.get();
      const book = await Book.open(Object.values(all)[0]);
      const chosen = [];
      const step = Math.max(1, Math.floor(book.spine.length / count));
      for (let i = 0; i < book.spine.length && chosen.length < count; i += step) {
        const list = await book.sentences(i);
        const pick = list[Math.floor(list.length / 2)];
        if (pick?.text.split(' ').length >= 5) chosen.push(pick.text);
      }
      const failures = [];
      for (const text of chosen) {
        try {
          const wav = await window.folio.tts.synth(text, 'af_heart');
          const peak = new Int16Array(wav, 44).reduce((max, v) => Math.max(max, Math.abs(v)), 0) / 0x7fff;
          if (peak < 0.02) failures.push(`silent: ${text}`);
        } catch (err) {
          failures.push(`${err.message}: ${text}`);
        }
      }
      return { checked: chosen.length, failures };
    }, 30);
    assert.deepEqual(audio.failures, [], 'Every sampled sentence produces real audio');
    assert.ok(audio.checked >= 15, `Enough sentences were checked: ${audio.checked}`);
    step(`${audio.checked} sentences across the book all produce real audio`);

    await page.keyboard.press('p');
    await page.waitForSelector('#p-play', { timeout: 60000 });
    await untilNarrationChanges(page, null);
    const first = await narrated(page);
    const second = await untilNarrationChanges(page, first);
    step(`reads aloud and moves on: "${first.slice(0, 32)}" then "${second.slice(0, 32)}"`);

    await page.locator('#p-play').click();
    await page.waitForTimeout(300);
    const paused = await narrated(page);
    await page.waitForTimeout(4000);
    assert.equal(await narrated(page), paused, 'Pause really stops');
    await page.locator('#p-play').click();
    await untilNarrationChanges(page, paused);
    step('pause holds and play carries on');

    await page.locator('#player select').first().selectOption('2');
    assert.equal(await page.evaluate(() => JSON.stringify(document.querySelector('#player select').value)), '"2"');
    await page.locator('#p-voice').click();
    assert.equal(await page.locator('.voice-row').count(), 28, 'All 28 voices are offered');
    await page.locator('.voice-row', { hasText: 'George' }).locator('.voice-choose').click();
    assert.equal(await page.locator('#p-voice').textContent(), 'George');
    await untilNarrationChanges(page, await narrated(page));
    step('voice and speed change while playing');

    const pageBefore = await page.evaluate(() => document.getElementById('r-info').textContent);
    await listenFromPageEnd(page);
    await page.waitForFunction((was) => document.getElementById('r-info').textContent !== was, pageBefore, { timeout: 40000 });
    step('the page turns by itself as the voice reaches the end');

    await page.keyboard.press('ArrowRight');
    await settle(page);
    assert.ok(await page.locator('#p-follow').isVisible(), 'Paging away offers a way back');
    const away = await page.evaluate(() => document.getElementById('r-info').textContent);
    await page.waitForTimeout(3500);
    assert.equal(await page.evaluate(() => document.getElementById('r-info').textContent), away, 'The voice does not drag you back');
    await page.locator('#p-follow').click();
    await page.waitForFunction((was) => document.getElementById('r-info').textContent !== was, away, { timeout: 15000 });
    step('paging away keeps your page until you choose Find my place');

    const chapter = () => page.evaluate(() => document.getElementById('r-info').textContent.split(' · ')[0]);
    await page.locator('#p-play').click();
    await openContentsEntry(page, (n) => Math.floor(n / 2) + 4);
    const nextChapter = await chapter();
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    await listenFromPageEnd(page);
    await page.waitForFunction(async (name) => document.getElementById('r-info').textContent.startsWith(name), nextChapter, { timeout: 40000 });
    step(`reading crosses into the next chapter: ${nextChapter}`);

    await page.waitForTimeout(1200);
    const info = () => page.evaluate(() => document.getElementById('r-info').textContent);
    const window_ = (method) => checkApp.evaluate(({ BrowserWindow }, m) => BrowserWindow.getAllWindows()[0][m](), method);
    const beforeMinimize = await info();
    await listenFromPageEnd(page);
    await window_('minimize');
    await page.waitForTimeout(400);
    assert.ok(await window_('isMinimized'), 'The window is minimized');
    const heard = await narrated(page);
    await untilNarrationChanges(page, heard);
    const deadline = Date.now() + 40000;
    while ((await info()) === beforeMinimize && Date.now() < deadline) await page.waitForTimeout(300);
    assert.notEqual(await info(), beforeMinimize, 'Pages still turn while minimized');
    await window_('restore');
    await page.waitForTimeout(800);
    await page.keyboard.press('ArrowRight');
    await settle(page);
    step('keeps reading and turning pages while the window is minimized');

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#shelf-view:not([hidden])', { timeout: 5000 });
    await page.locator('.book-item').first().click();
    await page.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 20000 });
    assert.ok(await page.locator('#player').isHidden(), 'Closing a book stops the voice');
    step('closing the book stops the voice');
  } finally {
    await checkApp.close().catch(() => {});
    cleanup();
  }
}

const HOSTILE_BODY = `
  <p>An ordinary looking paragraph of a perfectly ordinary looking book.</p>
  <script>top.pwned = 'inline script';</script>
  <script src="evil.js"></script>
  <img src="missing.jpg" onerror="top.pwned = 'onerror'"/>
  <svg xmlns="http://www.w3.org/2000/svg" onload="top.pwned = 'svg onload'"><script>top.pwned = 'svg script'</script></svg>
  <a id="bad" href="javascript:top.pwned='link'">Click me</a>
  <iframe srcdoc="&lt;script&gt;top.pwned='nested frame'&lt;/script&gt;"></iframe>`;

/** A book that tries everything to run code. Nothing in it may execute. */
async function hostileBookCheck() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('book.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Hostile</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`);
  zip.file('c.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body onload="top.pwned='body onload'">${HOSTILE_BODY}</body></html>`);
  zip.file('evil.js', `top.pwned = 'external script';`);
  const hostile = path.join(data, 'hostile.epub');
  writeFileSync(hostile, await zip.generateAsync({ type: 'nodebuffer' }));

  const hostileData = mkdtempSync(path.join(tmpdir(), 'folio-hostile-'));
  const evilApp = await electron.launch({ args: ['.', hostile], cwd: root, env: { ...process.env, FOLIO_DATA: hostileData } });
  try {
    const page = await evilApp.firstWindow();
    await page.waitForSelector('.book-item', { timeout: 20000 });
    await page.waitForTimeout(400);
    await page.locator('.book-item').first().click();
    await page.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 20000 });
    await page.waitForTimeout(800);
    assert.ok((await pos(page)).text.includes('ordinary'), 'The book still displays');
    assert.equal(await page.evaluate(() => window.pwned), undefined, 'Sanitized book content ran code');
    step('hostile book displays and runs nothing');

    // Second layer: load the raw hostile markup, bypassing the sanitizer entirely.
    const id = await page.evaluate(async () => Object.keys((await window.folio.library.get()).books)[0]);
    await page.evaluate(([body, bookId]) => new Promise((resolve) => {
      const frame = document.querySelector('.page.on iframe');
      frame.addEventListener('load', resolve, { once: true });
      frame.srcdoc = `<!doctype html><base href="app://local/book/${bookId}/c.xhtml"><body onload="top.pwned='body onload'">${body}`;
    }), [HOSTILE_BODY, id]);
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => window.pwned), undefined, 'The content policy let book code run');
    step('content policy alone also stops unsanitized book code');
  } finally {
    await evilApp.close().catch(() => {});
    rmSync(hostileData, { recursive: true, force: true });
  }
}

const launch = () => electron.launch({
  args: ['.', ...books],
  cwd: root,
  env: { ...process.env, FOLIO_DATA: data },
});

const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Some books reference images they don't contain; that's the book's flaw, not ours.
    if (m.type() === 'error' && !m.location().url.includes('/book/')) errors.push(`console: ${m.text()}`);
  });
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const step = (name) => console.log(`  ok  ${name}`);

const pos = (page) => page.evaluate(() => {
  const info = document.getElementById('r-info').textContent;
  const frames = [...document.querySelectorAll('.page.on iframe')];
  const text = frames.map((f) => f.contentDocument?.body.innerText.slice(0, 40)).join(' | ');
  return { info, frames: frames.length, text };
});

const waitMeasured = (page) => page.waitForFunction(
  () => /Page \d+ of \d+/.test(document.getElementById('r-info').textContent), null, { timeout: 60000 });
const settle = (page) => page.waitForTimeout(900);

let app = await launch();
try {
  const page = await app.firstWindow();
  watch(page);
  await page.waitForSelector('.book-item', { timeout: 20000 });
  await page.waitForFunction((n) => document.querySelectorAll('.book-item').length === n, books.length);
  await page.waitForTimeout(700);
  await shot(page, '01-shelf');
  step(`shelf shows ${books.length} books`);

  await page.locator('.book-item').first().click();
  await page.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 20000 });
  await page.waitForSelector('.page.on iframe');
  await waitMeasured(page);
  await settle(page);
  await shot(page, '02-cover');
  const start = await pos(page);
  step(`opened book: ${start.info}`);

  for (let i = 0; i < 6; i += 1) { await page.keyboard.press('ArrowRight'); await settle(page); }
  const after = await pos(page);
  assert.notEqual(after.info, start.info);
  await shot(page, '03-spread');
  step(`arrow keys turn pages: ${after.info}`);

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  await shot(page, '04-mid-flip');
  await settle(page);

  await page.keyboard.press('ArrowLeft');
  await settle(page);
  const back = await pos(page);
  assert.equal(back.text, after.text, 'Turning forward then back returns to the same page');
  step('turning back restores the same page');

  const box = await page.locator('#zone-next').boundingBox();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 260, box.y + box.height / 2, { steps: 8 });
  await page.waitForTimeout(150);
  await shot(page, '05-drag');
  await page.mouse.move(box.x - 500, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await settle(page);
  const dragged = await pos(page);
  assert.notEqual(dragged.text, back.text);
  step('dragging the page edge turns the page');

  await page.mouse.move(600, 10);
  await page.waitForTimeout(350);
  await page.locator('#r-contents').click();
  await page.waitForTimeout(400);
  await shot(page, '08-contents');
  const tocCount = await page.locator('.toc-item').count();
  assert.ok(tocCount > 1, 'The table of contents has entries');
  await page.locator('.toc-item').nth(Math.floor(tocCount / 2)).click();
  await settle(page);
  await page.keyboard.press('Escape');
  await settle(page);
  step(`contents lists ${tocCount} entries and jumps`);

  const frame = page.locator('.page.on iframe').first();
  const fb = await frame.boundingBox();
  await page.mouse.move(fb.x + 40, fb.y + 120);
  await page.mouse.down();
  await page.mouse.move(fb.x + 260, fb.y + 150, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('#sel-pop:not([hidden])', { timeout: 3000 });
  await shot(page, '06-selection');
  await page.locator('.swatch.yellow').click();
  await page.waitForTimeout(150);
  const painted = await page.evaluate(() => [...document.querySelectorAll('.page.on iframe')]
    .some((f) => f.contentWindow.CSS.highlights.get('folio-yellow')?.size > 0));
  assert.ok(painted, 'The highlight is painted on the page');
  await shot(page, '07-highlight');
  step('selecting text and highlighting works');

  await page.keyboard.press('b');
  await page.waitForTimeout(200);
  assert.ok(await page.locator('.page.on .page-ribbon.on').count(), 'A bookmark ribbon appears');
  step('bookmark ribbon appears');

  await page.keyboard.press('Control+f');
  await page.waitForTimeout(200);
  await page.keyboard.type('the');
  await page.waitForFunction(() => /\d+\+? match/.test(document.querySelector('.drawer-count')?.textContent ?? ''), null, { timeout: 30000 });
  await shot(page, '09-search');
  await page.locator('.search-item').nth(40).click();
  await settle(page);
  await page.keyboard.press('Escape');
  step('search finds matches');

  await page.mouse.move(600, 10);
  await page.waitForTimeout(300);
  await page.locator('#r-type').click();
  await page.waitForTimeout(250);
  await shot(page, '10-settings');
  await page.locator('.theme', { hasText: 'Night' }).click();
  await page.waitForTimeout(200);
  const aimText = (await pos(page)).text;
  await page.locator('.stepper button').last().click();
  await page.locator('.stepper button').last().click();
  await settle(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await shot(page, '11-night');
  step(`reflow after font change keeps place: "${aimText.slice(0, 30)}" -> "${(await pos(page)).text.slice(0, 30)}"`);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 900));
  await page.waitForTimeout(1200);
  const single = await pos(page);
  assert.equal(single.frames, 1, 'A narrow window shows one page');
  await shot(page, '12-single');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(280);
  await shot(page, '13-single-flip');
  await settle(page);
  step('narrow window switches to a single page');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 880));
  await page.waitForTimeout(1200);
  await waitMeasured(page);
  await settle(page);

  const beforeClose = await pos(page);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#shelf-view:not([hidden])');
  await page.waitForTimeout(1000);
  await shot(page, '14-shelf-progress');
  step('closing the book returns to the shelf');

  await app.close();
  app = await launch();
  const again = await app.firstWindow();
  watch(again);
  await again.waitForSelector('.book-item', { timeout: 20000 });
  await again.waitForTimeout(500);
  await again.locator('.book-item').first().click();
  await again.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 20000 });
  await waitMeasured(again);
  await settle(again);
  const resumed = await pos(again);
  const place = (info) => info.replace(/ of \d+/, '');
  assert.equal(place(resumed.info), place(beforeClose.info), 'The book reopens where it was left');
  step(`reopens where you left off: ${resumed.info}`);

  // Close the window immediately after a turn, before any delayed save could run.
  await again.keyboard.press('ArrowRight');
  await settle(again);
  await again.keyboard.press('ArrowRight');
  await again.waitForTimeout(720);
  const lastPlace = await pos(again);
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  assert.ok(!existsSync(path.join(data, 'library', 'library.json.tmp')), 'The final save finished before exit');

  app = await launch();
  const third = await app.firstWindow();
  watch(third);
  await third.waitForSelector('.book-item', { timeout: 20000 });
  await third.waitForTimeout(500);
  await third.locator('.book-item').first().click();
  await third.waitForSelector('#reader-view:not([hidden]):not(.entering)', { timeout: 20000 });
  await waitMeasured(third);
  await settle(third);
  assert.equal(place((await pos(third)).info), place(lastPlace.info), 'Closing the app keeps your place');
  step(`closing the app straight after a turn keeps your place: ${lastPlace.info}`);

  assert.deepEqual(errors, [], 'No errors in the console');
  step('no console errors');

  await app.close();
  await hostileBookCheck();
  await textSizeCheck();
  await sentenceCheck();
  await readAloudCheck();
  console.log('\nAll checks passed');
} catch (err) {
  console.error('\nFAILED:', err.message);
  console.error('Console errors:', errors);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  rmSync(data, { recursive: true, force: true });
}
