import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';
import { findGenre } from '../../common/musicGenres.js';
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
const KNOWN_KEYS = new Set(['genre', 'name', 'offset']);

export function validateRequest(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('payload must be { genre, name, offset }');
  }
  const unknown = Object.keys(payload).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ProtocolError(`unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; this takes genre, name, offset`);
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
  return { genre: payload.genre, name, offset };
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
  const { genre, name, offset } = validateRequest(payload);
  const outputDir = resolveMusicOutputDir();
  const dir = join(outputDir, genreFolder(genre));
  const path = resolve(dir, name);
  // Belt and braces: the name pattern already rules out separators.
  if (!path.startsWith(dir + sep)) throw new ProtocolError('track name resolves outside the output directory');

  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ProtocolError(`no track ${JSON.stringify(name)} on this machine`, { status: 404, code: 'no_track' });
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (offset > stat.size) {
      throw new ProtocolError(`offset ${offset} is past the end of ${name} (${stat.size} bytes)`);
    }
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - offset));
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return {
      name,
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
