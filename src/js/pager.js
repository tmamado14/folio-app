// Lays chapters out into pages and turns them.
//
// A chapter flows into CSS columns inside a sandboxed frame, one column being
// one page; showing a page means sliding the body sideways. An open book needs
// four such frames: the two facing pages, plus the two on the leaf being turned
// or the spread beneath it. Moving a frame in the DOM would reload it, so the
// four stay put and only trade roles and transforms.

const GAP = 48;
const TURN_MS = 640;
const QUICK_TURN_MS = 240;
const FADE_MS = 200;
const LOAD_TIMEOUT_MS = 8000;
const PAGE_ASPECT = 0.7;
const MIN_DOUBLE_WIDTH = 900;
const APP_STYLESHEET = '/css/page.css';
const FRAME_FALLBACK_MS = 60;

const FONT_STACKS = {
  literata: "'Literata', Georgia, serif",
  georgia: "Georgia, 'Times New Roman', serif",
  palatino: "'Palatino Linotype', Palatino, 'Book Antiqua', serif",
  cambria: "Cambria, Georgia, serif",
  segoe: "'Segoe UI', system-ui, sans-serif",
};

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Animation frames stop while the window is minimized, yet narration keeps turning
// pages, and document.hidden can't tell us (disabling background throttling keeps
// it false). So every wait races a timer: a turn always finishes on schedule.
const nextFrame = () => new Promise((resolve) => {
  let waiting = true;
  const go = () => {
    if (waiting) resolve();
    waiting = false;
  };
  requestAnimationFrame(go);
  setTimeout(go, FRAME_FALLBACK_MS);
});

const BROWSER_DEFAULT_PX = 16;
const PX_PER_UNIT = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };
const FONT_KEYWORDS = {
  'xx-small': 0.6, 'x-small': 0.75, small: 0.89, medium: 1, large: 1.2, 'x-large': 1.5, 'xx-large': 2, 'xxx-large': 3,
};

/** An absolute size as rem, so it follows the reader's text size; null if already relative. */
function toRem(value) {
  const v = value.trim().toLowerCase();
  if (v in FONT_KEYWORDS) return `${FONT_KEYWORDS[v]}rem`;
  const m = v.match(/^([\d.]+)(px|pt|pc|in|cm|mm)$/);
  return m ? `${((Number(m[1]) * PX_PER_UNIT[m[2]]) / BROWSER_DEFAULT_PX).toFixed(4)}rem` : null;
}

function relativize(style) {
  for (const prop of ['font-size', 'line-height']) {
    const value = style.getPropertyValue(prop);
    if (!value || (prop === 'line-height' && value.trim() in FONT_KEYWORDS)) continue;
    const rem = toRem(value);
    if (rem) style.setProperty(prop, rem, style.getPropertyPriority(prop));
  }
}

function relativizeRules(rules) {
  for (const rule of rules) {
    if (rule.style) relativize(rule.style);
    if (rule.cssRules) relativizeRules(rule.cssRules);
  }
}

/**
 * Publishers often pin sizes in px, pt or keywords, which ignore the reader's
 * text size: Inferno sets `body { font-size: medium }` and 84 more like it.
 * Converting them keeps the book's proportions while letting everything scale.
 */
function makeSizesRelative(doc) {
  for (const sheet of doc.styleSheets) {
    if (sheet.href?.endsWith(APP_STYLESHEET)) continue;
    try {
      relativizeRules(sheet.cssRules);
    } catch {
      // A sheet that failed to load has no readable rules; nothing to adjust.
    }
  }
  for (const el of doc.body.querySelectorAll('[style]')) relativize(el.style);
}

/** Maps character offsets in a chapter to DOM positions and back. */
class TextIndex {
  constructor(doc) {
    this.nodes = [];
    this.starts = [];
    this.total = 0;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      this.nodes.push(n);
      this.starts.push(this.total);
      this.total += n.length;
    }
  }

  offsetOf(node, offset) {
    const i = this.nodes.indexOf(node);
    return i === -1 ? null : this.starts[i] + offset;
  }

  position(offset) {
    let lo = 0;
    let hi = this.nodes.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const node = this.nodes[lo];
    return node ? { node, offset: Math.min(offset - this.starts[lo], node.length) } : null;
  }

  range(doc, start, end) {
    const a = this.position(start);
    const b = this.position(end);
    if (!a || !b) return null;
    const r = doc.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  }
}

class PageView {
  constructor(pager, side) {
    this.pager = pager;
    this.side = side;
    this.spine = null;
    this.page = 0;
    this.count = 1;
    this.doc = null;
    this.index = null;
    this.plate = false;

    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.side = side;
    el.innerHTML = `
      <div class="page-head"></div>
      <div class="page-text"><iframe sandbox="allow-same-origin allow-scripts" title="Book page" tabindex="-1"></iframe></div>
      <div class="page-foot"></div>
      <div class="page-ribbon" aria-hidden="true"></div>
      <div class="page-gutter"></div>
      <div class="page-shade"></div>
      <div class="page-cast"></div>`;
    this.el = el;
    this.frame = el.querySelector('iframe');
    this.head = el.querySelector('.page-head');
    this.foot = el.querySelector('.page-foot');
    this.ribbon = el.querySelector('.page-ribbon');
    this.shade = el.querySelector('.page-shade');
    this.cast = el.querySelector('.page-cast');
  }

  async load(spine) {
    if (this.spine === spine) return;
    await this.pager.loadInto(this.frame, spine);
    this.spine = spine;
    this.doc = this.frame.contentDocument;
    this.index = new TextIndex(this.doc);
    this.page = 0;
    this.plate = this.doc.documentElement.dataset.plate === '1';
    this.el.classList.toggle('plate', this.plate);
    this.count = this.pager.countPages(this.doc);
    this.pager.counts[spine] = this.count;
    this.pager.hooks.bindDoc?.(this);
    this.pager.hooks.paint?.(this);
  }

  refresh() {
    if (!this.doc) return;
    this.pager.styleDoc(this.doc);
    // Back to the first column: measurements below assume the current stride.
    this.setPage(0);
    this.count = this.pager.countPages(this.doc);
    this.pager.counts[this.spine] = this.count;
  }

  setPage(page) {
    this.page = page;
    const blank = page >= this.count;
    this.el.classList.toggle('blank', blank);
    this.doc.documentElement.style.setProperty('--x', `${-page * this.pager.stride}px`);
  }

  get translate() {
    return this.page * this.pager.stride;
  }

  /** The page holding a text offset, fragment id or fraction of the chapter. */
  pageOf({ offset, fragment, ratio }) {
    const { stride } = this.pager;
    const toPage = (rect) => clamp(Math.floor((rect.left + this.translate + stride / 4) / stride), 0, this.count - 1);
    if (fragment) {
      const el = this.doc.getElementById(fragment);
      if (el) return toPage(el.getBoundingClientRect());
    }
    if (offset != null) {
      const r = this.index.range(this.doc, offset, offset + 1);
      const rect = r?.getClientRects()[0];
      if (rect) return toPage(rect);
    }
    return ratio != null ? clamp(Math.round(ratio * (this.count - 1)), 0, this.count - 1) : 0;
  }

  /** Text offset of the first character on the visible page. */
  firstOffset() {
    if (!this.doc || this.page >= this.count) return null;
    const { textW, textH } = this.pager.layout;
    for (const [x, y] of [[2, 2], [textW / 2, 24], [textW / 2, textH / 2]]) {
      const r = this.doc.caretRangeFromPoint(x, y);
      if (!r || !this.doc.body.contains(r.startContainer)) continue;
      const offset = this.index.offsetOf(r.startContainer, r.startOffset);
      if (offset != null) return offset;
    }
    return null;
  }

  place(transform, visible) {
    this.el.style.transform = transform;
    this.el.classList.toggle('on', visible);
  }

  reset() {
    this.el.style.transform = '';
    this.el.style.opacity = '';
    this.shade.style.opacity = 0;
    this.cast.style.opacity = 0;
  }
}

export class Pager extends EventTarget {
  constructor(book, settings, hooks, els) {
    super();
    this.book = book;
    this.settings = settings;
    this.hooks = hooks;
    this.stage = els.stage;
    this.bookEl = els.book;
    this.leaves = els.leaves;
    this.measureFrame = els.measure;
    this.counts = [];
    this.pos = { spine: 0, page: 0 };
    this.anchor = null;
    this.queue = Promise.resolve();
    this.queued = 0;
    this.measureRun = 0;
    this.closed = false;

    const views = ['left', 'right', 'left', 'right'].map((s) => new PageView(this, s));
    this.leaves.replaceChildren(...views.map((v) => v.el));
    this.cur = { l: views[0], r: views[1] };
    this.spare = { l: views[2], r: views[3] };
    this.views = views;
  }

  get double() { return this.layout.double; }
  get step() { return this.layout.double ? 2 : 1; }
  get stride() { return this.layout.textW + GAP; }

  /** Runs operations strictly in order, so a turn can't overlap a relayout. */
  enqueue(fn) {
    const run = this.queue.then(() => (this.closed ? undefined : fn()));
    this.queue = run.catch((err) => console.error('Pager error', err));
    return run;
  }

  computeLayout() {
    const s = this.settings;
    const availW = this.stage.clientWidth - 72;
    const availH = this.stage.clientHeight - 84;
    const double = s.layout === 'single' ? false : s.layout === 'double'
      ? availW >= MIN_DOUBLE_WIDTH * 0.75 : availW >= MIN_DOUBLE_WIDTH;

    let pageW = Math.min(double ? availW / 2 : availW, availH * (double ? PAGE_ASPECT : 0.76));
    let pageH = availH;
    if (pageW < availH * PAGE_ASPECT) pageH = Math.min(availH, pageW / 0.62);
    pageW = Math.floor(pageW);
    pageH = Math.floor(pageH);

    const ratio = { narrow: 0.075, normal: 0.105, wide: 0.145 }[s.margins] ?? 0.105;
    const outer = Math.round(pageW * ratio);
    const inner = double ? Math.round(outer * 1.12) : outer;
    const top = Math.round(pageH * 0.085);
    const bottom = Math.round(pageH * 0.085);
    this.layout = {
      double, pageW, pageH, outer, inner, top, bottom,
      textW: pageW - outer - inner,
      textH: pageH - top - bottom,
    };

    const st = this.bookEl.style;
    st.setProperty('--page-w', `${pageW}px`);
    st.setProperty('--page-h', `${pageH}px`);
    st.setProperty('--pad-outer', `${outer}px`);
    st.setProperty('--pad-inner', `${inner}px`);
    st.setProperty('--pad-top', `${top}px`);
    st.setProperty('--pad-bottom', `${bottom}px`);
    this.bookEl.classList.toggle('single', !double);
  }

  get layoutKey() {
    const { textW, textH } = this.layout;
    const s = this.settings;
    return [textW, textH, s.font, s.fontSize, s.lineHeight, s.justify].join('|');
  }

  styleDoc(doc) {
    const html = doc.documentElement;
    const s = this.settings;
    const plate = html.dataset.plate === '1';
    const { textW, textH, pageW, pageH } = this.layout;
    const vars = {
      '--w': `${plate ? pageW : textW}px`,
      '--h': `${plate ? pageH : textH}px`,
      '--gap': `${GAP}px`,
      '--size': `${s.fontSize}px`,
      '--lh': String(s.lineHeight),
      '--font': FONT_STACKS[s.font] ?? '',
      '--ink': s.colors.ink,
      '--link': s.colors.link,
      '--accent': s.colors.accent,
    };
    for (const [k, v] of Object.entries(vars)) html.style.setProperty(k, v);
    html.toggleAttribute('data-font', s.font !== 'publisher');
    html.dataset.justify = s.justify ? '1' : '0';
    html.dataset.dark = s.colors.dark ? '1' : '0';
  }

  /** Marks text whose alignment is the book's default, leaving centred text alone. */
  prepareDoc(doc) {
    const { body } = doc;
    makeSizesRelative(doc);
    for (const img of body.querySelectorAll('img')) {
      if (img.complete && !img.naturalWidth) img.style.display = 'none';
    }
    const pictures = body.querySelectorAll('img:not([style*="display: none"]), svg, image').length;
    const plate = pictures >= 1 && pictures <= 2 && body.textContent.trim().length < 24;
    doc.documentElement.dataset.plate = plate ? '1' : '0';
    // Covers fill their page, but a small ornament shouldn't be blown up to fit.
    const large = [...body.querySelectorAll('img')].some((i) => i.naturalWidth >= this.layout.pageW * 0.5);
    doc.documentElement.toggleAttribute('data-fill', plate && large);
    const view = doc.defaultView;
    for (const el of body.querySelectorAll('p, li, blockquote, div')) {
      if (/^(start|left|justify|-webkit-auto)$/.test(view.getComputedStyle(el).textAlign)) {
        el.setAttribute('data-aligned', '');
      }
    }
  }

  async loadInto(frame, spine) {
    const { srcdoc } = await this.book.chapter(spine);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, LOAD_TIMEOUT_MS);
      frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
      frame.srcdoc = srcdoc;
    });
    const doc = frame.contentDocument;
    this.prepareDoc(doc);
    this.styleDoc(doc);
    // Font files are fetched when layout first needs them, so force layout, then
    // wait: otherwise pages get counted against fallback font metrics.
    doc.body.getBoundingClientRect();
    await doc.fonts.ready;
  }

  countPages(doc) {
    if (doc.documentElement.dataset.plate === '1') return 1;
    const shift = new DOMMatrixReadOnly(doc.defaultView.getComputedStyle(doc.body).transform).m41;
    // Stop at the last thing you can actually see, so empty elements trailing a
    // chapter don't add a blank page.
    const range = doc.createRange();
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    walker.currentNode = doc.body;
    while (walker.lastChild());
    let rects = [];
    for (let n = walker.currentNode; n && !rects.length; n = walker.previousNode()) {
      if (n.nodeType !== Node.TEXT_NODE || !/[^\s\u00a0]/.test(n.data)) continue;
      range.selectNodeContents(n);
      // Text can be unrendered, such as a stray <style> in the body; keep looking.
      rects = [...range.getClientRects()].filter((r) => r.width > 0);
    }
    const media = [...doc.body.querySelectorAll('img, svg, video, hr, table')].at(-1);
    if (media) rects.push(media.getBoundingClientRect());
    let right = 0;
    for (const rect of rects) {
      if (rect.width > 0 || rect.height > 0) right = Math.max(right, rect.right - shift);
    }
    return Math.max(1, Math.ceil((right - 1 + GAP) / this.stride));
  }

  async open(target) {
    this.computeLayout();
    await this.enqueue(async () => {
      const view = this.cur.r;
      await view.load(target.spine);
      const page = view.pageOf(target);
      this.pos = { spine: target.spine, page: this.spreadStart(page) };
      await this.showSpread(this.cur, this.pos);
      this.cur.l.place('', this.double);
      this.cur.r.place('', true);
      this.settle();
    });
    this.measureAll();
  }

  spreadStart(page) {
    return page - (page % this.step);
  }

  async showSpread(views, { spine, page }) {
    if (this.double) {
      await views.l.load(spine);
      views.l.setPage(page);
      this.hooks.decorate(views.l);
    }
    await views.r.load(spine);
    views.r.setPage(this.double ? page + 1 : page);
    this.hooks.decorate(views.r);
  }

  /** Called once a spread is at rest: records position, warms up the next spread. */
  settle() {
    const first = this.double ? this.cur.l : this.cur.r;
    const offset = first.firstOffset();
    this.anchor = {
      spine: this.pos.spine,
      offset: offset ?? undefined,
      ratio: first.count > 1 ? this.pos.page / (first.count - 1) : 0,
    };
    this.updateEdges();
    this.dispatchEvent(new CustomEvent('change'));
    this.enqueue(async () => {
      const next = await this.neighbor(1);
      if (next) await this.showSpread(this.spare, next);
    });
  }

  updateEdges() {
    const p = this.progress();
    this.bookEl.style.setProperty('--read', p.toFixed(4));
  }

  /** Fraction of the book read; exact once every chapter has been measured. */
  progress() {
    const { spine, page } = this.pos;
    if (this.measured) return clamp((this.pagesBefore(spine) + page) / Math.max(1, this.totalPages - 1), 0, 1);
    const within = page / Math.max(1, (this.counts[spine] ?? 1));
    return (spine + within) / this.book.spine.length;
  }

  get measured() {
    for (let i = 0; i < this.book.spine.length; i += 1) if (!this.counts[i]) return false;
    return true;
  }

  get totalPages() {
    return this.counts.reduce((a, b) => a + (b ?? 0), 0);
  }

  pagesBefore(spine) {
    let n = 0;
    for (let i = 0; i < spine; i += 1) n += this.counts[i] ?? 0;
    return n;
  }

  /** Global page number for a page in a chapter; null until all chapters are measured. */
  pageNumber(spine, page) {
    return this.measured ? this.pagesBefore(spine) + page + 1 : null;
  }

  locateGlobal(n) {
    let left = n;
    for (let spine = 0; spine < this.book.spine.length; spine += 1) {
      const c = this.counts[spine] ?? 1;
      if (left < c) return { spine, page: left };
      left -= c;
    }
    const last = this.book.spine.length - 1;
    return { spine: last, page: (this.counts[last] ?? 1) - 1 };
  }

  /** Counts every chapter in a hidden frame so page numbers cover the whole book. */
  async measureAll() {
    const run = ++this.measureRun;
    const key = `folio.pages.${this.book.id}.${this.layoutKey}`;
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (saved?.length === this.book.spine.length) this.counts = saved;
    } catch { /* A missing cache only means measuring again. */ }

    const { textW, textH } = this.layout;
    this.measureFrame.style.width = `${textW}px`;
    this.measureFrame.style.height = `${textH}px`;
    for (let i = 0; i < this.book.spine.length && !this.measured; i += 1) {
      if (this.counts[i]) continue;
      await this.loadInto(this.measureFrame, i);
      if (run !== this.measureRun || this.closed) return;
      this.counts[i] = this.countPages(this.measureFrame.contentDocument);
      if (i % 8 === 0) this.dispatchEvent(new CustomEvent('measuring', { detail: i / this.book.spine.length }));
    }
    try { localStorage.setItem(key, JSON.stringify(this.counts)); } catch { /* Cache is optional. */ }
    this.measureFrame.removeAttribute('srcdoc');
    this.updateEdges();
    this.dispatchEvent(new CustomEvent('measured'));
    this.refreshDecorations();
  }

  refreshDecorations() {
    for (const v of [this.cur.l, this.cur.r, this.spare.l, this.spare.r]) {
      if (v.doc) this.hooks.decorate(v);
    }
  }

  async countOf(spine) {
    if (this.counts[spine]) return this.counts[spine];
    await this.spare.r.load(spine);
    return this.spare.r.count;
  }

  async neighbor(dir) {
    const { spine, page } = this.pos;
    const step = this.step;
    if (dir > 0) {
      if (page + step < this.counts[spine]) return { spine, page: page + step };
      return spine + 1 < this.book.spine.length ? { spine: spine + 1, page: 0 } : null;
    }
    if (page - step >= 0) return { spine, page: page - step };
    if (spine === 0) return null;
    const c = await this.countOf(spine - 1);
    return { spine: spine - 1, page: this.spreadStart(c - 1) };
  }

  commit(target) {
    [this.cur, this.spare] = [this.spare, this.cur];
    this.pos = target;
    for (const v of Object.values(this.spare)) { v.reset(); v.place('', false); }
    for (const v of Object.values(this.cur)) v.reset();
    this.cur.l.place('', this.double);
    this.cur.r.place('', true);
    this.settle();
  }

  /** The cast of a turn. Forward and back are the same motion run in reverse. */
  flipRoles(dir) {
    const [before, after] = dir > 0 ? [this.cur, this.spare] : [this.spare, this.cur];
    return { still: before.l, front: before.r, back: after.l, under: after.r };
  }

  stageFlip(roles) {
    const { still, front, back, under } = roles;
    if (this.double) {
      still.place('', true);
      back.place('', true);
    }
    front.place('', true);
    under.place('', true);
    front.el.classList.add('leaf');
    back.el.classList.add('leaf');
  }

  setFlip({ still, front, back, under }, p) {
    const angle = p * 180;
    const lift = Math.sin(p * Math.PI);
    if (this.double) {
      front.el.style.transform = `translateZ(1px) rotateY(${-angle}deg)`;
      back.el.style.transform = `translateZ(1px) rotateY(${180 - angle}deg)`;
      front.shade.style.opacity = lift * 0.9;
      back.shade.style.opacity = lift * 0.9;
      still.cast.style.opacity = p > 0.5 ? lift * 0.45 : 0;
      under.cast.style.opacity = p <= 0.5 ? lift * 0.75 : lift * 0.2;
    } else {
      // Past 90 degrees the page is edge-on, then hidden by its back face.
      front.el.style.transform = `translateZ(1px) rotateY(${-p * 92}deg)`;
      front.shade.style.opacity = p * 0.9;
      under.cast.style.opacity = (1 - p) * 0.5 * lift;
    }
  }

  endFlip({ front, back }) {
    front.el.classList.remove('leaf');
    back.el.classList.remove('leaf');
  }

  async animateFlip(roles, from, to, ms) {
    const start = performance.now();
    for (let t = 0; t < 1 && !this.closed;) {
      await nextFrame();
      t = clamp((performance.now() - start) / ms, 0, 1);
      this.setFlip(roles, from + (to - from) * ease(t));
    }
  }

  async fade(target) {
    const incoming = Object.values(this.spare);
    incoming.forEach((v) => {
      v.el.style.opacity = 0;
      v.el.style.transition = `opacity ${FADE_MS}ms ease`;
      v.place('translateZ(2px)', v.side === 'right' || this.double);
    });
    await nextFrame();
    incoming.forEach((v) => { v.el.style.opacity = 1; });
    await new Promise((r) => setTimeout(r, FADE_MS));
    incoming.forEach((v) => { v.el.style.transition = ''; });
    this.commit(target);
  }

  async transition(target, dir, { jump = false } = {}) {
    await this.showSpread(this.spare, target);
    const mode = this.settings.turn;
    if (mode === 'none') {
      this.commit(target);
    } else if (mode === 'fade' || jump) {
      await this.fade(target);
    } else {
      const roles = this.flipRoles(dir);
      const ms = this.queued > 1 ? QUICK_TURN_MS : TURN_MS;
      this.stageFlip(roles);
      this.setFlip(roles, dir > 0 ? 0 : 1);
      await nextFrame();
      await this.animateFlip(roles, dir > 0 ? 0 : 1, dir > 0 ? 1 : 0, ms);
      this.endFlip(roles);
      this.commit(target);
    }
  }

  turn(dir) {
    if (this.queued >= 2) return Promise.resolve();
    this.queued += 1;
    return this.enqueue(async () => {
      const target = await this.neighbor(dir);
      if (target) await this.transition(target, dir);
      else this.dispatchEvent(new CustomEvent('edge', { detail: dir }));
    }).finally(() => { this.queued -= 1; });
  }

  /** A turn held under the pointer: move() follows it, release() lets go. */
  dragTurn(dir) {
    const drag = { amount: 0, released: false, commit: true, live: false };
    let letGo;
    const released = new Promise((r) => { letGo = r; });

    this.enqueue(async () => {
      const target = await this.neighbor(dir);
      if (!target) {
        this.dispatchEvent(new CustomEvent('edge', { detail: dir }));
        return;
      }
      await this.showSpread(this.spare, target);
      const roles = this.flipRoles(dir);
      const at = (amount) => (dir > 0 ? amount : 1 - amount);
      this.stageFlip(roles);
      this.setFlip(roles, at(drag.amount));
      drag.live = true;
      drag.apply = () => this.setFlip(roles, at(drag.amount));
      await released;
      drag.live = false;
      const remaining = drag.commit ? 1 - drag.amount : drag.amount;
      await this.animateFlip(roles, at(drag.amount), at(drag.commit ? 1 : 0), Math.max(160, TURN_MS * remaining));
      this.endFlip(roles);
      if (drag.commit) {
        this.commit(target);
      } else {
        for (const v of Object.values(this.spare)) { v.reset(); v.place('', false); }
        for (const v of Object.values(this.cur)) v.reset();
        this.cur.l.place('', this.double);
        this.cur.r.place('', true);
      }
    });

    return {
      move: (amount) => {
        drag.amount = clamp(amount, 0, 1);
        if (drag.live) drag.apply();
      },
      release: (commit) => {
        drag.commit = commit;
        drag.released = true;
        letGo();
      },
    };
  }

  /** Jumps anywhere: { spine, offset | fragment | ratio | page }. */
  goTo(target) {
    return this.enqueue(async () => {
      const view = this.spare.r;
      await view.load(target.spine);
      const page = target.page ?? view.pageOf(target);
      const dest = { spine: target.spine, page: this.spreadStart(page) };
      if (dest.spine === this.pos.spine && dest.page === this.pos.page) return;
      await this.transition(dest, 1, { jump: true });
    });
  }

  /** Brings a position into view: a page turn if it's next, otherwise a jump. */
  reveal(target) {
    return this.enqueue(async () => {
      const view = this.cur.r.spine === target.spine ? this.cur.r : this.spare.r;
      await view.load(target.spine);
      const dest = { spine: target.spine, page: this.spreadStart(view.pageOf(target)) };
      if (dest.spine === this.pos.spine && dest.page === this.pos.page) return;
      const next = await this.neighbor(1);
      const adjacent = next?.spine === dest.spine && next.page === dest.page;
      await this.transition(dest, 1, { jump: !adjacent });
    });
  }

  /** Re-flows every page after a size or typography change, keeping your place. */
  relayout() {
    return this.enqueue(async () => {
      const anchor = this.anchor;
      this.computeLayout();
      this.counts = [];
      this.measureRun += 1;
      for (const v of this.views) v.refresh();
      for (const v of Object.values(this.spare)) v.place('', false);
      const view = this.cur.r;
      await view.load(this.pos.spine);
      this.pos = { spine: this.pos.spine, page: this.spreadStart(view.pageOf(anchor ?? { ratio: 0 })) };
      await this.showSpread(this.cur, this.pos);
      this.cur.l.place('', this.double);
      this.cur.r.place('', true);
      const kept = this.anchor;
      this.settle();
      if (kept?.offset != null) this.anchor = kept;
      this.measureAll();
    });
  }

  /** Colours only: no text moves, so nothing needs re-flowing. */
  recolor() {
    for (const v of this.views) if (v.doc) this.styleDoc(v.doc);
  }

  close() {
    this.closed = true;
    this.measureRun += 1;
    for (const v of this.views) v.frame.removeAttribute('srcdoc');
    this.leaves.replaceChildren();
  }
}
