/**
 * What a generated track really holds, read from its bytes rather than
 * taken on trust.
 *
 * On 2026-10-06 the live test reported every track as "511 bytes, plays
 * (WAV)": it printed the size of the task's first output, which sorts before
 * the WAV because it is the `.json` sidecar, and it only checked the first 12
 * bytes for a RIFF header. A silent or truncated track would have passed the
 * same way. This reads the whole file: the format, how many seconds it
 * holds, and how loud it is, so "real audio" is a measured claim.
 */

const AUDIO_NAME = /\.(wav|mp3|flac|ogg)$/i;

/** The track among a task's outputs; the sidecar and anything else are not it. */
export function audioOutput(outputs) {
  return (Array.isArray(outputs) ? outputs : []).find((o) => typeof o?.name === 'string' && AUDIO_NAME.test(o.name)) ?? null;
}

/**
 * Inspect a WAV file. Returns { ok, reason, seconds, rate, channels, bits,
 * peak, rms } where peak and rms are 0..1 of full scale (16-bit PCM only;
 * other sample formats report the length but no loudness).
 */
export function inspectWav(buf) {
  const fail = (reason) => ({ ok: false, reason, seconds: 0, rate: 0, channels: 0, bits: 0, peak: 0, rms: 0 });
  if (!Buffer.isBuffer(buf) || buf.length < 12) return fail('shorter than a WAV header');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return fail('not a WAV file (no RIFF/WAVE header)');
  let fmt = null;
  let data = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
      break;
    }
    at = body + size + (size % 2);
  }
  if (!fmt) return fail('no fmt chunk');
  if (!data) return fail('no data chunk');
  const { channels, rate, bits } = fmt;
  const frameBytes = channels * (bits / 8);
  if (!channels || !rate || !frameBytes) return fail('a format that cannot hold audio');
  const seconds = data.length / (rate * frameBytes);
  let peak = 0;
  let rms = 0;
  if (fmt.format === 1 && bits === 16) {
    const n = Math.floor(data.length / 2);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(data.readInt16LE(i * 2)) / 32768;
      if (v > peak) peak = v;
      sum += v * v;
    }
    rms = n ? Math.sqrt(sum / n) : 0;
  }
  return { ok: true, reason: '', seconds, rate, channels, bits, peak, rms };
}

/**
 * Is this real audio of about the length asked for? A track is "real" when
 * it holds at least 80% of the seconds requested and is not silence (peak
 * above -40 dBFS). Formats whose loudness we do not measure pass on length.
 */
export function judgeTrack(info, wantSeconds) {
  if (!info.ok) return { ok: false, reason: info.reason };
  if (info.seconds < 0.8 * wantSeconds) return { ok: false, reason: `only ${info.seconds.toFixed(1)}s of audio (asked for ${wantSeconds}s)` };
  if (info.bits === 16 && info.peak < 0.01) return { ok: false, reason: 'the audio is silent' };
  return { ok: true, reason: '' };
}

/** "5.0s, 32000 Hz mono, peak -6 dBFS" */
export function describeWav(info) {
  const db = (x) => (x > 0 ? `${Math.round(20 * Math.log10(x))} dBFS` : '-inf dBFS');
  const layout = info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} ch`;
  return `${info.seconds.toFixed(1)}s, ${info.rate} Hz ${layout}${info.bits === 16 ? `, peak ${db(info.peak)}` : ''}`;
}
