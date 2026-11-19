// Vector PDF export with pdf-lib + PNG page export.
// Supports selective layer modes (matching Android ExportLayerMode), embedded images,
// text boxes / sticky notes / checklists, study tapes, PDF side margin notes, Dark Paper,
// and Infinite Canvas auto-bounding-box export.

import {
  PDFDocument,
  rgb,
  LineCapStyle,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip as pdfClip,
  endPath,
} from '../vendor/pdf-lib.esm.min.js';
import {
  drawPaper,
  drawInfinitePaper,
  drawMarginNotes,
  drawStroke,
  drawTape,
  drawPageContent,
  strokeBounds,
} from './render.js';
import { DEFAULT_MARGIN_WIDTH } from './model.js';

const A4_WIDTH_PT = 595.28;

export const EXPORT_LAYER_MODES = Object.freeze({
  ALL_VISIBLE: 'ALL_VISIBLE',
  WITH_SOLUTIONS: 'WITH_SOLUTIONS',
  ALL_LAYERS: 'ALL_LAYERS',
  BLANK_WORKSHEET_ONLY: 'BLANK_WORKSHEET_ONLY',
  ONLY_SOLUTIONS: 'ONLY_SOLUTIONS',
});

function parseColor(css) {
  if (typeof css !== 'string') return { color: rgb(0, 0, 0), opacity: 1 };
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim());
    return { color: rgb(+r / 255, +g / 255, +b / 255), opacity: Math.max(0, Math.min(1, +a)) };
  }
  const hex = css.replace('#', '');
  const v = parseInt(hex.slice(0, 6), 16);
  return { color: rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255), opacity: 1 };
}

const n = (v) => (Math.round(v * 100) / 100).toString();

/** Implements the subset of CanvasRenderingContext2D that render.js uses, emitting PDF paths. */
class PdfRecorder {
  constructor(page, scale, heightPt, { coalesce = false, offsetX = 0, offsetY = 0 } = {}) {
    this.page = page;
    this.scale = scale;
    this.heightPt = heightPt;
    this.coalesce = coalesce;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.path = '';
    this.lastRect = null;
    this.pending = null;
    this.stack = [];
    this.strokeStyle = '#000';
    this.fillStyle = '#000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'round';
    this.globalAlpha = 1;
    this.dash = [];
  }

  save() {
    this.stack.push({
      strokeStyle: this.strokeStyle,
      fillStyle: this.fillStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      dash: [...this.dash],
      globalAlpha: this.globalAlpha,
      hasClip: false,
    });
  }

  restore() {
    this.flush();
    const frame = this.stack.pop();
    if (!frame) return;
    if (frame.hasClip) {
      this.page.pushOperators(popGraphicsState());
    }
    this.strokeStyle = frame.strokeStyle;
    this.fillStyle = frame.fillStyle;
    this.lineWidth = frame.lineWidth;
    this.lineCap = frame.lineCap;
    this.dash = frame.dash;
    this.globalAlpha = frame.globalAlpha;
  }

  setLineDash(d) { this.dash = d; }
  beginPath() { this.path = ''; this.lastRect = null; }
  moveTo(x, y) { this.path += `M${n(x - this.offsetX)} ${n(y - this.offsetY)}`; }
  lineTo(x, y) { this.path += `L${n(x - this.offsetX)} ${n(y - this.offsetY)}`; }
  quadraticCurveTo(cx, cy, x, y) { this.path += `Q${n(cx - this.offsetX)} ${n(cy - this.offsetY)} ${n(x - this.offsetX)} ${n(y - this.offsetY)}`; }
  arc(x, y, r) {
    const ax = x - this.offsetX;
    const ay = y - this.offsetY;
    this.path += `M${n(ax - r)} ${n(ay)}A${n(r)} ${n(r)} 0 1 0 ${n(ax + r)} ${n(ay)}A${n(r)} ${n(r)} 0 1 0 ${n(ax - r)} ${n(ay)}Z`;
  }
  rect(x, y, w, h) {
    this.lastRect = {
      x: Math.min(x, x + w),
      y: Math.min(y, y + h),
      w: Math.abs(w),
      h: Math.abs(h),
    };
    this.path += `M${n(x - this.offsetX)} ${n(y - this.offsetY)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  }
  roundRect(x, y, w, h) { this.rect(x, y, w, h); }
  fillRect(x, y, w, h) { this.beginPath(); this.rect(x, y, w, h); this.fill(); }
  clip() {
    this.flush();
    const r = this.lastRect;
    this.path = '';
    this.lastRect = null;
    if (!r || r.w <= 0 || r.h <= 0) return;
    const top = this.stack[this.stack.length - 1];
    if (top && !top.hasClip) {
      this.page.pushOperators(pushGraphicsState());
      top.hasClip = true;
    }
    this.page.pushOperators(
      rectangle(
        (r.x - this.offsetX) * this.scale,
        this.heightPt - (r.y - this.offsetY + r.h) * this.scale,
        r.w * this.scale,
        r.h * this.scale,
      ),
      pdfClip(),
      endPath(),
    );
  }

  stroke() { this.emit('stroke'); }
  fill() { this.emit('fill'); }

  emit(kind) {
    if (!this.path) return;
    const style = kind === 'stroke' ? this.strokeStyle : this.fillStyle;
    const key = `${kind}|${style}|${this.lineWidth}|${this.lineCap}|${this.dash.join(',')}|${this.globalAlpha}`;
    if (this.coalesce && this.pending?.key === key) {
      this.pending.path += this.path;
      return;
    }
    this.flush();
    this.pending = { key, kind, style, width: this.lineWidth, cap: this.lineCap, dash: [...this.dash], alpha: this.globalAlpha, path: this.path };
    if (!this.coalesce) this.flush();
  }

  flush() {
    const op = this.pending;
    this.pending = null;
    if (!op) return;
    const { color, opacity } = parseColor(op.style);
    const finalOpacity = Math.max(0, Math.min(1, opacity * (op.alpha ?? 1)));
    const common = { x: 0, y: this.heightPt, scale: this.scale };
    if (op.kind === 'fill') {
      this.page.drawSvgPath(op.path, { ...common, color, opacity: finalOpacity });
    } else {
      this.page.drawSvgPath(op.path, {
        ...common,
        borderColor: color,
        borderOpacity: finalOpacity,
        borderWidth: op.width,
        borderLineCap: op.cap === 'round' ? LineCapStyle.Round : op.cap === 'square' ? LineCapStyle.Projecting : LineCapStyle.Butt,
        borderDashArray: op.dash.length ? op.dash : undefined,
      });
    }
  }
}

function shouldIncludeBackground(notebook, layerMode) {
  if (layerMode === 'ONLY_SOLUTIONS') return false;
  if (layerMode === 'WITH_SOLUTIONS' || layerMode === 'ALL_LAYERS' || layerMode === 'BLANK_WORKSHEET_ONLY') return true;
  const bgLayer = notebook.layers.find((l) => l.type === 'WORKSHEET');
  return !bgLayer || bgLayer.isVisible !== false;
}

function makeItemFilter(notebook, layerMode) {
  if (layerMode === 'BLANK_WORKSHEET_ONLY') return () => false;
  if (layerMode === 'WITH_SOLUTIONS' || layerMode === 'ALL_LAYERS') return () => true;
  if (layerMode === 'ONLY_SOLUTIONS') {
    return (item) => {
      const layer = notebook.resolveLayer(item.layerId);
      return !layer || layer.type !== 'WORKSHEET';
    };
  }
  return (item) => notebook.isItemVisible(item);
}

/** Computes content bounding box for Infinite Canvas PDF export. */
function infiniteContentBounds(page) {
  let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
  const expand = (l, t, r, b) => {
    if (l < left) left = l;
    if (t < top) top = t;
    if (r > right) right = r;
    if (b > bottom) bottom = b;
  };
  for (const s of page.payload.strokes || []) {
    const b = strokeBounds(s);
    if (Number.isFinite(b.left)) expand(b.left, b.top, b.right, b.bottom);
  }
  for (const box of page.payload.textBoxes || []) {
    expand(box.left, box.top, box.left + (box.width ?? 420), box.top + (box.height ?? 140));
  }
  for (const img of page.payload.images || []) {
    expand(Math.min(img.left, img.right), Math.min(img.top, img.bottom), Math.max(img.left, img.right), Math.max(img.top, img.bottom));
  }
  for (const tp of page.payload.tapes || []) {
    expand(Math.min(tp.left, tp.right), Math.min(tp.top, tp.bottom), Math.max(tp.left, tp.right), Math.max(tp.top, tp.bottom));
  }
  if (!Number.isFinite(left)) return { offsetX: 0, offsetY: 0, widthPx: page.widthPx, heightPx: page.heightPx };
  const pad = 80;
  return {
    offsetX: left - pad,
    offsetY: top - pad,
    widthPx: Math.max(400, right - left + pad * 2),
    heightPx: Math.max(400, bottom - top + pad * 2),
  };
}

function isJpeg(bytes) {
  return bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes) {
  return bytes && bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/**
 * Builds the PDF for [notebook] with selective layer control, embedded images, text boxes,
 * occlusion tapes, optional PDF side margin notes, Dark Paper, and Infinite Canvas auto-bounds.
 */
export async function exportNotebookPdf(notebook, {
  layerMode = 'ALL_LAYERS',
  includeTapes = true,
  darkPaper = false,
  rasterizeTextBox = null,
} = {}) {
  const out = await PDFDocument.create();
  out.setTitle(notebook.title);
  out.setCreator('DocFlow Studio für Windows');
  const sources = new Map();
  const itemFilter = makeItemFilter(notebook, layerMode);
  const showBg = shouldIncludeBackground(notebook, layerMode);

  for (const page of notebook.pages) {
    const rawBg = notebook.backgroundOf(page);
    const bg = showBg ? rawBg : null;
    const isInfinite = notebook.canvasMode === 'INFINITE' && !rawBg;
    const inf = isInfinite ? infiniteContentBounds(page) : { offsetX: 0, offsetY: 0, widthPx: page.widthPx, heightPx: page.heightPx };
    const rawMarginW = Number(notebook.marginWidthPx);
    const marginWidth = Number.isFinite(rawMarginW) && rawMarginW > 0 ? rawMarginW : DEFAULT_MARGIN_WIDTH;
    const hasMargin = !isInfinite && notebook.marginNotesEnabled && !!rawBg;
    const totalW = inf.widthPx + (hasMargin ? marginWidth : 0);
    const totalH = inf.heightPx;

    let pdfPage;
    let widthPt;
    let heightPt;
    if (bg) {
      if (!sources.has(bg.entry)) sources.set(bg.entry, await PDFDocument.load(notebook.entries[bg.entry], { ignoreEncryption: true }));
      const src = sources.get(bg.entry);
      const idx = Math.min(src.getPageCount() - 1, Math.max(0, bg.pageIndex));
      const [embedded] = await out.embedPdf(src, [idx]);
      const baseWidthPt = embedded.width;
      const scalePt = baseWidthPt / page.widthPx;
      widthPt = totalW * scalePt;
      heightPt = totalH * scalePt;
      pdfPage = out.addPage([widthPt, heightPt]);
      pdfPage.drawPage(embedded, {
        x: 0,
        y: heightPt - embedded.height * (baseWidthPt / embedded.width),
        width: baseWidthPt,
        height: embedded.height * (baseWidthPt / embedded.width),
      });
    } else if (rawBg) {
      if (!sources.has(rawBg.entry)) sources.set(rawBg.entry, await PDFDocument.load(notebook.entries[rawBg.entry], { ignoreEncryption: true }));
      const src = sources.get(rawBg.entry);
      const idx = Math.min(src.getPageCount() - 1, Math.max(0, rawBg.pageIndex));
      const baseWidthPt = src.getPage(idx).getWidth();
      const scalePt = baseWidthPt / page.widthPx;
      widthPt = totalW * scalePt;
      heightPt = totalH * scalePt;
      pdfPage = out.addPage([widthPt, heightPt]);
    } else {
      const scalePt = A4_WIDTH_PT / inf.widthPx;
      widthPt = totalW * scalePt;
      heightPt = totalH * scalePt;
      pdfPage = out.addPage([widthPt, heightPt]);
    }
    const scale = widthPt / totalW;

    if (!bg) {
      const paper = new PdfRecorder(pdfPage, scale, heightPt, { coalesce: true });
      drawPaper(paper, page.template, totalW, totalH, {
        darkPaper,
        withRuling: !rawBg && layerMode !== 'ONLY_SOLUTIONS',
      });
      paper.flush();
    }
    if (hasMargin) {
      const marginRec = new PdfRecorder(pdfPage, scale, heightPt, { coalesce: true });
      drawMarginNotes(marginRec, page.widthPx, totalH, { width: marginWidth, darkPaper, template: page.template });
      marginRec.flush();
    }

    // Embedded images
    for (const imgItem of (page.payload.images || []).filter(itemFilter)) {
      const bytes = notebook.getImageBytes(imgItem.imagePath);
      if (!bytes) continue;
      let embeddedImg = null;
      try {
        if (isPng(bytes)) embeddedImg = await out.embedPng(bytes);
        else if (isJpeg(bytes)) embeddedImg = await out.embedJpg(bytes);
      } catch { /* skip unsupported format */ }
      if (!embeddedImg) continue;
      const left = Math.min(imgItem.left, imgItem.right) - inf.offsetX;
      const top = Math.min(imgItem.top, imgItem.bottom) - inf.offsetY;
      const w = Math.abs(imgItem.right - imgItem.left);
      const h = Math.abs(imgItem.bottom - imgItem.top);
      pdfPage.drawImage(embeddedImg, {
        x: left * scale,
        y: heightPt - (top + h) * scale,
        width: w * scale,
        height: h * scale,
        rotate: imgItem.rotationDegrees ? degrees(-imgItem.rotationDegrees) : undefined,
        opacity: notebook.layerOpacity(imgItem),
      });
    }

    // Vector ink (highlighters under normal ink)
    const ink = new PdfRecorder(pdfPage, scale, heightPt, { offsetX: inf.offsetX, offsetY: inf.offsetY });
    const strokes = (page.payload.strokes || []).filter(itemFilter);
    for (const s of strokes) {
      if (s.brushKind === 'HIGHLIGHTER') drawStroke(ink, s, { darkPaper, opacity: notebook.layerOpacity(s) });
    }
    for (const s of strokes) {
      if (s.brushKind !== 'HIGHLIGHTER') drawStroke(ink, s, { darkPaper, opacity: notebook.layerOpacity(s) });
    }

    // Text boxes / sticky notes / checklists
    if (rasterizeTextBox) {
      for (const box of (page.payload.textBoxes || []).filter(itemFilter)) {
        const png = await rasterizeTextBox(box, darkPaper);
        if (!png) continue;
        const image = await out.embedPng(png);
        const w = Math.max(60, box.width ?? 420);
        const h = Math.max(36, box.height ?? 140);
        pdfPage.drawImage(image, {
          x: (box.left - inf.offsetX) * scale,
          y: heightPt - (box.top - inf.offsetY + h) * scale,
          width: w * scale,
          height: h * scale,
          opacity: notebook.layerOpacity(box),
        });
      }
    }

    // Study occlusion tapes
    if (includeTapes) {
      for (const tape of (page.payload.tapes || []).filter(itemFilter)) {
        drawTape(ink, tape, { opacity: notebook.layerOpacity(tape) });
      }
    }
    ink.flush();
  }
  return out.save();
}

function defaultCreateCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error('No 2D canvas implementation available for PNG export');
}

async function defaultEncodePng(canvas) {
  if (typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof canvas.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('PNG encoding failed'));
        blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
      }, 'image/png');
    });
  }
  throw new Error('No PNG encoder available on canvas');
}

/**
 * Exports a single page of [notebook] to PNG bytes (`Uint8Array`).
 * Supports selective layer modes, PDF side margin notes, Dark Paper, Study Mode,
 * Infinite Canvas auto-bounds, and dependency injection for headless Node tests.
 */
export async function exportPagePng(notebook, pageIndex = 0, {
  layerMode = 'ALL_LAYERS',
  includeTapes = true,
  studyMode = false,
  darkPaper = false,
  scale = 1,
  maxEdge = 4096,
  pdfBg = null,
  renderPdfBackground = null,
  decodeImage = null,
  createCanvas = null,
  encodePng = null,
} = {}) {
  const page = notebook?.pages?.[pageIndex];
  if (!page) throw new Error(`Invalid pageIndex: ${pageIndex}`);

  const itemFilter = makeItemFilter(notebook, layerMode);
  const showBg = shouldIncludeBackground(notebook, layerMode);
  const rawBg = notebook.backgroundOf(page);
  const bg = showBg ? rawBg : null;
  const isInfinite = notebook.canvasMode === 'INFINITE' && !rawBg;
  const inf = isInfinite ? infiniteContentBounds(page) : { offsetX: 0, offsetY: 0, widthPx: page.widthPx, heightPx: page.heightPx };
  const rawMarginW = Number(notebook.marginWidthPx);
  const marginWidth = Number.isFinite(rawMarginW) && rawMarginW > 0 ? rawMarginW : DEFAULT_MARGIN_WIDTH;
  const hasMargin = !isInfinite && notebook.marginNotesEnabled && !!rawBg;
  const totalW = inf.widthPx + (hasMargin ? marginWidth : 0);
  const totalH = inf.heightPx;

  const requestedScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  const maxDim = Math.max(1, Number(maxEdge) || 4096);
  const renderScale = Math.min(requestedScale, maxDim / Math.max(1, totalW, totalH));
  const pixelW = Math.max(1, Math.round(totalW * renderScale));
  const pixelH = Math.max(1, Math.round(totalH * renderScale));

  const canvas = (createCanvas || defaultCreateCanvas)(pixelW, pixelH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire 2D context for PNG export');

  const ownedBitmaps = [];
  ctx.save();
  ctx.scale(renderScale, renderScale);

  try {
    if (bg) {
      const targetWidthPx = Math.ceil(page.widthPx * renderScale);
      let bmp = null;
      if (renderPdfBackground) {
        bmp = await renderPdfBackground(bg.entry, bg.pageIndex, targetWidthPx, notebook.entries[bg.entry]);
      } else if (pdfBg) {
        pdfBg.setSource?.(notebook.entries);
        bmp = await pdfBg.render(bg.entry, bg.pageIndex, targetWidthPx);
      } else {
        const { PdfBackgrounds } = await import('./pdfbg.js');
        const loader = new PdfBackgrounds();
        loader.setSource(notebook.entries);
        try {
          bmp = await loader.render(bg.entry, bg.pageIndex, targetWidthPx);
          if (bmp) ownedBitmaps.push(bmp);
        } finally {
          loader.dispose();
        }
      }
      if (bmp) {
        ctx.drawImage(bmp, 0, 0, page.widthPx, page.heightPx);
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, page.widthPx, page.heightPx);
      }
    } else if (isInfinite) {
      ctx.save();
      ctx.translate(-inf.offsetX, -inf.offsetY);
      drawInfinitePaper(ctx, page.template, inf.offsetX, inf.offsetY, inf.offsetX + totalW, inf.offsetY + totalH, { darkPaper });
      ctx.restore();
    } else {
      drawPaper(ctx, page.template, totalW, totalH, {
        darkPaper,
        withRuling: !rawBg && layerMode !== 'ONLY_SOLUTIONS',
      });
    }

    if (hasMargin) {
      drawMarginNotes(ctx, page.widthPx, totalH, { width: marginWidth, darkPaper, template: page.template });
    }

    const decodedImages = new Map();
    const visibleImages = (page.payload.images || []).filter(itemFilter);
    for (const imgItem of visibleImages) {
      if (!imgItem.imagePath || decodedImages.has(imgItem.imagePath)) continue;
      const bytes = notebook.getImageBytes(imgItem.imagePath);
      if (!bytes) continue;
      if (decodeImage) {
        decodedImages.set(imgItem.imagePath, await decodeImage(bytes, imgItem.imagePath));
      } else if (typeof createImageBitmap === 'function') {
        try {
          const bmp = await createImageBitmap(new Blob([bytes]));
          decodedImages.set(imgItem.imagePath, bmp);
          ownedBitmaps.push(bmp);
        } catch { /* skip unreadable image */ }
      }
    }

    const filteredPayload = {
      ...page.payload,
      images: visibleImages,
      strokes: (page.payload.strokes || []).filter(itemFilter),
      textBoxes: (page.payload.textBoxes || []).filter(itemFilter),
      tapes: includeTapes ? (page.payload.tapes || []).filter(itemFilter) : [],
    };

    ctx.save();
    ctx.translate(-inf.offsetX, -inf.offsetY);
    drawPageContent(ctx, filteredPayload, () => true, {
      darkPaper,
      studyMode,
      layerOpacity: (it) => notebook.layerOpacity(it),
      getImageBitmap: (imagePath) => decodedImages.get(imagePath) ?? null,
    });
    ctx.restore();
  } finally {
    ctx.restore();
    for (const bmp of ownedBitmaps) bmp?.close?.();
  }

  const pngBytes = await (encodePng || defaultEncodePng)(canvas);
  return pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
}
