// Reads a book aloud, one sentence at a time. A few sentences are synthesized
// ahead of the listener so speech is continuous even though each is generated
// on demand. Reports each sentence as it starts so the page can follow along.

const SYSTEM_VOICE = 'system:';
const LOOKAHEAD = 4;
const PARAGRAPH_PAUSE_MS = 240;
const CHAPTER_PAUSE_MS = 900;

export class Narrator extends EventTarget {
  constructor(book, { voice, rate, audio }) {
    super();
    this.book = book;
    this.voice = voice;
    this.rate = rate;
    this.cursor = null;
    this.run = 0;
    this.playing = false;
    this.clips = new Map();
    this.audio = audio;
    this.audio.preservesPitch = true;
    this.sentenceCache = new Map();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async sentencesOf(spine) {
    if (!this.sentenceCache.has(spine)) this.sentenceCache.set(spine, await this.book.sentences(spine));
    return this.sentenceCache.get(spine);
  }

  /** The sentence at or after a position, moving into later chapters if needed. */
  async settle({ spine, i }) {
    for (let s = spine, at = i; s < this.book.spine.length; s += 1, at = 0) {
      const list = await this.sentencesOf(s);
      if (at < list.length) return { spine: s, i: at, sentence: list[at], list };
    }
    return null;
  }

  async previous({ spine, i }) {
    for (let s = spine, at = i - 1; s >= 0; s -= 1, at = Infinity) {
      const list = await this.sentencesOf(s);
      if (list.length) return { spine: s, i: Math.min(at, list.length - 1) };
      if (s === 0) break;
    }
    return { spine: 0, i: 0 };
  }

  clipKey({ spine, i }) {
    return `${this.voice}|${spine}|${i}`;
  }

  clipFor(item) {
    const key = this.clipKey(item);
    if (!this.clips.has(key)) {
      const clip = window.folio.tts.synth(item.sentence.text, this.voice).then((wav) => {
        if (!wav) throw new Error('cancelled');
        return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      });
      clip.catch(() => {});
      this.clips.set(key, clip);
    }
    return this.clips.get(key);
  }

  get usesSystemVoice() {
    return this.voice.startsWith(SYSTEM_VOICE);
  }

  /** Speaks through the device's own voices. Resolves false if interrupted. */
  speak(text, run) {
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const uri = this.voice.slice(SYSTEM_VOICE.length);
      utterance.voice = speechSynthesis.getVoices().find((v) => v.voiceURI === uri) ?? null;
      utterance.rate = this.rate;
      const done = (result) => {
        this.finishClip = null;
        resolve(result);
      };
      utterance.onend = () => done(run === this.run);
      utterance.onerror = (e) => {
        if (run === this.run && !/cancel|interrupt/.test(e.error)) reject(new Error('The device voice stopped working'));
        else done(false);
      };
      this.utterance = utterance;
      this.finishClip = () => done(false);
      speechSynthesis.speak(utterance);
    });
  }

  async prefetch(from) {
    if (this.usesSystemVoice) return;
    let at = { spine: from.spine, i: from.i + 1 };
    for (let n = 0; n < LOOKAHEAD; n += 1) {
      const item = await this.settle(at);
      if (!item) return;
      this.clipFor(item);
      at = { spine: item.spine, i: item.i + 1 };
    }
  }

  dropClip(key) {
    const clip = this.clips.get(key);
    this.clips.delete(key);
    clip?.then((url) => URL.revokeObjectURL(url), () => {});
  }

  dropAllClips() {
    for (const key of [...this.clips.keys()]) this.dropClip(key);
    window.folio.tts.cancel();
  }

  /** Plays one clip to its end. Resolves false if the listener moved elsewhere. */
  playClip(url, run) {
    return new Promise((resolve, reject) => {
      const { audio } = this;
      const done = (result) => {
        audio.removeEventListener('ended', onEnd);
        audio.removeEventListener('error', onError);
        this.finishClip = null;
        resolve(result);
      };
      const onEnd = () => done(run === this.run);
      const onError = () => {
        if (run === this.run) reject(new Error('This sentence could not be played'));
        else done(false);
      };
      this.finishClip = () => done(false);
      audio.addEventListener('ended', onEnd);
      audio.addEventListener('error', onError);
      audio.src = url;
      audio.defaultPlaybackRate = this.rate;
      audio.playbackRate = this.rate;
      if (this.playing) audio.play().catch(() => {});
    });
  }

  async loop(run) {
    try {
      while (run === this.run) {
        const item = await this.settle(this.cursor);
        if (run !== this.run) return;
        if (!item) {
          this.playing = false;
          this.emit('state');
          this.emit('finished');
          return;
        }
        this.cursor = { spine: item.spine, i: item.i };
        this.prefetch(item);

        let finished;
        if (this.usesSystemVoice) {
          await this.whilePaused(run);
          if (run !== this.run) return;
          this.emit('sentence', { spine: item.spine, ...item.sentence });
          finished = await this.speak(item.sentence.text, run);
        } else {
          this.emit('waiting', true);
          const url = await this.clipFor(item);
          if (run !== this.run) return;
          this.emit('waiting', false);
          this.emit('sentence', { spine: item.spine, ...item.sentence });
          finished = await this.playClip(url, run);
          this.dropClip(this.clipKey(item));
        }
        if (!finished) return;

        const next = item.list[item.i + 1];
        const pause = !next ? CHAPTER_PAUSE_MS : next.block !== item.sentence.block ? PARAGRAPH_PAUSE_MS : 0;
        if (pause) await new Promise((r) => setTimeout(r, pause / this.rate));
        await this.whilePaused(run);
        if (run !== this.run) return;
        this.cursor = { spine: item.spine, i: item.i + 1 };
      }
    } catch (err) {
      if (run !== this.run) return;
      this.playing = false;
      this.emit('waiting', false);
      this.emit('state');
      this.emit('failed', err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }

  whilePaused(run) {
    if (this.playing || run !== this.run) return Promise.resolve();
    return new Promise((resolve) => { this.resumePause = resolve; });
  }

  /** Starts over from a cursor, dropping whatever was playing or queued. */
  restart(cursor) {
    this.run += 1;
    window.speechSynthesis?.cancel();
    this.finishClip?.();
    this.resumePause?.();
    this.resumePause = null;
    this.audio.pause();
    this.cursor = cursor;
    this.playing = true;
    this.emit('state');
    this.loop(this.run);
  }

  /** Begin at the first sentence ending after this position in a chapter. */
  async playFrom(spine, offset = 0) {
    const list = await this.sentencesOf(spine);
    const i = list.findIndex((s) => s.end > offset);
    this.dropAllClips();
    this.restart(i === -1 ? { spine: spine + 1, i: 0 } : { spine, i });
  }

  get started() {
    return this.cursor !== null;
  }

  pause() {
    this.playing = false;
    this.audio.pause();
    if (this.usesSystemVoice) speechSynthesis.pause();
    this.emit('state');
  }

  resume() {
    this.playing = true;
    if (this.usesSystemVoice) speechSynthesis.resume();
    else if (this.audio.src && !this.audio.ended) this.audio.play().catch(() => {});
    this.resumePause?.();
    this.resumePause = null;
    this.emit('state');
  }

  async skip(dir) {
    if (!this.cursor) return;
    const { spine, i } = this.cursor;
    this.restart(dir > 0 ? { spine, i: i + 1 } : await this.previous({ spine, i }));
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
  }

  /** Clips are voice-specific, so restart the current sentence in the new voice. */
  setVoice(voice) {
    this.voice = voice;
    this.dropAllClips();
    if (this.cursor) this.restart(this.cursor);
  }

  stop() {
    this.run += 1;
    this.playing = false;
    window.speechSynthesis?.cancel();
    this.finishClip?.();
    this.resumePause?.();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.dropAllClips();
    this.cursor = null;
    this.emit('state');
  }
}
