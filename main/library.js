'use strict';
// The on-disk library: copies of each EPUB, extracted covers and one JSON file
// holding metadata, reading progress, annotations and settings.

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { openEpub } = require('./epub');

const SAVE_DELAY_MS = 400;
const MAX_OPEN_BOOKS = 3;
const PATCHABLE = new Set(['progress', 'bookmarks', 'highlights', 'collections', 'lastOpened', 'pageCount']);

class Library {
  constructor(dir) {
    this.dir = dir;
    this.booksDir = path.join(dir, 'books');
    this.coversDir = path.join(dir, 'covers');
    this.file = path.join(dir, 'library.json');
    this.data = { version: 1, books: {}, collections: [], settings: {} };
    this.open = new Map();
    this.saveTimer = null;
    this.writing = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.booksDir, { recursive: true });
    await fs.mkdir(this.coversDir, { recursive: true });
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    try {
      this.data = { ...this.data, ...JSON.parse(raw) };
    } catch {
      // Never overwrite a damaged library: set it aside so it can be recovered.
      await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
    }
  }

  snapshot() {
    return this.data;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** Writes to a temp file then renames, so a crash cannot truncate the library. */
  flush() {
    clearTimeout(this.saveTimer);
    const json = JSON.stringify(this.data);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, json);
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }

  async importFile(file) {
    const buffer = await fs.readFile(file);
    const id = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
    if (this.data.books[id]) return { id, duplicate: true };

    const book = await openEpub(buffer);
    let cover = null;
    if (book.coverPath) {
      const ext = path.extname(book.coverPath).toLowerCase() || '.jpg';
      cover = `${id}${ext}`;
      const bytes = await book.zip.file(book.coverPath).async('nodebuffer');
      await fs.writeFile(path.join(this.coversDir, cover), bytes);
    }
    await fs.writeFile(path.join(this.booksDir, `${id}.epub`), buffer);

    this.data.books[id] = {
      id,
      ...book.metadata,
      cover,
      fileName: path.basename(file),
      fileSize: buffer.length,
      addedAt: Date.now(),
      lastOpened: 0,
      progress: null,
      bookmarks: [],
      highlights: [],
      collections: [],
    };
    this.scheduleSave();
    return { id, duplicate: false };
  }

  async importFiles(files) {
    const result = { added: 0, duplicates: 0, failed: [] };
    for (const file of files) {
      try {
        const { duplicate } = await this.importFile(file);
        if (duplicate) result.duplicates += 1;
        else result.added += 1;
      } catch (err) {
        result.failed.push({ file: path.basename(file), reason: err.message });
      }
    }
    return result;
  }

  async findEpubs(folder) {
    const found = [];
    const entries = await fs.readdir(folder, { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (e.isFile() && /\.epub$/i.test(e.name)) found.push(path.join(e.parentPath, e.name));
    }
    return found;
  }

  async remove(id) {
    const book = this.data.books[id];
    if (!book) return;
    delete this.data.books[id];
    this.open.delete(id);
    await fs.rm(path.join(this.booksDir, `${id}.epub`), { force: true });
    if (book.cover) await fs.rm(path.join(this.coversDir, book.cover), { force: true });
    this.scheduleSave();
  }

  patchBook(id, patch) {
    const book = this.data.books[id];
    if (!book) return;
    for (const [key, value] of Object.entries(patch)) {
      if (PATCHABLE.has(key)) book[key] = value;
    }
    this.scheduleSave();
  }

  setCollections(collections) {
    this.data.collections = collections;
    const known = new Set(collections.map((c) => c.id));
    for (const book of Object.values(this.data.books)) {
      book.collections = book.collections.filter((c) => known.has(c));
    }
    this.scheduleSave();
  }

  patchSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.scheduleSave();
  }

  /** Keeps a few books unpacked in memory; pages are served straight from these. */
  async getOpenBook(id) {
    const cached = this.open.get(id);
    if (cached) {
      this.open.delete(id);
      this.open.set(id, cached);
      return cached;
    }
    if (!this.data.books[id]) return null;
    const book = await openEpub(await fs.readFile(path.join(this.booksDir, `${id}.epub`)));
    this.open.set(id, book);
    if (this.open.size > MAX_OPEN_BOOKS) this.open.delete(this.open.keys().next().value);
    return book;
  }

  async readBookFile(id, entryPath) {
    const book = await this.getOpenBook(id);
    const entry = book?.resolve(entryPath);
    return entry ? book.zip.file(entry).async('nodebuffer') : null;
  }
}

module.exports = { Library };
