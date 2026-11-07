// The listening controls: install prompt, transport, voice picker, speed and a
// sleep timer. The Narrator does the reading; this is what you touch.

import { Narrator } from './narrator.js';
import { $, applyIcons, el, toast } from './ui.js';

const RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SLEEP_MINUTES = [0, 15, 30, 60, 90];
const PREVIEW = 'Hello. This is how I will sound reading your book.';
const ACCENTS = { 'en-us': 'American', 'en-gb': 'British' };
const GRADE_ORDER = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+'];

const gradeRank = (g) => {
  const i = GRADE_ORDER.indexOf(g);
  return i === -1 ? GRADE_ORDER.length : i;
};
const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;

export class Player {
  constructor(reader) {
    this.reader = reader;
    this.narrator = null;
    this.voices = null;
    this.following = true;
    this.waiting = false;
    this.preview = new Audio();
    window.folio.tts.onProgress((p) => this.showProgress(p));
  }

  get open() {
    return !$('player').hidden;
  }

  attach(book, info, settings) {
    this.book = book;
    this.info = info;
    this.settings = settings;
  }

  /** Called when a book closes. */
  detach() {
    clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.sleepMinutes = 0;
    this.narrator?.stop();
    this.narrator = null;
    this.preview.pause();
    $('player').hidden = true;
    $('voice-panel').hidden = true;
    $('reader-view').classList.remove('listening');
    this.reader.setNarrated(null);
  }

  async toggle() {
    if (this.open) this.close();
    else await this.show();
  }

  close() {
    this.detach();
    $('r-listen').classList.remove('on');
  }

  async show() {
    $('player').hidden = false;
    $('r-listen').classList.add('on');
    const status = await window.folio.tts.status();
    if (status.installed) await this.begin();
    else this.renderInstall(status);
  }

  renderInstall({ bytes, downloading }) {
    const action = el('button', { class: 'btn primary', onclick: () => this.install() }, `Download voices (${megabytes(bytes)})`);
    $('player').replaceChildren(
      el('div', { class: 'install' },
        el('div', {},
          el('strong', {}, 'Listen to your books'),
          el('p', {}, 'Folio needs to download its voice engine once. After that, everything runs on this PC, with no internet and nothing sent anywhere.')),
        el('div', { class: 'install-actions', id: 'install-actions' }, action,
          el('button', { class: 'btn', onclick: () => this.close() }, 'Not now'))));
    if (downloading) this.showProgress({ done: 0, total: bytes });
  }

  showProgress({ done, total }) {
    const slot = $('install-actions');
    if (!slot) return;
    const bar = el('div', { class: 'install-bar' }, el('i', {}));
    bar.firstChild.style.width = `${(done / total) * 100}%`;
    slot.replaceChildren(bar, el('span', { class: 'install-count' }, `${megabytes(done)} of ${megabytes(total)}`));
  }

  async install() {
    this.showProgress({ done: 0, total: 1 });
    try {
      await window.folio.tts.install();
      if (this.open) await this.begin();
    } catch (err) {
      toast(`${err.message}. Your download will resume when you try again.`, { error: true });
      if (this.open) this.renderInstall(await window.folio.tts.status());
    }
  }

  async begin() {
    $('player').replaceChildren(el('div', { class: 'player-status' }, 'Warming up the voice…'));
    try {
      this.voices ??= await window.folio.tts.voices();
    } catch (err) {
      toast(`The voice engine could not start: ${err.message}`, { error: true });
      this.close();
      return;
    }
    if (!this.open) return;
    this.createNarrator();
    this.renderControls();
    await this.playFromPage();
  }

  createNarrator() {
    const { voice, rate } = this.settings;
    const n = new Narrator(this.book, { voice, rate });
    n.addEventListener('state', () => this.renderState());
    n.addEventListener('waiting', (e) => { this.waiting = e.detail; this.renderState(); });
    n.addEventListener('sentence', (e) => this.onSentence(e.detail));
    n.addEventListener('finished', () => toast('That is the end of the book'));
    n.addEventListener('failed', (e) => toast(`Reading stopped: ${e.detail}`, { error: true }));
    this.narrator = n;
    $('reader-view').classList.add('listening');
    this.bindMediaKeys();
  }

  bindMediaKeys() {
    const { mediaSession } = navigator;
    const cover = this.info.cover ? [{ src: `app://local/cover/${this.info.cover}` }] : [];
    mediaSession.metadata = new MediaMetadata({ title: this.info.title, artist: this.info.author, artwork: cover });
    mediaSession.setActionHandler('play', () => this.togglePlay());
    mediaSession.setActionHandler('pause', () => this.togglePlay());
    mediaSession.setActionHandler('previoustrack', () => this.narrator?.skip(-1));
    mediaSession.setActionHandler('nexttrack', () => this.narrator?.skip(1));
  }

  async playFromPage() {
    const { spine, offset } = this.reader.pager.anchor;
    await this.playFrom(spine, offset ?? 0);
  }

  async playFrom(spine, offset) {
    this.following = true;
    await this.narrator.playFrom(spine, offset);
  }

  /** Start reading at a chosen place, opening the player first if needed. */
  async listenFrom(spine, offset) {
    if (!this.narrator) await this.show();
    if (this.narrator) await this.playFrom(spine, offset);
  }

  togglePlay() {
    const n = this.narrator;
    if (!n) return;
    if (n.playing) n.pause();
    else if (n.started) n.resume();
    else this.playFromPage();
  }

  onSentence(sentence) {
    this.reader.setNarrated(sentence);
    if (this.following) this.reader.revealNarration(sentence);
    this.renderState();
  }

  /** Paging by hand while listening: stop pulling the page back to the voice. */
  noteManualTurn() {
    if (this.narrator?.playing) {
      this.following = false;
      this.renderState();
    }
  }

  findPlace() {
    this.following = true;
    const { current } = this.reader;
    if (current) this.reader.revealNarration(current);
    this.renderState();
  }

  renderControls() {
    const button = (id, ico, title, onclick) => el('button', { class: 'ico', id, title, ariaLabel: title, onclick, dataset: { ico } });
    const select = (label, options, value, onchange) => el('select', {
      class: 'field', title: label, ariaLabel: label, onchange: (e) => onchange(Number(e.target.value)),
    }, ...options.map(([v, text]) => el('option', { value: String(v), selected: v === value }, text)));

    const controls = el('div', { class: 'player-row' },
      button('p-prev', 'prev', 'Previous sentence', () => this.narrator?.skip(-1)),
      button('p-play', 'pause', 'Play or pause (P)', () => this.togglePlay()),
      button('p-next', 'next', 'Next sentence', () => this.narrator?.skip(1)),
      el('button', { class: 'voice-pick', id: 'p-voice', title: 'Choose a voice', onclick: () => this.toggleVoices() }),
      select('Reading speed', RATES.map((r) => [r, `${r}×`]), this.settings.rate, (r) => this.setRate(r)),
      select('Sleep timer', SLEEP_MINUTES.map((m) => [m, m ? `Stop in ${m} min` : 'No sleep timer']), this.sleepMinutes ?? 0, (m) => this.setSleep(m)),
      el('button', { class: 'follow', id: 'p-follow', hidden: true, onclick: () => this.findPlace() }, 'Find my place'),
      button('p-close', 'close', 'Stop listening', () => this.close()));
    $('player').replaceChildren(controls, el('div', { class: 'player-status', id: 'p-status' }));
    applyIcons($('player'));
    this.renderState();
  }

  renderState() {
    const play = $('p-play');
    if (!play || !this.narrator) return;
    const { playing } = this.narrator;
    if (play.dataset.ico !== (playing ? 'pause' : 'play')) {
      play.dataset.ico = playing ? 'pause' : 'play';
      applyIcons($('player'));
    }
    const voice = this.voices.find((v) => v.id === this.narrator.voice);
    $('p-voice').textContent = voice?.name ?? this.narrator.voice;
    $('p-follow').hidden = this.following;
    $('p-status').textContent = this.waiting && playing ? 'Preparing the next sentence…' : '';
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  setRate(rate) {
    this.narrator?.setRate(rate);
    this.reader.setOption('rate', rate);
  }

  setSleep(minutes) {
    this.sleepMinutes = minutes;
    clearTimeout(this.sleepTimer);
    if (!minutes) return;
    this.sleepTimer = setTimeout(() => {
      this.narrator?.pause();
      this.sleepMinutes = 0;
      this.renderControls();
      toast('Sleep timer: paused your book');
    }, minutes * 60000);
  }

  toggleVoices() {
    const panel = $('voice-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) this.renderVoices();
  }

  renderVoices() {
    const sorted = [...this.voices].sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade) || a.name.localeCompare(b.name));
    const row = (v) => el('div', { class: `voice-row${v.id === this.narrator?.voice ? ' on' : ''}` },
      el('button', {
        class: 'voice-try', title: `Hear ${v.name}`, ariaLabel: `Hear ${v.name}`, dataset: { ico: 'play' },
        onclick: (e) => this.tryVoice(v, e.currentTarget),
      }),
      el('button', { class: 'voice-choose', onclick: () => this.chooseVoice(v) },
        el('span', { class: 'voice-name' }, v.name),
        el('span', { class: 'voice-meta' }, `${v.gender}, grade ${v.grade}`)));
    const group = (accent) => [
      el('h3', {}, ACCENTS[accent]),
      ...sorted.filter((v) => v.language === accent).map(row),
    ];
    $('voice-panel').replaceChildren(...group('en-us'), ...group('en-gb'));
    applyIcons($('voice-panel'));
  }

  async tryVoice(voice, button) {
    if (this.narrator?.playing) this.narrator.pause();
    button.classList.add('busy');
    try {
      const wav = await window.folio.tts.synth(PREVIEW, voice.id);
      if (!wav) return;
      URL.revokeObjectURL(this.preview.src);
      this.preview.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      await this.preview.play();
    } catch (err) {
      toast(`That voice could not be previewed: ${err.message}`, { error: true });
    } finally {
      button.classList.remove('busy');
    }
  }

  chooseVoice(voice) {
    this.preview.pause();
    this.reader.setOption('voice', voice.id);
    this.narrator?.setVoice(voice.id);
    $('voice-panel').hidden = true;
    this.renderState();
  }
}
