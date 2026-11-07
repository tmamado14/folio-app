// Moves between the bookcase and an open book.

import { Shelf } from './shelf.js';
import { Reader } from './reader.js';
import { $, applyIcons, toast } from './ui.js';

const SHELF_CHROME = '#e9dcc7';
const FLIGHT_MS = 720;

applyIcons();

const shelf = new Shelf({ onOpen: openBook });
const reader = new Reader({ onClose: closeBook });
let opening = false;

/** The cover lifts off the shelf and swings open onto the reader. */
async function flyCover(fromEl) {
  const flight = $('cover-flight');
  const img = fromEl?.querySelector('img');
  if (!img) return;
  const from = fromEl.getBoundingClientRect();
  const h = window.innerHeight - 84;
  const w = Math.min(h * 0.7, window.innerWidth / 2 - 36);
  const toX = window.innerWidth / 2;
  const toY = (window.innerHeight - h) / 2;
  flight.replaceChildren(img.cloneNode());
  Object.assign(flight.style, {
    left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, transform: 'none',
  });
  flight.hidden = false;
  await flight.animate([
    { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, transform: 'perspective(2200px) rotateY(0deg)' },
    { offset: 0.55, left: `${toX}px`, top: `${toY}px`, width: `${w}px`, height: `${h}px`, transform: 'perspective(2200px) rotateY(0deg)' },
    { left: `${toX}px`, top: `${toY}px`, width: `${w}px`, height: `${h}px`, transform: 'perspective(2200px) rotateY(-100deg)' },
  ], { duration: FLIGHT_MS, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'forwards' }).finished;
  flight.hidden = true;
  flight.getAnimations().forEach((a) => a.cancel());
  flight.replaceChildren();
}

async function openBook(id, fromEl) {
  if (opening) return;
  opening = true;
  try {
    // Read the library without re-rendering: fromEl must stay in place to fly from.
    const data = await window.folio.library.get();
    $('reader-view').hidden = false;
    $('reader-view').classList.add('entering');
    const loaded = reader.open(data.books[id], data.settings);
    await Promise.all([loaded, flyCover(fromEl)]);
    $('shelf-view').hidden = true;
    $('reader-view').classList.remove('entering');
  } catch (err) {
    console.error(err);
    await reader.close();
    $('reader-view').hidden = true;
    $('shelf-view').hidden = false;
    toast(`Could not open this book: ${err.message}`, { error: true });
  } finally {
    opening = false;
  }
}

async function closeBook() {
  $('shelf-view').hidden = false;
  $('reader-view').hidden = true;
  window.folio.window.setChrome(SHELF_CHROME);
  await shelf.reload();
}

shelf.reload();
