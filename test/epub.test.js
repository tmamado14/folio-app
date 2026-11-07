'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { openEpub } = require('../main/epub');

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const opf = ({ manifest = '', spine = '', meta = '', guide = '' }) => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Test &amp; Trial</dc:title>
    <dc:creator id="a">Ann Author</dc:creator>
    <dc:language>en</dc:language>
    <dc:description>&lt;p&gt;A &lt;b&gt;bold&lt;/b&gt; story.&lt;/p&gt;</dc:description>
    ${meta}
  </metadata>
  <manifest>
    <item id="c1" href="text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    ${manifest}
  </manifest>
  <spine>${spine || '<itemref idref="c1"/>'}</spine>
  ${guide}
</package>`;

async function build(files) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', CONTAINER);
  zip.file('OEBPS/text/chapter 1.xhtml', '<html><body><p>Hello</p></body></html>');
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('reads metadata, decoding entities and stripping HTML from the description', async () => {
  const book = await openEpub(await build({ 'OEBPS/book.opf': opf({}) }));
  assert.equal(book.metadata.title, 'The Test & Trial');
  assert.equal(book.metadata.author, 'Ann Author');
  assert.equal(book.metadata.description, 'A bold story.');
});

test('resolves URL-encoded hrefs to real zip entries', async () => {
  const book = await openEpub(await build({ 'OEBPS/book.opf': opf({}) }));
  assert.equal(book.manifest.spine[0].path, 'OEBPS/text/chapter 1.xhtml');
});

test('finds an EPUB 3 cover-image', async () => {
  const book = await openEpub(await build({
    'OEBPS/book.opf': opf({ manifest: '<item id="i" href="c.jpg" media-type="image/jpeg" properties="cover-image"/>' }),
    'OEBPS/c.jpg': 'x',
  }));
  assert.equal(book.coverPath, 'OEBPS/c.jpg');
});

test('finds an EPUB 2 meta cover', async () => {
  const book = await openEpub(await build({
    'OEBPS/book.opf': opf({
      manifest: '<item id="pic" href="front.png" media-type="image/png"/>',
      meta: '<meta name="cover" content="pic"/>',
    }),
    'OEBPS/front.png': 'x',
  }));
  assert.equal(book.coverPath, 'OEBPS/front.png');
});

test('finds a cover through the guide when it points at a page', async () => {
  const book = await openEpub(await build({
    'OEBPS/book.opf': opf({
      manifest: '<item id="cp" href="start.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="art.jpg" media-type="image/jpeg"/>',
      guide: '<guide><reference type="cover" href="start.xhtml"/></guide>',
    }),
    'OEBPS/start.xhtml': '<html><body><img src="art.jpg"/></body></html>',
    'OEBPS/art.jpg': 'x',
  }));
  assert.equal(book.coverPath, 'OEBPS/art.jpg');
});

test('finds both navigation formats', async () => {
  const nav = await openEpub(await build({
    'OEBPS/book.opf': opf({ manifest: '<item id="n" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' }),
    'OEBPS/nav.xhtml': '<html/>',
  }));
  assert.deepEqual(nav.manifest.toc, { path: 'OEBPS/nav.xhtml', type: 'nav' });
  const ncx = await openEpub(await build({
    'OEBPS/book.opf': opf({ manifest: '<item id="t" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' }),
    'OEBPS/toc.ncx': '<ncx/>',
  }));
  assert.deepEqual(ncx.manifest.toc, { path: 'OEBPS/toc.ncx', type: 'ncx' });
});

test('rejects files that are not EPUBs', async () => {
  await assert.rejects(openEpub(Buffer.from('not a zip')), /Not a valid EPUB/);
  const zip = new JSZip();
  zip.file('hello.txt', 'hi');
  await assert.rejects(openEpub(await zip.generateAsync({ type: 'nodebuffer' })), /Not a valid EPUB/);
});

test('rejects DRM-protected books', async () => {
  const encrypted = `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
    <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/text/chapter 1.xhtml"/></enc:CipherData></enc:EncryptedData>
  </encryption>`;
  await assert.rejects(
    openEpub(await build({ 'OEBPS/book.opf': opf({}), 'META-INF/encryption.xml': encrypted })),
    /DRM/,
  );
});

test('allows books whose only encryption is font obfuscation', async () => {
  const obfuscated = `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
    <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/font.otf"/></enc:CipherData></enc:EncryptedData>
  </encryption>`;
  const book = await openEpub(await build({ 'OEBPS/book.opf': opf({}), 'META-INF/encryption.xml': obfuscated }));
  assert.equal(book.metadata.author, 'Ann Author');
});
