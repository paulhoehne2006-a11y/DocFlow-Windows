// Reading and writing `.docflownote` bundles – the exact ZIP format shared with DocFlow Android
// (branch `claude/eager-wozniak-so4azi`). Unknown entries and fields are always preserved so a
// round trip through Windows never loses data added by Android.

import { unzipSync, zipSync, strToU8, strFromU8 } from '../vendor/fflate.js';

export const BUNDLE_EXTENSION = '.docflownote';
export const MANIFEST_ENTRY = 'manifest.json';
export const EXPORTED_PDF_ENTRY = 'pdf/exported.pdf';
export const SOURCE_PDF_ENTRY = 'source/worksheet.pdf';
export const IMAGES_PREFIX = 'images/';
export const AUDIO_PREFIX = 'audio/';
export const DEFAULT_PAGE_WIDTH = 1654;
export const DEFAULT_PAGE_HEIGHT = 2339;
/** Margin-notes column width relative to the page width, identical to Android's MARGIN_NOTES_WIDTH_RATIO. */
export const MARGIN_NOTES_WIDTH_RATIO = 0.42;
/** Margin width for an A4 page (1654 px wide), the same value Android writes into `marginWidthPx`. */
export const DEFAULT_MARGIN_WIDTH = Math.round(1654 * MARGIN_NOTES_WIDTH_RATIO);

function resolveImageEntryKey(entries, imagePath) {
  if (!imagePath || !entries) return null;
  if (entries[imagePath]) return imagePath;
  const normalized = String(imagePath).replace(/\\/g, '/').replace(/^\.?\//, '');
  if (entries[normalized]) return normalized;
  const base = String(imagePath).split(/[\\/]/).pop();
  const byPrefix = base ? `${IMAGES_PREFIX}${base}` : null;
  if (byPrefix && entries[byPrefix]) return byPrefix;
  return null;
}

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

export function emptyPayload() {
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
    return {
      x: +p[0] || 0,
      y: +p[1] || 0,
      pressure: p[2] ?? 0.5,
      tiltX: p[3] ?? 0,
      tiltY: p[4] ?? 0,
      timestampMs: p[5] ?? 0,
    };
  }
  return {
    x: +p.x || 0,
    y: +p.y || 0,
    pressure: p.pressure ?? 0.5,
    tiltX: p.tiltX ?? 0,
    tiltY: p.tiltY ?? 0,
    timestampMs: p.timestampMs ?? 0,
  };
}

/**
 * Fast summary inspection of a `.docflownote` bundle (manifest + first page text) for library
 * cards, sync badges and OCR search indexing without decoding every page.
 */
export function inspectBundleSummary(bytes, fileName = 'notebook.docflownote') {
  const entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  if (!entries[MANIFEST_ENTRY]) throw new Error('manifest.json fehlt');
  const manifest = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]));
  const nb = manifest.notebook ?? {};
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  const audioCount = Object.keys(entries).filter((k) => k.startsWith(AUDIO_PREFIX)).length;
  const imageCount = Object.keys(entries).filter((k) => k.startsWith(IMAGES_PREFIX)).length;
  // Collect text from textBoxes across pages for instant full-text search
  const boxTexts = [];
  for (const p of pages) {
    const entryName = p.payloadEntry || `pages/page_${p.pageIndex ?? 0}.json`;
    const raw = entries[entryName];
    if (!raw) continue;
    try {
      const payload = JSON.parse(strFromU8(raw));
      if (Array.isArray(payload.textBoxes)) {
        for (const box of payload.textBoxes) {
          if (box?.text) boxTexts.push(box.text);
        }
      }
    } catch { /* skip malformed page */ }
  }
  return {
    fileName,
    title: nb.title || fileName.replace(/\.docflownote$/i, '').replace(/_/g, ' '),
    coverColorArgb: nb.coverColorArgb ?? 0xff1e293b,
    canvasMode: nb.canvasMode || 'PAGES',
    defaultTemplate: nb.defaultTemplate || 'GRID_5MM',
    pageCount: Math.max(1, pages.length, nb.pageCount ?? 1),
    isFavorite: !!nb.isFavorite,
    folderId: nb.folderId || null,
    folderPath: nb.folderPath || nb.folderName || '',
    extractedHandwritingText: [nb.extractedHandwritingText || '', ...boxTexts].filter(Boolean).join('\n'),
    deviceId: manifest.deviceId || '',
    deviceName: manifest.deviceName || '',
    originDeviceId: nb.originDeviceId || manifest.originDeviceId || '',
    exportedAtMillis: manifest.exportedAtMillis || 0,
    createdAt: nb.createdAt || 0,
    updatedAt: nb.updatedAt || manifest.exportedAtMillis || 0,
    hasSourcePdf: !!(manifest.hasSourcePdf || entries[SOURCE_PDF_ENTRY] || pages.some((p) => p.backgroundPdfEntry)),
    audioCount,
    imageCount,
  };
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
    /** Notebook-level manifest fields changed on this device since the last save. */
    this.dirtyMetaKeys = new Set();
  }

  /** Marks manifest `notebook` fields as edited here, so a merge with a phone version keeps them. */
  markMeta(...keys) {
    for (const key of keys) this.dirtyMetaKeys.add(key);
    this.metaDirty = true;
  }

  get title() {
    return this.manifest.notebook?.title || this.fileName.replace(/\.docflownote$/i, '');
  }

  set title(v) {
    const next = String(v ?? '').trim();
    if (!next) return;
    this.manifest.notebook = { ...(this.manifest.notebook ?? {}), title: next };
    this.markMeta('title');
  }

  get originDeviceId() {
    return this.manifest.notebook?.originDeviceId || this.manifest.originDeviceId || '';
  }

  get folderId() {
    return this.manifest.notebook?.folderId || null;
  }

  set folderId(v) {
    this.manifest.notebook = { ...(this.manifest.notebook ?? {}), folderId: v || null };
    this.markMeta('folderId');
  }

  get folderPath() {
    return this.manifest.notebook?.folderPath || this.manifest.notebook?.folderName || '';
  }

  set folderPath(v) {
    this.manifest.notebook = { ...(this.manifest.notebook ?? {}), folderPath: String(v ?? '') };
    this.markMeta('folderPath');
  }

  setFolder(folderId, folderPath = '') {
    this.manifest.notebook = {
      ...(this.manifest.notebook ?? {}),
      folderId: folderId || null,
      folderPath: String(folderPath ?? ''),
    };
    this.markMeta('folderId', 'folderPath');
  }

  get coverColorArgb() {
    return this.manifest.notebook?.coverColorArgb ?? 0xff1e293b;
  }

  set coverColorArgb(v) {
    this.manifest.notebook = { ...(this.manifest.notebook ?? {}), coverColorArgb: v };
    this.markMeta('coverColorArgb');
  }

  get isFavorite() {
    return !!this.manifest.notebook?.isFavorite;
  }

  set isFavorite(v) {
    this.manifest.notebook = { ...(this.manifest.notebook ?? {}), isFavorite: !!v };
    this.markMeta('isFavorite');
  }

  get canvasMode() {
    return this.manifest.notebook?.canvasMode || 'PAGES';
  }

  set canvasMode(mode) {
    const next = mode === 'INFINITE' ? 'INFINITE' : 'PAGES';
    if (this.canvasMode === next) return;
    this.manifest.notebook = { ...(this.manifest.notebook ?? {}), canvasMode: next };
    this.markMeta('canvasMode');
  }

  get marginNotesEnabled() {
    return !!this.manifest.notebook?.marginNotesEnabled;
  }

  set marginNotesEnabled(v) {
    this.manifest.notebook = { ...(this.manifest.notebook ?? {}), marginNotesEnabled: !!v };
    this.markMeta('marginNotesEnabled');
  }

  get marginWidthPx() {
    const w = Number(this.manifest.notebook?.marginWidthPx);
    return Number.isFinite(w) && w > 0 ? w : DEFAULT_MARGIN_WIDTH;
  }

  set marginWidthPx(v) {
    const n = Number(v);
    const width = Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MARGIN_WIDTH;
    this.manifest.notebook = { ...(this.manifest.notebook ?? {}), marginWidthPx: width };
    this.markMeta('marginWidthPx');
  }

  get defaultTemplate() {
    return this.manifest.notebook?.defaultTemplate || 'GRID_5MM';
  }

  get extractedHandwritingText() {
    return this.manifest.notebook?.extractedHandwritingText || '';
  }

  set extractedHandwritingText(text) {
    this.manifest.notebook = { ...(this.manifest.notebook ?? {}), extractedHandwritingText: String(text || '') };
    this.markMeta('extractedHandwritingText');
  }

  get audioBookmarks() {
    return Array.isArray(this.manifest.audioBookmarks) ? this.manifest.audioBookmarks : [];
  }

  get isDirty() {
    return this.metaDirty || this.pages.some((p) => p.dirty);
  }

  /** Background PDF entry name and page index for [page], or null for paper pages. */
  backgroundOf(page) {
    if (page.backgroundPdfEntry && this.entries[page.backgroundPdfEntry]) {
      return { entry: page.backgroundPdfEntry, pageIndex: page.backgroundPdfPageIndex ?? 0 };
    }
    if (page.backgroundPdfPageIndex != null && this.manifest.hasSourcePdf && this.entries[SOURCE_PDF_ENTRY]) {
      return { entry: SOURCE_PDF_ENTRY, pageIndex: page.backgroundPdfPageIndex };
    }
    return null;
  }

  /** Total logical width of a page including the optional margin-notes column (every page, like Android). */
  pageTotalWidth(page) {
    if (this.canvasMode === 'INFINITE') return page.widthPx;
    return this.marginNotesEnabled
      ? page.widthPx + this.marginWidthPx
      : page.widthPx;
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

  layerOpacity(item) {
    const layer = this.resolveLayer(item.layerId);
    const op = layer?.opacity;
    return typeof op === 'number' && Number.isFinite(op) ? Math.max(0.05, Math.min(1, op)) : 1;
  }

  sortedLayers() {
    return [...this.layers].sort((a, b) => (a.sortOrder - b.sortOrder) || (Number(a.id) - Number(b.id)));
  }

  /** "Hintergrund" for the worksheet layer, "Ebene N" for the others, unless renamed. */
  layerDisplayName(layer, t) {
    const legacy = ['worksheet', 'solution', 'notes', 'layer', 'arbeitsblatt', 'lösung', 'notizen', 'ebene', 'background'];
    const name = (layer.name ?? '').trim();
    if (name && !legacy.includes(name.toLowerCase())) return name;
    if (layer.type === 'WORKSHEET') return t('layerBackground');
    const others = this.sortedLayers().filter((l) => l.type !== 'WORKSHEET');
    return t('layerN', others.indexOf(layer) + 1);
  }

  addLayer(name = '') {
    const ids = this.layers.map((l) => Number(l.id)).filter(Number.isFinite);
    // Large, time-based ids never collide with the small Room ids of the phone
    const id = Math.max(Date.now(), ...ids.map((v) => v + 1));
    const layer = {
      id,
      name,
      type: 'SOLUTION',
      isVisible: true,
      isLocked: false,
      opacity: 1,
      sortOrder: Math.max(-1, ...this.layers.map((l) => l.sortOrder ?? 0)) + 1,
      createdAt: Date.now(),
    };
    this.layers.push(layer);
    this.metaDirty = true;
    return layer;
  }

  reorderLayers(fromIndex, toIndex) {
    const sorted = this.sortedLayers();
    if (fromIndex < 0 || fromIndex >= sorted.length || toIndex < 0 || toIndex >= sorted.length || fromIndex === toIndex) {
      return false;
    }
    const [moved] = sorted.splice(fromIndex, 1);
    sorted.splice(toIndex, 0, moved);
    sorted.forEach((l, i) => { l.sortOrder = i; });
    this.metaDirty = true;
    return true;
  }

  setLayerOpacity(layer, opacity) {
    const clamped = Math.max(0.1, Math.min(1, Number(opacity) || 1));
    layer.opacity = +clamped.toFixed(2);
    this.metaDirty = true;
  }

  renameLayer(layer, name) {
    const target = typeof layer === 'object' && layer !== null
      ? layer
      : (this.layerById(layer) ?? this.resolveLayer(layer));
    if (!target) return false;
    target.name = String(name ?? '').trim();
    this.metaDirty = true;
    return true;
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

  /** Re-indexes `pageIndex` & `payloadEntry` sequentially after insert/reorder/delete. */
  reindexPages() {
    this.pages.forEach((page, idx) => {
      if (page.pageIndex !== idx) {
        page.pageIndex = idx;
        page.payloadEntry = `pages/page_${idx}.json`;
        page.dirty = true;
      }
    });
    this.metaDirty = true;
  }

  addPage(template, atIndex = this.pages.length) {
    const insertAt = Math.max(0, Math.min(this.pages.length, atIndex));
    const ref = this.pages[Math.max(0, insertAt - 1)] ?? this.pages[0];
    const pageIndex = Math.max(-1, ...this.pages.map((p) => p.pageIndex)) + 1;
    const page = {
      pageIndex,
      template: template || this.defaultTemplate,
      widthPx: ref && !this.backgroundOf(ref) ? ref.widthPx : DEFAULT_PAGE_WIDTH,
      heightPx: ref && !this.backgroundOf(ref) ? ref.heightPx : DEFAULT_PAGE_HEIGHT,
      payloadEntry: `pages/page_${pageIndex}.json`,
      backgroundPdfPageIndex: null,
      backgroundPdfEntry: null,
      updatedAt: Date.now(),
      payload: emptyPayload(),
      dirty: true,
    };
    this.pages.splice(insertAt, 0, page);
    this.reindexPages();
    return page;
  }

  duplicatePage(index) {
    const src = this.pages[index];
    if (!src) return null;
    const copy = {
      ...src,
      payload: structuredClone(src.payload),
      updatedAt: Date.now(),
      dirty: true,
    };
    // Give copied items fresh IDs
    for (const listName of ['strokes', 'tapes', 'textBoxes', 'images']) {
      copy.payload[listName] = copy.payload[listName].map((it) => ({
        ...it,
        id: `${it.id}_c_${Math.random().toString(36).slice(2, 6)}`,
      }));
    }
    this.pages.splice(index + 1, 0, copy);
    this.reindexPages();
    return copy;
  }

  deletePage(index) {
    if (this.pages.length <= 1 || index < 0 || index >= this.pages.length) return false;
    this.pages.splice(index, 1);
    this.reindexPages();
    return true;
  }

  reorderPages(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.pages.length || toIndex < 0 || toIndex >= this.pages.length || fromIndex === toIndex) {
      return false;
    }
    const [moved] = this.pages.splice(fromIndex, 1);
    this.pages.splice(toIndex, 0, moved);
    this.reindexPages();
    return true;
  }

  setPageTemplate(index, template) {
    const page = this.pages[index];
    if (!page || !TEMPLATES.includes(template)) return false;
    page.template = template;
    page.dirty = true;
    this.metaDirty = true;
    return true;
  }

  toggleBookmark(index) {
    const page = this.pages[index];
    if (!page) return false;
    page.payload.isBookmarked = !page.payload.isBookmarked;
    page.dirty = true;
    return page.payload.isBookmarked;
  }

  /** Appends every page of another PDF into this notebook (matches Android claude/eager-wozniak-so4azi). */
  appendPdfPages(pdfBytes, pdfPageSizes) {
    if (!pdfBytes || !pdfPageSizes?.length) return [];
    let bgIdx = 0;
    while (this.entries[`backgrounds/bg_${bgIdx}.pdf`]) bgIdx++;
    const bgEntry = `backgrounds/bg_${bgIdx}.pdf`;
    this.entries[bgEntry] = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);

    if (!this.layers.some((l) => l.type === 'WORKSHEET')) {
      this.layers.unshift({
        id: Math.max(Date.now(), 100),
        name: '',
        type: 'WORKSHEET',
        isVisible: true,
        isLocked: true,
        opacity: 1,
        sortOrder: -1,
        createdAt: Date.now(),
      });
      this.sortedLayers().forEach((l, i) => { l.sortOrder = i; });
    }

    const now = Date.now();
    const added = [];
    for (let i = 0; i < pdfPageSizes.length; i++) {
      const size = pdfPageSizes[i];
      const pageIndex = this.pages.length;
      const page = {
        pageIndex,
        template: 'BLANK',
        widthPx: DEFAULT_PAGE_WIDTH,
        heightPx: Math.max(100, DEFAULT_PAGE_WIDTH * (size.height / size.width)),
        payloadEntry: `pages/page_${pageIndex}.json`,
        backgroundPdfPageIndex: i,
        backgroundPdfEntry: bgEntry,
        updatedAt: now,
        payload: emptyPayload(),
        dirty: true,
      };
      this.pages.push(page);
      added.push(page);
    }
    this.reindexPages();
    return added;
  }

  /** Stores an embedded image inside the `.docflownote` bundle under `images/<name>`. */
  addImageEntry(bytes, ext = 'png') {
    const cleanExt = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const name = `${IMAGES_PREFIX}img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${cleanExt}`;
    this.entries[name] = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.metaDirty = true;
    return name;
  }

  /** Resolves an image item's bytes inside the bundle (supports `images/...` or basename fallback). */
  getImageBytes(imagePath) {
    const key = resolveImageEntryKey(this.entries, imagePath);
    return key ? this.entries[key] : null;
  }

  /** Adds a lecture audio recording into `audio/` and registers a bookmark entry in manifest. */
  addAudioEntry(bytes, { ext = 'webm', label = '', pageIndex = 0, durationMs = 0 } = {}) {
    const cleanExt = String(ext || 'webm').toLowerCase().replace(/[^a-z0-9]/g, '') || 'webm';
    const fileName = `rec_${Date.now()}.${cleanExt}`;
    const entryName = `${AUDIO_PREFIX}${fileName}`;
    this.entries[entryName] = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const bookmarks = [...this.audioBookmarks];
    const bookmark = {
      id: Date.now(),
      entryName,
      fileName,
      pageIndex,
      label: label || `Aufnahme ${bookmarks.length + 1}`,
      durationMs: Math.max(0, Math.round(durationMs)),
      createdAt: Date.now(),
    };
    bookmarks.push(bookmark);
    this.manifest.audioBookmarks = bookmarks;
    this.metaDirty = true;
    return bookmark;
  }

  /** Lists all audio entries inside the bundle (both manifest bookmarks and Android `audio/*.m4a`). */
  listAudioEntries() {
    const fromManifest = this.audioBookmarks.filter((b) => this.entries[b.entryName]);
    const known = new Set(fromManifest.map((b) => b.entryName));
    const discovered = Object.keys(this.entries)
      .filter((k) => k.startsWith(AUDIO_PREFIX) && !known.has(k))
      .map((entryName, i) => ({
        id: i + 1,
        entryName,
        fileName: entryName.slice(AUDIO_PREFIX.length),
        pageIndex: 0,
        label: entryName.slice(AUDIO_PREFIX.length).replace(/\.[^.]+$/, ''),
        durationMs: 0,
        createdAt: 0,
      }));
    return [...fromManifest, ...discovered];
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

  const layers = (Array.isArray(manifest.layers) ? manifest.layers : []).map((l) => ({
    opacity: 1,
    ...l,
  }));
  if (layers.length === 0) {
    layers.push({ id: 1, name: '', type: 'SOLUTION', isVisible: true, isLocked: false, opacity: 1, sortOrder: 0, createdAt: 0 });
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

  const referencedImages = new Set();
  for (const page of notebook.pages) {
    for (const img of page.payload?.images || []) {
      const key = resolveImageEntryKey(entries, img?.imagePath);
      if (key) referencedImages.add(key);
    }
  }
  for (const name of Object.keys(entries)) {
    if (name.startsWith(IMAGES_PREFIX) && !referencedImages.has(name)) {
      delete entries[name];
    }
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

  // PDFs, images & audio are already compressed – store level 0 to keep autosaves instant
  const zipInput = {};
  for (const [name, data] of Object.entries(entries)) {
    zipInput[name] = name.endsWith('.json') ? data : [data, { level: 0 }];
  }
  const bytes = zipSync(zipInput, { level: 6 });

  notebook.manifest = manifest;
  notebook.entries = entries;
  notebook.pages.forEach((p) => { p.dirty = false; });
  notebook.metaDirty = false;
  notebook.dirtyMetaKeys?.clear();
  return bytes;
}

/** A new notebook created on Windows (blank, infinite, or from a PDF whose page sizes are given in points). */
export function createNotebook({
  title,
  deviceId,
  template = 'GRID_5MM',
  canvasMode = 'PAGES',
  coverColorArgb = 0xff1e293b,
  folderId = null,
  folderPath = '',
  pdfBytes = null,
  pdfPageSizes = [],
}) {
  const now = Date.now();
  const entries = {};
  const fromPdf = pdfBytes && pdfPageSizes.length > 0;
  if (fromPdf) entries['backgrounds/bg_0.pdf'] = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);

  const layers = fromPdf
    ? [
        { id: 1, name: '', type: 'WORKSHEET', isVisible: true, isLocked: true, opacity: 1, sortOrder: 0, createdAt: now },
        { id: 2, name: '', type: 'SOLUTION', isVisible: true, isLocked: false, opacity: 1, sortOrder: 1, createdAt: now },
      ]
    : [{ id: 1, name: '', type: 'SOLUTION', isVisible: true, isLocked: false, opacity: 1, sortOrder: 0, createdAt: now }];

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
      originDeviceId: deviceId,
      coverColorArgb: Number(coverColorArgb) >>> 0,
      canvasMode: fromPdf ? 'PAGES' : (canvasMode === 'INFINITE' ? 'INFINITE' : 'PAGES'),
      defaultTemplate: template,
      marginNotesEnabled: false,
      marginWidthPx: DEFAULT_MARGIN_WIDTH,
      pageCount: pages.length,
      isFavorite: false,
      folderId: folderId || null,
      folderPath: folderPath || '',
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

  const layers = remote.layers.map((l) => ({ opacity: 1, ...l }));
  for (const layer of local.layers) {
    if (!layers.some((l) => String(l.id) === String(layer.id))) layers.push(layer);
  }

  const localNb = local.manifest.notebook ?? {};
  const remoteNb = remote.manifest.notebook ?? {};
  // Only fields edited here since the last save override the phone's values; everything else
  // (e.g. a favorite or folder set on the phone while the notebook is open here) comes from remote.
  const dirtyKeys = local.dirtyMetaKeys ?? new Set();
  const mergedNotebook = { ...remoteNb };
  for (const key of dirtyKeys) {
    if (localNb[key] !== undefined) mergedNotebook[key] = localNb[key];
  }
  if (dirtyKeys.has('extractedHandwritingText') && !localNb.extractedHandwritingText) {
    mergedNotebook.extractedHandwritingText = remoteNb.extractedHandwritingText || '';
  }

  const mergedAudio = [...(Array.isArray(remote.manifest.audioBookmarks) ? remote.manifest.audioBookmarks : [])];
  for (const bm of Array.isArray(local.manifest.audioBookmarks) ? local.manifest.audioBookmarks : []) {
    if (!mergedAudio.some((r) => r.entryName === bm.entryName)) mergedAudio.push(bm);
  }

  local.manifest = {
    ...remote.manifest,
    notebook: mergedNotebook,
    ...(mergedAudio.length ? { audioBookmarks: mergedAudio } : {}),
  };
  local.entries = { ...remote.entries, ...pickLocalAssets(local.entries, merged) };
  local.pages = merged;
  local.layers = layers;
  local.metaDirty = local.metaDirty || localDirty.size > 0;
  return local;
}

function pickLocalAssets(entries, pages) {
  const out = {};
  for (const page of pages) {
    if (page.backgroundPdfEntry && entries[page.backgroundPdfEntry]) out[page.backgroundPdfEntry] = entries[page.backgroundPdfEntry];
    for (const img of page.payload?.images || []) {
      const key = resolveImageEntryKey(entries, img?.imagePath);
      if (key) out[key] = entries[key];
    }
  }
  for (const [k, v] of Object.entries(entries)) {
    if (k.startsWith(AUDIO_PREFIX)) out[k] = v;
  }
  return out;
}
