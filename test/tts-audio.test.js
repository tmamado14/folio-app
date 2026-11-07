'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSpeech, toWav } = require('../main/tts-audio');

const tone = (length = 2400) => Float32Array.from({ length }, (_, i) => 0.4 * Math.sin(i / 8));

test('accepts real sound', () => {
  assert.equal(isSpeech(tone()), true);
});

test('rejects a clip of invalid numbers', () => {
  assert.equal(isSpeech(new Float32Array(2400).fill(NaN)), false);
});

test('rejects a clip with a single invalid sample', () => {
  const clip = tone();
  clip[1200] = NaN;
  assert.equal(isSpeech(clip), false);
  clip[1200] = Infinity;
  assert.equal(isSpeech(clip), false);
});

test('rejects silence and empty clips', () => {
  assert.equal(isSpeech(new Float32Array(2400)), false);
  assert.equal(isSpeech(new Float32Array(0)), false);
});

test('writes a valid 16-bit mono WAV', () => {
  const samples = tone(100);
  const view = new DataView(toWav(samples, 24000));
  const tag = (at) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(36), 'data');
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 200);
  assert.ok(Math.abs(view.getInt16(44 + 20, true) / 0x7fff - samples[10]) < 0.001);
});

test('keeps overdriven samples in range', () => {
  const view = new DataView(toWav(Float32Array.from([5, -5]), 24000));
  assert.equal(view.getInt16(44, true), 0x7fff);
  assert.equal(view.getInt16(46, true), -0x8000);
});
