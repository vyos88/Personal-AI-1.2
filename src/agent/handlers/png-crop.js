import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Crops an 8-bit, non-interlaced RGB or RGBA PNG down to its top-left
 * `width x height`, dropping everything to the right of and below it.
 *
 * This exists for one reason: Chromium's headless `--screenshot` writes a
 * bitmap the size of `--window-size`, but the page's actual content viewport
 * is shorter than that by however much vertical space this build of Chromium
 * reserves for a toolbar it never draws in headless mode — verified on
 * Chromium 141 at ~85-90px, constant across requested heights, present under
 * both `--headless` and `--headless=new`. `alpha-grow-render.js` works around
 * it by asking for a window taller than the picture it wants, drawing its
 * canvas at the top-left corner (never resized to fill the viewport), and
 * cropping the extra strip off here — which is reliable regardless of the
 * exact deficit, as long as the requested margin exceeds it. There is no
 * flag that fixes this from the CLI, and the actual fix (Chrome DevTools
 * Protocol's `Emulation.setDeviceMetricsOverride`) needs a client this repo
 * has no business depending on for one crop.
 *
 * Implemented on `node:zlib` alone: parse the chunks by hand, inflate the
 * `IDAT` stream, undo the per-scanline filter PNG requires, slice out the
 * rows and columns wanted, re-filter with "None" (larger IDAT, but correct,
 * and there is no reason to spend code shrinking a screenshot further),
 * deflate, and reassemble. No image library, because this repository has
 * none and one crop is not a reason to add one.
 */
export function cropPngTopLeft(buffer, width, height) {
  requireSignature(buffer);
  const chunks = readChunks(buffer);

  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  const srcWidth = ihdr.data.readUInt32BE(0);
  const srcHeight = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  const bpp = bytesPerPixel(colorType);
  if (bitDepth !== 8 || interlace !== 0 || bpp === null) {
    throw new Error(
      `cannot crop this PNG: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace} ` +
        '(only 8-bit, non-interlaced RGB or RGBA is supported)',
    );
  }
  if (width > srcWidth || height > srcHeight) {
    throw new Error(`cannot crop to ${width}x${height} from a ${srcWidth}x${srcHeight} image`);
  }

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat);
  const unfiltered = unfilterAll(raw, srcWidth, srcHeight, bpp);

  const srcStride = srcWidth * bpp;
  const dstStride = width * bpp;
  const croppedRaw = Buffer.alloc(height * (dstStride + 1));
  for (let y = 0; y < height; y += 1) {
    const dstRowStart = y * (dstStride + 1);
    croppedRaw[dstRowStart] = 0; // filter type 0: None
    unfiltered.copy(croppedRaw, dstRowStart + 1, y * srcStride, y * srcStride + dstStride);
  }

  const newIhdr = Buffer.alloc(13);
  newIhdr.writeUInt32BE(width, 0);
  newIhdr.writeUInt32BE(height, 4);
  ihdr.data.copy(newIhdr, 8, 8, 13); // bit depth, colour type, compression, filter, interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', newIhdr),
    chunk('IDAT', deflateSync(croppedRaw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function requireSignature(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)');
  }
}

function bytesPerPixel(colorType) {
  if (colorType === 2) return 3; // RGB
  if (colorType === 6) return 4; // RGBA
  return null; // grayscale, palette, grayscale+alpha: not what a screenshot produces
}

function readChunks(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length; // length + type + data + crc
  }
  return chunks;
}

/** Undoes the PNG filter applied to every scanline, per the spec's own algorithm. */
function unfilterAll(raw, width, height, bpp) {
  const stride = width * bpp;
  const rowBytes = stride + 1; // leading filter-type byte
  const out = Buffer.alloc(height * stride);
  let prevRow = Buffer.alloc(stride); // the "row above" row 0 is defined as all zero

  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * rowBytes];
    const src = raw.subarray(y * rowBytes + 1, y * rowBytes + 1 + stride);
    const dst = out.subarray(y * stride, (y + 1) * stride);
    unfilterRow(filterType, src, prevRow, dst, bpp);
    prevRow = dst;
  }
  return out;
}

function unfilterRow(filterType, src, prevRow, dst, bpp) {
  for (let i = 0; i < src.length; i += 1) {
    const left = i >= bpp ? dst[i - bpp] : 0;
    const up = prevRow[i];
    const upLeft = i >= bpp ? prevRow[i - bpp] : 0;
    let value = src[i];
    switch (filterType) {
      case 0: // None
        break;
      case 1: // Sub
        value = (value + left) & 0xff;
        break;
      case 2: // Up
        value = (value + up) & 0xff;
        break;
      case 3: // Average
        value = (value + Math.floor((left + up) / 2)) & 0xff;
        break;
      case 4: // Paeth
        value = (value + paethPredictor(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`unsupported PNG filter type ${filterType}`);
    }
    dst[i] = value;
  }
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}
