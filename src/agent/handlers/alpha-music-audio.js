import { execFile, execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';
import { createLogger } from '../../common/log.js';
import { findGenre } from '../../common/musicGenres.js';
import { resolveExecutable } from '../../common/resolve-executable.js';
import { genreFolder, resolveMusicOutputDir } from './alpha-music.js';

/**
 * Hands back one slice of a track `alpha.music` made, so a person can hear it
 * somewhere other than the machine that made it.
 *
 * `alpha.music` keeps the audio where it was made and returns the recipe,
 * which is right for the queue and wrong for a person who wants to listen.
 * Nothing can reach *into* an agent to fetch a file — every connection is
 * outbound from the agent — so the file has to come back the way everything
 * does: as task results. A request body is capped at 1 MB and a 30-second
 * track is about 2 MB, so it comes back in slices of CHUNK_BYTES, one task
 * each, which the music bridge reassembles and caches (src/bridge/music.js).
 * The coordinator keeps every result in memory, so the bridge fetches each
 * track once and serves every later play from its own disk.
 *
 * What it will not do, and why each matters:
 *   - **Take a path.** The payload names a genre and a file name, and the file
 *     is looked for at exactly `<output>/<genre folder>/<name>`, the place
 *     `alpha.music` files it. A name with a separator, `..`, or anything but
 *     an audio extension is refused before the filesystem is touched, the
 *     `alpha-render-inventory` rule: a handler that can be told where to look
 *     is a file server with a task queue in front of it.
 *   - **Serve a file that changed underneath it.** Every slice reports the
 *     file's size and mtime; the bridge restarts if they move between slices,
 *     because a re-run with the same recipe replaces the file in place and a
 *     download stitched from two versions is noise.
 *
 *
 * **Sent as MP3 when it can be.** With `format: "mp3"` a WAV or FLAC is
 * encoded once (ffmpeg, LAME V2) into `<output>/.compressed/<genre folder>/`,
 * and the slices come from that copy: a 40-second WAV of 7-15 MB becomes about
 * 1 MB, two slices instead of up to thirty, each of them a task through the
 * coordinator. The WAV the generator wrote stays as it is; the copy is
 * re-encoded when the WAV is newer. With no ffmpeg (ALPHA_MUSIC_FFMPEG, then
 * `ffmpeg` on PATH, then the one pip's `imageio-ffmpeg` ships beside the
 * generator's Python) or a failed encode, the original is sent as before, and
 * each slice says which it is (`format`).
 *
 * Opt-in beside `alpha-music`: ALPHA_EXTRA_HANDLERS=alpha-music,alpha-music-audio.
 * Its `available()` asks only for the output directory, not for Python or the
 * generator — a machine whose generator broke still holds every track it made,
 * the same reason `alpha-render-inventory` does not need Blender.
 */

export const type = 'alpha.music.audio';

export const description =
  'Returns one slice of a track alpha.music made, so the Music Creator can play it.';

// Raw bytes per slice. Base64 makes it 4/3 larger, and the result travels in a
// JSON body the coordinator caps at 1 MB, so this leaves room for the envelope.
export const CHUNK_BYTES = 512 * 1024;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(wav|mp3|flac|ogg)$/;
const KNOWN_KEYS = new Set(['genre', 'name', 'offset', 'format']);
const FORMATS = new Set(['original', 'mp3']);
const COMPRESSIBLE = /\.(wav|flac)$/i;
export const COMPRESSED_DIR = '.compressed';
// LAME's V2: transparent for music, about 190 kbps for stereo and less for
// mono, against 1,411 kbps for CD-quality WAV and twice that for float WAV.
export const MP3_QUALITY = '2';
const ENCODE_TIMEOUT_MS = 120_000;

const log = createLogger('handler:alpha.music.audio');

export function validateRequest(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('payload must be { genre, name, offset, format? }');
  }
  const unknown = Object.keys(payload).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ProtocolError(`unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; this takes genre, name, offset, format`);
  }
  if (!findGenre(payload.genre)) throw new ProtocolError(`unknown genre ${JSON.stringify(payload.genre)}`);
  const { name } = payload;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name.includes('..')) {
    throw new ProtocolError(`"name" must be a track file name alpha.music wrote (got ${JSON.stringify(name)})`);
  }
  const offset = payload.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ProtocolError(`"offset" must be a non-negative whole number of bytes (got ${JSON.stringify(payload.offset)})`);
  }
  const format = payload.format ?? 'original';
  if (!FORMATS.has(format)) {
    throw new ProtocolError(`"format" must be "original" or "mp3" (got ${JSON.stringify(payload.format)})`);
  }
  return { genre: payload.genre, name, offset, format };
}

let encoderKey = null;
let encoder = null;

/**
 * The ffmpeg to encode with, or null. Looked up once per configuration, since
 * the imageio-ffmpeg probe starts a Python and every slice asks.
 */
export function findEncoder() {
  const configuredPath = (process.env.ALPHA_MUSIC_FFMPEG ?? '').trim();
  const python = (process.env.ALPHA_MUSIC_PYTHON ?? '').trim() || (process.platform === 'win32' ? 'python' : 'python3');
  const key = `${configuredPath}|${python}|${process.env.PATH ?? ''}`;
  if (key === encoderKey) return encoder;
  encoderKey = key;
  if (configuredPath.toLowerCase() === 'off') encoder = null;
  else if (configuredPath) encoder = resolveExecutable(configuredPath);
  else encoder = resolveExecutable('ffmpeg') ?? imageioFfmpeg(python);
  return encoder;
}

function imageioFfmpeg(python) {
  try {
    const path = execFileSync(python, ['-c', 'import imageio_ffmpeg, sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * The MP3 copy of `source`, encoding it first if there is none newer than it.
 * Null when there is no encoder or the encode failed: the caller then sends
 * the original, which is slower to play but never wrong.
 */
async function mp3Copy(source, sourceMtimeMs, outputDir, genre, name) {
  const ffmpeg = findEncoder();
  if (!ffmpeg) return null;
  const dir = join(outputDir, COMPRESSED_DIR, genreFolder(genre));
  const target = join(dir, name.replace(/\.[^.]+$/, '.mp3'));
  try {
    if (statSync(target).mtimeMs >= sourceMtimeMs) return target;
  } catch {
    // not encoded yet
  }
  mkdirSync(dir, { recursive: true });
  // Written aside and renamed, so a slice never reads a half-written copy.
  const temp = `${target}.${process.pid}-${Date.now()}.part`;
  try {
    await new Promise((resolveEncode, rejectEncode) => {
      execFile(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source, '-vn', '-codec:a', 'libmp3lame', '-q:a', MP3_QUALITY, '-f', 'mp3', temp],
        { timeout: ENCODE_TIMEOUT_MS, windowsHide: true },
        (error) => (error ? rejectEncode(error) : resolveEncode()),
      );
    });
    renameSync(temp, target);
    return target;
  } catch (error) {
    rmSync(temp, { force: true });
    log.warn('could not encode the track as MP3; sending the original', { name, message: error.message });
    return null;
  }
}

export function available() {
  try {
    const outputDir = resolveMusicOutputDir();
    if (!existsSync(outputDir)) {
      return { ok: false, reason: `no music output directory yet at ${outputDir}` };
    }
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

export async function run(payload) {
  const { genre, name, offset, format } = validateRequest(payload);
  const outputDir = resolveMusicOutputDir();
  const dir = join(outputDir, genreFolder(genre));
  const path = resolve(dir, name);
  // Belt and braces: the name pattern already rules out separators.
  if (!path.startsWith(dir + sep)) throw new ProtocolError('track name resolves outside the output directory');

  let sourceMtimeMs;
  try {
    sourceMtimeMs = statSync(path).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ProtocolError(`no track ${JSON.stringify(name)} on this machine`, { status: 404, code: 'no_track' });
    }
    throw error;
  }
  if (format === 'mp3' && COMPRESSIBLE.test(name)) {
    const copy = await mp3Copy(path, sourceMtimeMs, outputDir, genre, name);
    if (copy) return { ...readSlice(copy, offset), name: name.replace(/\.[^.]+$/, '.mp3'), source: name, format: 'mp3' };
  }
  return { ...readSlice(path, offset), name, source: name, format: 'original' };
}

function readSlice(path, offset) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (offset > stat.size) {
      throw new ProtocolError(`offset ${offset} is past the end of the track (${stat.size} bytes)`, { code: 'bad_offset' });
    }
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - offset));
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return {
      offset,
      bytes: read,
      totalBytes: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      data: buffer.subarray(0, read).toString('base64'),
    };
  } finally {
    closeSync(fd);
  }
}
