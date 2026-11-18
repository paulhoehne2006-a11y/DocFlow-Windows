// The notebook editor: pages on one viewport canvas, S Pen input (pressure, tilt, side button,
// eraser tip), palm rejection, touch pan/pinch, tools, layers, undo and autosave.

import { drawPaper, drawPageContent, drawStroke, strokeHit, strokeInLasso, strokeBounds, cssHexToArgb } from './render.js';
import { PdfBackgrounds } from './pdfbg.js';
import { pointOf } from './model.js';
import { t } from './i18n.js';

const PAGE_GAP = 70; // page px between pages
const MARGIN = 40; // css px around the document
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 6;
const MAX_CACHE_EDGE = 4096;
const INK_TOOLS = ['FOUNTAIN_PEN', 'FINELINER', 'BALLPOINT_PEN', 'PENCIL', 'BRUSH_PEN', 'CALLIGRAPHY_PEN', 'HIGHLIGHTER'];

export const DEFAULT_TOOL_SETTINGS = {
  FOUNTAIN_PEN: { color: '#0f172a', width: 5.5 },
  FINELINER: { color: '#0f172a', width: 4 },
  BALLPOINT_PEN: { color: '#1d4ed8', width: 4.5 },
  PENCIL: { color: '#334155', width: 5 },
  BRUSH_PEN: { color: '#0f172a', width: 9 },
  CALLIGRAPHY_PEN: { color: '#0f172a', width: 8 },
  HIGHLIGHTER: { color: '#facc15', width: 28 },
  ERASER: { width: 24 },
};

function newId() {
  return crypto.randomUUID();
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
  constructor(root, { settings, onDirty, onStatus, onToast }) {
    this.root = root;
    this.settings = settings;
    this.onDirty = onDirty;
    this.onStatus = onStatus;
    this.onToast = onToast;

    this.view = root.querySelector('#view');
    this.wet = root.querySelector('#wet');
    this.ctx = this.view.getContext('2d');
    this.wetCtx = this.wet.getContext('2d', { desynchronized: true });

    this.notebook = null;
    this.zoom = 1;
    this.cam = { x: 0, y: 0 };
    this.tool = settings.tool || 'FOUNTAIN_PEN';
    this.toolSettings = structuredClone({ ...DEFAULT_TOOL_SETTINGS, ...(settings.toolSettings || {}) });
    this.activeLayerId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null; // { pageIndex, ids:Set, bounds }
    this.caches = new Map(); // pageIndex → { canvas, scale, valid }
    this.pdf = new PdfBackgrounds();
    this.pointers = new Map(); // touch pointers for pan/pinch
    this.action = null; // current pen/mouse action
    this.dirtyFrame = false;
    this.lastInteraction = 0;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.bindInput();
  }

  // ---- Notebook ----

  open(notebook, { keepView = false } = {}) {
    const prevCam = { ...this.cam };
    const prevZoom = this.zoom;
    this.notebook = notebook;
    this.pdf.dispose();
    this.pdf = new PdfBackgrounds();
    this.pdf.setSource(notebook.entries);
    this.caches.clear();
    this.selection = null;
    if (!keepView) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.layout();
    const layers = notebook.sortedLayers();
    if (!this.activeLayerId || !notebook.layerById(this.activeLayerId)) {
      const drawable = [...layers].reverse().find((l) => !l.isLocked && l.isVisible !== false && l.type !== 'WORKSHEET')
        ?? [...layers].reverse().find((l) => !l.isLocked) ?? layers[layers.length - 1];
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
    this.requestDraw();
  }

  close() {
    this.pdf.dispose();
    this.notebook = null;
    this.caches.clear();
  }

  layout() {
    let y = 0;
    this.pageTops = [];
    this.docWidth = 0;
    for (const page of this.notebook.pages) {
      this.pageTops.push(y);
      y += page.heightPx + PAGE_GAP;
      this.docWidth = Math.max(this.docWidth, page.widthPx);
    }
    this.docHeight = Math.max(0, y - PAGE_GAP);
  }

  pageRect(i) {
    const page = this.notebook.pages[i];
    return { x: (this.docWidth - page.widthPx) / 2, y: this.pageTops[i], w: page.widthPx, h: page.heightPx };
  }

  // ---- Viewport ----

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.root.getBoundingClientRect();
    this.vw = Math.max(1, width);
    this.vh = Math.max(1, height);
    for (const c of [this.view, this.wet]) {
      c.width = Math.round(this.vw * dpr);
      c.height = Math.round(this.vh * dpr);
      c.style.width = `${this.vw}px`;
      c.style.height = `${this.vh}px`;
    }
    this.dpr = dpr;
    if (this.notebook) {
      this.clampCamera();
      this.requestDraw();
    }
  }

  /** Zoom at which the widest page fills the window (capped to a comfortable reading width). */
  fitZoom() {
    const fit = Math.min((this.vw - MARGIN * 2) / this.docWidth, 1400 / this.docWidth);
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fit));
  }

  fitWidth() {
    if (!this.notebook) return;
    this.zoom = this.fitZoom();
    this.cam = { x: 0, y: -MARGIN / this.zoom };
    this.clampCamera();
    this.requestDraw();
  }

  clampCamera() {
    if (!this.notebook) return;
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
    this.requestDraw();
    this.root.dispatchEvent(new CustomEvent('viewchange'));
  }

  scrollBy(dx, dy) {
    this.cam.x += dx / this.zoom;
    this.cam.y += dy / this.zoom;
    this.clampCamera();
    this.touchInteraction();
    this.requestDraw();
    this.root.dispatchEvent(new CustomEvent('viewchange'));
  }

  toDoc(sx, sy) {
    return { x: sx / this.zoom + this.cam.x, y: sy / this.zoom + this.cam.y };
  }

  /** Page under a doc point, with the point in that page's coordinates. */
  hitPage(doc, { nearest = false } = {}) {
    let best = null;
    for (let i = 0; i < this.notebook.pages.length; i++) {
      const r = this.pageRect(i);
      const inside = doc.x >= r.x && doc.x <= r.x + r.w && doc.y >= r.y && doc.y <= r.y + r.h;
      if (inside) return { index: i, x: doc.x - r.x, y: doc.y - r.y };
      if (nearest) {
        const dy = doc.y < r.y ? r.y - doc.y : doc.y - (r.y + r.h);
        if (!best || dy < best.d) best = { d: dy, index: i, x: doc.x - r.x, y: doc.y - r.y };
      }
    }
    return nearest ? best : null;
  }

  currentPageIndex() {
    if (!this.notebook) return 0;
    const mid = this.cam.y + this.vh / this.zoom / 2;
    let idx = 0;
    for (let i = 0; i < this.pageTops.length; i++) if (this.pageTops[i] <= mid) idx = i;
    return idx;
  }

  goToPage(i) {
    const idx = Math.max(0, Math.min(this.notebook.pages.length - 1, i));
    this.cam.y = this.pageTops[idx] - MARGIN / this.zoom;
    this.clampCamera();
    this.requestDraw();
    this.root.dispatchEvent(new CustomEvent('viewchange'));
  }

  touchInteraction() {
    this.lastInteraction = performance.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.requestDraw(), 180);
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

  isVisibleItem = (item) => this.notebook.isItemVisible(item);

  /** Paper or PDF background of a page, drawn in page coordinates at [scalePx] device px per page px. */
  drawBackground(ctx, page, scalePx, onReady) {
    const bg = this.notebook.backgroundOf(page);
    const bgLayer = this.notebook.layers.find((l) => l.type === 'WORKSHEET');
    const bgVisible = !bgLayer || bgLayer.isVisible !== false;
    if (bg && bgVisible) {
      drawPaper(ctx, page.template, page.widthPx, page.heightPx, { withRuling: false });
      const raster = this.pdf.get(bg.entry, bg.pageIndex, page.widthPx * scalePx, onReady);
      if (raster) ctx.drawImage(raster, 0, 0, page.widthPx, page.heightPx);
    } else {
      drawPaper(ctx, page.template, page.widthPx, page.heightPx, { withRuling: !bg });
    }
  }

  pageCache(i, wantedScale) {
    const page = this.notebook.pages[i];
    const target = Math.min(wantedScale, MAX_CACHE_EDGE / Math.max(page.widthPx, page.heightPx));
    const c = this.caches.get(i);
    const settling = performance.now() - this.lastInteraction < 170;
    const scaleOff = c && Math.abs(c.scale - target) / target > 0.2;
    if (c && c.valid && (!scaleOff || settling)) return c;
    // While a pinch is running, keep the old resolution so zooming stays fluid
    const scale = c && scaleOff && settling ? c.scale : target;
    const canvas = c && c.scale === scale ? c.canvas : new OffscreenCanvas(Math.ceil(page.widthPx * scale), Math.ceil(page.heightPx * scale));
    const cx = canvas.getContext('2d');
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, canvas.width, canvas.height);
    cx.setTransform(scale, 0, 0, scale, 0, 0);
    this.drawBackground(cx, page, scale, () => this.invalidatePage(i));
    drawPageContent(cx, page.payload, this.isVisibleItem);
    const next = { canvas, scale, valid: true };
    this.caches.set(i, next);
    return next;
  }

  draw() {
    if (!this.notebook) return;
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(this.root).getPropertyValue('--desk').trim() || '#e2e8f0';
    ctx.fillRect(0, 0, this.view.width, this.view.height);

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
      ctx.shadowColor = 'rgba(15,23,42,0.18)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = '#fff';
      ctx.fillRect(sx, sy, sw, sh);
      ctx.shadowColor = 'transparent';

      const cache = this.pageCache(i, wanted);
      const sharpNeeded = wanted > cache.scale * 1.05 && performance.now() - this.lastInteraction > 170;
      if (sharpNeeded) {
        // Zoomed in further than a cache can hold: draw the visible part as vectors
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.max(0, sx), Math.max(0, sy), Math.min(this.vw, sx + sw) - Math.max(0, sx), Math.min(this.vh, sy + sh) - Math.max(0, sy));
        ctx.clip();
        ctx.setTransform(this.zoom * dpr, 0, 0, this.zoom * dpr, sx * dpr, sy * dpr);
        this.drawBackground(ctx, this.notebook.pages[i], wanted, () => this.invalidatePage(i));
        drawPageContent(ctx, this.notebook.pages[i].payload, this.isVisibleItem);
        ctx.restore();
      } else {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(cache.canvas, sx, sy, sw, sh);
      }

      if (this.selection?.pageIndex === i) this.drawSelection(ctx, sx, sy);
    }
    // Free memory of pages far away
    for (const key of this.caches.keys()) if (!keep.has(key)) this.caches.delete(key);
    this.root.dispatchEvent(new CustomEvent('drawn'));
  }

  drawSelection(ctx, sx, sy) {
    const b = this.selection.bounds;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(sx + b.left * this.zoom, sy + b.top * this.zoom, (b.right - b.left) * this.zoom, (b.bottom - b.top) * this.zoom);
    ctx.restore();
  }

  clearWet() {
    this.wetCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.wetCtx.clearRect(0, 0, this.wet.width, this.wet.height);
  }

  drawWet() {
    this.clearWet();
    const a = this.action;
    if (!a) return;
    const r = this.pageRect(a.pageIndex);
    const ctx = this.wetCtx;
    ctx.setTransform(this.zoom * this.dpr, 0, 0, this.zoom * this.dpr, (r.x - this.cam.x) * this.zoom * this.dpr, (r.y - this.cam.y) * this.zoom * this.dpr);
    if (a.kind === 'ink') {
      drawStroke(ctx, a.stroke);
    } else if (a.kind === 'lasso' && a.points.length > 1) {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2.6 / this.zoom;
      ctx.setLineDash([12 / this.zoom, 8 / this.zoom]);
      ctx.beginPath();
      ctx.moveTo(a.points[0].x, a.points[0].y);
      for (const p of a.points) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (a.kind === 'erase' && a.cursor) {
      ctx.strokeStyle = 'rgba(100,116,139,0.8)';
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.beginPath();
      ctx.arc(a.cursor.x, a.cursor.y, a.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---- Edit operations (undoable) ----

  activeLayer() {
    return this.notebook.layerById(this.activeLayerId);
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

  /** Replaces the strokes of a page and records the change for undo. */
  commitStrokes(pageIndex, nextStrokes) {
    const page = this.notebook.pages[pageIndex];
    const prev = page.payload.strokes;
    if (prev === nextStrokes) return;
    this.undoStack.push({ pageIndex, before: prev, after: nextStrokes });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.applyStrokes(pageIndex, nextStrokes);
  }

  applyStrokes(pageIndex, strokes) {
    const page = this.notebook.pages[pageIndex];
    page.payload.strokes = strokes;
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
    this.applyStrokes(op.pageIndex, op.before);
    this.goToPageIfHidden(op.pageIndex);
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.undoStack.push(op);
    this.selection = null;
    this.applyStrokes(op.pageIndex, op.after);
    this.goToPageIfHidden(op.pageIndex);
  }

  goToPageIfHidden(i) {
    const r = this.pageRect(i);
    const top = this.cam.y;
    const bottom = this.cam.y + this.vh / this.zoom;
    if (r.y + r.h < top || r.y > bottom) this.goToPage(i);
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    const page = this.notebook.pages[sel.pageIndex];
    this.selection = null;
    this.commitStrokes(sel.pageIndex, page.payload.strokes.filter((s) => !sel.ids.has(s.id)));
    this.root.dispatchEvent(new CustomEvent('selectionchange'));
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
    el.addEventListener('contextmenu', (e) => e.preventDefault()); // pen long-press
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey) {
        // Touchpad pinch and Ctrl+wheel
        this.zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - rect.left, e.clientY - rect.top);
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

  /** Eraser tip, or the S Pen side button when that setting is on. */
  wantsEraser(e) {
    if (e.pointerType !== 'pen') return false;
    if (e.button === 5 || (e.buttons & 32)) return true;
    return this.settings.barrelErases !== false && (e.button === 2 || (e.buttons & 2) === 2);
  }

  capture(pointerId) {
    try {
      this.root.setPointerCapture(pointerId);
    } catch { /* pointer already gone */ }
  }

  onPointerDown(e) {
    if (!this.notebook) return;
    const { sx, sy } = this.localPoint(e);

    if (e.pointerType === 'touch') {
      // Palm rejection: while the pen is on the screen, hands are ignored
      if (this.action && this.action.pointerType === 'pen') return;
      if (!(this.settings.fingerDraws && this.pointers.size === 0 && this.tool !== 'HAND')) {
        this.pointers.set(e.pointerId, { x: sx, y: sy });
        this.capture(e.pointerId);
        this.gesture = null;
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

    // A pen touching down cancels any finger gesture that started with the palm
    this.pointers.clear();
    this.gesture = null;

    const doc = this.toDoc(sx, sy);
    const tool = this.wantsEraser(e) ? 'ERASER' : this.tool;

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
      this.action = { kind: 'erase', active: true, pointerId: e.pointerId, pointerType: e.pointerType, pageIndex: hit.index, radius, removed: new Set(), before: this.notebook.pages[hit.index].payload.strokes };
      this.eraseAt(hit);
      return;
    }
    if (tool === 'LASSO') {
      this.action = { kind: 'lasso', pointerId: e.pointerId, pointerType: e.pointerType, pageIndex: hit.index, points: [{ x: hit.x, y: hit.y }] };
      return;
    }
    if (!INK_TOOLS.includes(tool) || !this.canDraw()) {
      
      return;
    }
    const ts = this.toolSettings[tool];
    const stroke = {
      id: newId(),
      layerId: String(this.activeLayerId),
      pageIndex: this.notebook.pages[hit.index].pageIndex,
      brushKind: tool,
      colorArgb: cssHexToArgb(ts.color),
      strokeWidth: ts.width,
      alpha: 1,
      isShapeSnapped: false,
      points: [],
    };
    this.action = { kind: 'ink', pointerId: e.pointerId, pointerType: e.pointerType, pageIndex: hit.index, stroke, t0: e.timeStamp };
    this.addInkPoint(e, hit.index);
    this.drawWet();
  }

  addInkPoint(e, pageIndex) {
    const a = this.action;
    const r = this.pageRect(pageIndex);
    const events = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
    const rect = this.root.getBoundingClientRect();
    for (const ev of events) {
      const x = (ev.clientX - rect.left) / this.zoom + this.cam.x - r.x;
      const y = (ev.clientY - rect.top) / this.zoom + this.cam.y - r.y;
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
    for (const s of page.payload.strokes) {
      if (a.removed.has(s.id) || !this.isEditable(s)) continue;
      if (strokeHit(s, hit.x, hit.y, a.radius)) {
        a.removed.add(s.id);
        changed = true;
      }
    }
    if (changed) {
      page.payload.strokes = a.before.filter((s) => !a.removed.has(s.id));
      this.invalidatePage(a.pageIndex);
    }
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

    // Eraser cursor while the pen hovers with the button pressed
    if (!this.action && e.pointerType === 'pen' && (this.wantsEraser(e) || this.tool === 'ERASER')) {
      const hit = this.hitPage(this.toDoc(sx, sy));
      if (hit) {
        this.action = { kind: 'erase', active: false, pageIndex: hit.index, radius: (this.toolSettings.ERASER.width / 2) / Math.min(1, this.zoom), cursor: { x: hit.x, y: hit.y } };
        this.drawWet();
        this.action = null;
      }
      return;
    }

    const a = this.action;
    if (!a || a.pointerId !== e.pointerId) return;
    if (a.kind === 'pan') {
      this.scrollBy(a.last.sx - sx, a.last.sy - sy);
      a.last = { sx, sy };
      return;
    }
    const r = this.pageRect(a.pageIndex);
    const doc = this.toDoc(sx, sy);
    const local = { x: doc.x - r.x, y: doc.y - r.y };
    if (a.kind === 'ink') {
      this.addInkPoint(e, a.pageIndex);
      if (!this.wetPending) {
        this.wetPending = true;
        requestAnimationFrame(() => { this.wetPending = false; this.drawWet(); });
      }
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
    if (e.pointerType === 'touch' && this.pointers.has(e.pointerId)) {
      this.pointers.delete(e.pointerId);
      this.gesture = null;
      return;
    }
    const a = this.action;
    if (!a || a.pointerId !== e.pointerId) return;
    this.action = null;
    this.clearWet();
    const page = this.notebook.pages[a.pageIndex];

    if (a.kind === 'ink' && !cancelled && a.stroke.points.length > 0) {
      this.commitStrokes(a.pageIndex, [...page.payload.strokes, a.stroke]);
    } else if (a.kind === 'erase' && a.removed.size > 0) {
      page.payload.strokes = a.before;
      this.commitStrokes(a.pageIndex, a.before.filter((s) => !a.removed.has(s.id)));
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
