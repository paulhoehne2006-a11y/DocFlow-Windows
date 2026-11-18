// Vector PDF export with pdf-lib. The page drawing code from render.js runs against a small
// "recording" 2D context that turns canvas paths into PDF paths, so the PDF matches the screen.
// Background PDFs are embedded as vector pages (text stays selectable).

import { PDFDocument, rgb, LineCapStyle } from '../vendor/pdf-lib.esm.min.js';
import { drawPaper, drawStroke, drawTape } from './render.js';

const A4_WIDTH_PT = 595.28;

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
  constructor(page, scale, heightPt, { coalesce = false } = {}) {
    this.page = page;
    this.scale = scale;
    this.heightPt = heightPt;
    this.coalesce = coalesce;
    this.path = '';
    this.pending = null;
    this.stack = [];
    this.strokeStyle = '#000';
    this.fillStyle = '#000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'round';
    this.dash = [];
  }

  save() { this.stack.push([this.strokeStyle, this.fillStyle, this.lineWidth, this.lineCap, this.dash]); }
  restore() { [this.strokeStyle, this.fillStyle, this.lineWidth, this.lineCap, this.dash] = this.stack.pop() ?? []; }
  setLineDash(d) { this.dash = d; }
  beginPath() { this.path = ''; }
  moveTo(x, y) { this.path += `M${n(x)} ${n(y)}`; }
  lineTo(x, y) { this.path += `L${n(x)} ${n(y)}`; }
  quadraticCurveTo(cx, cy, x, y) { this.path += `Q${n(cx)} ${n(cy)} ${n(x)} ${n(y)}`; }
  arc(x, y, r) {
    this.path += `M${n(x - r)} ${n(y)}A${n(r)} ${n(r)} 0 1 0 ${n(x + r)} ${n(y)}A${n(r)} ${n(r)} 0 1 0 ${n(x - r)} ${n(y)}Z`;
  }
  rect(x, y, w, h) { this.path += `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`; }
  roundRect(x, y, w, h) { this.rect(x, y, w, h); }
  fillRect(x, y, w, h) { this.beginPath(); this.rect(x, y, w, h); this.fill(); }
  clip() {}

  stroke() { this.emit('stroke'); }
  fill() { this.emit('fill'); }

  emit(kind) {
    if (!this.path) return;
    const style = kind === 'stroke' ? this.strokeStyle : this.fillStyle;
    const key = `${kind}|${style}|${this.lineWidth}|${this.lineCap}|${this.dash.join(',')}`;
    if (this.coalesce && this.pending?.key === key) {
      this.pending.path += this.path;
      return;
    }
    this.flush();
    this.pending = { key, kind, style, width: this.lineWidth, cap: this.lineCap, dash: [...this.dash], path: this.path };
    if (!this.coalesce) this.flush();
  }

  flush() {
    const op = this.pending;
    this.pending = null;
    if (!op) return;
    const { color, opacity } = parseColor(op.style);
    const common = { x: 0, y: this.heightPt, scale: this.scale };
    if (op.kind === 'fill') {
      this.page.drawSvgPath(op.path, { ...common, color, opacity });
    } else {
      this.page.drawSvgPath(op.path, {
        ...common,
        borderColor: color,
        borderOpacity: opacity,
        borderWidth: op.width,
        borderLineCap: op.cap === 'round' ? LineCapStyle.Round : op.cap === 'square' ? LineCapStyle.Projecting : LineCapStyle.Butt,
        borderDashArray: op.dash.length ? op.dash : undefined,
      });
    }
  }
}

/**
 * Builds the PDF for [notebook] with every layer (like the phone's cloud export).
 * [rasterizeTextBox] (optional) returns PNG bytes for a text box so any script/emoji survives.
 */
export async function exportNotebookPdf(notebook, { rasterizeTextBox = null } = {}) {
  const out = await PDFDocument.create();
  out.setTitle(notebook.title);
  out.setCreator('DocFlow Studio für Windows');
  const sources = new Map();

  for (const page of notebook.pages) {
    const bg = notebook.backgroundOf(page);
    let pdfPage;
    let widthPt;
    let heightPt;
    if (bg) {
      if (!sources.has(bg.entry)) sources.set(bg.entry, await PDFDocument.load(notebook.entries[bg.entry], { ignoreEncryption: true }));
      const src = sources.get(bg.entry);
      const idx = Math.min(src.getPageCount() - 1, Math.max(0, bg.pageIndex));
      const [embedded] = await out.embedPdf(src, [idx]);
      widthPt = embedded.width;
      heightPt = widthPt * (page.heightPx / page.widthPx);
      pdfPage = out.addPage([widthPt, heightPt]);
      pdfPage.drawPage(embedded, { x: 0, y: heightPt - embedded.height * (widthPt / embedded.width), width: widthPt, height: embedded.height * (widthPt / embedded.width) });
    } else {
      widthPt = A4_WIDTH_PT;
      heightPt = A4_WIDTH_PT * (page.heightPx / page.widthPx);
      pdfPage = out.addPage([widthPt, heightPt]);
    }
    const scale = widthPt / page.widthPx;

    if (!bg) {
      const paper = new PdfRecorder(pdfPage, scale, heightPt, { coalesce: true });
      drawPaper(paper, page.template, page.widthPx, page.heightPx);
      paper.flush();
    }

    const ink = new PdfRecorder(pdfPage, scale, heightPt);
    const strokes = page.payload.strokes;
    for (const s of strokes) if (s.brushKind === 'HIGHLIGHTER') drawStroke(ink, s);
    for (const s of strokes) if (s.brushKind !== 'HIGHLIGHTER') drawStroke(ink, s);

    if (rasterizeTextBox) {
      for (const box of page.payload.textBoxes) {
        const png = await rasterizeTextBox(box);
        if (!png) continue;
        const image = await out.embedPng(png);
        const w = Math.max(40, box.width ?? 420);
        const h = Math.max(24, box.height ?? 140);
        pdfPage.drawImage(image, { x: box.left * scale, y: heightPt - (box.top + h) * scale, width: w * scale, height: h * scale });
      }
    }
    for (const tape of page.payload.tapes) drawTape(ink, tape);
    ink.flush();
  }
  return out.save();
}
