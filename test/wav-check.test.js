import test from 'node:test';
import assert from 'node:assert/strict';
import { audioOutput, describeAudio, describeWav, inspectAudio, inspectWav, judgeTrack } from '../scripts/wav-check.mjs';

function wav({ seconds = 2, rate = 16000, channels = 1, amplitude = 8000 } = {}) {
  const frames = Math.round(rate * seconds);
  const bytes = frames * channels * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames * channels; i++) b.writeInt16LE(Math.round(amplitude * Math.sin(i / 7)), 44 + i * 2);
  return b;
}

test('the track is the audio output, not the sidecar that sorts first', () => {
  assert.equal(audioOutput([{ name: 'a.json', bytes: 511 }, { name: 'a.wav', bytes: 9 }]).name, 'a.wav');
  assert.equal(audioOutput([{ name: 'a.json' }]), null);
  assert.equal(audioOutput(undefined), null);
});

test('length, rate, channels and loudness come from the bytes', () => {
  const info = inspectWav(wav({ seconds: 3, rate: 32000, channels: 2 }));
  assert.equal(info.ok, true);
  assert.equal(info.rate, 32000);
  assert.equal(info.channels, 2);
  assert.ok(Math.abs(info.seconds - 3) < 0.001);
  assert.ok(info.peak > 0.2 && info.rms > 0.1);
  assert.equal(describeWav(info), '3.0s, 32000 Hz stereo, peak -12 dBFS');
  assert.deepEqual(judgeTrack(info, 3), { ok: true, reason: '' });
});

test('silence, short audio and non-WAV bytes are not real tracks', () => {
  assert.equal(judgeTrack(inspectWav(wav({ amplitude: 0 })), 2).reason, 'the audio is silent');
  assert.match(judgeTrack(inspectWav(wav({ seconds: 1 })), 5).reason, /only 1\.0s of audio \(asked for 5s\)/);
  assert.match(judgeTrack(inspectWav(Buffer.from('{"recipe":{}}')), 5).reason, /not a WAV file|shorter than/);
  assert.match(judgeTrack(inspectWav(wav().subarray(0, 40)), 5).reason, /no data chunk/);
});

/** MPEG-1 layer III frames, 128 kbps 44.1 kHz: 417 bytes and 1152 samples each. */
function mp3(frames, { id3 = false, mono = false } = {}) {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = mono ? 0xc4 : 0x44;
  const tag = id3 ? Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...Buffer.alloc(20)]) : Buffer.alloc(0);
  return Buffer.concat([tag, ...Array.from({ length: frames }, () => frame)]);
}

test('an MP3 is measured by its frames: what the bridge plays since #159', () => {
  const info = inspectAudio(mp3(383, { id3: true, mono: true }));
  assert.equal(info.ok, true, info.reason);
  assert.equal(info.format, 'mp3');
  assert.equal(info.rate, 44100);
  assert.equal(info.channels, 1);
  assert.ok(Math.abs(info.seconds - (383 * 1152) / 44100) < 1e-9);
  assert.equal(describeAudio(info), 'MP3, 10.0s, 44100 Hz mono');
  assert.deepEqual(judgeTrack(info, 10), { ok: true, reason: '' });
  assert.match(judgeTrack(inspectAudio(mp3(40)), 10).reason, /only 1\.0s of audio/);
  assert.equal(inspectAudio(mp3(10)).channels, 2);
  // A WAV still reads as a WAV, and junk as neither.
  assert.equal(describeAudio(inspectAudio(wav({ seconds: 3, rate: 32000, channels: 2 }))), 'WAV, 3.0s, 32000 Hz stereo, peak -12 dBFS');
  assert.equal(inspectAudio(Buffer.from([0xff, 0xfb, 0, 0, 1, 2, 3])).ok, false);
  assert.match(inspectAudio(Buffer.from('{"recipe":{}}')).reason, /not a WAV file/);
});
