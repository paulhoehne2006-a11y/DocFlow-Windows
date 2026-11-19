// Browser & Playwright stand-in for the Electron `window.docflow` bridge.
// Implements 100% of `PROJECT.md § Interface Contracts §1`, persists state in `localStorage`,
// and seeds 3 rich `.docflownote` bundles + a 3-level nested `.docflow-workspace.json` tree.

import { createNotebook, writeBundle, DEFAULT_MARGIN_WIDTH } from './model.js';
import { FOLDER_COLORS, COVER_COLORS } from './folders.js';
import { PDFDocument, StandardFonts } from '../vendor/pdf-lib.esm.min.js';

const STORAGE_KEYS = {
  meta: 'docflow.demo.v1.meta',
  files: 'docflow.demo.v1.files',
  workspace: 'docflow.demo.v1.workspace',
  trash: 'docflow.demo.v1.trash',
};

const TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_DEMO_FOLDER = 'C:\\Users\\Demo\\OneDrive\\DocFlow Studio';
const BACKUPS_DEMO_DIR = 'C:\\Users\\Demo\\AppData\\Roaming\\DocFlow Studio\\backups';

function getStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function getSearchParams() {
  try {
    return typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  } catch {
    return new URLSearchParams();
  }
}

function u8ToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (typeof btoa === 'function') {
    let bin = '';
    const chunkSize = 0x2000;
    for (let i = 0; i < u8.length; i += chunkSize) {
      bin += String.fromCharCode(...u8.subarray(i, i + chunkSize));
    }
    return btoa(bin);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(u8).toString('base64');
  }
  throw new Error('No base64 encoder available');
}

function base64ToU8(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  throw new Error('No base64 decoder available');
}

function cloneObj(val) {
  if (val == null) return val;
  if (typeof structuredClone === 'function') return structuredClone(val);
  return JSON.parse(JSON.stringify(val));
}

function isGoogleDrivePath(folder) {
  if (!folder) return false;
  const lower = String(folder).toLowerCase();
  return lower.includes('meine ablage') || lower.includes('my drive') || lower.includes('google drive');
}

function isAllowedHttpsUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl ?? '').trim());
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function assignFolder(nb, folderId, folderPath) {
  if (typeof nb.setFolder === 'function') {
    nb.setFolder(folderId, folderPath);
  } else {
    nb.manifest.notebook = { ...(nb.manifest.notebook ?? {}), folderId, folderPath };
    nb.metaDirty = true;
  }
}

// ---- Pure-JS Valid PNG + WAV Generators (zero DOM dependency for fallback) ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

function encodeRgbaPngFallback(width = 64, height = 40) {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 4;
      const border = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
      const axis = x === 12 || y === height - 10;
      const diag = Math.abs((y - (height - 10)) + Math.round((x - 12) * 0.5)) <= 1 && x >= 12 && x < width - 8;
      if (border) {
        raw[p] = 79; raw[p + 1] = 70; raw[p + 2] = 229; raw[p + 3] = 255;
      } else if (diag) {
        raw[p] = 15; raw[p + 1] = 118; raw[p + 2] = 110; raw[p + 3] = 255;
      } else if (axis) {
        raw[p] = 30; raw[p + 1] = 41; raw[p + 2] = 59; raw[p + 3] = 255;
      } else {
        raw[p] = 248; raw[p + 1] = 250; raw[p + 2] = 252; raw[p + 3] = 255;
      }
    }
  }
  const zlib = new Uint8Array(2 + 5 + raw.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib[2] = 0x01; // final uncompressed block
  zlib[3] = raw.length & 0xff;
  zlib[4] = (raw.length >>> 8) & 0xff;
  const nlen = (~raw.length) & 0xffff;
  zlib[5] = nlen & 0xff;
  zlib[6] = (nlen >>> 8) & 0xff;
  zlib.set(raw, 7);
  new DataView(zlib.buffer).setUint32(7 + raw.length, adler32(raw), false);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const c1 = pngChunk('IHDR', ihdr);
  const c2 = pngChunk('IDAT', zlib);
  const c3 = pngChunk('IEND', new Uint8Array(0));
  const out = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  let off = 0;
  for (const part of [sig, c1, c2, c3]) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

async function createSamplePngBytes() {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(180, 110);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, 180, 110);
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = 2;
      ctx.strokeRect(2, 2, 176, 106);
      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(20, 88);
      ctx.lineTo(160, 88);
      ctx.moveTo(24, 92);
      ctx.lineTo(24, 18);
      ctx.stroke();
      ctx.strokeStyle = '#0f766e';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(24, 88);
      ctx.lineTo(140, 30);
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('F = m · a', 66, 36);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return new Uint8Array(await blob.arrayBuffer());
    }
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 180;
      canvas.height = 110;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, 180, 110);
        ctx.strokeStyle = '#4f46e5';
        ctx.lineWidth = 2;
        ctx.strokeRect(2, 2, 176, 106);
        ctx.strokeStyle = '#0f766e';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(24, 88);
        ctx.lineTo(140, 30);
        ctx.stroke();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (blob) return new Uint8Array(await blob.arrayBuffer());
      }
    }
  } catch { /* fallback below */ }
  return encodeRgbaPngFallback(64, 40);
}

function createSilentWavBytes(durationMs = 200, sampleRate = 8000) {
  const numSamples = Math.max(160, Math.round((sampleRate * durationMs) / 1000));
  const dataSize = numSamples * 2;
  const buf = new Uint8Array(44 + dataSize);
  const dv = new DataView(buf.buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true); // PCM chunk size
  dv.setUint16(20, 1, true); // PCM format
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  return buf;
}

async function createSamplePdfBytes({ title = 'Übungsblatt Import', pages = 1 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`${title} – Seite ${i}`, { x: 50, y: 780, size: 20, font });
    for (let k = 0; k < 6; k++) {
      page.drawText(`${k + 1}) Aufgabe ${k + 1}: Berechne die Ableitung f'(x) für x = ${k + 1}.`, { x: 50, y: 710 - k * 65, size: 12, font });
    }
  }
  return new Uint8Array(await doc.save());
}

// ---- Seed Builders ----

function makeCurvePoints(startX, startY, dx, dy, steps, startT, dt, pressure = 0.65) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const x = +(startX + dx * u).toFixed(1);
    const y = +(startY + dy * u + Math.sin(u * Math.PI * 2) * 14).toFixed(1);
    pts.push([x, y, pressure, 0, 0, startT + i * dt]);
  }
  return pts;
}

async function buildSeedState(now = Date.now()) {
  const files = new Map();
  const samplePng = await createSamplePngBytes();
  const sampleWav = createSilentWavBytes(250, 8000);

  // 1. Mathe – Analysis (Handwritten Study Notebook, Favorite, Nested Folder)
  {
    const mathNb = createNotebook({
      title: 'Mathe – Analysis',
      deviceId: 'phone-demo',
      template: 'GRID_5MM',
      canvasMode: 'PAGES',
      coverColorArgb: COVER_COLORS[2].argb, // Indigo 0xff4f46e5
      folderId: 'fld_mathe',
      folderPath: 'Universität / Mathematik',
    });
    mathNb.coverColorArgb = COVER_COLORS[2].argb;
    mathNb.isFavorite = true;
    assignFolder(mathNb, 'fld_mathe', 'Universität / Mathematik');
    mathNb.extractedHandwritingText = "Analysis II – Differentialrechnung\nAbleitung f'(x) = 2x + 3\nMerksatz: Kettenregel & Produktregel";

    const notesLayer = mathNb.addLayer('Herleitung');
    const p0 = mathNb.pages[0];
    p0.payload.isBookmarked = true;
    p0.payload.strokes.push(
      {
        id: 'st_math_1',
        layerId: '1',
        pageIndex: 0,
        brushKind: 'FOUNTAIN_PEN',
        colorArgb: 0xff0f172a,
        strokeWidth: 5.5,
        alpha: 1,
        isShapeSnapped: false,
        points: makeCurvePoints(140, 120, 420, 0, 14, now - 3600_000, 18, 0.7),
      },
      {
        id: 'st_math_2',
        layerId: '1',
        pageIndex: 0,
        brushKind: 'BALLPOINT_PEN',
        colorArgb: 0xff1d4ed8,
        strokeWidth: 4.5,
        alpha: 1,
        isShapeSnapped: false,
        points: makeCurvePoints(140, 500, 380, -30, 12, now - 3590_000, 20, 0.6),
      },
      {
        id: 'st_math_3',
        layerId: '1',
        pageIndex: 0,
        brushKind: 'HIGHLIGHTER',
        colorArgb: 0xfffacc15,
        strokeWidth: 28,
        alpha: 0.45,
        isShapeSnapped: true,
        points: [[135, 118, 0.5, 0, 0, now - 3580_000], [565, 118, 0.5, 0, 0, now - 3579_500]],
      },
    );
    p0.payload.textBoxes.push(
      {
        id: 'tb_math_1',
        layerId: '1',
        left: 140,
        top: 180,
        width: 540,
        height: 150,
        text: "Merksatz: (f∘g)'(x) = f'(g(x)) · g'(x)",
        fontSizeSp: 18,
        textColorArgb: 0xff0f172a,
        backgroundColorArgb: 0xfffef3c7,
        isBold: true,
        isItalic: false,
        isChecklist: false,
        isChecked: false,
      },
      {
        id: 'tb_math_2',
        layerId: '1',
        left: 140,
        top: 360,
        width: 460,
        height: 80,
        text: 'Übungsblatt 3 bis Freitag abgeben',
        fontSizeSp: 16,
        textColorArgb: 0xff0f172a,
        backgroundColorArgb: 0,
        isBold: false,
        isItalic: false,
        isChecklist: true,
        isChecked: true,
      },
    );
    p0.payload.tapes.push({
      id: 'tape_math_1',
      layerId: String(notesLayer.id),
      left: 220,
      top: 620,
      right: 860,
      bottom: 710,
      colorArgb: 0xff4f46e5,
      isRevealed: false,
    });

    const p1 = mathNb.addPage('COORDINATE');
    const parabolaPts = [];
    for (let i = -8; i <= 8; i++) {
      parabolaPts.push([500 + i * 32, 620 - (i * i) * 4, 0.7, 0, 0, now - 3500_000 + (i + 8) * 20]);
    }
    p1.payload.strokes.push({
      id: 'st_math_p1',
      layerId: '1',
      pageIndex: 1,
      brushKind: 'BRUSH_PEN',
      colorArgb: 0xff0f766e,
      strokeWidth: 6,
      alpha: 1,
      isShapeSnapped: false,
      points: parabolaPts,
    });

    const bytes = writeBundle(mathNb, { deviceId: 'phone-demo', now: now - 3600_000 });
    files.set('Mathe_–_Analysis.docflownote', {
      bytes,
      mtimeMs: now - 3600_000,
      birthtimeMs: now - 86400_000 * 5,
    });
  }

  // 2. Arbeitsblatt Scan (2-Page PDF Worksheet + Margin Notes + Tapes)
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page1 = doc.addPage([595.28, 841.89]);
    page1.drawText('Arbeitsblatt 1 – Lineare Funktionen', { x: 50, y: 780, size: 20, font });
    for (let k = 0; k < 8; k++) {
      page1.drawText(`${k + 1}) Bestimme die Steigung von f(x) = ${k + 2}x - ${k}.`, { x: 50, y: 720 - k * 60, size: 12, font });
    }
    const page2 = doc.addPage([595.28, 841.89]);
    page2.drawText('Arbeitsblatt 2 – Nullstellen & Schnittpunkte', { x: 50, y: 780, size: 20, font });
    for (let k = 0; k < 4; k++) {
      page2.drawText(`${k + 1}) Berechne die Nullstelle von g(x) = ${k + 1}x + ${2 * (k + 1)}.`, { x: 50, y: 710 - k * 75, size: 12, font });
    }
    const pdfBytes = new Uint8Array(await doc.save());

    const wsNb = createNotebook({
      title: 'Arbeitsblatt Scan',
      deviceId: 'phone-demo',
      template: 'BLANK',
      coverColorArgb: COVER_COLORS[4].argb, // Teal 0xff0f766e
      folderId: 'fld_klausuren',
      folderPath: 'Universität / Mathematik / Klausurvorbereitung',
      pdfBytes,
      pdfPageSizes: [
        { width: 595.28, height: 841.89 },
        { width: 595.28, height: 841.89 },
      ],
    });
    wsNb.coverColorArgb = COVER_COLORS[4].argb;
    wsNb.isFavorite = false;
    wsNb.marginNotesEnabled = true;
    wsNb.manifest.notebook = {
      ...(wsNb.manifest.notebook ?? {}),
      marginWidthPx: DEFAULT_MARGIN_WIDTH,
    };
    assignFolder(wsNb, 'fld_klausuren', 'Universität / Mathematik / Klausurvorbereitung');
    wsNb.extractedHandwritingText = 'Arbeitsblatt 1 Lineare Funktionen Steigung m = 2 Nullstelle x0 = 0';

    const wp0 = wsNb.pages[0];
    wp0.payload.strokes.push(
      {
        id: 'st_ws_1',
        layerId: '2',
        pageIndex: 0,
        brushKind: 'FINELINER',
        colorArgb: 0xff1d4ed8,
        strokeWidth: 3.5,
        alpha: 1,
        isShapeSnapped: false,
        points: makeCurvePoints(680, 380, 260, 0, 10, now - 120_000, 15, 0.55),
      },
      {
        id: 'st_ws_2',
        layerId: '2',
        pageIndex: 0,
        brushKind: 'HIGHLIGHTER',
        colorArgb: 0xfffacc15,
        strokeWidth: 26,
        alpha: 0.45,
        isShapeSnapped: true,
        points: [[140, 330, 0.5, 0, 0, now - 119_000], [520, 330, 0.5, 0, 0, now - 118_500]],
      },
    );
    wp0.payload.tapes.push({
      id: 'tape_ws_1',
      layerId: '2',
      left: 680,
      top: 340,
      right: 1180,
      bottom: 420,
      colorArgb: 0xff1d4ed8,
      isRevealed: false,
    });
    wp0.payload.textBoxes.push({
      id: 'tb_ws_margin',
      layerId: '2',
      left: 1690,
      top: 220,
      width: 540,
      height: 180,
      text: 'Randnotiz: m = Δy / Δx immer zuerst prüfen!',
      fontSizeSp: 16,
      textColorArgb: 0xff0f172a,
      backgroundColorArgb: 0xffe0e7ff,
      isBold: false,
      isItalic: false,
      isChecklist: false,
      isChecked: false,
    });

    const bytes = writeBundle(wsNb, { deviceId: 'phone-demo', now: now - 120_000 });
    files.set('Arbeitsblatt_Scan.docflownote', {
      bytes,
      mtimeMs: now - 120_000,
      birthtimeMs: now - 86400_000 * 3,
    });
  }

  // 3. Physik Vorlesung (Infinite / Cornell + Embedded PNG + Audio Bookmark + audioOffsetMs)
  {
    const physNb = createNotebook({
      title: 'Physik Vorlesung',
      deviceId: 'windows-demo',
      template: 'CORNELL',
      canvasMode: 'INFINITE',
      coverColorArgb: COVER_COLORS[3].argb, // Violet 0xff6d28d9
      folderId: 'fld_physik',
      folderPath: 'Universität / Physik',
    });
    physNb.coverColorArgb = COVER_COLORS[3].argb;
    physNb.isFavorite = true;
    assignFolder(physNb, 'fld_physik', 'Universität / Physik');
    physNb.extractedHandwritingText = 'Mechanik – Impuls- & Energieerhaltung\nF = m · a\nE_kin = 1/2 m v^2';

    const imgPath = physNb.addImageEntry(samplePng, 'png');
    physNb.addAudioEntry(sampleWav, {
      ext: 'wav',
      label: 'Vorlesung 04 – Mechanik',
      pageIndex: 0,
      durationMs: 4200,
    });

    const pp0 = physNb.pages[0];
    pp0.payload.images.push({
      id: 'img_phys_1',
      layerId: '1',
      imagePath: imgPath,
      left: 960,
      top: 200,
      right: 1320,
      bottom: 420,
      rotationDegrees: 0,
    });
    pp0.payload.strokes.push(
      {
        id: 'st_phys_1',
        layerId: '1',
        pageIndex: 0,
        brushKind: 'CALLIGRAPHY_PEN',
        colorArgb: 0xff6d28d9,
        strokeWidth: 7,
        alpha: 1,
        isShapeSnapped: false,
        audioOffsetMs: 800,
        points: makeCurvePoints(160, 400, 440, 20, 12, now - 1800_000, 22, 0.72),
      },
      {
        id: 'st_phys_2',
        layerId: '1',
        pageIndex: 0,
        brushKind: 'PENCIL',
        colorArgb: 0xff334155,
        strokeWidth: 4,
        alpha: 0.9,
        isShapeSnapped: false,
        audioOffsetMs: 2100,
        points: makeCurvePoints(160, 480, 380, -15, 10, now - 1795_000, 20, 0.55),
      },
    );
    pp0.payload.textBoxes.push({
      id: 'tb_phys_1',
      layerId: '1',
      left: 160,
      top: 180,
      width: 620,
      height: 140,
      text: 'Kapitel 4: Newtonsche Axiome & Impulssatz',
      fontSizeSp: 20,
      textColorArgb: 0xff0f172a,
      backgroundColorArgb: 0xffdcfce7,
      isBold: true,
      isItalic: false,
      isChecklist: false,
      isChecked: false,
    });

    const bytes = writeBundle(physNb, { deviceId: 'windows-demo', now: now - 1800_000 });
    files.set('Physik_Vorlesung.docflownote', {
      bytes,
      mtimeMs: now - 1800_000,
      birthtimeMs: now - 86400_000 * 4,
    });
  }

  const workspace = {
    version: 1,
    folders: [
      { id: 'fld_uni', name: 'Universität', parentId: null, color: FOLDER_COLORS[0], createdAt: now - 86400_000 * 7, updatedAt: now - 86400_000 * 7 },
      { id: 'fld_mathe', name: 'Mathematik', parentId: 'fld_uni', color: FOLDER_COLORS[2], createdAt: now - 86400_000 * 6, updatedAt: now - 86400_000 * 6 },
      { id: 'fld_physik', name: 'Physik', parentId: 'fld_uni', color: FOLDER_COLORS[1], createdAt: now - 86400_000 * 5, updatedAt: now - 86400_000 * 5 },
      { id: 'fld_klausuren', name: 'Klausurvorbereitung', parentId: 'fld_mathe', color: FOLDER_COLORS[3], createdAt: now - 86400_000 * 3, updatedAt: now - 86400_000 * 3 },
    ],
    notebookFolders: {
      'Mathe_–_Analysis.docflownote': 'fld_mathe',
      'Arbeitsblatt_Scan.docflownote': 'fld_klausuren',
      'Physik_Vorlesung.docflownote': 'fld_physik',
    },
    favorites: {
      'Mathe_–_Analysis.docflownote': true,
      'Physik_Vorlesung.docflownote': true,
    },
    ocrIndex: {
      'Mathe_–_Analysis.docflownote': {
        text: "Analysis II Differentialrechnung Ableitung f'(x) = 2x + 3 Kettenregel Produktregel",
        updatedAt: now - 3600_000,
      },
      'Arbeitsblatt_Scan.docflownote': {
        text: 'Arbeitsblatt 1 Lineare Funktionen Bestimme die Steigung Nullstelle y-Achsenabschnitt',
        updatedAt: now - 120_000,
      },
      'Physik_Vorlesung.docflownote': {
        text: 'Mechanik Impulserhaltung F = m * a Energieerhaltung E_kin = 1/2 m v^2',
        updatedAt: now - 1800_000,
      },
    },
    lastSyncedAt: now - 60_000,
  };

  return { files, workspace, samplePng };
}

export async function createDemoBridge() {
  const storage = getStorage();
  const params = getSearchParams();
  const forceReset = params.has('reset');
  const forceSetup = params.has('setup');

  if (forceReset && storage) {
    for (const key of Object.values(STORAGE_KEYS)) {
      try { storage.removeItem(key); } catch { /* ignore */ }
    }
  }

  const files = new Map(); // name -> { bytes: Uint8Array, mtimeMs: number, birthtimeMs: number }
  const trash = new Map(); // trashId -> { trashId, originalName, deletedAt, expiresAt, size, bytes: Uint8Array }
  let folder = forceSetup ? null : DEFAULT_DEMO_FOLDER;
  let settings = {};
  let workspace = null;
  let maximized = false;
  let fullscreen = false;
  let cachedSamplePng = null;

  const listeners = {
    changed: new Set(),
    openExternal: new Set(),
    closeRequested: new Set(),
    maximized: new Set(),
  };

  const hooks = {
    nextPdfPick: null,
    nextPdfMultiPick: null,
    nextImagePick: null,
    nextChooseFolder: null,
    nextOcr: null,
    lastExport: null,
    openedUrls: [],
  };

  function persistMeta() {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEYS.meta, JSON.stringify({
        version: 1,
        deviceId: 'windows-demo',
        syncFolder: folder,
        settings,
      }));
    } catch { /* ignore QuotaExceededError */ }
  }

  function persistFiles() {
    if (!storage) return;
    try {
      const obj = {};
      for (const [name, entry] of files) {
        obj[name] = {
          b64: u8ToBase64(entry.bytes),
          size: entry.bytes.length,
          mtimeMs: entry.mtimeMs,
          birthtimeMs: entry.birthtimeMs,
        };
      }
      storage.setItem(STORAGE_KEYS.files, JSON.stringify(obj));
    } catch { /* ignore QuotaExceededError */ }
  }

  function persistWorkspace() {
    if (!storage) return;
    try {
      if (workspace == null) storage.removeItem(STORAGE_KEYS.workspace);
      else storage.setItem(STORAGE_KEYS.workspace, JSON.stringify(workspace));
    } catch { /* ignore QuotaExceededError */ }
  }

  function persistTrash() {
    if (!storage) return;
    try {
      const obj = {};
      for (const [id, entry] of trash) {
        obj[id] = {
          trashId: entry.trashId,
          originalName: entry.originalName,
          deletedAt: entry.deletedAt,
          expiresAt: entry.expiresAt,
          size: entry.size,
          b64: u8ToBase64(entry.bytes),
        };
      }
      storage.setItem(STORAGE_KEYS.trash, JSON.stringify(obj));
    } catch { /* ignore QuotaExceededError */ }
  }

  function purgeExpiredTrashInMemory(now = Date.now()) {
    let changed = false;
    for (const [id, entry] of trash) {
      if (now >= Number(entry.expiresAt)) {
        trash.delete(id);
        changed = true;
      }
    }
    if (changed) persistTrash();
    return changed;
  }

  async function seedAll() {
    files.clear();
    trash.clear();
    const seeded = await buildSeedState();
    cachedSamplePng = seeded.samplePng;
    for (const [name, entry] of seeded.files) files.set(name, entry);
    workspace = seeded.workspace;
    folder = forceSetup ? null : DEFAULT_DEMO_FOLDER;
    settings = {};
    persistMeta();
    persistFiles();
    persistWorkspace();
    persistTrash();
  }

  function loadFromStorage() {
    if (!storage) return false;
    try {
      const rawFiles = storage.getItem(STORAGE_KEYS.files);
      if (!rawFiles) return false;
      const parsedFiles = JSON.parse(rawFiles);
      if (!parsedFiles || typeof parsedFiles !== 'object') return false;
      for (const [name, entry] of Object.entries(parsedFiles)) {
        files.set(name, {
          bytes: base64ToU8(entry.b64),
          mtimeMs: Number(entry.mtimeMs) || Date.now(),
          birthtimeMs: Number(entry.birthtimeMs) || Date.now(),
        });
      }

      const rawMeta = storage.getItem(STORAGE_KEYS.meta);
      if (rawMeta) {
        const meta = JSON.parse(rawMeta);
        if (!forceSetup) folder = meta.syncFolder ?? DEFAULT_DEMO_FOLDER;
        settings = meta.settings && typeof meta.settings === 'object' ? { ...meta.settings } : {};
      }

      const rawWs = storage.getItem(STORAGE_KEYS.workspace);
      if (rawWs) workspace = JSON.parse(rawWs);

      const rawTrash = storage.getItem(STORAGE_KEYS.trash);
      if (rawTrash) {
        const parsedTrash = JSON.parse(rawTrash);
        for (const [id, entry] of Object.entries(parsedTrash || {})) {
          trash.set(id, {
            trashId: String(entry.trashId || id),
            originalName: String(entry.originalName),
            deletedAt: Number(entry.deletedAt) || Date.now(),
            expiresAt: Number(entry.expiresAt) || (Date.now() + TRASH_MAX_AGE_MS),
            size: Number(entry.size) || 0,
            bytes: base64ToU8(entry.b64),
          });
        }
      }
      purgeExpiredTrashInMemory();
      return true;
    } catch {
      files.clear();
      trash.clear();
      return false;
    }
  }

  if (!loadFromStorage()) {
    await seedAll();
  } else {
    cachedSamplePng = await createSamplePngBytes();
  }

  const bridge = {
    isDemo: true,

    async appInfo() {
      return {
        version: '1.0.0-demo',
        deviceId: 'windows-demo',
        platform: 'win32',
        syncFolder: folder,
        folder,
        backupsDir: BACKUPS_DEMO_DIR,
        settings: { ...settings },
        isGoogleDrive: isGoogleDrivePath(folder),
        openFile: null,
      };
    },

    async saveSettings(patch) {
      settings = { ...settings, ...(patch && typeof patch === 'object' ? patch : {}) };
      persistMeta();
      return { ok: true, settings: { ...settings } };
    },

    async detectFolders() {
      return {
        candidates: [
          {
            provider: 'OneDrive',
            label: 'OneDrive (DocFlow Studio)',
            path: DEFAULT_DEMO_FOLDER,
            root: 'C:\\Users\\Demo\\OneDrive',
            folder: DEFAULT_DEMO_FOLDER,
            exists: true,
            notebooks: files.size,
          },
          {
            provider: 'Google Drive',
            label: 'Google Drive (DocFlow Studio)',
            path: 'G:\\Meine Ablage\\DocFlow Studio',
            root: 'G:\\Meine Ablage',
            folder: 'G:\\Meine Ablage\\DocFlow Studio',
            exists: false,
            notebooks: 0,
          },
          {
            provider: 'Nextcloud',
            label: 'Nextcloud (DocFlow Studio)',
            path: 'C:\\Users\\Demo\\Nextcloud\\DocFlow Studio',
            root: 'C:\\Users\\Demo\\Nextcloud',
            folder: 'C:\\Users\\Demo\\Nextcloud\\DocFlow Studio',
            exists: false,
            notebooks: 0,
          },
        ],
        defaultSuggestion: DEFAULT_DEMO_FOLDER,
      };
    },

    async setFolder(folderPath) {
      const next = String(folderPath || '').trim() || DEFAULT_DEMO_FOLDER;
      const created = next !== folder;
      folder = next;
      persistMeta();
      return { ok: true, folder, created };
    },

    async chooseFolder() {
      if (hooks.nextChooseFolder) {
        const res = hooks.nextChooseFolder;
        hooks.nextChooseFolder = null;
        if (res.canceled) return { canceled: true };
        folder = res.path || DEFAULT_DEMO_FOLDER;
        persistMeta();
        return { canceled: false, path: folder };
      }
      folder = folder || DEFAULT_DEMO_FOLDER;
      persistMeta();
      return { canceled: false, path: folder };
    },

    async listFiles() {
      return [...files.entries()]
        .filter(([name]) => name.toLowerCase().endsWith('.docflownote') && !name.startsWith('.'))
        .map(([name, entry]) => ({
          name,
          size: entry.bytes.length,
          mtimeMs: entry.mtimeMs,
          birthtimeMs: entry.birthtimeMs,
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    },

    async revealFolder() {
      return { ok: Boolean(folder) };
    },

    async readFile(name) {
      const entry = files.get(name);
      if (!entry) throw new Error(`File not found: ${name}`);
      return new Uint8Array(entry.bytes);
    },

    async statFile(name) {
      const entry = files.get(name);
      return entry ? { size: entry.bytes.length, mtimeMs: entry.mtimeMs } : null;
    },

    async writeFile(name, bytes) {
      const u8 = new Uint8Array(bytes || []);
      if (String(name).toLowerCase().endsWith('.docflownote') && u8.length === 0) {
        throw new Error('Cannot write empty .docflownote');
      }
      const existing = files.get(name);
      const now = Date.now();
      files.set(name, {
        bytes: u8,
        mtimeMs: now,
        birthtimeMs: existing?.birthtimeMs ?? now,
      });
      persistFiles();
      return { ok: true, mtimeMs: now, size: u8.length };
    },

    async deleteFile(name) {
      const entry = files.get(name);
      if (!entry) return { ok: false };
      const now = Date.now();
      const trashId = `${now}-${Math.random().toString(36).slice(2, 10)}`;
      trash.set(trashId, {
        trashId,
        originalName: name,
        deletedAt: now,
        expiresAt: now + TRASH_MAX_AGE_MS,
        size: entry.bytes.length,
        bytes: new Uint8Array(entry.bytes),
      });
      files.delete(name);
      purgeExpiredTrashInMemory(now);
      persistFiles();
      persistTrash();
      return { ok: true, trashedName: trashId };
    },

    async readExternalFile(filePath) {
      const clean = String(filePath || '');
      const base = clean.split(/[\\/]/).pop();
      const entry = base ? files.get(base) : null;
      if (!entry) throw new Error('External file not supported in browser demo');
      return { name: base, bytes: new Uint8Array(entry.bytes) };
    },

    async pickPdf() {
      if (hooks.nextPdfPick) {
        const res = hooks.nextPdfPick;
        hooks.nextPdfPick = null;
        return res;
      }
      const bytes = await createSamplePdfBytes({ title: 'Übungsblatt Import', pages: 1 });
      return { canceled: false, name: 'Übungsblatt_Import', bytes };
    },

    async pickPdfMulti() {
      if (hooks.nextPdfMultiPick) {
        const res = hooks.nextPdfMultiPick;
        hooks.nextPdfMultiPick = null;
        return res;
      }
      const bytes = await createSamplePdfBytes({ title: 'Anhang Arbeitsblatt', pages: 2 });
      return { canceled: false, files: [{ name: 'Anhang_Blatt.pdf', bytes }] };
    },

    async pickImage() {
      if (hooks.nextImagePick) {
        const res = hooks.nextImagePick;
        hooks.nextImagePick = null;
        return res;
      }
      const bytes = cachedSamplePng ? new Uint8Array(cachedSamplePng) : await createSamplePngBytes();
      return { canceled: false, name: 'diagramm.png', mime: 'image/png', bytes };
    },

    async savePdfAs(suggestedName, bytes) {
      const u8 = new Uint8Array(bytes || []);
      hooks.lastExport = {
        suggestedName,
        ext: 'pdf',
        bytes: u8,
        size: u8.length,
        savedAt: Date.now(),
      };
      return { canceled: false, path: `C:\\Users\\Demo\\Documents\\${suggestedName || 'Export.pdf'}` };
    },

    async saveExportFile(opts) {
      const u8 = new Uint8Array(opts?.bytes || []);
      const ext = opts?.ext || 'pdf';
      const suggestedName = opts?.suggestedName || `Export.${ext}`;
      hooks.lastExport = {
        suggestedName,
        ext,
        bytes: u8,
        size: u8.length,
        savedAt: Date.now(),
      };
      return { canceled: false, path: `C:\\Users\\Demo\\Documents\\${suggestedName}` };
    },

    async readWorkspace() {
      return workspace ? cloneObj(workspace) : null;
    },

    async writeWorkspace(data) {
      workspace = cloneObj(data);
      persistWorkspace();
      return { ok: true };
    },

    async listTrash() {
      purgeExpiredTrashInMemory();
      return [...trash.values()]
        .map(({ trashId, originalName, deletedAt, expiresAt, size }) => ({
          trashId,
          originalName,
          deletedAt,
          expiresAt,
          size,
        }))
        .sort((a, b) => b.deletedAt - a.deletedAt);
    },

    async restoreTrash(trashId) {
      const entry = trash.get(trashId);
      if (!entry) throw new Error(`Trash entry not found: ${trashId}`);
      const orig = entry.originalName;
      const dot = orig.lastIndexOf('.');
      const stem = dot > 0 ? orig.slice(0, dot) : orig;
      const ext = dot > 0 ? orig.slice(dot) : '.docflownote';
      let restoredName = orig;
      if (files.has(restoredName)) {
        restoredName = `${stem}_restored${ext}`;
        let idx = 2;
        while (files.has(restoredName)) {
          restoredName = `${stem}_restored_${idx}${ext}`;
          idx++;
        }
      }
      const now = Date.now();
      files.set(restoredName, {
        bytes: new Uint8Array(entry.bytes),
        mtimeMs: now,
        birthtimeMs: now,
      });
      trash.delete(trashId);
      persistFiles();
      persistTrash();
      return { ok: true, restoredName };
    },

    async purgeTrash(trashId) {
      const ok = trash.delete(trashId);
      if (ok) persistTrash();
      return { ok };
    },

    async emptyTrash() {
      const removed = trash.size;
      trash.clear();
      persistTrash();
      return { ok: true, removed };
    },

    async openBackupsFolder() {
      return { ok: true, path: BACKUPS_DEMO_DIR };
    },

    async recognizeOcr(pngBytes, preferredLang = 'de-DE') {
      if (hooks.nextOcr) {
        const res = hooks.nextOcr;
        hooks.nextOcr = null;
        return res;
      }
      if (!pngBytes || pngBytes.length === 0) {
        return { ok: true, text: '', lines: [], engine: 'empty' };
      }
      const isEn = String(preferredLang || 'de-DE').toLowerCase().startsWith('en');
      const lines = isEn
        ? ['Analysis: f(x) = 2x + 3', 'Chain rule & slope review']
        : ['Analysis: f(x) = 2x + 3', 'Steigung prüfen & Kettenregel'];
      return {
        ok: true,
        text: lines.join('\n'),
        lines,
        language: isEn ? 'en-US' : 'de-DE',
        engine: 'demo-mock',
      };
    },

    async checkUpdate() {
      return {
        ok: true,
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        hasUpdate: false,
        url: 'https://github.com/paulhoehne2006-a11y/DocFlow-Windows/releases',
        notes: '',
      };
    },

    async openExternalUrl(url) {
      if (!isAllowedHttpsUrl(url)) return { ok: false };
      hooks.openedUrls.push(new URL(String(url).trim()).toString());
      return { ok: true };
    },

    async windowMinimize() {},

    async windowMaximize() {
      maximized = !maximized;
      listeners.maximized.forEach((cb) => cb(maximized));
      return { maximized };
    },

    async windowClose() {
      listeners.closeRequested.forEach((cb) => cb());
    },

    async windowIsMaximized() {
      return maximized;
    },

    async setFullscreen(flag) {
      fullscreen = typeof flag === 'boolean' ? flag : !fullscreen;
      try {
        if (typeof document !== 'undefined') {
          if (fullscreen && !document.fullscreenElement) {
            await document.documentElement.requestFullscreen?.().catch(() => {});
          } else if (!fullscreen && document.fullscreenElement) {
            await document.exitFullscreen?.().catch(() => {});
          }
        }
      } catch { /* ignore fullscreen rejection in headless */ }
      return { fullscreen };
    },

    async closeNow() {},

    onFolderChanged(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.changed.add(cb);
      return () => { listeners.changed.delete(cb); };
    },

    onOpenExternalFile(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.openExternal.add(cb);
      return () => { listeners.openExternal.delete(cb); };
    },

    onWindowCloseRequested(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.closeRequested.add(cb);
      return () => { listeners.closeRequested.delete(cb); };
    },

    onWindowMaximized(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.maximized.add(cb);
      return () => { listeners.maximized.delete(cb); };
    },

    // ---- Playwright / Test Hooks ----
    _files: files,
    _trash: trash,
    get _workspace() { return workspace; },
    get _lastExport() { return hooks.lastExport; },
    get _openedUrls() { return hooks.openedUrls; },
    _external(name, bytes) {
      const u8 = new Uint8Array(bytes || []);
      const existing = files.get(name);
      const now = Date.now();
      files.set(name, {
        bytes: u8,
        mtimeMs: now,
        birthtimeMs: existing?.birthtimeMs ?? now,
      });
      persistFiles();
      const payload = { event: 'change', filename: name };
      listeners.changed.forEach((cb) => cb(payload));
    },
    _triggerOpenExternal(filePath) {
      listeners.openExternal.forEach((cb) => cb(filePath));
    },
    _setNextPick({ pdf, pdfMulti, image, chooseFolder } = {}) {
      if (pdf !== undefined) hooks.nextPdfPick = pdf;
      if (pdfMulti !== undefined) hooks.nextPdfMultiPick = pdfMulti;
      if (image !== undefined) hooks.nextImagePick = image;
      if (chooseFolder !== undefined) hooks.nextChooseFolder = chooseFolder;
    },
    _setNextOcr(result) {
      hooks.nextOcr = result;
    },
    async _reset() {
      if (storage) {
        for (const key of Object.values(STORAGE_KEYS)) {
          try { storage.removeItem(key); } catch { /* ignore */ }
        }
      }
      await seedAll();
    },
  };

  if (typeof window !== 'undefined') {
    window.docflow = bridge;
    window.__demoBridge = bridge;
  }
  return bridge;
}
