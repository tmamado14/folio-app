// Everything around the pages: input, reading settings, bookmarks, highlights,
// notes, search and the table of contents.

import { Book } from './book.js';
import { Pager } from './pager.js';
import { Player } from './player.js';
import { $, el, toast, uid } from './ui.js';

const THEMES = {
  paper: { name: 'Paper', swatch: '#faf5e9', ink: '#2b2622', link: '#7a4a1d', accent: '#b5762a', chrome: '#e9dcc7', dark: false },
  sepia: { name: 'Sepia', swatch: '#eeddbd', ink: '#46361f', link: '#7d4a16', accent: '#a7661c', chrome: '#efe0c4', dark: false },
  dusk: { name: 'Dusk', swatch: '#3b3d43', ink: '#dcd8cf', link: '#e3b77c', accent: '#d9a35e', chrome: '#dcd8cf', dark: true },
  night: { name: 'Night', swatch: '#141416', ink: '#a9a59c', link: '#c79a5e', accent: '#c79a5e', chrome: '#a9a59c', dark: true },
};

const FONTS = [
  ['literata', 'Literata'], ['georgia', 'Georgia'], ['palatino', 'Palatino'],
  ['cambria', 'Cambria'], ['segoe', 'Segoe UI'], ['publisher', 'Publisher'],
];

const DEFAULTS = {
  theme: 'paper', font: 'literata', fontSize: 19, lineHeight: 1.55,
  margins: 'normal', justify: true, turn: 'flip', layout: 'auto',
  voice: 'af_heart', rate: 1,
};

const FONT_MIN = 13;
const FONT_MAX = 34;
const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'];
const REFLOW_KEYS = new Set(['font', 'fontSize', 'lineHeight', 'margins', 'justify', 'layout']);
const CHARS_PER_MINUTE = 1100;
const CHROME_HIDE_MS = 2600;
const CHROME_EDGE_PX = 76;
const WHEEL_THRESHOLD = 40;
const WHEEL_COOLDOWN_MS = 320;
const DRAG_COMMIT = 0.28;
const DRAG_SLOP_PX = 6;
const SAVE_DELAY_MS = 700;
const RETURN_PILL_MS = 20000;
const SEARCH_FLASH_MS = 2500;
const SINGLE_PAGE_BACK_ZONE = 0.35;

export class Reader {
  constructor({ onClose }) {
    this.onClose = onClose;
    this.pager = null;
    this.book = null;
    this.tab = 'contents';
    this.wheelSum = 0;
    this.wheelLockUntil = 0;
    this.player = new Player(this);
    this.current = null;
    this.bindChrome();
  }

  bindChrome() {
    $('r-back').addEventListener('click', () => this.close());
    $('r-contents').addEventListener('click', () => this.toggleDrawer(this.tab === 'search' ? 'contents' : this.tab));
    $('r-search').addEventListener('click', () => this.toggleDrawer('search'));
    $('r-mark').addEventListener('click', () => this.toggleBookmark());
    $('r-listen').addEventListener('click', () => this.player.toggle());
    $('r-type').addEventListener('click', () => this.toggleTypePanel());
    $('r-full').addEventListener('click', () => window.folio.window.toggleFullscreen());
    $('r-return').addEventListener('click', () => this.returnFromJump());
    $('drawer-tabs').addEventListener('click', (e) => {
      if (e.target.dataset.tab) this.showTab(e.target.dataset.tab);
    });

    const scrub = $('r-scrub');
    scrub.addEventListener('input', () => this.previewScrub());
    scrub.addEventListener('change', () => this.commitScrub());

    const search = $('book-search');
    search.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.runSearch(search.value.trim()), 250);
    });

    this.bindZone($('zone-next'), 1);
    this.bindZone($('zone-prev'), -1);

    $('stage').addEventListener('pointerdown', () => this.closePanels());
    $('reader-view').addEventListener('mousemove', (e) => this.chromeNear(e.clientY));
    $('stage').addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    document.addEventListener('keydown', (e) => this.onKey(e));

    window.addEventListener('beforeunload', () => this.saveProgress());

    new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.onResize(), 180);
    }).observe($('stage'));
  }

  get active() {
    return this.pager !== null && !$('reader-view').hidden;
  }

  async open(info, savedSettings) {
    this.info = info;
    this.settings = { ...DEFAULTS, ...savedSettings?.reader };
    this.settings.colors = THEMES[this.settings.theme];
    this.applyTheme();
    this.book = await Book.open(info);
    $('r-title').textContent = info.title;

    this.pager = new Pager(this.book, this.settings, {
      bindDoc: (view) => this.bindDoc(view),
      paint: (view) => this.paint(view),
      decorate: (view) => this.decorate(view),
    }, { stage: $('stage'), book: $('book'), leaves: $('leaves'), measure: $('measure') });

    this.pager.addEventListener('change', () => this.onPageChange());
    this.pager.addEventListener('measured', () => this.updateProgressUi());
    this.pager.addEventListener('edge', (e) => {
      toast(e.detail > 0 ? 'You have reached the end of this book' : 'This is the first page');
    });

    this.jump = null;
    $('r-return').hidden = true;
    const p = info.progress;
    await this.pager.open(p ? { spine: p.spine, offset: p.offset, ratio: p.ratio } : { spine: 0, ratio: 0 });
    this.player.attach(this.book, info, this.settings);
    this.lastSize = `${$('stage').clientWidth}x${$('stage').clientHeight}`;
    this.showChrome();
  }

  async close() {
    if (!this.pager) {
      this.onClose();
      return;
    }
    this.saveProgress();
    this.closePanels();
    this.player.close();
    const { pager } = this;
    this.pager = null;
    pager.close();
    this.book = null;
    await this.onClose();
  }

  // Settings

  applyTheme() {
    const colors = THEMES[this.settings.theme];
    this.settings.colors = colors;
    $('reader-view').dataset.theme = this.settings.theme;
    if (!$('reader-view').hidden) window.folio.window.setChrome(colors.chrome);
  }

  setOption(key, value) {
    this.settings[key] = value;
    const { colors, ...stored } = this.settings;
    window.folio.settings.patch({ reader: stored });
    if (key === 'theme') {
      this.applyTheme();
      this.pager.recolor();
    } else if (REFLOW_KEYS.has(key)) {
      this.pager.relayout();
    }
    this.renderTypePanel();
  }

  toggleTypePanel() {
    const panel = $('type-panel');
    const opening = panel.hidden;
    this.closePanels();
    panel.hidden = !opening;
    if (opening) this.renderTypePanel();
  }

  renderTypePanel() {
    const panel = $('type-panel');
    if (panel.hidden) return;
    const s = this.settings;

    const seg = (key, options) => el('div', { class: 'seg' }, ...options.map(([value, label]) =>
      el('button', {
        class: s[key] === value ? 'on' : '',
        onclick: () => this.setOption(key, value),
      }, label)));
    const row = (label, control) => el('div', { class: 'row' }, el('span', { class: 'row-label' }, label), control);

    panel.replaceChildren(
      el('div', { class: 'themes' }, ...Object.entries(THEMES).map(([id, t]) => {
        const b = el('button', {
          class: `theme${s.theme === id ? ' on' : ''}`, title: t.name,
          onclick: () => this.setOption('theme', id),
        }, el('span', { class: 'theme-dot' }, 'Aa'), t.name);
        b.querySelector('.theme-dot').style.cssText = `background:${t.swatch};color:${t.ink}`;
        return b;
      })),
      row('Font', el('select', {
        class: 'field',
        onchange: (e) => this.setOption('font', e.target.value),
      }, ...FONTS.map(([id, name]) => el('option', { value: id, selected: s.font === id }, name)))),
      row('Text size', el('div', { class: 'stepper' },
        el('button', { ariaLabel: 'Smaller text', onclick: () => this.bumpFont(-1) }, 'A−'),
        el('span', {}, `${s.fontSize}`),
        el('button', { ariaLabel: 'Larger text', onclick: () => this.bumpFont(1) }, 'A+'))),
      row('Line spacing', seg('lineHeight', [[1.35, 'Tight'], [1.55, 'Normal'], [1.8, 'Loose']])),
      row('Margins', seg('margins', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']])),
      row('Alignment', seg('justify', [[true, 'Justified'], [false, 'Left']])),
      row('Pages', seg('layout', [['auto', 'Auto'], ['single', 'One'], ['double', 'Two']])),
      row('Page turn', seg('turn', [['flip', 'Flip'], ['fade', 'Fade'], ['none', 'None']])),
    );
  }

  bumpFont(delta) {
    const size = Math.min(FONT_MAX, Math.max(FONT_MIN, this.settings.fontSize + delta));
    if (size !== this.settings.fontSize) this.setOption('fontSize', size);
  }

  onResize() {
    if (!this.active) return;
    const size = `${$('stage').clientWidth}x${$('stage').clientHeight}`;
    if (size === this.lastSize) return;
    this.lastSize = size;
    this.pager.relayout();
  }

  // Page furniture

  decorate(view) {
    const { spine, page, count } = view;
    const blank = page >= count;
    const opener = page === 0;
    const left = view.side === 'left';
    view.head.textContent = blank || opener ? '' : left ? this.info.title : this.book.titles[spine];

    view.foot.replaceChildren();
    if (!blank) {
      const number = this.pager.pageNumber(spine, page);
      view.foot.append(el('span', { class: 'num' }, number ?? ''));
      if (!left) {
        const remaining = Math.ceil((view.index.total * (1 - (page + 1) / count)) / CHARS_PER_MINUTE);
        view.foot.append(el('span', { class: 'time' }, remaining > 0 ? `${remaining} min left in chapter` : 'End of chapter'));
      }
    }
    view.ribbon.classList.toggle('on', !blank && this.bookmarkOn(view) != null);
  }

  bookmarkOn(view) {
    if (view.page >= view.count) return null;
    return this.info.bookmarks.find((b) => b.spine === view.spine && view.pageOf({ offset: b.offset }) === view.page) ?? null;
  }

  visibleViews() {
    const { cur, double } = this.pager;
    return double ? [cur.l, cur.r] : [cur.r];
  }

  onPageChange() {
    this.updateProgressUi();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveProgress(), SAVE_DELAY_MS);
    if (!$('drawer').classList.contains('open')) return;
    if (this.tab === 'contents') this.renderContents();
  }

  updateProgressUi() {
    const { pager } = this;
    if (!pager) return;
    const { spine, page } = pager.pos;
    const percent = Math.round(pager.progress() * 100);
    const scrub = $('r-scrub');
    if (pager.measured) {
      scrub.max = pager.totalPages - 1;
      scrub.value = pager.pagesBefore(spine) + page;
      $('r-info').textContent = `${this.book.titles[spine]} · Page ${pager.pageNumber(spine, page)} of ${pager.totalPages} · ${percent}%`;
    } else {
      scrub.max = 1000;
      scrub.value = pager.progress() * 1000;
      $('r-info').textContent = `${this.book.titles[spine]} · ${percent}% · Counting pages…`;
    }
    $('r-mark').classList.toggle('on', this.visibleViews().some((v) => this.bookmarkOn(v)));
    pager.refreshDecorations();
  }

  saveProgress() {
    if (!this.pager?.anchor) return;
    clearTimeout(this.saveTimer);
    const { spine, offset, ratio } = this.pager.anchor;
    const progress = { spine, offset, ratio, percent: this.pager.progress() };
    const patch = { progress, lastOpened: Date.now() };
    if (this.pager.measured) patch.pageCount = this.pager.totalPages;
    this.info.progress = progress;
    window.folio.library.patchBook(this.info.id, patch);
  }

  previewScrub() {
    const { pager } = this;
    const value = Number($('r-scrub').value);
    const tip = $('r-tip');
    const fraction = value / Math.max(1, Number($('r-scrub').max));
    tip.hidden = false;
    tip.style.left = `calc(${fraction * 100}% )`;
    const at = pager.measured ? pager.locateGlobal(value) : { spine: Math.floor(fraction * (this.book.spine.length - 1)) };
    tip.textContent = pager.measured ? `${this.book.titles[at.spine]} · Page ${value + 1}` : this.book.titles[at.spine];
    tip.classList.add('on');
  }

  commitScrub() {
    const { pager } = this;
    const value = Number($('r-scrub').value);
    $('r-tip').classList.remove('on');
    this.player.noteManualTurn();
    this.noteJump();
    if (pager.measured) {
      pager.goTo(pager.locateGlobal(value));
    } else {
      const exact = (value / 1000) * (this.book.spine.length - 1);
      pager.goTo({ spine: Math.floor(exact), ratio: exact - Math.floor(exact) });
    }
  }

  // Input

  chromeNear(y) {
    if (y < CHROME_EDGE_PX || y > window.innerHeight - CHROME_EDGE_PX) this.showChrome();
  }

  showChrome() {
    const view = $('reader-view');
    view.classList.add('chrome');
    clearTimeout(this.chromeTimer);
    this.chromeTimer = setTimeout(() => {
      const busy = !$('type-panel').hidden || $('drawer').classList.contains('open');
      if (!busy) view.classList.remove('chrome');
    }, CHROME_HIDE_MS);
  }

  /** Edge zones turn on click and follow the pointer on drag. */
  bindZone(zone, dir) {
    let press = null;
    zone.addEventListener('pointerdown', (e) => {
      if (!this.pager) return;
      zone.setPointerCapture(e.pointerId);
      this.hideSelectionPop();
      const canDrag = this.settings.turn === 'flip';
      this.player.noteManualTurn();
      press = { x: e.clientX, moved: false, drag: canDrag ? this.pager.dragTurn(dir) : null };
    });
    zone.addEventListener('pointermove', (e) => {
      if (!press?.drag) return;
      const travel = (press.x - e.clientX) * dir;
      if (Math.abs(travel) > DRAG_SLOP_PX) press.moved = true;
      const { pageW, double } = this.pager.layout;
      press.amount = travel / (double ? pageW * 2 : pageW);
      if (press.moved) press.drag.move(press.amount);
    });
    const finish = () => {
      if (!press) return;
      if (press.drag) press.drag.release(!press.moved || press.amount > DRAG_COMMIT);
      else this.turn(dir);
      press = null;
    };
    zone.addEventListener('pointerup', finish);
    zone.addEventListener('pointercancel', finish);
  }

  /** A page turn the reader asked for, as opposed to one following the narrator. */
  turn(dir) {
    this.player.noteManualTurn();
    return this.pager?.turn(dir);
  }

  onWheel(e) {
    if (!this.active) return;
    const now = performance.now();
    if (now < this.wheelLockUntil) return;
    this.wheelSum += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(this.wheelSum) < WHEEL_THRESHOLD) return;
    this.turn(Math.sign(this.wheelSum));
    this.wheelSum = 0;
    this.wheelLockUntil = now + WHEEL_COOLDOWN_MS;
  }

  onKey(e) {
    if (!this.active) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.panelsOpen()) this.closePanels();
      else this.close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.openDrawer('search');
      return;
    }
    if (e.key === 'F11') {
      e.preventDefault();
      window.folio.window.toggleFullscreen();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    const action = {
      ArrowRight: () => this.turn(1),
      PageDown: () => this.turn(1),
      ' ': () => this.turn(e.shiftKey ? -1 : 1),
      ArrowLeft: () => this.turn(-1),
      PageUp: () => this.turn(-1),
      b: () => this.toggleBookmark(),
      p: () => (this.player.narrator ? this.player.togglePlay() : this.player.show()),
      c: () => this.toggleDrawer('contents'),
      '+': () => this.bumpFont(1),
      '=': () => this.bumpFont(1),
      '-': () => this.bumpFont(-1),
    }[e.key];
    if (action) {
      e.preventDefault();
      this.closePanels();
      action();
    }
  }

  /** Wires up one chapter document; frames forward what the app needs to see. */
  bindDoc(view) {
    const { doc } = view;
    doc.addEventListener('keydown', (e) => this.onKey(e));
    doc.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    doc.addEventListener('mousedown', (e) => {
      this.press = { x: e.clientX, y: e.clientY, dismissing: this.panelsOpen() };
      this.closePanels();
    });
    doc.addEventListener('mouseup', (e) => setTimeout(() => this.onMouseUp(view, e), 0));
    doc.addEventListener('click', (e) => this.onDocClick(view, e));
    doc.addEventListener('mousemove', (e) => this.chromeNear(view.frame.getBoundingClientRect().top + e.clientY));
  }

  onDocClick(view, e) {
    const link = e.target.closest?.('a[href]');
    if (!link) return;
    e.preventDefault();
    const hit = this.book.locate(link.href);
    if (hit) {
      this.noteJump();
      this.pager.goTo(hit);
    } else {
      window.folio.openExternal(link.href);
    }
  }

  onMouseUp(view, e) {
    const sel = view.doc.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      this.showSelectionPop(view, sel.getRangeAt(0).cloneRange());
      return;
    }
    if (e.target.closest?.('a[href]')) return;
    const caret = view.doc.caretRangeFromPoint(e.clientX, e.clientY);
    if (caret) {
      const at = this.offsetsOf(view, caret).start;
      const hit = this.info.highlights.find((h) => h.spine === view.spine && at >= h.start && at < h.end);
      if (hit) {
        this.showHighlightPop(view, hit, caret.getBoundingClientRect());
        return;
      }
    }
    this.clickToTurn(view, e);
  }

  /** A plain click turns the page, unless it was only closing a panel or a selection. */
  clickToTurn(view, e) {
    const { press } = this;
    if (!press || press.dismissing) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_SLOP_PX) return;
    const onLeft = this.pager.double ? view.side === 'left' : e.clientX < this.pager.layout.textW * SINGLE_PAGE_BACK_ZONE;
    this.turn(onLeft ? -1 : 1);
  }

  offsetsOf(view, range) {
    const before = view.doc.createRange();
    before.setStart(view.doc.body, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    return { start, end: start + range.toString().length };
  }

  // Selection, highlights and notes

  placePop(view, rect) {
    const pop = $('sel-pop');
    const frame = view.frame.getBoundingClientRect();
    pop.hidden = false;
    const x = frame.left + rect.left + rect.width / 2;
    const y = frame.top + rect.top;
    const { offsetWidth: w, offsetHeight: h } = pop;
    pop.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
    pop.style.top = `${y - h - 10 > 8 ? y - h - 10 : frame.top + rect.bottom + 10}px`;
  }

  swatches(onPick, current) {
    return HIGHLIGHT_COLORS.map((c) => el('button', {
      class: `swatch ${c}${c === current ? ' on' : ''}`, title: `Highlight ${c}`, onclick: () => onPick(c),
    }));
  }

  showSelectionPop(view, range) {
    const text = range.toString().trim();
    const { start, end } = this.offsetsOf(view, range);
    const create = (color, note = '') => {
      const highlight = { id: uid(), spine: view.spine, start, end, text, color, note, createdAt: Date.now() };
      this.info.highlights = [...this.info.highlights, highlight];
      this.saveAnnotations();
      view.doc.getSelection().removeAllRanges();
      this.hideSelectionPop();
      return highlight;
    };
    const pop = $('sel-pop');
    pop.replaceChildren(
      ...this.swatches((c) => create(c)),
      el('button', {
        class: 'pop-btn',
        onclick: () => {
          this.hideSelectionPop();
          view.doc.getSelection().removeAllRanges();
          this.player.listenFrom(view.spine, start);
        },
      }, 'Listen'),
      el('button', { class: 'pop-btn', onclick: () => this.editNote(view, create('yellow'), range.getBoundingClientRect()) }, 'Note'),
      el('button', {
        class: 'pop-btn',
        onclick: () => {
          navigator.clipboard.writeText(text);
          this.hideSelectionPop();
          toast('Copied');
        },
      }, 'Copy'),
      el('button', {
        class: 'pop-btn',
        onclick: () => {
          this.hideSelectionPop();
          this.openDrawer('search');
          $('book-search').value = text.slice(0, 80);
          this.runSearch(text.slice(0, 80));
        },
      }, 'Find'),
    );
    this.placePop(view, range.getBoundingClientRect());
  }

  showHighlightPop(view, highlight, rect) {
    const update = (patch) => {
      Object.assign(highlight, patch);
      this.info.highlights = [...this.info.highlights];
      this.saveAnnotations();
    };
    const pop = $('sel-pop');
    pop.replaceChildren(
      ...this.swatches((color) => { update({ color }); this.hideSelectionPop(); }, highlight.color),
      el('button', { class: 'pop-btn', onclick: () => this.editNote(view, highlight, rect) }, highlight.note ? 'Edit note' : 'Note'),
      el('button', {
        class: 'pop-btn',
        onclick: () => {
          this.info.highlights = this.info.highlights.filter((h) => h.id !== highlight.id);
          this.saveAnnotations();
          this.hideSelectionPop();
        },
      }, 'Delete'),
    );
    this.placePop(view, rect);
  }

  editNote(view, highlight, rect) {
    const area = el('textarea', { class: 'note-box', rows: 4, value: highlight.note ?? '', placeholder: 'Write a note', ariaLabel: 'Note' });
    const save = () => {
      highlight.note = area.value.trim();
      this.info.highlights = [...this.info.highlights];
      this.saveAnnotations();
      this.hideSelectionPop();
    };
    $('sel-pop').replaceChildren(el('div', { class: 'note-edit' }, area, el('button', { class: 'btn primary', onclick: save }, 'Save note')));
    this.placePop(view, rect);
    area.focus();
  }

  hideSelectionPop() {
    $('sel-pop').hidden = true;
  }

  saveAnnotations() {
    const { bookmarks, highlights, id } = this.info;
    window.folio.library.patchBook(id, { bookmarks, highlights });
    for (const v of this.pager.views) if (v.doc) this.paint(v);
    this.updateProgressUi();
    if ($('drawer').classList.contains('open')) this.renderTab();
  }

  paint(view, flash) {
    const win = view.doc.defaultView;
    const { CSS: css, Highlight } = win;
    for (const color of HIGHLIGHT_COLORS) {
      const ranges = this.info.highlights
        .filter((h) => h.spine === view.spine && h.color === color)
        .map((h) => view.index.range(view.doc, h.start, h.end))
        .filter(Boolean);
      css.highlights.set(`folio-${color}`, new Highlight(...ranges));
    }
    const flashRange = flash?.spine === view.spine ? view.index.range(view.doc, flash.start, flash.end) : null;
    if (flashRange) css.highlights.set('folio-flash', new Highlight(flashRange));
    else css.highlights.delete('folio-flash');
    this.paintNarration(view);
  }

  /** Marks the sentence being read aloud, on whichever pages show it. */
  setNarrated(sentence) {
    this.current = sentence;
    if (this.pager) for (const v of this.pager.views) if (v.doc) this.paintNarration(v);
  }

  paintNarration(view) {
    const { current } = this;
    const win = view.doc.defaultView;
    const range = current?.spine === view.spine ? view.index.range(view.doc, current.start, current.end) : null;
    if (range) win.CSS.highlights.set('folio-tts', new win.Highlight(range));
    else win.CSS.highlights.delete('folio-tts');
  }

  revealNarration(sentence) {
    this.pager?.reveal({ spine: sentence.spine, offset: sentence.start });
  }

  toggleBookmark() {
    const views = this.visibleViews().filter((v) => v.page < v.count);
    const existing = views.map((v) => this.bookmarkOn(v)).filter(Boolean);
    if (existing.length) {
      const ids = new Set(existing.map((b) => b.id));
      this.info.bookmarks = this.info.bookmarks.filter((b) => !ids.has(b.id));
      toast('Bookmark removed');
    } else {
      const view = views[0];
      const { anchor } = this.pager;
      this.info.bookmarks = [...this.info.bookmarks, {
        id: uid(),
        spine: view.spine,
        offset: anchor.offset ?? 0,
        label: this.book.titles[view.spine],
        page: this.pager.pageNumber(view.spine, view.page),
        snippet: view.index.range(view.doc, anchor.offset ?? 0, (anchor.offset ?? 0) + 110)?.toString().replace(/\s+/g, ' ').trim() ?? '',
        createdAt: Date.now(),
      }];
      toast('Page bookmarked');
    }
    this.saveAnnotations();
  }

  // Drawer

  panelsOpen() {
    return $('drawer').classList.contains('open') || !$('type-panel').hidden || !$('sel-pop').hidden || !$('voice-panel').hidden;
  }

  closePanels() {
    $('drawer').classList.remove('open');
    $('type-panel').hidden = true;
    $('voice-panel').hidden = true;
    this.hideSelectionPop();
  }

  toggleDrawer(tab) {
    if ($('drawer').classList.contains('open') && this.tab === tab) this.closePanels();
    else this.openDrawer(tab);
  }

  openDrawer(tab) {
    $('type-panel').hidden = true;
    $('drawer').classList.add('open');
    this.showChrome();
    this.showTab(tab);
  }

  showTab(tab) {
    this.tab = tab;
    for (const b of $('drawer-tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
    $('drawer-search').hidden = tab !== 'search';
    this.renderTab();
    if (tab === 'search') $('book-search').focus();
  }

  renderTab() {
    const render = {
      contents: () => this.renderContents(),
      bookmarks: () => this.renderBookmarks(),
      highlights: () => this.renderHighlights(),
      search: () => this.renderSearch(this.searchResults ?? [], $('book-search').value.trim()),
    };
    render[this.tab]();
  }

  emptyNote(text) {
    return el('p', { class: 'drawer-empty' }, text);
  }

  renderContents() {
    const current = this.pager.pos.spine;
    let activeEl = null;
    const lastEntry = this.book.toc.reduce((best, entry, i) => (entry.spine <= current ? i : best), 0);
    const items = this.book.toc.map((entry, i) => {
      const item = el('button', {
        class: `toc-item${i === lastEntry ? ' on' : ''}`,
        onclick: () => this.jumpTo({ spine: entry.spine, fragment: entry.fragment, ratio: 0 }),
      }, entry.label);
      item.style.paddingLeft = `${16 + entry.depth * 16}px`;
      if (i === lastEntry) activeEl = item;
      return item;
    });
    $('drawer-body').replaceChildren(...items);
    activeEl?.scrollIntoView({ block: 'center' });
  }

  renderBookmarks() {
    const marks = [...this.info.bookmarks].sort((a, b) => a.spine - b.spine || a.offset - b.offset);
    if (!marks.length) {
      $('drawer-body').replaceChildren(this.emptyNote('No bookmarks yet. Press B on any page to add one.'));
      return;
    }
    $('drawer-body').replaceChildren(...marks.map((m) => el('div', { class: 'note-item' },
      el('button', { class: 'note-open', onclick: () => this.jumpTo({ spine: m.spine, offset: m.offset }) },
        el('span', { class: 'note-meta' }, m.page ? `${m.label} · Page ${m.page}` : m.label),
        el('span', { class: 'note-text' }, m.snippet)),
      el('button', {
        class: 'note-del', title: 'Remove bookmark',
        onclick: () => {
          this.info.bookmarks = this.info.bookmarks.filter((b) => b.id !== m.id);
          this.saveAnnotations();
        },
      }, '×'))));
  }

  renderHighlights() {
    const marks = [...this.info.highlights].sort((a, b) => a.spine - b.spine || a.start - b.start);
    if (!marks.length) {
      $('drawer-body').replaceChildren(this.emptyNote('Select text on any page to highlight it or add a note.'));
      return;
    }
    $('drawer-body').replaceChildren(...marks.map((h) => el('div', { class: `note-item mark-${h.color}` },
      el('button', {
        class: 'note-open',
        onclick: () => this.jumpTo({ spine: h.spine, offset: h.start }),
      },
      el('span', { class: 'note-meta' }, this.book.titles[h.spine]),
      el('span', { class: 'note-text quote' }, h.text),
      h.note ? el('span', { class: 'note-user' }, h.note) : null),
      el('button', {
        class: 'note-del', title: 'Delete highlight',
        onclick: () => {
          this.info.highlights = this.info.highlights.filter((x) => x.id !== h.id);
          this.saveAnnotations();
        },
      }, '×'))));
  }

  async runSearch(query) {
    const run = (this.searchRun = (this.searchRun ?? 0) + 1);
    if (query.length < 2) {
      this.searchResults = [];
      this.renderSearch([], query);
      return;
    }
    this.renderSearch([], query, true);
    const results = await this.book.search(query, (partial) => {
      if (run === this.searchRun) this.renderSearch(partial, query, true);
    });
    if (run !== this.searchRun) return;
    this.searchResults = results;
    this.renderSearch(results, query);
  }

  renderSearch(results, query, busy = false) {
    if (this.tab !== 'search') return;
    const body = $('drawer-body');
    if (!query) {
      body.replaceChildren(this.emptyNote('Search every chapter of this book.'));
      return;
    }
    const head = el('p', { class: 'drawer-count' },
      busy ? `Searching… ${results.length} found` : `${results.length}${results.length >= 300 ? '+' : ''} ${results.length === 1 ? 'match' : 'matches'}`);
    const items = results.slice(0, 300).map((r) => el('button', {
      class: 'search-item',
      onclick: async () => {
        await this.jumpTo({ spine: r.spine, offset: r.start });
        await this.pager.queue;
        const views = this.visibleViews();
        views.forEach((v) => this.paint(v, r));
        setTimeout(() => views.forEach((v) => v.doc && this.paint(v)), SEARCH_FLASH_MS);
      },
    },
    el('span', { class: 'note-meta' }, this.book.titles[r.spine]),
    el('span', { class: 'note-text' }, r.before, el('mark', {}, r.match), r.after)));
    body.replaceChildren(head, ...items);
  }

  noteJump() {
    this.jump = { ...this.pager.anchor };
  }

  /** After a jump, offer a way back to the page you came from. */
  async jumpTo(target) {
    this.player.noteManualTurn();
    this.noteJump();
    this.hideSelectionPop();
    await this.pager.goTo(target);
    const pill = $('r-return');
    pill.textContent = 'Back to where you were';
    pill.hidden = false;
    clearTimeout(this.pillTimer);
    this.pillTimer = setTimeout(() => { pill.hidden = true; }, RETURN_PILL_MS);
  }

  returnFromJump() {
    $('r-return').hidden = true;
    if (this.jump) this.pager.goTo(this.jump);
    this.jump = null;
  }
}
