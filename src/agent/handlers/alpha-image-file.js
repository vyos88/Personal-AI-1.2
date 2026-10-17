import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { ProtocolError } from '../../common/protocol.js';
import { IMAGE_NAME_PATTERN, resolveImageOutputDir } from './alpha-image.js';

/**
 * Hands back one slice of a PNG `alpha.image` made, so the image bridge can
 * give it to Alpha. The same shape as `alpha.music.audio`, for the same
 * reason: nothing can reach into an agent to fetch a file, a request body is
 * capped at 1 MB, and a 1024x1024 PNG can be well over that once base64'd, so
 * it comes back in CHUNK_BYTES slices, one task each.
 *
 * It takes a name, never a path: the name must be one `alpha.image` could have
 * written (IMAGE_NAME_PATTERN — no separators, no `..`), and it is looked for
 * directly in ALPHA_IMAGE_OUTPUT. A handler that can be told where to look is
 * a file server with a task queue in front of it.
 *
 * Opt-in beside `alpha-image`: ALPHA_EXTRA_HANDLERS=alpha-image,alpha-image-file.
 * Its `available()` asks for nothing: the output directory is created by the
 * first render, and an agent decides what it offers once, at start.
 */

export const type = 'alpha.image.file';

export const description =
  'Returns one slice of a PNG alpha.image made, so the image bridge can hand it to Alpha.';

// Raw bytes per slice. Base64 makes it 4/3 larger, and the result travels in a
// JSON body the coordinator caps at 1 MB, so this leaves room for the envelope.
export const CHUNK_BYTES = 512 * 1024;

const KNOWN_KEYS = new Set(['name', 'offset']);

export function validateRequest(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('payload must be { name, offset }');
  }
  const unknown = Object.keys(payload).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ProtocolError(`unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; this takes name, offset`);
  }
  const { name } = payload;
  if (typeof name !== 'string' || !IMAGE_NAME_PATTERN.test(name) || name.includes('..')) {
    throw new ProtocolError(`"name" must be an image file name alpha.image wrote (got ${JSON.stringify(name)})`);
  }
  const offset = payload.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ProtocolError(`"offset" must be a non-negative whole number of bytes (got ${JSON.stringify(payload.offset)})`);
  }
  return { name, offset };
}

export function available() {
  try {
    resolveImageOutputDir();
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

export async function run(payload) {
  const { name, offset } = validateRequest(payload);
  const dir = resolveImageOutputDir();
  const path = resolve(dir, name);
  // Belt and braces: the name pattern already rules out separators.
  if (!path.startsWith(dir + sep)) throw new ProtocolError('image name resolves outside the output directory');

  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ProtocolError(`no image ${JSON.stringify(name)} on this machine`, { status: 404, code: 'no_image' });
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
