// The bookcase: books stand face-out on wooden shelves, each with a brass label
// on the shelf edge showing its title and how far you've read.

import { $, el, formatDate, formatSize, reportImport, toast, uid } from './ui.js';

const TIER_HEIGHT = 348;
const CELL_WIDTH = 214;
const CASE_PADDING = 120;
const SYSTEM_TABS = [
  { id: 'all', name: 'All books' },
  { id: 'reading', name: 'Reading' },
  { id: 'finished', name: 'Finished' },
];
const FINISHED_AT = 0.98;

const hashHue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const percentOf = (b) => b.progress?.percent ?? 0;
const isFinished = (b) => percentOf(b) >= FINISHED_AT;

const SORTERS = {
  recent: (a, b) => (b.lastOpened - a.lastOpened) || (b.addedAt - a.addedAt),
  added: (a, b) => b.addedAt - a.addedAt,
  title: (a, b) => a.title.localeCompare(b.title),
  author: (a, b) => a.author.localeCompare(b.author) || a.title.localeCompare(b.title),
  progress: (a, b) => percentOf(b) - percentOf(a),
};

export class Shelf {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.data = { books: {}, collections: [] };
    this.tab = 'all';
    this.sort = 'recent';
    this.query = '';

    $('shelf-search').addEventListener('input', (e) => { this.query = e.target.value.trim().toLowerCase(); this.render(); });
    $('shelf-sort').addEventListener('change', (e) => { this.sort = e.target.value; this.render(); });
    $('add-books').addEventListener('click', () => this.importWith(window.folio.library.pickFiles));
    $('add-folder').addEventListener('click', () => this.importWith(window.folio.library.pickFolder));
    window.folio.library.onChanged((result) => { reportImport(result); this.reload(); });
    new ResizeObserver(() => this.render()).observe($('bookcase'));
    this.bindDrop();
  }

  async importWith(picker) {
    const result = await picker();
    if (!result) return;
    reportImport(result);
    await this.reload();
  }

  bindDrop() {
    const veil = $('drop-veil');
    let depth = 0;
    const view = $('shelf-view');
    const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
    view.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth += 1;
      veil.classList.add('on');
    });
    view.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) veil.classList.remove('on');
    });
    view.addEventListener('dragover', (e) => e.preventDefault());
    view.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      veil.classList.remove('on');
      const paths = [...e.dataTransfer.files].map((f) => window.folio.pathForFile(f)).filter((p) => /\.epub$/i.test(p));
      if (!paths.length) {
        toast('Only .epub files can be added', { error: true });
        return;
      }
      reportImport(await window.folio.library.importPaths(paths));
      await this.reload();
    });
  }

  async reload() {
    this.data = await window.folio.library.get();
    this.render();
    return this.data;
  }

  visibleBooks() {
    const { books } = this.data;
    const q = this.query;
    return Object.values(books)
      .filter((b) => {
        if (this.tab === 'reading') return percentOf(b) > 0 && !isFinished(b);
        if (this.tab === 'finished') return isFinished(b);
        if (this.tab !== 'all') return b.collections.includes(this.tab);
        return true;
      })
      .filter((b) => !q || `${b.title} ${b.author}`.toLowerCase().includes(q))
      .sort(SORTERS[this.sort]);
  }

  renderTabs() {
    const { collections } = this.data;
    if (this.tab !== 'all' && !SYSTEM_TABS.some((t) => t.id === this.tab) && !collections.some((c) => c.id === this.tab)) {
      this.tab = 'all';
    }
    const tabs = [...SYSTEM_TABS, ...collections].map((t) =>
      el('button', {
        class: `tab${t.id === this.tab ? ' active' : ''}`,
        onclick: () => { this.tab = t.id; this.render(); },
      }, t.name));
    const custom = collections.find((c) => c.id === this.tab);
    if (custom) {
      tabs.push(el('button', {
        class: 'tab subtle', title: `Delete the collection "${custom.name}"`,
        onclick: () => this.deleteCollection(custom),
      }, 'Delete collection'));
    }
    $('shelf-tabs').replaceChildren(...tabs);
  }

  render() {
    this.renderTabs();
    const books = this.visibleBooks();
    const bookcase = $('bookcase');
    const perRow = Math.max(1, Math.floor((bookcase.clientWidth - CASE_PADDING) / CELL_WIDTH));
    const rows = Math.max(Math.ceil(books.length / perRow), Math.ceil(bookcase.clientHeight / TIER_HEIGHT), 1);

    const tiers = [];
    for (let r = 0; r < rows; r += 1) {
      const row = books.slice(r * perRow, (r + 1) * perRow);
      tiers.push(el('section', { class: 'tier' },
        el('div', { class: 'tier-books' }, ...row.map((b) => this.bookEl(b))),
        el('div', { class: 'plank' }, ...row.map((b) => this.labelEl(b)))));
    }
    const nodes = [...tiers];
    if (!books.length) nodes.push(this.emptyEl());
    bookcase.replaceChildren(...nodes);
  }

  emptyEl() {
    const hasBooks = Object.keys(this.data.books).length > 0;
    return el('div', { class: 'shelf-empty' },
      el('h2', {}, hasBooks ? 'Nothing here yet' : 'Your shelves are empty'),
      el('p', {}, hasBooks ? 'No books match this view.' : 'Drag .epub files anywhere on this window, or use Add books.'));
  }

  coverEl(book) {
    if (book.cover) {
      const img = el('img', { src: `app://local/cover/${book.cover}`, alt: '', draggable: false });
      img.addEventListener('error', () => img.replaceWith(this.plainCover(book)), { once: true });
      return img;
    }
    return this.plainCover(book);
  }

  /** A cloth-bound cover for books that don't include one. */
  plainCover(book) {
    const cover = el('span', { class: 'plain-cover' },
      el('span', { class: 'plain-title' }, book.title),
      el('span', { class: 'plain-author' }, book.author));
    cover.style.setProperty('--hue', hashHue(book.title));
    return cover;
  }

  bookEl(book) {
    const pct = percentOf(book);
    const node = el('button', {
      class: 'book-item',
      title: `${book.title}${book.author ? ` by ${book.author}` : ''}`,
      dataset: { id: book.id },
      onclick: (e) => this.onOpen(book.id, e.currentTarget.querySelector('.book-face')),
      oncontextmenu: (e) => { e.preventDefault(); this.showDetails(book.id); },
    },
    el('span', { class: 'book-body' },
      el('span', { class: 'book-spine' }),
      el('span', { class: 'book-face' }, this.coverEl(book)),
      el('span', { class: 'book-block' })),
    pct > 0 && !isFinished(book) ? el('span', { class: 'book-ribbon' }) : null);
    return node;
  }

  labelEl(book) {
    const pct = percentOf(book);
    const status = isFinished(book) ? 'Finished' : pct > 0 ? `${Math.round(pct * 100)}%` : 'New';
    const label = el('button', {
      class: 'shelf-label',
      title: 'Book details',
      onclick: () => this.showDetails(book.id),
    },
    el('span', { class: 'label-title' }, book.title),
    el('span', { class: 'label-meta' }, status),
    el('span', { class: 'label-bar' }, el('i', {})));
    label.querySelector('i').style.width = `${pct * 100}%`;
    return label;
  }

  closeModal() {
    $('modal').hidden = true;
    $('modal').replaceChildren();
  }

  showDetails(id) {
    const book = this.data.books[id];
    const modal = $('modal');
    const facts = [
      ['Publisher', book.publisher],
      ['Published', book.published?.slice(0, 4)],
      ['Language', book.language],
      ['Added', formatDate(book.addedAt)],
      ['File', formatSize(book.fileSize)],
      ['Notes', `${book.highlights.length} highlights, ${book.bookmarks.length} bookmarks`],
    ].filter(([, v]) => v);

    const chips = el('div', { class: 'chips' });
    const renderChips = () => {
      const current = this.data.books[id].collections;
      chips.replaceChildren(
        ...this.data.collections.map((c) => el('button', {
          class: `chip${current.includes(c.id) ? ' on' : ''}`,
          onclick: () => this.toggleCollection(id, c.id).then(renderChips),
        }, c.name)),
        el('input', {
          class: 'chip-input', placeholder: 'New collection',
          ariaLabel: 'New collection name',
          onkeydown: async (e) => {
            const name = e.target.value.trim();
            if (e.key !== 'Enter' || !name) return;
            await this.createCollection(name, id);
            renderChips();
          },
        }));
    };
    renderChips();

    const removal = el('button', {
      class: 'btn danger',
      onclick: async (e) => {
        if (e.currentTarget.dataset.armed !== '1') {
          e.currentTarget.dataset.armed = '1';
          e.currentTarget.textContent = 'Click again to remove, including notes';
          return;
        }
        await window.folio.library.remove(id);
        this.closeModal();
        toast(`Removed "${book.title}"`);
        await this.reload();
      },
    }, 'Remove from library');

    const sheet = el('div', { class: 'sheet', role: 'dialog', ariaLabel: book.title },
      el('div', { class: 'sheet-cover' }, this.coverEl(book)),
      el('div', { class: 'sheet-main' },
        el('h2', {}, book.title),
        el('p', { class: 'sheet-author' }, book.author || 'Unknown author'),
        book.description ? el('p', { class: 'sheet-desc' }, book.description) : null,
        el('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
        el('h3', {}, 'Collections'),
        chips,
        el('div', { class: 'sheet-actions' },
          el('button', {
            class: 'btn primary',
            onclick: () => { this.closeModal(); this.onOpen(id, null); },
          }, percentOf(book) > 0 ? 'Continue reading' : 'Start reading'),
          removal)));

    modal.replaceChildren(sheet);
    modal.hidden = false;
    modal.onclick = (e) => { if (e.target === modal) this.closeModal(); };
  }

  async toggleCollection(bookId, collectionId) {
    const book = this.data.books[bookId];
    const collections = book.collections.includes(collectionId)
      ? book.collections.filter((c) => c !== collectionId)
      : [...book.collections, collectionId];
    book.collections = collections;
    await window.folio.library.patchBook(bookId, { collections });
    this.render();
  }

  async createCollection(name, bookId) {
    const existing = this.data.collections.find((c) => c.name.toLowerCase() === name.toLowerCase());
    const collection = existing ?? { id: uid(), name };
    if (!existing) {
      this.data.collections = [...this.data.collections, collection];
      await window.folio.library.setCollections(this.data.collections);
    }
    if (!this.data.books[bookId].collections.includes(collection.id)) {
      await this.toggleCollection(bookId, collection.id);
    }
    this.render();
  }

  async deleteCollection(collection) {
    await window.folio.library.setCollections(this.data.collections.filter((c) => c.id !== collection.id));
    this.tab = 'all';
    toast(`Deleted the collection "${collection.name}". Its books stay in your library.`);
    await this.reload();
  }
}
