// A book as the renderer sees it: table of contents, plus chapters converted
// into safe, self-contained documents ready to load into a page frame.

import { splitSentences } from './sentences.js';

const ORIGIN = location.origin;
const PAGE_CSS = new URL('css/page.css', document.baseURI).href;
const REMOVED = 'script, iframe, object, embed, frame, frameset, applet, meta, base, title, form, input, button';

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function decodeBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 200));
  const declared = head.match(/encoding=["']([\w-]+)["']/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(declared).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Strict XML first (self-closing tags matter), HTML if the file is malformed. */
function parseMarkup(source) {
  const strict = new DOMParser().parseFromString(source, 'application/xhtml+xml');
  if (strict.querySelector('parsererror') || !strict.body) {
    return new DOMParser().parseFromString(source, 'text/html');
  }
  return strict;
}

function clean(root) {
  root.querySelectorAll(REMOVED).forEach((el) => el.remove());
  root.querySelectorAll('link').forEach((el) => {
    if (!/stylesheet/i.test(el.getAttribute('rel') ?? '')) el.remove();
  });
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const value = attr.value.trim().toLowerCase();
      if (attr.name.toLowerCase().startsWith('on') || value.startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
  });
}

// Anything with an id stays: the table of contents and footnotes link to them.
const isBlank = (el) =>
  el != null
  && !el.id
  && !el.textContent.replace(/[\s\u00a0]/g, '')
  && !el.querySelector('[id], img, svg, image, hr, table, video, audio');

const isBlankBlock = (el) => (el?.localName === 'p' || el?.localName === 'div') && isBlank(el);

/** Badly converted books pad with hundreds of empty paragraphs, making blank pages. */
function collapseBlankRuns(body) {
  for (const li of [...body.querySelectorAll('li')]) {
    if (isBlank(li)) li.remove();
  }
  for (const list of [...body.querySelectorAll('ul, ol')]) {
    if (isBlank(list) && !list.children.length) list.remove();
  }
  for (const el of [...body.querySelectorAll('p, div')]) {
    if (isBlankBlock(el) && isBlankBlock(el.previousElementSibling)) el.remove();
  }
  while (isBlankBlock(body.lastElementChild)) body.lastElementChild.remove();
}

export class Book {
  constructor(id, info, manifest) {
    this.id = id;
    this.info = info;
    this.spine = manifest.spine;
    this.language = manifest.language || 'en';
    this.tocSource = manifest.toc;
    this.toc = [];
    this.chapters = new Map();
    this.assets = new Map();
    this.spineByPath = new Map(this.spine.map((s, i) => [s.path, i]));
  }

  static async open(info) {
    const manifest = await window.folio.book.manifest(info.id);
    if (!manifest) throw new Error('This book could not be opened');
    const book = new Book(info.id, info, manifest);
    await book.loadToc();
    return book;
  }

  fileUrl(path) {
    return `${ORIGIN}/book/${this.id}/${encodePath(path)}`;
  }

  async fetchText(path) {
    const { read } = window.folio.book;
    if (read) {
      const blob = await read(this.id, path);
      if (!blob) throw new Error(`Missing file in book: ${path}`);
      return decodeBytes(await blob.arrayBuffer());
    }
    const res = await fetch(this.fileUrl(path));
    if (!res.ok) throw new Error(`Missing file in book: ${path}`);
    return decodeBytes(await res.arrayBuffer());
  }

  pathOf(url) {
    const prefix = `${ORIGIN}/book/${this.id}/`;
    return url.startsWith(prefix) ? decodeURIComponent(new URL(url).pathname).slice(`/book/${this.id}/`.length) : null;
  }

  assetUrl(path) {
    if (!this.assets.has(path)) {
      this.assets.set(path, window.folio.book.read(this.id, path).then((blob) => (blob ? URL.createObjectURL(blob) : null)));
    }
    return this.assets.get(path);
  }

  /** Points a reference at this book's own file, or null if it leaves the book. */
  async embedRef(ref, base) {
    if (!ref || /^(data|blob):/i.test(ref)) return ref;
    const path = this.pathOf(new URL(ref, base).href);
    return path ? this.assetUrl(path) : null;
  }

  async embedCss(css, path) {
    const base = this.fileUrl(path);
    const refs = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
    const urls = await Promise.all(refs.map((m) => this.embedRef(m[2], base)));
    let i = 0;
    return css.replace(/@import[^;]+;/g, '').replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, () => {
      const url = urls[i];
      i += 1;
      return url ? `url("${url}")` : 'none';
    });
  }

  /**
   * On the web there is no server for files inside a book, so a chapter's images,
   * styles and fonts become blob: URLs. That also means no book file has an address
   * on the site, so the content policy can treat every book as untrusted.
   */
  async embedAssets(doc, path) {
    const base = this.fileUrl(path);
    const swap = async (el, attr) => {
      const url = await this.embedRef(el.getAttribute(attr), base);
      if (url) el.setAttribute(attr, url);
      else el.removeAttribute(attr);
    };
    const jobs = [...doc.querySelectorAll('img[src]')].map((el) => swap(el, 'src'));
    for (const el of doc.querySelectorAll('image')) {
      for (const attr of ['href', 'xlink:href']) if (el.hasAttribute(attr)) jobs.push(swap(el, attr));
    }
    for (const style of doc.querySelectorAll('style')) {
      jobs.push(this.embedCss(style.textContent, path).then((css) => { style.textContent = css; }));
    }
    for (const link of doc.querySelectorAll('link[href]')) {
      const cssPath = this.pathOf(new URL(link.getAttribute('href'), base).href);
      jobs.push((async () => {
        const style = doc.createElement('style');
        style.textContent = cssPath ? await this.embedCss(await this.fetchText(cssPath), cssPath) : '';
        link.replaceWith(style);
      })().catch(() => link.remove()));
    }
    await Promise.all(jobs);
  }

  dispose() {
    for (const asset of this.assets.values()) asset.then((url) => url && URL.revokeObjectURL(url), () => {});
    this.assets.clear();
  }

  /** Maps any URL inside this book to a spine index and fragment. */
  locate(url) {
    const prefix = `${ORIGIN}/book/${this.id}/`;
    if (!url.startsWith(prefix)) return null;
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).slice(`/book/${this.id}/`.length);
    const spine = this.spineByPath.get(path);
    return spine === undefined ? null : { spine, fragment: decodeURIComponent(u.hash.slice(1)) };
  }

  async loadToc() {
    try {
      if (this.tocSource?.type === 'nav') await this.loadNav();
      else if (this.tocSource?.type === 'ncx') await this.loadNcx();
    } catch (err) {
      console.warn('Could not read table of contents', err);
    }
    if (!this.toc.length) {
      this.toc = this.spine.map((_, i) => ({ label: `Section ${i + 1}`, spine: i, fragment: '', depth: 0 }));
    }
    this.titles = this.spine.map(() => '');
    let current = '';
    const firstBySpine = new Map();
    for (const entry of this.toc) {
      if (!firstBySpine.has(entry.spine)) firstBySpine.set(entry.spine, entry.label);
    }
    this.spine.forEach((_, i) => {
      current = firstBySpine.get(i) ?? current;
      this.titles[i] = current || this.info.title;
    });
  }

  tocEntry(base, href, label, depth) {
    const hit = this.locate(new URL(href, base).href);
    return hit && label ? { label, spine: hit.spine, fragment: hit.fragment, depth } : null;
  }

  async loadNav() {
    const base = this.fileUrl(this.tocSource.path);
    const doc = parseMarkup(await this.fetchText(this.tocSource.path));
    const navs = [...doc.querySelectorAll('nav')];
    const nav = navs.find((n) => /\btoc\b/.test(n.getAttribute('epub:type') ?? n.getAttribute('type') ?? '')) ?? navs[0];
    const walk = (ol, depth) => {
      for (const li of ol?.children ?? []) {
        if (li.localName !== 'li') continue;
        const a = [...li.children].find((c) => c.localName === 'a');
        if (a) {
          const entry = this.tocEntry(base, a.getAttribute('href'), a.textContent.replace(/\s+/g, ' ').trim(), depth);
          if (entry) this.toc.push(entry);
        }
        walk([...li.children].find((c) => c.localName === 'ol'), depth + 1);
      }
    };
    walk(nav && [...nav.children].find((c) => c.localName === 'ol'), 0);
  }

  async loadNcx() {
    const base = this.fileUrl(this.tocSource.path);
    const doc = new DOMParser().parseFromString(await this.fetchText(this.tocSource.path), 'application/xml');
    const walk = (parent, depth) => {
      for (const point of parent.children) {
        if (point.localName !== 'navPoint') continue;
        const label = point.querySelector('navLabel text')?.textContent.replace(/\s+/g, ' ').trim();
        const src = point.querySelector('content')?.getAttribute('src');
        const entry = src && this.tocEntry(base, src, label, depth);
        if (entry) this.toc.push(entry);
        walk(point, depth + 1);
      }
    };
    const map = doc.getElementsByTagNameNS('*', 'navMap')[0];
    if (map) walk(map, 0);
  }

  async chapter(index) {
    if (!this.chapters.has(index)) this.chapters.set(index, this.buildChapter(index));
    return this.chapters.get(index);
  }

  async buildChapter(index) {
    const item = this.spine[index];
    const url = this.fileUrl(item.path);
    const out = document.implementation.createHTMLDocument('');
    const lang = this.language;

    if (/^image\//.test(item.mediaType)) {
      const img = out.createElement('img');
      img.src = url;
      out.body.append(img);
    } else {
      const src = parseMarkup(await this.fetchText(item.path));
      for (const node of src.head?.querySelectorAll('link, style') ?? []) {
        out.head.append(out.importNode(node, true));
      }
      for (const attr of src.body.attributes) {
        if (/^(class|id|dir|lang)$/.test(attr.name)) out.body.setAttribute(attr.name, attr.value);
      }
      for (const node of src.body.childNodes) out.body.append(out.importNode(node, true));
      clean(out);
      collapseBlankRuns(out.body);
      const docLang = src.documentElement.getAttribute('lang') ?? src.documentElement.getAttribute('xml:lang');
      out.documentElement.setAttribute('lang', docLang || lang);
    }

    if (window.folio.book.read) await this.embedAssets(out, item.path);

    const base = out.createElement('base');
    base.href = url;
    out.head.prepend(base);
    const style = out.createElement('link');
    style.rel = 'stylesheet';
    style.href = PAGE_CSS;
    out.head.append(style);

    const srcdoc = `<!doctype html>${out.documentElement.outerHTML}`;
    // Offsets are defined against the text as the frame will really parse it.
    const parsed = new DOMParser().parseFromString(srcdoc, 'text/html');
    return { srcdoc, text: parsed.body.textContent, length: parsed.body.textContent.length };
  }

  async sentences(index) {
    return splitSentences((await this.chapter(index)).srcdoc);
  }

  async search(query, onProgress) {
    const needle = query.toLocaleLowerCase();
    const results = [];
    const LIMIT = 300;
    for (let i = 0; i < this.spine.length && results.length < LIMIT; i += 1) {
      const { text } = await this.chapter(i);
      const hay = text.toLocaleLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1 && results.length < LIMIT) {
        results.push({
          spine: i,
          start: at,
          end: at + needle.length,
          before: text.slice(Math.max(0, at - 50), at).replace(/\s+/g, ' ').trimStart(),
          match: text.slice(at, at + needle.length),
          after: text.slice(at + needle.length, at + needle.length + 70).replace(/\s+/g, ' ').trimEnd(),
        });
        at = hay.indexOf(needle, at + needle.length);
      }
      onProgress?.(results);
    }
    return results;
  }
}
