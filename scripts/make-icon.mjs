// Generates a multi-size Windows .ico (16, 24, 32, 48, 64, 128, 256 px) from build/icon.png
// using pure Node.js built-ins (node:zlib, node:fs) with premultiplied-alpha area-averaging
// downsampling, 32-bit BGRA DIB + 1-bit AND masks (16..128), and embedded PNG (256).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TARGET_SIZES = [16, 24, 32, 48, 64, 128, 256];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
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

function decodePng(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = 0;
  let filterMethod = 0;
  let interlace = 0;
  const idatChunks = [];
  let sawIhdr = false;
  let sawIend = false;

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new Error(`Truncated PNG chunk: ${type}`);
    const data = buf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      if (length < 13) throw new Error('Invalid IHDR chunk length');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      compression = data.readUInt8(10);
      filterMethod = data.readUInt8(11);
      interlace = data.readUInt8(12);
      sawIhdr = true;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
    offset = dataEnd + 4;
  }

  if (!sawIhdr || !sawIend || width <= 0 || height <= 0) {
    throw new Error('Incomplete PNG file');
  }
  if (bitDepth !== 8 || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, interlace=${interlace})`);
  }
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`Unsupported PNG colorType=${colorType} (expected 6 RGBA or 2 RGB)`);
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const expectedLen = height * (stride + 1);
  if (raw.length < expectedLen) {
    throw new Error(`Inflated PNG data too short (${raw.length} < ${expectedLen})`);
  }

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const rowIn = y * (stride + 1);
    const filter = raw[rowIn];
    const rowOut = y * stride;
    const prevOut = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const val = raw[rowIn + 1 + x];
      const a = x >= bpp ? pixels[rowOut + x - bpp] : 0;
      const b = y > 0 ? pixels[prevOut + x] : 0;
      const c = (x >= bpp && y > 0) ? pixels[prevOut + x - bpp] : 0;
      let recon;
      switch (filter) {
        case 0: recon = val; break;
        case 1: recon = (val + a) & 0xff; break;
        case 2: recon = (val + b) & 0xff; break;
        case 3: recon = (val + ((a + b) >> 1)) & 0xff; break;
        case 4: recon = (val + paethPredictor(a, b, c)) & 0xff; break;
        default: throw new Error(`Unknown PNG scanline filter: ${filter}`);
      }
      pixels[rowOut + x] = recon;
    }
  }

  if (colorType === 6) return { width, height, rgba: pixels };

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

function downsampleRgba(srcRgba, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return new Uint8Array(srcRgba);
  const dst = new Uint8Array(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = dy * scaleY;
    const sy1 = (dy + 1) * scaleY;
    const iy0 = Math.floor(sy0);
    const iy1 = Math.min(srcH - 1, Math.ceil(sy1) - 1);

    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = dx * scaleX;
      const sx1 = (dx + 1) * scaleX;
      const ix0 = Math.floor(sx0);
      const ix1 = Math.min(srcW - 1, Math.ceil(sx1) - 1);

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let totalWeight = 0;

      for (let sy = iy0; sy <= iy1; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = ix0; sx <= ix1; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          const w = wx * wy;
          if (w <= 0) continue;
          const idx = (sy * srcW + sx) * 4;
          const a = srcRgba[idx + 3] / 255;
          sumR += srcRgba[idx] * a * w;
          sumG += srcRgba[idx + 1] * a * w;
          sumB += srcRgba[idx + 2] * a * w;
          sumA += srcRgba[idx + 3] * w;
          totalWeight += w;
        }
      }

      const outIdx = (dy * dstW + dx) * 4;
      if (totalWeight > 0) {
        const avgA = sumA / totalWeight;
        const alphaFrac = avgA / 255;
        dst[outIdx + 3] = Math.min(255, Math.max(0, Math.round(avgA)));
        if (alphaFrac > 1e-6) {
          dst[outIdx] = Math.min(255, Math.max(0, Math.round(sumR / (totalWeight * alphaFrac))));
          dst[outIdx + 1] = Math.min(255, Math.max(0, Math.round(sumG / (totalWeight * alphaFrac))));
          dst[outIdx + 2] = Math.min(255, Math.max(0, Math.round(sumB / (totalWeight * alphaFrac))));
        }
      }
    }
  }
  return dst;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, crcInput, crcBuf]);
}

function encodePngRgba(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  ihdr.writeUInt8(0, 10); // deflate
  ihdr.writeUInt8(0, 11); // adaptive filtering
  ihdr.writeUInt8(0, 12); // non-interlaced

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const outRow = y * (stride + 1);
    raw[outRow] = 0; // Filter None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, outRow + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeDibIcon(rgba, size) {
  const headerSize = 40;
  const xorSize = size * size * 4;
  const andRowBytes = Math.ceil(size / 32) * 4;
  const andSize = andRowBytes * size;
  const buf = Buffer.alloc(headerSize + xorSize + andSize);

  buf.writeUInt32LE(headerSize, 0); // biSize
  buf.writeInt32LE(size, 4); // biWidth
  buf.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  buf.writeUInt16LE(1, 12); // biPlanes
  buf.writeUInt16LE(32, 14); // biBitCount
  buf.writeUInt32LE(0, 16); // BI_RGB
  buf.writeUInt32LE(xorSize + andSize, 20); // biSizeImage

  // Bottom-up BGRA XOR mask
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = headerSize + y * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      buf[d] = rgba[s + 2]; // B
      buf[d + 1] = rgba[s + 1]; // G
      buf[d + 2] = rgba[s]; // R
      buf[d + 3] = rgba[s + 3]; // A
    }
  }

  // Bottom-up 1-bit AND mask (1 = transparent where alpha == 0)
  const andStart = headerSize + xorSize;
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = andStart + y * andRowBytes;
    for (let x = 0; x < size; x++) {
      const alpha = rgba[srcRow + x * 4 + 3];
      if (alpha === 0) {
        buf[dstRow + (x >> 3)] |= 1 << (7 - (x & 7));
      }
    }
  }

  return buf;
}

export function buildIcoFromPng(pngBuffer) {
  const { width, height, rgba } = decodePng(pngBuffer);
  const images = TARGET_SIZES.map((size) => {
    const scaled = downsampleRgba(rgba, width, height, size, size);
    const data = size >= 256 ? encodePngRgba(scaled, size, size) : encodeDibIcon(scaled, size);
    return { size, data };
  });

  const dirSize = 6 + images.length * 16;
  const header = Buffer.alloc(dirSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(images.length, 4);

  let offset = dirSize;
  for (let i = 0; i < images.length; i++) {
    const { size, data } = images[i];
    const entryOff = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entryOff);
    header.writeUInt8(size >= 256 ? 0 : size, entryOff + 1);
    header.writeUInt8(0, entryOff + 2); // color palette
    header.writeUInt8(0, entryOff + 3); // reserved
    header.writeUInt16LE(1, entryOff + 4); // planes
    header.writeUInt16LE(32, entryOff + 6); // bpp
    header.writeUInt32LE(data.length, entryOff + 8);
    header.writeUInt32LE(offset, entryOff + 12);
    offset += data.length;
  }

  return Buffer.concat([header, ...images.map((im) => im.data)]);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pngPath = path.join(root, 'build', 'icon.png');
  const icoPath = path.join(root, 'build', 'icon.ico');
  const ico = buildIcoFromPng(fs.readFileSync(pngPath));
  fs.writeFileSync(icoPath, ico);
  console.log(`Generated ${icoPath} (${ico.length} bytes, sizes: ${TARGET_SIZES.join(', ')}px)`);
}
