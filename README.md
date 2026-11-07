# Folio

A desktop EPUB reader for Windows. Your books stand on a wooden bookcase; opening one gives you a real
two-page book with pages you can turn.

## Run it

```
npm install
npm start
```

To build a standalone app (no Node needed afterwards), run `npm run package`, then open
`dist\Folio-win32-x64\Folio.exe`.

## Reading

| Action | How |
| --- | --- |
| Turn a page | Arrow keys, Space, Page Up/Down, mouse wheel, or click a page (right page forward, left page back) |
| Turn by hand | Drag from the outer edge of a page |
| Show the toolbar and progress bar | Move the mouse to the top or bottom of the window |
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

## Tests

`npm test` runs the parser unit tests, then drives the real app end to end. The end-to-end run needs an
`.epub` in the project folder and uses a temporary library, so yours isn't touched.

DRM-protected books can't be opened, and Folio says so when you try to add one.
