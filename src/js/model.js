// Reading and writing `.docflownote` bundles – the same ZIP format the Android app uploads to
// Google Drive / OneDrive. Unknown entries and fields are preserved so a round trip through
// Windows never loses data the Android app added (audio, images, future fields).

import { unzipSync, zipSync, strToU8, strFromU8 } from '../vendor/fflate.js';

export const BUNDLE_EXTENSION = '.docflownote';
export const MANIFEST_ENTRY = 'manifest.json';
export const EXPORTED_PDF_ENTRY = 'pdf/exported.pdf';
export const SOURCE_PDF_ENTRY = 'source/worksheet.pdf';
export const DEFAULT_PAGE_WIDTH = 1654;
export const DEFAULT_PAGE_HEIGHT = 2339;

export const BRUSHES = [
  'FOUNTAIN_PEN', 'FINELINER', 'BRUSH_PEN', 'BALLPOINT_PEN', 'PENCIL', 'CALLIGRAPHY_PEN', 'HIGHLIGHTER',
];
export const TEMPLATES = ['BLANK', 'GRID_5MM', 'LINED', 'DOTTED', 'CORNELL', 'COORDINATE', 'MUSIC'];

/** Same rules as `StudioCloudSyncCoordinator.sanitizeCloudFileStem` on Android. */
export function sanitizeFileStem(title) {
  const cleaned = String(title ?? '')
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
  return (cleaned || 'DocFlow_Note').slice(0, 80);
}

function emptyPayload() {
  return { version: 1, isBookmarked: false, strokes: [], tapes: [], textBoxes: [], images: [] };
}

export function parsePayload(text) {
  if (!text || !text.trim()) return emptyPayload();
  try {
    const raw = JSON.parse(text);
    return {
      ...raw,
      version: raw.version ?? 1,
      isBookmarked: !!raw.isBookmarked,
      strokes: Array.isArray(raw.strokes) ? raw.strokes : [],
      tapes: Array.isArray(raw.tapes) ? raw.tapes : [],
      textBoxes: Array.isArray(raw.textBoxes) ? raw.textBoxes : [],
      images: Array.isArray(raw.images) ? raw.images : [],
    };
  } catch {
    return emptyPayload();
  }
}

/** Point tuple `[x, y, pressure, tiltX, tiltY, timestampMs]` → object (accepts both encodings). */
export function pointOf(p) {
  if (Array.isArray(p)) {
    return { x: +p[0] || 0, y: +p[1] || 0, pressure: p[2] ?? 0.5, tiltX: p[3] ?? 0, tiltY: p[4] ?? 0 };
  }
  return { x: +p.x || 0, y: +p.y || 0, pressure: p.pressure ?? 0.5, tiltX: p.tiltX ?? 0, tiltY: p.tiltY ?? 0 };
}

/**
 * A notebook opened from a bundle. `pages[i].payload` holds the decoded canvas content,
 * `pages[i].dirty` marks pages edited on this device since the last save.
 */
export class Notebook {
  constructor({ manifest, pages, layers, entries, fileName }) {
    this.manifest = manifest;
    this.pages = pages;
    this.layers = layers;
    this.entries = entries; // every zip entry (Uint8Array), kept for lossless re-saving
    this.fileName = fileName;
    this.metaDirty = false;
  }

  get title() {
    return this.manifest.notebook?.title || this.fileName.replace(/\.docflownote$/i, '');
  }

  get canvasMode() {
    return this.manifest.notebook?.canvasMode || 'PAGES';
  }

  get defaultTemplate() {
    return this.manifest.notebook?.defaultTemplate || 'GRID_5MM';
  }

  get isDirty() {
    return this.metaDirty || this.pages.some((p) => p.dirty);
  }

  /** Background PDF entry name and page index for [page], or null for paper pages. */
  backgroundOf(page) {
    if (page.backgroundPdfEntry && this.entries[page.backgroundPdfEntry]) {
      return { entry: page.backgroundPdfEntry, pageIndex: page.backgroundPdfPageIndex ?? 0 };
    }
    // Bundles of older app versions only carry the notebook's worksheet PDF
    if (page.backgroundPdfPageIndex != null && this.manifest.hasSourcePdf && this.entries[SOURCE_PDF_ENTRY]) {
      return { entry: SOURCE_PDF_ENTRY, pageIndex: page.backgroundPdfPageIndex };
    }
    return null;
  }

  layerById(id) {
    return this.layers.find((l) => String(l.id) === String(id)) ?? null;
  }

  /** Layer a stroke belongs to; strokes from old app versions may reference the layer type. */
  resolveLayer(layerId) {
    return this.layerById(layerId)
      ?? this.layers.find((l) => String(l.type).toUpperCase() === String(layerId).toUpperCase())
      ?? null;
  }

  isItemVisible(item) {
    const layer = this.resolveLayer(item.layerId);
    return layer ? layer.isVisible !== false : true;
  }

  sortedLayers() {
    return [...this.layers].sort((a, b) => (a.sortOrder - b.sortOrder) || (Number(a.id) - Number(b.id)));
  }

  /** "Hintergrund" for the worksheet layer, "Ebene N" for the others, unless renamed. */
  layerDisplayName(layer, t) {
    const legacy = ['worksheet', 'solution', 'notes', 'layer', 'arbeitsblatt', 'lösung', 'notizen', 'ebene'];
    const name = (layer.name ?? '').trim();
    if (name && !legacy.includes(name.toLowerCase())) return name;
    if (layer.type === 'WORKSHEET') return t('layerBackground');
    const others = this.sortedLayers().filter((l) => l.type !== 'WORKSHEET');
    return t('layerN', others.indexOf(layer) + 1);
  }

  addLayer() {
    const ids = this.layers.map((l) => Number(l.id)).filter(Number.isFinite);
    // Large, time-based ids never collide with the small Room ids of the phone
    const id = Math.max(Date.now(), ...ids.map((v) => v + 1));
    const layer = {
      id,
      name: '',
      type: 'SOLUTION',
      isVisible: true,
      isLocked: false,
      sortOrder: Math.max(-1, ...this.layers.map((l) => l.sortOrder ?? 0)) + 1,
      createdAt: Date.now(),
    };
    this.layers.push(layer);
    this.metaDirty = true;
    return layer;
  }

  removeLayer(layer) {
    this.layers = this.layers.filter((l) => l !== layer);
    for (const page of this.pages) {
      const p = page.payload;
      const before = p.strokes.length + p.tapes.length + p.textBoxes.length + p.images.length;
      const keep = (item) => String(item.layerId) !== String(layer.id);
      p.strokes = p.strokes.filter(keep);
      p.tapes = p.tapes.filter(keep);
      p.textBoxes = p.textBoxes.filter(keep);
      p.images = p.images.filter(keep);
      if (p.strokes.length + p.tapes.length + p.textBoxes.length + p.images.length !== before) page.dirty = true;
    }
    this.metaDirty = true;
  }

  addPage(template) {
    const last = this.pages[this.pages.length - 1];
    const pageIndex = Math.max(-1, ...this.pages.map((p) => p.pageIndex)) + 1;
    const page = {
      pageIndex,
      template: template || this.defaultTemplate,
      widthPx: last && !this.backgroundOf(last) ? last.widthPx : DEFAULT_PAGE_WIDTH,
      heightPx: last && !this.backgroundOf(last) ? last.heightPx : DEFAULT_PAGE_HEIGHT,
      payloadEntry: `pages/page_${pageIndex}.json`,
      backgroundPdfPageIndex: null,
      backgroundPdfEntry: null,
      updatedAt: Date.now(),
      payload: emptyPayload(),
      dirty: true,
    };
    this.pages.push(page);
    this.metaDirty = true;
    return page;
  }
}

export function readBundle(bytes, fileName = 'notebook.docflownote') {
  const entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  if (!entries[MANIFEST_ENTRY]) throw new Error('manifest.json fehlt – keine gültige DocFlow-Datei');
  const manifest = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]));
  const manifestPages = Array.isArray(manifest.pages) ? manifest.pages : [];
  const pageCount = Math.max(1, manifestPages.length, manifest.notebook?.pageCount ?? 1);

  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const meta = manifestPages[i] ?? {};
    const pageIndex = meta.pageIndex ?? i;
    const entryName = meta.payloadEntry || `pages/page_${pageIndex}.json`;
    const raw = entries[entryName];
    pages.push({
      ...meta,
      pageIndex,
      template: meta.template || manifest.notebook?.defaultTemplate || 'GRID_5MM',
      widthPx: meta.widthPx > 0 ? meta.widthPx : DEFAULT_PAGE_WIDTH,
      heightPx: meta.heightPx > 0 ? meta.heightPx : DEFAULT_PAGE_HEIGHT,
      payloadEntry: entryName,
      backgroundPdfPageIndex: meta.backgroundPdfPageIndex ?? null,
      backgroundPdfEntry: meta.backgroundPdfEntry && meta.backgroundPdfEntry !== 'null' ? meta.backgroundPdfEntry : null,
      updatedAt: meta.updatedAt ?? 0,
      payload: parsePayload(raw ? strFromU8(raw) : ''),
      dirty: false,
    });
  }
  pages.sort((a, b) => a.pageIndex - b.pageIndex);

  const layers = (Array.isArray(manifest.layers) ? manifest.layers : []).map((l) => ({ ...l }));
  if (layers.length === 0) {
    layers.push({ id: 1, name: '', type: 'SOLUTION', isVisible: true, isLocked: false, sortOrder: 0, createdAt: 0 });
  }
  return new Notebook({ manifest, pages, layers, entries, fileName });
}

/**
 * Serializes [notebook] back into a bundle. Pages edited here get a fresh `updatedAt` so the
 * phone can merge page by page; `deviceId` tells the phone the bundle was changed elsewhere.
 */
export function writeBundle(notebook, { deviceId, exportedPdf = null, now = Date.now() } = {}) {
  const entries = { ...notebook.entries };
  for (const name of Object.keys(entries)) {
    if (name.startsWith('pages/') && name.endsWith('.json')) delete entries[name];
  }

  const pagesMeta = notebook.pages.map((page) => {
    if (page.dirty) page.updatedAt = now;
    const { payload, dirty, ...meta } = page;
    entries[meta.payloadEntry] = strToU8(JSON.stringify(payload));
    return meta;
  });

  if (exportedPdf) entries[EXPORTED_PDF_ENTRY] = exportedPdf;

  const manifest = {
    ...notebook.manifest,
    schemaVersion: notebook.manifest.schemaVersion ?? 1,
    format: 'docflownote',
    exportedAtMillis: now,
    deviceId,
    deviceName: 'Windows',
    hasExportedPdf: !!entries[EXPORTED_PDF_ENTRY],
    hasSourcePdf: !!entries[SOURCE_PDF_ENTRY],
    notebook: {
      ...(notebook.manifest.notebook ?? {}),
      pageCount: notebook.pages.length,
      updatedAt: now,
    },
    layers: notebook.layers,
    pages: pagesMeta,
  };
  entries[MANIFEST_ENTRY] = strToU8(JSON.stringify(manifest, null, 2));

  // PDFs are already compressed – storing them avoids burning CPU on every autosave
  const zipInput = {};
  for (const [name, data] of Object.entries(entries)) {
    zipInput[name] = name.endsWith('.json') ? data : [data, { level: 0 }];
  }
  const bytes = zipSync(zipInput, { level: 6 });

  notebook.manifest = manifest;
  notebook.entries = entries;
  notebook.pages.forEach((p) => { p.dirty = false; });
  notebook.metaDirty = false;
  return bytes;
}

/** A new notebook created on Windows (blank or from a PDF whose page sizes are given in points). */
export function createNotebook({ title, deviceId, template = 'GRID_5MM', pdfBytes = null, pdfPageSizes = [] }) {
  const now = Date.now();
  const entries = {};
  const fromPdf = pdfBytes && pdfPageSizes.length > 0;
  if (fromPdf) entries['backgrounds/bg_0.pdf'] = pdfBytes;

  const layers = fromPdf
    ? [
        { id: 1, name: '', type: 'WORKSHEET', isVisible: true, isLocked: true, sortOrder: 0, createdAt: now },
        { id: 2, name: '', type: 'SOLUTION', isVisible: true, isLocked: false, sortOrder: 1, createdAt: now },
      ]
    : [{ id: 1, name: '', type: 'SOLUTION', isVisible: true, isLocked: false, sortOrder: 0, createdAt: now }];

  const sizes = fromPdf ? pdfPageSizes : [{ width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT }];
  const pages = sizes.map((size, i) => ({
    pageIndex: i,
    template,
    widthPx: DEFAULT_PAGE_WIDTH,
    heightPx: fromPdf ? Math.max(100, DEFAULT_PAGE_WIDTH * (size.height / size.width)) : DEFAULT_PAGE_HEIGHT,
    payloadEntry: `pages/page_${i}.json`,
    backgroundPdfPageIndex: fromPdf ? i : null,
    backgroundPdfEntry: fromPdf ? 'backgrounds/bg_0.pdf' : null,
    updatedAt: now,
    payload: emptyPayload(),
    dirty: true,
  }));

  const manifest = {
    schemaVersion: 1,
    format: 'docflownote',
    createdOn: 'windows',
    originDeviceId: deviceId,
    notebook: {
      title,
      coverColorArgb: 4280163870, // 0xFF1E293B
      canvasMode: 'PAGES',
      defaultTemplate: template,
      pageCount: pages.length,
      isFavorite: false,
      extractedHandwritingText: '',
      createdAt: now,
      updatedAt: now,
    },
    layers,
    pages: [],
  };
  const notebook = new Notebook({ manifest, pages, layers, entries, fileName: `${sanitizeFileStem(title)}${BUNDLE_EXTENSION}` });
  notebook.metaDirty = true;
  return notebook;
}

/**
 * Merges a newer copy of the same notebook (e.g. the phone uploaded while it was open here):
 * pages edited on this device win, every other page takes the remote version.
 */
export function mergeRemote(local, remote) {
  const localDirty = new Map(local.pages.filter((p) => p.dirty).map((p) => [p.pageIndex, p]));
  const merged = remote.pages.map((rp) => localDirty.get(rp.pageIndex) ?? rp);
  for (const [idx, page] of localDirty) {
    if (!merged.some((p) => p.pageIndex === idx)) merged.push(page);
  }
  merged.sort((a, b) => a.pageIndex - b.pageIndex);

  const layers = remote.layers.map((l) => ({ ...l }));
  for (const layer of local.layers) {
    if (!layers.some((l) => String(l.id) === String(layer.id))) layers.push(layer);
  }

  local.manifest = remote.manifest;
  local.entries = { ...remote.entries, ...pickBackgrounds(local.entries, merged) };
  local.pages = merged;
  local.layers = layers;
  local.metaDirty = local.metaDirty || localDirty.size > 0;
  return local;
}

function pickBackgrounds(entries, pages) {
  const out = {};
  for (const page of pages) {
    if (page.backgroundPdfEntry && entries[page.backgroundPdfEntry]) out[page.backgroundPdfEntry] = entries[page.backgroundPdfEntry];
  }
  return out;
}
