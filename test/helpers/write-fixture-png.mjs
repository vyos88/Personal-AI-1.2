#!/usr/bin/env node
// Writes a valid, solid-colour, 8-bit RGB PNG at the given size. Used only by
// test fixtures standing in for a real browser's `--screenshot` output: it
// has to be a real PNG so `cropPngTopLeft` (src/agent/handlers/png-crop.js)
// has something genuine to decode, not just a placeholder text file.
//
// Usage: node write-fixture-png.mjs <width> <height> <outPath>

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const [, , widthArg, heightArg, outPath] = process.argv;
const width = Number(widthArg);
const height = Number(heightArg);

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
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

const stride = width * 3;
const raw = Buffer.alloc(height * (stride + 1));
for (let y = 0; y < height; y += 1) {
  raw[y * (stride + 1)] = 0; // filter type: None
  for (let x = 0; x < stride; x += 1) {
    raw[y * (stride + 1) + 1 + x] = (x + y) % 256; // arbitrary but non-uniform
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: RGB
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter method
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  SIGNATURE,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(outPath, png);
