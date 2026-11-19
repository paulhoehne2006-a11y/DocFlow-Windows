// The notebook editor: pages or Infinite 2D Canvas on one viewport canvas, S Pen input
// (pressure, tilt, side button, eraser tip), Hold-to-Snap shapes, Scribble-to-Erase,
// Geodreieck overlay, Dark Paper, PDF side margin notes, Study Tapes, Textboxes/Checklists,
// Embedded Images, Laser pointer, palm rejection, touch pan/pinch, layers, undo and autosave.

import {
  drawPaper,
  drawInfinitePaper,
  drawMarginNotes,
  drawPageContent,
  drawStroke,
  drawTape,
  drawLaserBeam,
  strokeHit,
  eraseStrokeSegments,
  strokeInLasso,
  strokeBounds,
  hitTestTape,
  hitTestTextBox,
  hitTestImage,
  cssHexToArgb,
} from './render.js';
import { PdfBackgrounds } from './pdfbg.js';
import { pointOf } from './model.js';
import { t } from './i18n.js';
import { recognizeShape, isScribbleToErase } from './shapes.js';
import {
  DEFAULT_PIXELS_PER_CM,
  createDefaultRuler,
  normalizeAngleDegrees,
  snapAngleToCommonIncrements,
  snapPointIfEnabled,
  formatDisplayAngle,
  hitTestGeodreieck,
  drawGeodreieckOverlay,
} from './geodreieck.js';

const PAGE_GAP = 70; // page px between pages
const MARGIN = 40; // css px around the document
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 6;
const MAX_CACHE_EDGE = 4096;
const HOLD_TO_SNAP_DELAY_MS = 380;

export const INK_TOOLS = [
  'FOUNTAIN_PEN',
  'FINELINER',
  'BALLPOINT_PEN',
  'PENCIL',
  'BRUSH_PEN',
  'CALLIGRAPHY_PEN',
  'HIGHLIGHTER',
];

export const DEFAULT_TOOL_SETTINGS = {
  FOUNTAIN_PEN: { color: '#0f172a', width: 5.5 },
  FINELINER: { color: '#0f172a', width: 4 },
  BALLPOINT_PEN: { color: '#1d4ed8', width: 4.5 },
  PENCIL: { color: '#334155', width: 5 },
  BRUSH_PEN: { color: '#0f172a', width: 9 },
  CALLIGRAPHY_PEN: { color: '#0f172a', width: 8 },
  HIGHLIGHTER: { color: '#facc15', width: 28 },
  TAPE_OCCLUSION: { color: '#4f46e5', width: 44 },
  ERASER: { width: 24, mode: 'STROKE' },
};

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Converts browser pen tilt to the normalized (tiltX, tiltY) the Android app stores. */
function penTilt(e) {
  if (typeof e.altitudeAngle === 'number' && typeof e.azimuthAngle === 'number' && e.pointerType === 'pen') {
    const tilt = Math.max(0, Math.min(Math.PI / 2, Math.PI / 2 - e.altitudeAngle));
    const mag = Math.sin(tilt);
    return [mag * Math.cos(e.azimuthAngle), mag * Math.sin(e.azimuthAngle)];
  }
  if (e.tiltX || e.tiltY) {
    return [Math.sin((e.tiltX * Math.PI) / 180), Math.sin((e.tiltY * Math.PI) / 180)];
  }
  return [0, 0];
}

export class Editor {
  constructor(root, {
    settings = {},
    onDirty = () => {},
    onStatus = () => {},
    onToast = () => {},
    onEditTextBox = null,
    onRequestImage = null,
    onAudioSeek = null,
    getAudioRecordingOffsetMs = null,
    onRadialMenu = null,
  } = {}) {
    this.root = root;
    this.settings = settings;
    this.onDirty = onDirty;
    this.onStatus = onStatus;
    this.onToast = onToast;
    this.onEditTextBox = onEditTextBox;
    this.onRequestImage = onRequestImage;
    this.onAudioSeek = onAudioSeek;
    this.getAudioRecordingOffsetMs = getAudioRecordingOffsetMs;
    this.onRadialMenu = onRadialMenu;

    this.view = root.querySelector('canvas.view, canvas#view, canvas');
    this.wet = root.querySelector('canvas.wet, canvas#wet') || root.querySelectorAll('canvas')[1];
    this.geoOverlayEl = root.querySelector('[data-testid="geodreieck-overlay"], .geodreieck-overlay');
    this.ctx = this.view.getContext('2d');
    this.wetCtx = this.wet.getContext('2d');

    this.notebook = null;
    this.zoom = 1;
    this.cam = { x: 0, y: 0 };
    this.tool = settings.tool || 'FOUNTAIN_PEN';
    this.toolSettings = structuredClone({ ...DEFAULT_TOOL_SETTINGS, ...(settings.toolSettings || {}) });
    for (const [k, def] of Object.entries(DEFAULT_TOOL_SETTINGS)) {
      this.toolSettings[k] = { ...def, ...(this.toolSettings[k] || {}) };
    }
    this.activeLayerId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null; // { pageIndex, ids:Set, bounds }
    this.selectedBox = null; // { pageIndex, id }
    this.selectedImage = null; // { pageIndex, id }
    this.caches = new Map(); // pageIndex → { canvas, scale, valid }
    this.imageBitmaps = new Map(); // imagePath → ImageBitmap | null
    this.pdf = new PdfBackgrounds();
    this.pointers = new Map(); // touch pointers for pan/pinch
    this.action = null; // current pen/mouse action
    this.dirtyFrame = false;
    this.lastInteraction = 0;

    this.darkPaper = Boolean(settings.darkPaper);
    this.studyMode = false;
    this.readingMode = false;
    this.audioJumpMode = false;
    this.activeAudioOffsetMs = null;
    this.ruler = createDefaultRuler(827, 720);
    this.laserBeams = [];
    this.laserRaf = null;
    this.holdSnapTimer = null;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.bindInput();
  }

  // ---- Notebook ----

  open(notebook, { keepView = false, preserveAssets = false } = {}) {
    const prevCam = { ...this.cam };
    const prevZoom = this.zoom;
    this.notebook = notebook;
    if (!preserveAssets) {
      this.pdf.dispose();
      this.pdf = new PdfBackgrounds();
      this.pdf.setSource(notebook.entries);
      this.clearImageBitmaps();
      this.decodeAllImages();
    }
    this.caches.clear();
    this.selection = null;
    this.selectedBox = null;
    this.selectedImage = null;
    if (!keepView) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.layout();
    const layers = notebook.sortedLayers();
    if (!this.activeLayerId || !notebook.layerById(this.activeLayerId)) {
      const drawable = [...layers].reverse().find((l) => !l.isLocked && l.isVisible !== false && l.type !== 'WORKSHEET')
        ?? [...layers].reverse().find((l) => !l.isLocked)
        ?? layers[layers.length - 1];
      this.activeLayerId = drawable ? String(drawable.id) : null;
    }
    this.resize();
    if (keepView) {
      this.zoom = prevZoom;
      this.cam = prevCam;
      this.clampCamera();
    } else {
      this.fitWidth();
    }
    this.syncGeodreieckDom();
    this.requestDraw();
    this.root.dispatchEvent(new CustomEvent('selectionchange'));
    this.root.dispatchEvent(new CustomEvent('historychange'));
  }

  async prewarm(nb = this.notebook) {
    if (!nb) return;
    this.notebook = nb;
    this.pdf.dispose();
    this.pdf = new PdfBackgrounds();
    this.pdf.setSource(nb.entries);
    this.layout();

    const dpr = window.devicePixelRatio || 1;
    const estVw = this.vw > 100 ? this.vw : Math.max(320, (window.innerWidth || 1440));
    const docW = Math.max(400, this.docWidth || 1654);
    const estZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((estVw - MARGIN * 2) / docW, 1400 / docW)));
    const wantedScale = estZoom * dpr;

    const jobs = [];
    for (let i = 0; i < Math.min(2, nb.pages.length); i++) {
      const page = nb.pages[i];
      const bg = nb.backgroundOf(page);
      if (bg) {
        const totalW = nb.pageTotalWidth(page);
        const target = Math.min(wantedScale, MAX_CACHE_EDGE / Math.max(totalW, page.heightPx));
        const buckets = new Set([
          PdfBackgrounds.bucketFor(page.widthPx * target),
          800,
          1400,
        ]);
        for (const bucket of buckets) {
          const key = `${bg.entry}#${bg.pageIndex}@${bucket}`;
          if (!this.pdf.rasters.has(key)) {
            const job = this.pdf.render(bg.entry, bg.pageIndex, bucket)
              .then((bmp) => { this.pdf.rasters.set(key, bmp); })
              .catch(() => {});
            this.pdf.rasters.set(key, job);
            jobs.push(job);
          }
        }
      }
      for (const img of page.payload.images || []) {
        const bytes = nb.getImageBytes(img.imagePath);
        if (bytes && typeof createImageBitmap === 'function' && !this.imageBitmaps.get(img.imagePath)) {
          jobs.push(
            createImageBitmap(new Blob([bytes]))
              .then((bmp) => { this.imageBitmaps.set(img.imagePath, bmp); })
              .catch(() => {}),
          );
        }
      }
    }
    if (jobs.length > 0) {
      await Promise.all(jobs);
    }
  }

  close() {
    clearTimeout(this.holdSnapTimer);
    this.pdf.dispose();
    this.clearImageBitmaps();
    this.notebook = null;
    this.caches.clear();
  }

  clearImageBitmaps() {
    for (const bmp of this.imageBitmaps.values()) {
      if (bmp && typeof bmp.close === 'function') bmp.close();
    }
    this.imageBitmaps.clear();
  }

  decodeAllImages() {
    if (!this.notebook || typeof createImageBitmap !== 'function') return;
    for (const page of this.notebook.pages) {
      for (const img of page.payload.images || []) {
        this.ensureImageBitmap(img.imagePath);
      }
    }
  }

  ensureImageBitmap(imagePath) {
    if (!imagePath || !this.notebook || this.imageBitmaps.has(imagePath)) return;
    const bytes = this.notebook.getImageBytes(imagePath);
    if (!bytes) return;
    this.imageBitmaps.set(imagePath, null);
    createImageBitmap(new Blob([bytes]))
      .then((bmp) => {
        this.imageBitmaps.set(imagePath, bmp);
        this.invalidateAll();
      })
      .catch(() => {
        this.imageBitmaps.delete(imagePath);
      });
  }

  getImageBitmap(imagePath) {
    if (!imagePath) return null;
    if (!this.imageBitmaps.has(imagePath)) this.ensureImageBitmap(imagePath);
    return this.imageBitmaps.get(imagePath) || null;
  }

  isInfinite() {
    return this.notebook?.canvasMode === 'INFINITE';
  }

  layout() {
    if (!this.notebook) return;
    let y = 0;
    this.pageTops = [];
    this.docWidth = 0;
    for (const page of this.notebook.pages) {
      this.pageTops.push(y);
      y += page.heightPx + PAGE_GAP;
      const w = this.notebook.pageTotalWidth(page);
      this.docWidth = Math.max(this.docWidth, w);
    }
    this.docHeight = Math.max(0, y - PAGE_GAP);
  }

  pageRect(i) {
    const page = this.notebook.pages[i] || this.notebook.pages[0];
    const w = this.notebook.pageTotalWidth(page);
    return {
      x: (this.docWidth - w) / 2,
      y: this.pageTops[i] ?? 0,
      w,
      h: page.heightPx,
      baseW: page.widthPx,
    };
  }

  // ---- Viewport ----

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.root.getBoundingClientRect();
    this.vw = Math.max(1, width);
    this.vh = Math.max(1, height);
    for (const c of [this.view, this.wet]) {
      if (!c) continue;
      c.width = Math.round(this.vw * dpr);
      c.height = Math.round(this.vh * dpr);
      c.style.width = `${this.vw}px`;
      c.style.height = `${this.vh}px`;
    }
    this.dpr = dpr;
    if (this.notebook) {
      this.clampCamera();
      this.syncGeodreieckDom();
      this.requestDraw();
    }
  }

  /** Zoom at which the widest page fills the window (capped to a comfortable reading width). */
  fitZoom() {
    const docW = Math.max(400, this.docWidth || 1654);
    const availW = Math.max(120, this.vw - MARGIN * 2);
    const fit = Math.min(availW / docW, 1400 / docW);
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fit));
  }

  fitWidth() {
    if (!this.notebook) return;
    this.layout();
    this.zoom = this.fitZoom();
    const viewW = this.vw / this.zoom;
    this.cam = {
      x: -(viewW - this.docWidth) / 2,
      y: -MARGIN / this.zoom,
    };
    this.clampCamera();
    this.syncGeodreieckDom();
    this.requestDraw();
    this.root.dispatchEvent(new CustomEvent('viewchange'));
  }

  centerView() {
    if (!this.notebook) return;
    this.zoom = this.fitZoom();
    const viewW = this.vw / this.zoom;
    const viewH = this.vh / this.zoom;
    if (this.isInfinite()) {
      const page = this.notebook.pages[0];
      const strokes = page?.payload?.strokes || [];
      if (strokes.length > 0) {
        const b = boundsOf(strokes);
        const cx = (b.left + b.right) / 2;
        const cy = (b.top + b.bottom) / 2;
        this.cam = { x: cx - viewW / 2, y: cy - viewH / 2 };
      } else {
        this.cam = { x: (page.widthPx - viewW) / 2, y: -MARGIN / this.zoom };
      }
    } else {
      this.cam = { x: -(viewW - this.docWidth) / 2, y: -MARGIN / this.zoom };
      this.clampCamera();
    }
    this.syncGeodreieckDom();
    this.requestDraw();
    this.root.dispatchEvent(new CustomEvent('viewchange'));
  }

  clampCamera() {
    if (!this.notebook || this.isInfinite()) return;
    const viewW = this.vw / this.zoom;
    const viewH = this.vh / this.zoom;
    const m = MARGIN / this.zoom;
    if (this.docWidth + 2 * m <= viewW) {
      this.cam.x = -(viewW - this.docWidth) / 2;
    } else {
      this.cam.x = Math.min(Math.max(this.cam.x, -m), this.docWidth + m - viewW);
    }
    const maxY = Math.max(-m, this.docHeight + m - viewH);
    this.cam.y = Math.min(Math.max(this.cam.y, -m), maxY);
  }

  zoomAt(factor, sx, sy) {
    const before = this.toDoc(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.cam.x = before.x - sx / this.zoom;
    this.cam.y = before.y - sy / this.zoom;
    this.clampCamera();
    this.touchInteraction();
    this.syncGeodreieckDom();
    this.requestDraw();
    this.root.dispatchEvent(new CustomEvent('viewchange'));
  }

  scrollBy(dx, dy) {
    this.cam.x += dx / this.zoom;
    this.cam.y += dy / this.zoom;
    this.clampCamera();
    this.touchInteraction();
    this.syncGeodreieckDom();
    this.requestDraw();
    this.root.dispatchEvent(new CustomEvent('viewchange'));
  }

  toDoc(sx, sy) {
    return { x: sx / this.zoom + this.cam.x, y: sy / this.zoom + this.cam.y };
  }

  toScreen(docX, docY) {
    return {
      sx: (docX - this.cam.x) * this.zoom,
      sy: (docY - this.cam.y) * this.zoom,
    };
  }

  /** Page under a doc point, with the point in that page's coordinates. */
  hitPage(doc, { nearest = false } = {}) {
    if (!this.notebook || !this.notebook.pages.length) return null;
    if (this.isInfinite()) {
      return { index: 0, x: doc.x, y: doc.y };
    }
    let best = null;
    for (let i = 0; i < this.notebook.pages.length; i++) {
      const r = this.pageRect(i);
      const inside = doc.x >= r.x && doc.x <= r.x + r.w && doc.y >= r.y && doc.y <= r.y + r.h;
      if (inside) return { index: i, x: doc.x - r.x, y: doc.y - r.y };
      if (nearest) {
        const dy = doc.y < r.y ? r.y - doc.y : (doc.y > r.y + r.h ? doc.y - (r.y + r.h) : 0);
        if (!best || dy < best.d) {
          const clampedX = Math.max(0, Math.min(r.w, doc.x - r.x));
          const clampedY = Math.max(0, Math.min(r.h, doc.y - r.y));
          best = { d: dy, index: i, x: clampedX, y: clampedY };
        }
      }
    }
    return nearest ? best : null;
  }

  currentPageIndex() {
    if (!this.notebook) return 0;
    if (this.isInfinite()) return 0;
    const mid = this.cam.y + this.vh / this.zoom / 2;
    let idx = 0;
    for (let i = 0; i < this.pageTops.length; i++) if (this.pageTops[i] <= mid) idx = i;
    return idx;
  }

  goToPage(i) {
    if (!this.notebook) return;
    const idx = Math.max(0, Math.min(this.notebook.pages.length - 1, i));
    this.cam.y = (this.pageTops[idx] ?? 0) - MARGIN / this.zoom;
    this.clampCamera();
    this.syncGeodreieckDom();
    this.requestDraw();
    this.root.dispatchEvent(new CustomEvent('viewchange'));
  }

  touchInteraction() {
    this.lastInteraction = performance.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.requestDraw(), 180);
  }

  // ---- Geodreieck ----

  toggleGeodreieck(force) {
    const next = typeof force === 'boolean' ? force : !this.ruler.enabled;
    this.ruler.enabled = next;
    if (next && this.notebook) {
      // Position Geodreieck in the upper-middle of the current viewport, well clear of the bottom dock
      const centerDoc = this.toDoc(this.vw * 0.46, this.vh * 0.28);
      this.ruler.centerX = centerDoc.x;
      this.ruler.centerY = centerDoc.y;
    }
    this.syncGeodreieckDom();
    this.requestDraw();
    return this.ruler.enabled;
  }

  syncGeodreieckDom() {
    const el = this.geoOverlayEl;
    if (!el) return;
    if (!this.ruler.enabled || !this.notebook) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const lengthCm = this.ruler.lengthCm ?? 14;
    const halfW = (lengthCm * DEFAULT_PIXELS_PER_CM) / 2;
    const height = halfW;
    const { sx, sy } = this.toScreen(this.ruler.centerX, this.ruler.centerY);
    const screenW = Math.round(halfW * 2 * this.zoom);
    const screenH = Math.round(height * this.zoom);

    el.style.left = `${Math.round(sx - screenW / 2)}px`;
    el.style.top = `${Math.round(sy)}px`;
    el.style.width = `${screenW}px`;
    el.style.height = `${screenH}px`;
    el.style.transformOrigin = '50% 0%';
    el.style.transform = `rotate(${this.ruler.angleDegrees}deg)`;
    el.dataset.angle = String(Math.round(this.ruler.angleDegrees));
    const badge = el.querySelector('.geo-angle-label');
    const angleText = formatDisplayAngle(this.ruler.angleDegrees);
    if (badge) badge.textContent = angleText;
    else el.textContent = angleText;
  }

  hitGeodreieckExtended(docX, docY) {
    if (!this.ruler.enabled) return null;
    const halfW = ((this.ruler.lengthCm ?? 14) * DEFAULT_PIXELS_PER_CM) / 2;
    const height = halfW;
    const rad = (this.ruler.angleDegrees * Math.PI) / 180;
    const cos = Math.cos(-rad);
    const sin = Math.sin(-rad);
    const dx = docX - this.ruler.centerX;
    const dy = docY - this.ruler.centerY;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;

    const handleR = Math.max(24, 22 / this.zoom);
    if (Math.hypot(lx - (halfW - 44), ly - 44) <= handleR) return 'rotate-right';
    if (Math.hypot(lx - (-halfW + 44), ly - 44) <= handleR) return 'rotate-left';

    // Outer bottom-left / bottom-right corner zones of the overlay box rotate the ruler
    if (ly >= height * 0.45 && ly <= height + 24 && Math.abs(lx) >= halfW * 0.55 && Math.abs(lx) <= halfW + 24) {
      return lx > 0 ? 'rotate-right' : 'rotate-left';
    }

    // Inner body grab zone (away from the top drawing edge y=0 so pen strokes along the edge draw ink)
    if (ly >= 28 && ly <= height * 0.88 && Math.abs(lx) <= (halfW - ly) * 0.85) {
      return 'body';
    }
    return null;
  }

  // ---- Mode Toggles ----

  setDarkPaper(enabled) {
    this.darkPaper = Boolean(enabled);
    this.invalidateAll();
  }

  setStudyMode(enabled) {
    this.studyMode = Boolean(enabled);
    this.invalidateAll();
  }

  setReadingMode(enabled) {
    this.readingMode = Boolean(enabled);
    this.root.dataset.reading = this.readingMode ? 'true' : 'false';
    if (this.readingMode && this.selection) {
      this.selection = null;
      this.root.dispatchEvent(new CustomEvent('selectionchange'));
      this.requestDraw();
    }
  }

  updateSettings(nextSettings) {
    this.settings = nextSettings || {};
  }

  revealAllTapes(revealed = true) {
    if (!this.notebook) return;
    this.studyMode = true;
    for (let i = 0; i < this.notebook.pages.length; i++) {
      const page = this.notebook.pages[i];
      for (const tp of page.payload.tapes || []) {
        tp.isRevealed = Boolean(revealed);
      }
      page.dirty = true;
    }
    this.onDirty();
    this.invalidateAll();
  }

  // ---- Drawing ----

  requestDraw() {
    if (this.dirtyFrame) return;
    this.dirtyFrame = true;
    requestAnimationFrame(() => {
      this.dirtyFrame = false;
      this.draw();
    });
  }

  invalidatePage(i) {
    const c = this.caches.get(i);
    if (c) c.valid = false;
    this.requestDraw();
  }

  invalidateAll() {
    for (const c of this.caches.values()) c.valid = false;
    this.requestDraw();
  }

  isVisibleItem = (item) => (this.notebook ? this.notebook.isItemVisible(item) : true);

  contentOptions(pageIndex) {
    return {
      selectedIds: this.selection?.pageIndex === pageIndex ? this.selection.ids : null,
      selectedBoxId: this.selectedBox?.pageIndex === pageIndex ? this.selectedBox.id : null,
      selectedImageId: this.selectedImage?.pageIndex === pageIndex ? this.selectedImage.id : null,
      darkPaper: this.darkPaper,
      studyMode: this.studyMode,
      layerOpacity: (item) => this.notebook.layerOpacity(item),
      getImageBitmap: (imagePath) => this.getImageBitmap(imagePath),
      activeAudioOffsetMs: this.activeAudioOffsetMs,
    };
  }

  /** Paper or PDF background of a page, drawn in page coordinates at [scalePx] device px per page px. */
  drawBackground(ctx, page, scalePx, onReady) {
    const bg = this.notebook.backgroundOf(page);
    const bgLayer = this.notebook.layers.find((l) => l.type === 'WORKSHEET');
    const bgVisible = !bgLayer || bgLayer.isVisible !== false;
    const totalW = this.notebook.pageTotalWidth(page);
    const hasMargin = !this.isInfinite() && this.notebook.marginNotesEnabled;

    if (bg && bgVisible) {
      drawPaper(ctx, page.template, page.widthPx, page.heightPx, { withRuling: false, darkPaper: this.darkPaper });
      const raster = this.pdf.get(bg.entry, bg.pageIndex, page.widthPx * scalePx, onReady);
      if (raster) {
        if (this.darkPaper) {
          ctx.save();
          ctx.filter = 'invert(0.9) hue-rotate(180deg)';
          ctx.globalAlpha = 0.88;
          ctx.drawImage(raster, 0, 0, page.widthPx, page.heightPx);
          ctx.restore();
        } else {
          ctx.drawImage(raster, 0, 0, page.widthPx, page.heightPx);
        }
      }
    } else {
      drawPaper(ctx, page.template, page.widthPx, page.heightPx, { withRuling: !bg, darkPaper: this.darkPaper });
    }

    if (hasMargin) {
      drawMarginNotes(ctx, page.widthPx, page.heightPx, {
        width: totalW - page.widthPx,
        darkPaper: this.darkPaper,
        template: page.template,
      });
    }
  }

  pageCache(i, wantedScale) {
    const page = this.notebook.pages[i];
    const totalW = this.notebook.pageTotalWidth(page);
    const target = Math.min(wantedScale, MAX_CACHE_EDGE / Math.max(totalW, page.heightPx));
    const c = this.caches.get(i);
    const settling = performance.now() - this.lastInteraction < 170;
    const scaleOff = c && Math.abs(c.scale - target) / target > 0.2;
    if (c && c.valid && (!scaleOff || settling)) return c;
    const scale = c && scaleOff && settling ? c.scale : target;
    const wPx = Math.max(1, Math.ceil(totalW * scale));
    const hPx = Math.max(1, Math.ceil(page.heightPx * scale));
    const canvas = c && c.scale === scale && c.canvas.width === wPx && c.canvas.height === hPx
      ? c.canvas
      : new OffscreenCanvas(wPx, hPx);
    const cx = canvas.getContext('2d');
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, canvas.width, canvas.height);
    cx.setTransform(scale, 0, 0, scale, 0, 0);
    this.drawBackground(cx, page, scale, () => this.invalidatePage(i));
    drawPageContent(cx, page.payload, this.isVisibleItem, this.contentOptions(i));
    const next = { canvas, scale, valid: true };
    this.caches.set(i, next);
    return next;
  }

  draw() {
    if (!this.notebook) return;
    const ctx = this.ctx;
    const dpr = this.dpr || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(this.root).getPropertyValue('--desk').trim() || '#0e1117';
    ctx.fillRect(0, 0, this.view.width, this.view.height);

    if (this.isInfinite()) {
      const page = this.notebook.pages[0];
      const left = this.cam.x;
      const top = this.cam.y;
      const right = this.cam.x + this.vw / this.zoom;
      const bottom = this.cam.y + this.vh / this.zoom;
      ctx.save();
      ctx.setTransform(this.zoom * dpr, 0, 0, this.zoom * dpr, -this.cam.x * this.zoom * dpr, -this.cam.y * this.zoom * dpr);
      drawInfinitePaper(ctx, page.template, left, top, right, bottom, { darkPaper: this.darkPaper });
      drawPageContent(ctx, page.payload, this.isVisibleItem, this.contentOptions(0));
      if (this.ruler.enabled) {
        drawGeodreieckOverlay(ctx, this.ruler, {
          isDark: this.darkPaper,
          zoom: this.zoom,
          active: this.action?.kind?.startsWith('ruler'),
        });
      }
      ctx.restore();
      if (this.selection?.pageIndex === 0) {
        this.drawSelection(ctx, -this.cam.x * this.zoom, -this.cam.y * this.zoom);
      }
      this.root.dispatchEvent(new CustomEvent('drawn'));
      return;
    }

    const wanted = this.zoom * dpr;
    const viewTop = this.cam.y;
    const viewBottom = this.cam.y + this.vh / this.zoom;
    const keep = new Set();

    for (let i = 0; i < this.notebook.pages.length; i++) {
      const r = this.pageRect(i);
      if (r.y + r.h < viewTop - 400 || r.y > viewBottom + 400) continue;
      keep.add(i);
      const sx = (r.x - this.cam.x) * this.zoom;
      const sy = (r.y - this.cam.y) * this.zoom;
      const sw = r.w * this.zoom;
      const sh = r.h * this.zoom;
      if (r.y + r.h < viewTop || r.y > viewBottom) continue;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
      ctx.shadowBlur = 20;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = this.darkPaper ? '#161B26' : '#FCFDFE';
      ctx.fillRect(sx, sy, sw, sh);
      ctx.shadowColor = 'transparent';

      const cache = this.pageCache(i, wanted);
      const sharpNeeded = wanted > cache.scale * 1.05 && performance.now() - this.lastInteraction > 170;
      if (sharpNeeded) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          Math.max(0, sx),
          Math.max(0, sy),
          Math.min(this.vw, sx + sw) - Math.max(0, sx),
          Math.min(this.vh, sy + sh) - Math.max(0, sy),
        );
        ctx.clip();
        ctx.setTransform(this.zoom * dpr, 0, 0, this.zoom * dpr, sx * dpr, sy * dpr);
        this.drawBackground(ctx, this.notebook.pages[i], wanted, () => this.invalidatePage(i));
        drawPageContent(ctx, this.notebook.pages[i].payload, this.isVisibleItem, this.contentOptions(i));
        ctx.restore();
      } else {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(cache.canvas, sx, sy, sw, sh);
      }

      if (this.selection?.pageIndex === i) this.drawSelection(ctx, sx, sy);
    }

    if (this.ruler.enabled) {
      ctx.save();
      ctx.setTransform(this.zoom * dpr, 0, 0, this.zoom * dpr, -this.cam.x * this.zoom * dpr, -this.cam.y * this.zoom * dpr);
      drawGeodreieckOverlay(ctx, this.ruler, {
        isDark: this.darkPaper,
        zoom: this.zoom,
        active: this.action?.kind?.startsWith('ruler'),
      });
      ctx.restore();
    }

    for (const key of this.caches.keys()) if (!keep.has(key)) this.caches.delete(key);
    this.root.dispatchEvent(new CustomEvent('drawn'));
  }

  drawSelection(ctx, sx, sy) {
    const b = this.selection.bounds;
    if (!b || !Number.isFinite(b.left)) return;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      sx + b.left * this.zoom,
      sy + b.top * this.zoom,
      (b.right - b.left) * this.zoom,
      (b.bottom - b.top) * this.zoom,
    );
    ctx.restore();
  }

  clearWet() {
    this.wetCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.wetCtx.clearRect(0, 0, this.wet.width, this.wet.height);
  }

  drawWet() {
    this.clearWet();
    const a = this.action;
    const now = performance.now();
    const dpr = this.dpr || 1;
    const ctx = this.wetCtx;

    if (a && a.pageIndex != null) {
      const r = this.isInfinite() ? { x: 0, y: 0 } : this.pageRect(a.pageIndex);
      ctx.setTransform(
        this.zoom * dpr,
        0,
        0,
        this.zoom * dpr,
        (r.x - this.cam.x) * this.zoom * dpr,
        (r.y - this.cam.y) * this.zoom * dpr,
      );
      if (a.kind === 'ink') {
        drawStroke(ctx, a.stroke, { darkPaper: this.darkPaper });
      } else if (a.kind === 'tape' && a.tape) {
        drawTape(ctx, a.tape, { studyMode: this.studyMode });
      } else if (a.kind === 'lasso' && a.points.length > 1) {
        ctx.strokeStyle = '#6366f1';
        ctx.lineWidth = 2.6 / this.zoom;
        ctx.setLineDash([12 / this.zoom, 8 / this.zoom]);
        ctx.beginPath();
        ctx.moveTo(a.points[0].x, a.points[0].y);
        for (const p of a.points) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (a.kind === 'erase' && a.cursor) {
        ctx.strokeStyle = 'rgba(129, 140, 248, 0.85)';
        ctx.lineWidth = 1.6 / this.zoom;
        ctx.beginPath();
        ctx.arc(a.cursor.x, a.cursor.y, a.radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (this.laserBeams.length > 0) {
      ctx.setTransform(
        this.zoom * dpr,
        0,
        0,
        this.zoom * dpr,
        -this.cam.x * this.zoom * dpr,
        -this.cam.y * this.zoom * dpr,
      );
      this.laserBeams = this.laserBeams.filter((beam) => drawLaserBeam(ctx, beam, now));
      if (this.laserBeams.length > 0 && !this.laserRaf) {
        this.laserRaf = requestAnimationFrame(() => {
          this.laserRaf = null;
          this.drawWet();
        });
      }
    }
  }

  // ---- Edit operations (undoable) ----

  activeLayer() {
    return this.notebook?.layerById(this.activeLayerId) ?? null;
  }

  canDraw() {
    const layer = this.activeLayer();
    if (!layer) return false;
    if (layer.isLocked) { this.onToast(t('layerLocked')); return false; }
    if (layer.isVisible === false) { this.onToast(t('layerHidden')); return false; }
    return true;
  }

  isEditable(item) {
    const layer = this.notebook.resolveLayer(item.layerId);
    return !layer || (!layer.isLocked && layer.isVisible !== false);
  }

  /** Commits a new page payload snapshot and records it on the undo stack. */
  commitPayload(pageIndex, nextPayload) {
    const page = this.notebook.pages[pageIndex];
    if (!page) return;
    const before = structuredClone(page.payload);
    const after = structuredClone(nextPayload);
    this.undoStack.push({ pageIndex, before, after });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.applyPayload(pageIndex, after);
  }

  /** Replaces the strokes of a page and records the change for undo. */
  commitStrokes(pageIndex, nextStrokes) {
    const page = this.notebook.pages[pageIndex];
    if (!page || page.payload.strokes === nextStrokes) return;
    this.commitPayload(pageIndex, {
      ...page.payload,
      strokes: nextStrokes,
    });
  }

  applyPayload(pageIndex, payload) {
    const page = this.notebook.pages[pageIndex];
    if (!page) return;
    page.payload = structuredClone(payload);
    page.dirty = true;
    this.invalidatePage(pageIndex);
    this.onDirty();
    this.root.dispatchEvent(new CustomEvent('historychange'));
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    this.redoStack.push(op);
    this.selection = null;
    this.selectedBox = null;
    this.selectedImage = null;
    this.applyPayload(op.pageIndex, op.before);
    this.goToPageIfHidden(op.pageIndex);
    this.root.dispatchEvent(new CustomEvent('selectionchange'));
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.undoStack.push(op);
    this.selection = null;
    this.selectedBox = null;
    this.selectedImage = null;
    this.applyPayload(op.pageIndex, op.after);
    this.goToPageIfHidden(op.pageIndex);
    this.root.dispatchEvent(new CustomEvent('selectionchange'));
  }

  goToPageIfHidden(i) {
    if (this.isInfinite()) return;
    const r = this.pageRect(i);
    const top = this.cam.y;
    const bottom = this.cam.y + this.vh / this.zoom;
    if (r.y + r.h < top || r.y > bottom) this.goToPage(i);
  }

  deleteSelection() {
    if (this.selection) {
      const sel = this.selection;
      const page = this.notebook.pages[sel.pageIndex];
      this.selection = null;
      this.commitStrokes(sel.pageIndex, page.payload.strokes.filter((s) => !sel.ids.has(s.id)));
      this.root.dispatchEvent(new CustomEvent('selectionchange'));
      return;
    }
    if (this.selectedBox) {
      const { pageIndex, id } = this.selectedBox;
      const page = this.notebook.pages[pageIndex];
      this.selectedBox = null;
      this.commitPayload(pageIndex, {
        ...page.payload,
        textBoxes: (page.payload.textBoxes || []).filter((b) => b.id !== id),
      });
      this.root.dispatchEvent(new CustomEvent('selectionchange'));
      return;
    }
    if (this.selectedImage) {
      const { pageIndex, id } = this.selectedImage;
      const page = this.notebook.pages[pageIndex];
      this.selectedImage = null;
      this.commitPayload(pageIndex, {
        ...page.payload,
        images: (page.payload.images || []).filter((im) => im.id !== id),
      });
      this.root.dispatchEvent(new CustomEvent('selectionchange'));
    }
  }

  duplicateSelection() {
    const sel = this.selection;
    if (!sel) return;
    const page = this.notebook.pages[sel.pageIndex];
    const copies = [];
    const newIds = new Set();
    for (const s of page.payload.strokes) {
      if (sel.ids.has(s.id)) {
        const copy = translateStroke({ ...s, id: newId() }, 28, 28);
        copies.push(copy);
        newIds.add(copy.id);
      }
    }
    if (!copies.length) return;
    const nextStrokes = [...page.payload.strokes, ...copies];
    this.commitStrokes(sel.pageIndex, nextStrokes);
    this.selection = {
      pageIndex: sel.pageIndex,
      ids: newIds,
      bounds: boundsOf(copies),
    };
    this.invalidatePage(sel.pageIndex);
    this.root.dispatchEvent(new CustomEvent('selectionchange'));
  }

  recolorSelection(hexColor) {
    const sel = this.selection;
    if (!sel) return;
    const argb = cssHexToArgb(hexColor);
    const page = this.notebook.pages[sel.pageIndex];
    const nextStrokes = page.payload.strokes.map((s) => (sel.ids.has(s.id) ? { ...s, colorArgb: argb } : s));
    this.commitStrokes(sel.pageIndex, nextStrokes);
  }

  getSelectedStrokes() {
    const sel = this.selection;
    if (!sel || !this.notebook) return [];
    const page = this.notebook.pages[sel.pageIndex];
    return (page?.payload?.strokes || []).filter((s) => sel.ids.has(s.id));
  }

  upsertTextBox(pageIndex, boxData) {
    const page = this.notebook?.pages[pageIndex];
    if (!page) return null;
    const existingIdx = (page.payload.textBoxes || []).findIndex((b) => b.id === boxData.id);
    const nextBoxes = [...(page.payload.textBoxes || [])];
    const item = {
      id: boxData.id || newId(),
      layerId: boxData.layerId || String(this.activeLayerId || '1'),
      left: Math.round(boxData.left ?? 180),
      top: Math.round(boxData.top ?? 220),
      width: Math.max(80, Math.round(boxData.width ?? 420)),
      height: Math.max(44, Math.round(boxData.height ?? 140)),
      text: String(boxData.text ?? ''),
      fontSizeSp: Number(boxData.fontSizeSp) || 16,
      textColorArgb: boxData.textColorArgb ?? 0xff0f172a,
      backgroundColorArgb: boxData.backgroundColorArgb ?? 0,
      isBold: Boolean(boxData.isBold),
      isItalic: Boolean(boxData.isItalic),
      isChecklist: Boolean(boxData.isChecklist),
      isChecked: Boolean(boxData.isChecked),
    };
    if (existingIdx >= 0) nextBoxes[existingIdx] = item;
    else nextBoxes.push(item);
    this.commitPayload(pageIndex, { ...page.payload, textBoxes: nextBoxes });
    return item;
  }

  insertImageOnPage(pageIndex, imagePath, { x = 240, y = 240, width = 360, height = 240 } = {}) {
    const page = this.notebook?.pages[pageIndex];
    if (!page) return null;
    this.ensureImageBitmap(imagePath);
    const item = {
      id: newId(),
      layerId: String(this.activeLayerId || '1'),
      imagePath,
      left: Math.round(x),
      top: Math.round(y),
      right: Math.round(x + width),
      bottom: Math.round(y + height),
      rotationDegrees: 0,
    };
    this.commitPayload(pageIndex, {
      ...page.payload,
      images: [...(page.payload.images || []), item],
    });
    return item;
  }

  // ---- Input ----

  bindInput() {
    const el = this.root;
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    el.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    el.addEventListener('pointerleave', (e) => {
      if (this.action?.kind === 'erase' && !this.action.active) { this.action = null; this.clearWet(); }
      if (e.pointerType === 'touch') this.pointers.delete(e.pointerId);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { sx, sy } = this.localPoint(e);
      const doc = this.toDoc(sx, sy);

      // Rotating the Geodreieck with the mouse wheel when hovering over it
      if (this.ruler.enabled && !e.ctrlKey && this.hitGeodreieckExtended(doc.x, doc.y)) {
        const step = e.deltaY > 0 ? -15 : 15;
        this.ruler.angleDegrees = snapAngleToCommonIncrements(this.ruler.angleDegrees + step, 3);
        this.syncGeodreieckDom();
        this.requestDraw();
        return;
      }

      if (e.ctrlKey) {
        this.zoomAt(Math.exp(-e.deltaY * 0.0022), sx, sy);
      } else {
        const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.vh : 1;
        this.scrollBy((e.shiftKey ? e.deltaY : e.deltaX) * unit, (e.shiftKey ? 0 : e.deltaY) * unit);
      }
    }, { passive: false });
  }

  localPoint(e) {
    const rect = this.root.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  }

  /** Eraser tip, or the S Pen side button when configured as ERASER. */
  wantsEraser(e) {
    if (e.pointerType !== 'pen') return false;
    if (e.button === 5 || (e.buttons & 32)) return true;
    const sideAction = this.settings.sideButtonAction || 'ERASER';
    return sideAction === 'ERASER' && this.settings.barrelErases !== false && (e.button === 2 || (e.buttons & 2) === 2);
  }

  capture(pointerId) {
    try {
      this.root.setPointerCapture(pointerId);
    } catch { /* pointer already gone */ }
  }

  onPointerDown(e) {
    if (!this.notebook) return;
    if (e.target && e.target.closest?.('.split-pane-header')) return;
    const { sx, sy } = this.localPoint(e);
    const doc = this.toDoc(sx, sy);

    // 1. Geodreieck interaction takes priority when enabled and hit
    if (this.ruler.enabled) {
      const geoHit = this.hitGeodreieckExtended(doc.x, doc.y);
      if (geoHit === 'rotate-left' || geoHit === 'rotate-right') {
        const startAngle = (Math.atan2(doc.y - this.ruler.centerY, doc.x - this.ruler.centerX) * 180) / Math.PI;
        this.action = {
          kind: 'ruler-rotate',
          pointerId: e.pointerId,
          startPointerAngle: startAngle,
          initialRulerAngle: this.ruler.angleDegrees,
        };
        this.capture(e.pointerId);
        this.requestDraw();
        return;
      }
      if (geoHit === 'body') {
        this.action = {
          kind: 'ruler-move',
          pointerId: e.pointerId,
          offsetX: doc.x - this.ruler.centerX,
          offsetY: doc.y - this.ruler.centerY,
        };
        this.capture(e.pointerId);
        this.requestDraw();
        return;
      }
    }

    if (e.pointerType === 'touch') {
      if (this.action && this.action.pointerType === 'pen') return;
      if (!(this.settings.fingerDraws && this.pointers.size === 0 && this.tool !== 'HAND')) {
        this.pointers.set(e.pointerId, { x: sx, y: sy });
        this.capture(e.pointerId);
        this.gesture = null;
        return;
      }
    }

    // S-Pen side button custom actions (LASSO, UNDO, COLOR_CYCLE, RADIAL_MENU)
    if (e.pointerType === 'pen' && (e.button === 2 || (e.buttons & 2) === 2)) {
      const sideAction = this.settings.sideButtonAction || 'ERASER';
      if (sideAction === 'UNDO') {
        this.undo();
        return;
      }
      if (sideAction === 'RADIAL_MENU' && this.onRadialMenu) {
        this.onRadialMenu(e.clientX, e.clientY);
        return;
      }
    }

    if (e.pointerType === 'mouse' && (e.button === 1 || this.tool === 'HAND' || this.spaceDown)) {
      this.action = { kind: 'pan', pointerId: e.pointerId, pointerType: e.pointerType, last: { sx, sy } };
      this.capture(e.pointerId);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.tool === 'HAND' && e.pointerType !== 'mouse') {
      this.action = { kind: 'pan', pointerId: e.pointerId, pointerType: e.pointerType, last: { sx, sy } };
      this.capture(e.pointerId);
      return;
    }

    this.pointers.clear();
    this.gesture = null;

    // 2. Audio stroke-jump mode: clicking a stroke with audioOffsetMs seeks playback
    if (this.audioJumpMode && this.onAudioSeek) {
      const hit = this.hitPage(doc);
      if (hit) {
        const page = this.notebook.pages[hit.index];
        const hitStroke = [...(page.payload.strokes || [])]
          .reverse()
          .find((s) => this.isVisibleItem(s) && s.audioOffsetMs != null && strokeHit(s, hit.x, hit.y, 18));
        if (hitStroke) {
          this.onAudioSeek(hitStroke.audioOffsetMs);
          return;
        }
      }
    }

    // 3. Study Mode: clicking an occlusion tape toggles its revealed state
    if (this.studyMode) {
      const hit = this.hitPage(doc);
      if (hit) {
        const page = this.notebook.pages[hit.index];
        const tape = hitTestTape((page.payload.tapes || []).filter(this.isVisibleItem), hit.x, hit.y);
        if (tape) {
          tape.isRevealed = !tape.isRevealed;
          page.dirty = true;
          this.onDirty();
          this.invalidatePage(hit.index);
          return;
        }
      }
    }

    // 4. Checklist checkbox toggle on any visible checklist textbox
    {
      const hit = this.hitPage(doc);
      if (hit) {
        const page = this.notebook.pages[hit.index];
        const tbHit = hitTestTextBox((page.payload.textBoxes || []).filter(this.isVisibleItem), hit.x, hit.y);
        if (tbHit && tbHit.handle === 'checkbox' && this.isEditable(tbHit.item)) {
          const nextBoxes = page.payload.textBoxes.map((b) => (b.id === tbHit.item.id ? { ...b, isChecked: !b.isChecked } : b));
          this.commitPayload(hit.index, { ...page.payload, textBoxes: nextBoxes });
          return;
        }
      }
    }

    const sideAction = this.settings.sideButtonAction || 'ERASER';
    const barrelLasso = e.pointerType === 'pen' && sideAction === 'LASSO' && (e.button === 2 || (e.buttons & 2) === 2);
    const tool = this.wantsEraser(e) ? 'ERASER' : (barrelLasso ? 'LASSO' : this.tool);

    // 4b. Reading / Presentation Mode: block editing strokes, allow only Laserpointer or Pan
    if (this.readingMode && tool !== 'LASER') {
      this.action = { kind: 'pan', pointerId: e.pointerId, pointerType: e.pointerType, last: { sx, sy } };
      this.capture(e.pointerId);
      return;
    }

    // 5. Textbox tool: click existing textbox to edit/drag or click empty area to open creation modal
    if (tool === 'TEXT_BOX') {
      const hit = this.hitPage(doc, { nearest: true });
      if (!hit || !this.canDraw()) return;
      const page = this.notebook.pages[hit.index];
      const tbHit = hitTestTextBox((page.payload.textBoxes || []).filter(this.isVisibleItem), hit.x, hit.y);
      if (tbHit && this.isEditable(tbHit.item)) {
        this.selectedBox = { pageIndex: hit.index, id: tbHit.item.id };
        if (this.onEditTextBox) {
          this.onEditTextBox(hit.index, tbHit.item);
        }
        return;
      }
      if (this.onEditTextBox) {
        this.onEditTextBox(hit.index, {
          left: Math.max(40, Math.min(page.widthPx - 240, hit.x)),
          top: Math.max(40, Math.min(page.heightPx - 120, hit.y)),
          width: 420,
          height: 140,
          text: '',
          fontSizeSp: 16,
          textColorArgb: 0xff0f172a,
          backgroundColorArgb: 0xfffef3c7,
          isChecklist: false,
          isChecked: false,
        });
      }
      return;
    }

    // 6. Image tool: click existing image to move/resize/rotate, or request image pick
    if (tool === 'IMAGE') {
      const hit = this.hitPage(doc, { nearest: true });
      if (!hit || !this.canDraw()) return;
      const page = this.notebook.pages[hit.index];
      const imgHit = hitTestImage((page.payload.images || []).filter(this.isVisibleItem), hit.x, hit.y);
      if (imgHit && this.isEditable(imgHit.item)) {
        this.selectedImage = { pageIndex: hit.index, id: imgHit.item.id };
        this.action = {
          kind: 'image-transform',
          pointerId: e.pointerId,
          pageIndex: hit.index,
          handle: imgHit.handle,
          itemId: imgHit.item.id,
          start: { x: hit.x, y: hit.y },
          initial: structuredClone(imgHit.item),
          beforePayload: structuredClone(page.payload),
        };
        this.capture(e.pointerId);
        this.invalidatePage(hit.index);
        this.root.dispatchEvent(new CustomEvent('selectionchange'));
        return;
      }
      if (this.onRequestImage) {
        this.onRequestImage(hit.index, hit.x, hit.y);
      }
      return;
    }

    // 7. Laser pointer tool
    if (tool === 'LASER') {
      const beam = { id: newId(), createdAtMs: performance.now(), points: [{ x: doc.x, y: doc.y }] };
      this.laserBeams.push(beam);
      this.action = { kind: 'laser', pointerId: e.pointerId, beam };
      this.capture(e.pointerId);
      this.drawWet();
      return;
    }

    // 8. Lasso selection move or new lasso
    if (tool === 'LASSO' && this.selection) {
      const hit = this.hitPage(doc);
      const b = this.selection.bounds;
      if (hit && hit.index === this.selection.pageIndex && hit.x >= b.left && hit.x <= b.right && hit.y >= b.top && hit.y <= b.bottom) {
        this.action = { kind: 'move', pointerId: e.pointerId, pointerType: e.pointerType, pageIndex: hit.index, start: hit, dx: 0, dy: 0 };
        this.capture(e.pointerId);
        return;
      }
      this.selection = null;
      this.root.dispatchEvent(new CustomEvent('selectionchange'));
      this.requestDraw();
    }

    const hit = this.hitPage(doc, { nearest: tool !== 'ERASER' });
    if (!hit) return;
    this.capture(e.pointerId);

    if (tool === 'ERASER') {
      const radius = (this.toolSettings.ERASER.width / 2) / Math.min(1, this.zoom);
      const beforePayload = structuredClone(this.notebook.pages[hit.index].payload);
      this.action = {
        kind: 'erase',
        active: true,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        pageIndex: hit.index,
        radius,
        mode: this.toolSettings.ERASER.mode || 'STROKE',
        mutated: false,
        beforePayload,
      };
      this.eraseAt(hit);
      return;
    }

    if (tool === 'LASSO') {
      this.action = { kind: 'lasso', pointerId: e.pointerId, pointerType: e.pointerType, pageIndex: hit.index, points: [{ x: hit.x, y: hit.y }] };
      return;
    }

    // 9. Study Occlusion Tape drawing
    if (tool === 'TAPE_OCCLUSION') {
      if (!this.canDraw()) return;
      const ts = this.toolSettings.TAPE_OCCLUSION || DEFAULT_TOOL_SETTINGS.TAPE_OCCLUSION;
      const halfH = Math.max(18, (ts.width || 44) * 0.65);
      const tape = {
        id: newId(),
        layerId: String(this.activeLayerId),
        left: hit.x,
        top: hit.y - halfH,
        right: hit.x + 24,
        bottom: hit.y + halfH,
        colorArgb: cssHexToArgb(ts.color || '#4f46e5'),
        isRevealed: false,
      };
      this.action = {
        kind: 'tape',
        pointerId: e.pointerId,
        pageIndex: hit.index,
        startX: hit.x,
        startY: hit.y,
        halfH,
        tape,
      };
      this.drawWet();
      return;
    }

    if (!INK_TOOLS.includes(tool) || !this.canDraw()) {
      return;
    }

    const ts = this.toolSettings[tool] || DEFAULT_TOOL_SETTINGS.FOUNTAIN_PEN;
    const recOffset = this.getAudioRecordingOffsetMs ? this.getAudioRecordingOffsetMs() : null;
    const stroke = {
      id: newId(),
      layerId: String(this.activeLayerId),
      pageIndex: this.notebook.pages[hit.index].pageIndex,
      brushKind: tool,
      colorArgb: cssHexToArgb(ts.color),
      strokeWidth: ts.width,
      alpha: 1,
      isShapeSnapped: false,
      ...(recOffset != null ? { audioOffsetMs: recOffset } : {}),
      points: [],
    };
    this.action = {
      kind: 'ink',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      pageIndex: hit.index,
      stroke,
      t0: e.timeStamp,
    };
    this.addInkPoint(e, hit.index);
    this.scheduleHoldToSnap();
    this.drawWet();
  }

  scheduleHoldToSnap() {
    clearTimeout(this.holdSnapTimer);
    if (this.settings.holdToSnap === false) return;
    const a = this.action;
    if (!a || a.kind !== 'ink' || a.stroke.isShapeSnapped || this.ruler.enabled) return;
    this.holdSnapTimer = setTimeout(() => {
      if (!this.action || this.action !== a || a.stroke.isShapeSnapped) return;
      if (a.stroke.points.length < 4) return;
      const res = recognizeShape(a.stroke.points);
      if (res && res.shapeType !== 'NONE') {
        a.stroke.points = res.snappedPoints;
        a.stroke.isShapeSnapped = true;
        this.drawWet();
        this.onToast(t('shapeSnapped', t(`shape_${res.shapeType}`)));
      }
    }, HOLD_TO_SNAP_DELAY_MS);
  }

  addInkPoint(e, pageIndex) {
    const a = this.action;
    const r = this.isInfinite() ? { x: 0, y: 0 } : this.pageRect(pageIndex);
    const events = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
    const rect = this.root.getBoundingClientRect();
    for (const ev of events) {
      let docX = (ev.clientX - rect.left) / this.zoom + this.cam.x;
      let docY = (ev.clientY - rect.top) / this.zoom + this.cam.y;
      if (this.ruler.enabled) {
        const snapped = snapPointIfEnabled(docX, docY, this.ruler);
        docX = snapped.x;
        docY = snapped.y;
      }
      const x = docX - r.x;
      const y = docY - r.y;
      const pts = a.stroke.points;
      const last = pts[pts.length - 1];
      if (last && Math.hypot(last[0] - x, last[1] - y) < 0.6 / this.zoom) continue;
      const pressure = ev.pointerType === 'pen' ? Math.max(0.05, Math.min(1, ev.pressure || 0.05)) : 0.5;
      const [tx, ty] = penTilt(ev);
      pts.push([+x.toFixed(2), +y.toFixed(2), +pressure.toFixed(3), +tx.toFixed(3), +ty.toFixed(3), Math.round(ev.timeStamp - a.t0)]);
    }
  }

  eraseAt(hit) {
    const a = this.action;
    const page = this.notebook.pages[a.pageIndex];
    let changed = false;

    if (a.mode === 'AREA') {
      const nextStrokes = [];
      for (const s of page.payload.strokes) {
        if (!this.isEditable(s)) {
          nextStrokes.push(s);
          continue;
        }
        const segments = eraseStrokeSegments(s, hit.x, hit.y, a.radius);
        if (segments.length !== 1 || segments[0] !== s) {
          changed = true;
          a.mutated = true;
        }
        nextStrokes.push(...segments);
      }
      if (changed) page.payload.strokes = nextStrokes;
    } else {
      const nextStrokes = page.payload.strokes.filter((s) => {
        if (!this.isEditable(s)) return true;
        if (strokeHit(s, hit.x, hit.y, a.radius)) {
          changed = true;
          a.mutated = true;
          return false;
        }
        return true;
      });
      if (changed) page.payload.strokes = nextStrokes;
    }

    // Also allow erasing occlusion tapes touched by the eraser
    const beforeTapes = (page.payload.tapes || []).length;
    page.payload.tapes = (page.payload.tapes || []).filter((tp) => {
      if (!this.isEditable(tp)) return true;
      const left = Math.min(tp.left, tp.right) - a.radius;
      const right = Math.max(tp.left, tp.right) + a.radius;
      const top = Math.min(tp.top, tp.bottom) - a.radius;
      const bottom = Math.max(tp.top, tp.bottom) + a.radius;
      const hitTape = hit.x >= left && hit.x <= right && hit.y >= top && hit.y <= bottom;
      if (hitTape) {
        changed = true;
        a.mutated = true;
      }
      return !hitTape;
    });
    if (page.payload.tapes.length !== beforeTapes) changed = true;

    if (changed) this.invalidatePage(a.pageIndex);
    a.cursor = { x: hit.x, y: hit.y };
    this.drawWet();
  }

  onPointerMove(e) {
    if (!this.notebook) return;
    const { sx, sy } = this.localPoint(e);

    if (e.pointerType === 'touch' && this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x: sx, y: sy });
      this.handleGesture();
      return;
    }

    if (!this.action && e.pointerType === 'pen' && (this.wantsEraser(e) || this.tool === 'ERASER')) {
      const hit = this.hitPage(this.toDoc(sx, sy));
      if (hit) {
        this.action = {
          kind: 'erase',
          active: false,
          pageIndex: hit.index,
          radius: (this.toolSettings.ERASER.width / 2) / Math.min(1, this.zoom),
          cursor: { x: hit.x, y: hit.y },
        };
        this.drawWet();
        this.action = null;
      }
      return;
    }

    const a = this.action;
    if (!a || a.pointerId !== e.pointerId) return;
    const doc = this.toDoc(sx, sy);

    if (a.kind === 'ruler-move') {
      this.ruler.centerX = doc.x - a.offsetX;
      this.ruler.centerY = doc.y - a.offsetY;
      this.syncGeodreieckDom();
      this.requestDraw();
      return;
    }
    if (a.kind === 'ruler-rotate') {
      const angle = (Math.atan2(doc.y - this.ruler.centerY, doc.x - this.ruler.centerX) * 180) / Math.PI;
      const delta = angle - a.startPointerAngle;
      this.ruler.angleDegrees = snapAngleToCommonIncrements(normalizeAngleDegrees(a.initialRulerAngle + delta), 3);
      this.syncGeodreieckDom();
      this.requestDraw();
      return;
    }
    if (a.kind === 'pan') {
      this.scrollBy(a.last.sx - sx, a.last.sy - sy);
      a.last = { sx, sy };
      return;
    }
    if (a.kind === 'laser') {
      a.beam.points.push({ x: doc.x, y: doc.y });
      a.beam.createdAtMs = performance.now();
      this.drawWet();
      return;
    }

    const r = this.isInfinite() ? { x: 0, y: 0 } : this.pageRect(a.pageIndex);
    const local = { x: doc.x - r.x, y: doc.y - r.y };

    if (a.kind === 'ink') {
      const prevLen = a.stroke.points.length;
      this.addInkPoint(e, a.pageIndex);
      if (a.stroke.points.length !== prevLen && !a.stroke.isShapeSnapped) {
        this.scheduleHoldToSnap();
      }
      if (!this.wetPending) {
        this.wetPending = true;
        requestAnimationFrame(() => { this.wetPending = false; this.drawWet(); });
      }
    } else if (a.kind === 'tape') {
      a.tape.left = Math.min(a.startX, local.x);
      a.tape.right = Math.max(a.startX + 24, local.x);
      a.tape.top = Math.min(a.startY, local.y) - a.halfH;
      a.tape.bottom = Math.max(a.startY, local.y) + a.halfH;
      this.drawWet();
    } else if (a.kind === 'image-transform') {
      const page = this.notebook.pages[a.pageIndex];
      const dx = local.x - a.start.x;
      const dy = local.y - a.start.y;
      page.payload.images = page.payload.images.map((im) => {
        if (im.id !== a.itemId) return im;
        if (a.handle === 'resize') {
          return {
            ...im,
            right: Math.max(a.initial.left + 40, a.initial.right + dx),
            bottom: Math.max(a.initial.top + 40, a.initial.bottom + dy),
          };
        }
        if (a.handle === 'rotate') {
          const cx = (a.initial.left + a.initial.right) / 2;
          const cy = (a.initial.top + a.initial.bottom) / 2;
          const deg = (Math.atan2(local.y - cy, local.x - cx) * 180) / Math.PI + 90;
          return { ...im, rotationDegrees: Math.round(deg) };
        }
        return {
          ...im,
          left: a.initial.left + dx,
          right: a.initial.right + dx,
          top: a.initial.top + dy,
          bottom: a.initial.bottom + dy,
        };
      });
      this.invalidatePage(a.pageIndex);
    } else if (a.kind === 'erase') {
      this.eraseAt(local);
    } else if (a.kind === 'lasso') {
      a.points.push(local);
      this.drawWet();
    } else if (a.kind === 'move') {
      a.dx = local.x - a.start.x;
      a.dy = local.y - a.start.y;
      this.previewMove(a);
    }
  }

  previewMove(a) {
    const page = this.notebook.pages[a.pageIndex];
    if (!a.original) a.original = page.payload.strokes;
    page.payload.strokes = a.original.map((s) => (this.selection.ids.has(s.id) ? translateStroke(s, a.dx, a.dy) : s));
    this.selection.bounds = boundsOf(page.payload.strokes.filter((s) => this.selection.ids.has(s.id)));
    this.invalidatePage(a.pageIndex);
  }

  onPointerUp(e, cancelled = false) {
    clearTimeout(this.holdSnapTimer);
    if (e.pointerType === 'touch' && this.pointers.has(e.pointerId)) {
      this.pointers.delete(e.pointerId);
      this.gesture = null;
      return;
    }
    const a = this.action;
    if (!a || a.pointerId !== e.pointerId) return;
    this.action = null;
    this.clearWet();

    if (a.kind === 'ruler-move' || a.kind === 'ruler-rotate') {
      this.syncGeodreieckDom();
      this.requestDraw();
      return;
    }
    if (a.kind === 'laser' || a.kind === 'pan') {
      this.drawWet();
      return;
    }

    const page = this.notebook?.pages[a.pageIndex];
    if (!page) return;

    if (a.kind === 'ink' && !cancelled && a.stroke.points.length >= 2) {
      // Check Scribble-to-Erase gesture first
      if (!a.stroke.isShapeSnapped && this.settings.scribbleToErase !== false && isScribbleToErase(a.stroke.points)) {
        const scribbleBox = strokeBounds(a.stroke);
        const remaining = page.payload.strokes.filter((s) => {
          if (!this.isEditable(s)) return true;
          const sb = strokeBounds(s);
          const overlaps = !(sb.right < scribbleBox.left || sb.left > scribbleBox.right || sb.bottom < scribbleBox.top || sb.top > scribbleBox.bottom);
          return !overlaps;
        });
        if (remaining.length < page.payload.strokes.length) {
          this.commitStrokes(a.pageIndex, remaining);
          return;
        }
      }
      this.commitStrokes(a.pageIndex, [...page.payload.strokes, a.stroke]);
    } else if (a.kind === 'tape' && !cancelled) {
      if (Math.abs(a.tape.right - a.tape.left) >= 16) {
        this.commitPayload(a.pageIndex, {
          ...page.payload,
          tapes: [...(page.payload.tapes || []), a.tape],
        });
      }
    } else if (a.kind === 'image-transform') {
      const afterPayload = structuredClone(page.payload);
      page.payload = a.beforePayload;
      this.commitPayload(a.pageIndex, afterPayload);
    } else if (a.kind === 'erase' && a.mutated) {
      const afterPayload = structuredClone(page.payload);
      page.payload = a.beforePayload;
      this.commitPayload(a.pageIndex, afterPayload);
    } else if (a.kind === 'lasso' && a.points.length > 2) {
      const ids = new Set(page.payload.strokes.filter((s) => this.isEditable(s) && strokeInLasso(s, a.points)).map((s) => s.id));
      this.selection = ids.size ? { pageIndex: a.pageIndex, ids, bounds: boundsOf(page.payload.strokes.filter((s) => ids.has(s.id))) } : null;
      this.root.dispatchEvent(new CustomEvent('selectionchange'));
      this.requestDraw();
    } else if (a.kind === 'move' && a.original) {
      const moved = page.payload.strokes;
      page.payload.strokes = a.original;
      if (a.dx || a.dy) this.commitStrokes(a.pageIndex, moved);
    }
  }

  handleGesture() {
    const pts = [...this.pointers.values()];
    if (pts.length === 1) {
      const p = pts[0];
      if (this.gesture?.type === 'pan') this.scrollBy(this.gesture.x - p.x, this.gesture.y - p.y);
      this.gesture = { type: 'pan', x: p.x, y: p.y };
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.gesture?.type === 'pinch') {
        this.scrollBy(this.gesture.cx - cx, this.gesture.cy - cy);
        if (this.gesture.dist > 0) this.zoomAt(dist / this.gesture.dist, cx, cy);
      }
      this.gesture = { type: 'pinch', cx, cy, dist };
    }
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 'LASSO' && this.selection) {
      this.selection = null;
      this.root.dispatchEvent(new CustomEvent('selectionchange'));
      this.requestDraw();
    }
    this.root.dataset.tool = tool;
  }
}

function translateStroke(s, dx, dy) {
  return {
    ...s,
    points: s.points.map((p) => (Array.isArray(p) ? [p[0] + dx, p[1] + dy, ...p.slice(2)] : { ...p, x: p.x + dx, y: p.y + dy })),
  };
}

function boundsOf(strokes) {
  const b = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const s of strokes) {
    const sb = strokeBounds(s);
    b.left = Math.min(b.left, sb.left);
    b.top = Math.min(b.top, sb.top);
    b.right = Math.max(b.right, sb.right);
    b.bottom = Math.max(b.bottom, sb.bottom);
  }
  return b;
}

export { pointOf };
