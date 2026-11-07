'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require('electron');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const path = require('path');
const { Library } = require('./library');
const { Tts } = require('./tts');

app.setName('Folio');
if (process.env.FOLIO_DATA) app.setPath('userData', path.resolve(process.env.FOLIO_DATA));

const SRC = path.join(__dirname, '..', 'src');
const ORIGIN = 'app://local';

const MIME = {
  '.html': 'text/html', '.htm': 'application/xhtml+xml', '.xhtml': 'application/xhtml+xml',
  '.xml': 'application/xml', '.ncx': 'application/xml', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

// Page frames must allow scripts, or Chromium drops the app's own event listeners
// on them. They inherit this policy, which is what keeps books inert: only files
// under /js/ may run, so nothing inside a book can, inline or otherwise. It also
// keeps book content fully offline.
const CSP = [
  "default-src 'none'", `script-src ${ORIGIN}/js/`, "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' blob:",
  "connect-src 'self'", "frame-src 'self'", "base-uri 'self'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
let library = null;
let tts = null;

const notFound = () => new Response('Not found', { status: 404 });

async function handleRequest(request) {
  const url = new URL(request.url);
  if (url.host !== 'local') return notFound();
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/book/')) {
      const [, , id, ...rest] = pathname.split('/');
      const entry = rest.join('/');
      const bytes = await library.readBookFile(id, entry);
      if (!bytes) return notFound();
      return new Response(bytes, { headers: { 'content-type': mimeOf(entry) } });
    }
    if (pathname.startsWith('/cover/')) {
      const file = path.basename(pathname);
      const bytes = await fs.readFile(path.join(library.coversDir, file));
      return new Response(bytes, { headers: { 'content-type': mimeOf(file) } });
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(SRC, relative));
    if (!file.startsWith(SRC + path.sep)) return notFound();
    const bytes = await fs.readFile(file);
    const headers = { 'content-type': mimeOf(file) };
    if (file.endsWith('.html')) headers['content-security-policy'] = CSP;
    return new Response(bytes, { headers });
  } catch (err) {
    if (err.code === 'ENOENT') return notFound();
    console.error('Request failed:', request.url, err);
    return new Response('Server error', { status: 500 });
  }
}

function createWindow() {
  const { windowBounds, windowMaximized } = library.snapshot().settings;
  win = new BrowserWindow({
    ...(windowBounds ?? { width: 1320, height: 880 }),
    useContentSize: true,
    minWidth: 640,
    minHeight: 520,
    show: false,
    backgroundColor: '#1c1410',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e9dcc7', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Reading aloud must carry on while the window is minimized.
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);

  // The window only ever shows the app itself; links in books open externally.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const rememberBounds = () => {
    if (win.isMaximized() || win.isFullScreen()) return;
    const { x, y } = win.getBounds();
    const [width, height] = win.getContentSize();
    library.patchSettings({ windowBounds: { x, y, width, height } });
  };
  // Windows nudges a restored window by a few pixels under fractional display
  // scaling. 'resized' and 'moved' fire only for real user changes; saving on
  // 'resize' would store each nudge, growing the window on every launch.
  win.on('resized', rememberBounds);
  win.on('moved', rememberBounds);
  win.on('maximize', () => library.patchSettings({ windowMaximized: true }));
  win.on('unmaximize', () => library.patchSettings({ windowMaximized: false }));
  win.once('ready-to-show', () => {
    if (windowMaximized) win.maximize();
    win.show();
  });
  win.on('closed', () => { win = null; });

  win.loadURL(`${ORIGIN}/index.html`);
}

async function importAndAnnounce(files) {
  const result = await library.importFiles(files);
  win?.webContents.send('library:changed', result);
  return result;
}

const epubArgs = (argv) =>
  argv.filter((a) => /\.epub$/i.test(a) && existsSync(a)).map((a) => path.resolve(a));

function registerIpc() {
  const handlers = {
    'library:get': () => library.snapshot(),
    'library:import': (paths) => library.importFiles(paths),
    'library:pickFiles': async () => {
      const r = await dialog.showOpenDialog(win, {
        title: 'Add books',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'EPUB books', extensions: ['epub'] }],
      });
      return r.canceled ? null : library.importFiles(r.filePaths);
    },
    'library:pickFolder': async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Add a folder of books', properties: ['openDirectory'] });
      return r.canceled ? null : library.importFiles(await library.findEpubs(r.filePaths[0]));
    },
    'library:remove': (id) => library.remove(id),
    'library:patchBook': (id, patch) => library.patchBook(id, patch),
    'library:setCollections': (list) => library.setCollections(list),
    'settings:patch': (patch) => library.patchSettings(patch),
    'tts:status': () => tts.status(),
    'tts:install': () => tts.install(),
    'tts:voices': () => tts.voices(),
    'tts:synth': (text, voice) => tts.synth(text, voice),
    'tts:cancel': () => tts.cancel(),
    'book:manifest': async (id) => (await library.getOpenBook(id))?.manifest ?? null,
    'shell:openExternal': (url) => {
      if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
    },
    'window:setChrome': (symbolColor) => {
      win?.setTitleBarOverlay({ color: '#00000000', symbolColor, height: 40 });
    },
    'window:toggleFullscreen': () => win?.setFullScreen(!win.isFullScreen()),
  };
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => fn(...args));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
    const files = epubArgs(argv);
    if (files.length) importAndAnnounce(files);
  });

  app.whenReady().then(async () => {
    library = new Library(path.join(app.getPath('userData'), 'library'));
    await library.load();
    const ttsRoot = process.env.FOLIO_TTS_ROOT ?? path.join(app.getPath('userData'), 'voices');
    tts = new Tts(ttsRoot, (progress) => win?.webContents.send('tts:progress', progress));
    protocol.handle('app', handleRequest);
    registerIpc();
    createWindow();
    const files = epubArgs(process.argv.slice(1));
    if (files.length) win.webContents.once('did-finish-load', () => importAndAnnounce(files));
  });

  // Saving is asynchronous, so hold the quit until it finishes or the last
  // changes (your place in the book, new highlights) would be lost.
  let saved = false;
  app.on('before-quit', (event) => {
    if (saved || !library) return;
    event.preventDefault();
    tts?.dispose();
    library.flush().finally(() => {
      saved = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
