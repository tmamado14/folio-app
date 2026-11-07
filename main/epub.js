'use strict';
// Reads the structure of an EPUB (a zip of XHTML) without touching chapter
// content. Chapters are parsed in the renderer, which has a real DOM.

const path = require('path').posix;
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: true,
  processEntities: { enabled: true, maxTotalExpansions: 100000 },
  isArray: (name) => ['item', 'itemref', 'meta', 'creator', 'title', 'reference', 'rootfile', 'EncryptedData'].includes(name),
});

const IMAGE_TYPE = /^image\//;
const OBFUSCATION = /font|obfuscat/i;

class EpubError extends Error {}

const text = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return String(v['#text'] ?? '').trim();
  return String(v).trim();
};

const safeDecode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

const stripTags = (s) =>
  s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Zip paths are matched exactly first, then loosely, since real EPUBs are sloppy. */
function entryIndex(zip) {
  const exact = new Set();
  const lower = new Map();
  zip.forEach((p, f) => {
    if (f.dir) return;
    exact.add(p);
    lower.set(p.toLowerCase(), p);
  });
  return (wanted) => {
    if (exact.has(wanted)) return wanted;
    const decoded = safeDecode(wanted);
    if (exact.has(decoded)) return decoded;
    return lower.get(decoded.toLowerCase()) ?? null;
  };
}

function chooseAuthor(creators) {
  if (!creators?.length) return '';
  const authors = creators.filter((c) => {
    const role = typeof c === 'object' ? c['@role'] : '';
    return !role || role === 'aut';
  });
  return [...new Set((authors.length ? authors : creators).map(text).filter(Boolean))].join(', ');
}

/** Tries each way publishers mark a cover, most explicit first. */
async function findCover({ zip, resolve, manifest, opfDir, meta, guide, spine }) {
  const items = [...manifest.values()];
  const isImage = (i) => i && IMAGE_TYPE.test(i.mediaType);

  const epub3 = items.find((i) => i.properties.split(/\s+/).includes('cover-image'));
  if (isImage(epub3)) return epub3.path;

  const metaCover = meta.find((m) => m['@name'] === 'cover');
  if (metaCover) {
    const byId = manifest.get(metaCover['@content']);
    if (isImage(byId)) return byId.path;
    const byHref = items.find((i) => i.href === metaCover['@content']);
    if (isImage(byHref)) return byHref.path;
  }

  const fromPage = async (file) => {
    if (!file) return null;
    const entry = resolve(file);
    if (!entry) return null;
    const html = await zip.file(entry).async('string');
    const m = html.match(/<(?:img[^>]+src|image[^>]+(?:xlink:)?href)\s*=\s*["']([^"']+)["']/i);
    return m ? resolve(path.normalize(path.join(path.dirname(entry), m[1].split('#')[0]))) : null;
  };

  const guideCover = guide.find((r) => /cover/i.test(r['@type'] ?? ''));
  if (guideCover) {
    const href = path.normalize(path.join(opfDir, safeDecode(guideCover['@href'].split('#')[0])));
    const target = resolve(href);
    if (target && /\.(jpe?g|png|gif|webp|svg)$/i.test(target)) return target;
    const found = await fromPage(href);
    if (found) return found;
  }

  const named = items.find((i) => isImage(i) && /cover/i.test(i.id + i.href));
  if (named) return named.path;

  return (await fromPage(spine[0]?.path)) ?? null;
}

/** True when content (not merely fonts) is encrypted, meaning the book has DRM. */
async function hasContentEncryption(zip, resolve) {
  if (resolve('META-INF/rights.xml')) return true;
  const entry = resolve('META-INF/encryption.xml');
  if (!entry) return false;
  const doc = xml.parse(await zip.file(entry).async('string'));
  const items = doc.encryption?.EncryptedData ?? [];
  return items.some((d) => {
    const uri = d.CipherData?.CipherReference?.['@URI'] ?? '';
    const algo = d.EncryptionMethod?.['@Algorithm'] ?? '';
    return !(OBFUSCATION.test(algo) || /\.(otf|ttf|woff2?)$/i.test(uri));
  });
}

async function openEpub(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new EpubError('Not a valid EPUB file');
  }
  const resolve = entryIndex(zip);

  const containerEntry = resolve('META-INF/container.xml');
  if (!containerEntry) throw new EpubError('Not a valid EPUB file (no container)');
  if (await hasContentEncryption(zip, resolve)) {
    throw new EpubError('This book is DRM-protected and cannot be opened');
  }

  const container = xml.parse(await zip.file(containerEntry).async('string'));
  const opfRef = container.container?.rootfiles?.rootfile?.[0]?.['@full-path'];
  const opfPath = opfRef && resolve(opfRef);
  if (!opfPath) throw new EpubError('Not a valid EPUB file (no package document)');

  const opf = xml.parse(await zip.file(opfPath).async('string')).package;
  if (!opf) throw new EpubError('Not a valid EPUB file (bad package document)');
  const opfDir = path.dirname(opfPath) === '.' ? '' : path.dirname(opfPath);

  const manifest = new Map();
  for (const it of opf.manifest?.item ?? []) {
    const href = it['@href'];
    if (!href) continue;
    const entry = resolve(path.normalize(path.join(opfDir, safeDecode(href))));
    if (!entry) continue;
    manifest.set(it['@id'], {
      id: it['@id'],
      href,
      path: entry,
      mediaType: it['@media-type'] ?? '',
      properties: it['@properties'] ?? '',
    });
  }

  const spine = (opf.spine?.itemref ?? [])
    .map((ref) => manifest.get(ref['@idref']))
    .filter(Boolean)
    .map(({ path: p, mediaType }) => ({ path: p, mediaType }));
  if (!spine.length) throw new EpubError('This book has no readable chapters');

  const items = [...manifest.values()];
  const nav = items.find((i) => i.properties.split(/\s+/).includes('nav'));
  const ncxItem =
    manifest.get(opf.spine?.['@toc']) ?? items.find((i) => i.mediaType === 'application/x-dtbncx+xml');

  const m = opf.metadata ?? {};
  const meta = m.meta ?? [];
  const metadata = {
    title: text(m.title) || 'Untitled',
    author: chooseAuthor(m.creator),
    publisher: text(m.publisher),
    language: text(m.language),
    published: text(m.date),
    description: stripTags(text(m.description)),
  };

  const coverPath = await findCover({
    zip, resolve, manifest, opfDir, meta, guide: opf.guide?.reference ?? [], spine,
  });

  return {
    zip,
    resolve,
    coverPath,
    metadata,
    manifest: {
      spine,
      toc: nav ? { path: nav.path, type: 'nav' } : ncxItem ? { path: ncxItem.path, type: 'ncx' } : null,
      language: metadata.language,
    },
  };
}

module.exports = { openEpub, EpubError };
