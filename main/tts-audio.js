'use strict';
// Checks and encodes what the voice model produces.

const SAMPLE_BITS = 16;
const SILENCE_PEAK = 1e-4;

/**
 * A model can return invalid numbers instead of sound. Encoded to WAV those become
 * silence that plays and "ends" normally, so a sentence vanishes with no error.
 * Every clip has to pass this before it can reach the listener.
 */
function isSpeech(samples) {
  let peak = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) return false;
    peak = Math.max(peak, Math.abs(value));
  }
  return peak > SILENCE_PEAK;
}

function toWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const wav = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wav);
  const text = (at, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, SAMPLE_BITS, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return wav;
}

module.exports = { isSpeech, toWav };
