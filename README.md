# Folio

An EPUB reader for Windows and the web. Your books stand on a wooden bookcase; opening one gives you a real
two-page book with pages you can turn.

## Run it

```
npm install
npm start
```

To build a standalone app (no Node needed afterwards), run `npm run package`, then open
`dist\Folio-win32-x64\Folio.exe`.

## On iPad and the web

Folio also runs as a website, hosted free on GitHub Pages from the `docs/` folder. It works offline once
loaded. On an iPad, open the site in Safari, tap Share, then Add to Home Screen, and use it from there. Books
stay in that device's browser storage and are never uploaded, so add them on each device and keep your
originals in Files. Libraries and reading progress are separate from the desktop app.

To change the site, edit `src/` or `web/`, run `npm run build:web`, and commit the rebuilt `docs/`.

## Reading

| Action | How |
| --- | --- |
| Turn a page | Arrow keys, Space, Page Up/Down, mouse wheel, or click a page (right page forward, left page back). On a touchscreen, swipe or tap the sides |
| Turn by hand | Drag from the outer edge of a page |
| Show the toolbar and progress bar | Move the mouse to the top or bottom of the window, or tap the middle of the page |
| Contents, bookmarks, highlights | Press `C` |
| Search the book | `Ctrl+F` |
| Bookmark the page | `B` |
| Text size | `+` and `-` |
| Highlight or add a note | Select text on a page |
| Read aloud | Press `P` or the headphones button; select text and choose Listen to start there |
| Full screen | `F11` |
| Back to the shelf | `Esc` |

Right-click a book, or click its label on the shelf, for its details, collections and the remove option.

## Listening

Folio reads books aloud with Kokoro, a neural voice that runs entirely on your PC. It offers 28 English
voices, American and British. Pick one from the listening bar, where you can also hear a sample of each,
set the speed up to 2x, or set a sleep timer. The page highlights each sentence and turns itself as the voice
reads. If you page away, the voice carries on, and Find my place brings you back. Media keys work too.

The voice model (326 MB) downloads once, the first time you listen, and goes in `%APPDATA%\Folio\voices`.
Nothing leaves your computer. An interrupted download resumes where it stopped.

On the web the same model runs in the browser and is stored there. It uses the GPU where that is reliable and
the CPU on Safari, where the GPU path can run out of memory. The offline service worker adds the headers that
let it use several CPU cores, which GitHub Pages can't send. If the voice can't run on a device, or takes too
long to start, Folio offers that device's built-in voices instead.

## Where your data lives

`%APPDATA%\Folio\library` holds a copy of each book, its cover, and `library.json` with your progress,
notes and collections. Removing a book from Folio never touches your original file.

## How it's built

- `main/`: the Electron main process. `epub.js` reads a book's structure, `library.js` stores your
  library, and `main.js` serves files straight out of each book's zip through an `app://` protocol.
- `src/js/book.js`: turns chapters into safe documents, with scripts stripped, and handles the table of
  contents and search.
- `src/js/pager.js`: pagination and page turning. Each page is a sandboxed frame showing one CSS column
  of a chapter.
- `src/js/reader.js` and `shelf.js`: the reading interface and the bookcase.
- `main/tts*.js`: the voice engine, in its own process so it can't stall the app, its model download, and
  the check that every clip is real sound before it plays.
- `src/js/sentences.js`, `narrator.js`, `player.js`: finding sentences on the page, reading them in order
  with a few synthesized ahead, and the listening controls.
- `web/`: the browser's version of the `window.folio` interface (storage, book import, voices), which is
  all that differs from the desktop app, plus offline support. `scripts/build-web.js` builds it into `docs/`.

## Tests

`npm test` runs the unit tests, drives the real desktop app end to end, then tests the built website in
WebKit, Safari's engine, emulating an iPad. The end-to-end runs need an `.epub` in the project folder and use
a temporary library, so yours isn't touched. The WebKit run needs `npx playwright-core install webkit` once.

DRM-protected books can't be opened, and Folio says so when you try to add one.
