// Small helpers shared by the shelf and the reader.

const stroke = (d) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const ICONS = {
  back: stroke('<path d="M15 5l-7 7 7 7"/>'),
  list: stroke('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  search: stroke('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  bookmark: stroke('<path d="M7 3.5h10v17l-5-3.6-5 3.6z"/>'),
  type: stroke('<path d="M3 18l5-12 5 12M4.7 14h6.6M15 18l3-7.5 3 7.5M16 15.5h4"/>'),
  expand: stroke('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  close: stroke('<path d="M6 6l12 12M18 6L6 18"/>'),
  headphones: stroke('<path d="M4 15v-3a8 8 0 0116 0v3"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.6"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.6"/>'),
  play: stroke('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>'),
  pause: stroke('<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="3"/>'),
  prev: stroke('<path d="M17.5 6v12L9 12zM6.5 6v12" fill="currentColor"/>'),
  next: stroke('<path d="M6.5 6v12L15 12zM17.5 6v12" fill="currentColor"/>'),
};

export function applyIcons(root = document) {
  root.querySelectorAll('[data-ico]').forEach((el) => { el.innerHTML = ICONS[el.dataset.ico]; });
}

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node[key] = value;
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

export function toast(message, { error = false } = {}) {
  const t = el('div', { class: `toast${error ? ' error' : ''}` }, message);
  $('toasts').append(t);
  setTimeout(() => t.classList.add('gone'), error ? 6000 : 3200);
  setTimeout(() => t.remove(), error ? 6400 : 3600);
}

export function reportImport(result) {
  if (!result) return;
  const { added, duplicates, failed } = result;
  if (added) toast(`Added ${added} ${added === 1 ? 'book' : 'books'} to your shelves`);
  if (duplicates && !added) toast(duplicates === 1 ? 'That book is already on your shelves' : 'Those books are already on your shelves');
  for (const f of failed) toast(`${f.file}: ${f.reason}`, { error: true });
}

export function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatSize(bytes) {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
}

export const coverUrl = (book) => book.coverUrl ?? `${location.origin}/cover/${book.cover}`;

export const uid = () => Math.random().toString(36).slice(2, 10);
