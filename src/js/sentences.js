// Splits a chapter into sentences a voice can read, each keeping its exact
// character offsets in the chapter so the page can highlight along with it.

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, td, th, figcaption, pre, div, section, article';
const UNSPOKEN = new Set(['STYLE', 'SCRIPT', 'TITLE', 'NOSCRIPT']);
const ABBREVIATION = /(?:^|[\s(“"‘'])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|Lt|Col|Gen|Sgt|Capt|Rev|Hon|No|vs|etc|e\.g|i\.e)\.\s*$/i;
const MAX_CHARS = 380;

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Sentence spans within one block of text, with abbreviations rejoined. */
function sentenceSpans(text) {
  const spans = [];
  for (const { index, segment } of segmenter.segment(text)) {
    const last = spans.at(-1);
    if (last && ABBREVIATION.test(text.slice(last.start, last.end))) last.end = index + segment.length;
    else spans.push({ start: index, end: index + segment.length });
  }
  return spans;
}

/** Keeps a span under the voice's limit by breaking at the most natural pause. */
function capLength(text, span) {
  const out = [];
  let { start } = span;
  while (span.end - start > MAX_CHARS) {
    const window = text.slice(start, start + MAX_CHARS);
    const cut = Math.max(
      window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(', '),
      window.lastIndexOf(' — '), window.lastIndexOf('— '),
    );
    const at = cut > MAX_CHARS / 3 ? cut + 2 : window.lastIndexOf(' ') + 1 || MAX_CHARS;
    out.push({ start, end: start + at });
    start += at;
  }
  out.push({ start, end: span.end });
  return out;
}

/** What the voice is given: tidy text, and shouted headings in normal case. */
function speakable(raw) {
  return raw
    .replace(/[\s ]+/g, ' ')
    .replace(/\b[A-Z][A-Z'’]{3,}\b/g, (w) => w[0] + w.slice(1).toLowerCase())
    .trim();
}

const canBeSpoken = (text) => /[\p{L}\p{N}]/u.test(text);

/** Runs of text that belong together, each with its offset in the chapter. */
function blocksOf(doc) {
  const blocks = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!UNSPOKEN.has(parent.tagName)) {
      const block = parent.closest(BLOCKS) ?? doc.body;
      const last = blocks.at(-1);
      if (last?.element === block) last.text += n.data;
      else blocks.push({ element: block, start: offset, text: n.data });
    }
    offset += n.length;
  }
  return blocks;
}

export function splitSentences(srcdoc) {
  const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
  const sentences = [];
  blocksOf(doc).forEach((block, blockIndex) => {
    for (const span of sentenceSpans(block.text).flatMap((s) => capLength(block.text, s))) {
      const text = speakable(block.text.slice(span.start, span.end));
      if (canBeSpoken(text)) {
        sentences.push({ block: blockIndex, start: block.start + span.start, end: block.start + span.end, text });
      }
    }
  });
  return sentences;
}
