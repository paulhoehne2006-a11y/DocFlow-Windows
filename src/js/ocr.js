// Offline Handwriting & Page OCR helper.
// Renders handwritten strokes at high contrast (pure black on crisp white, 2x scale) and sends
// the PNG to the Electron Main Process native Windows OCR bridge (`Windows.Media.Ocr`),
// combining recognized handwriting with PDF text layers and text boxes into `extractedHandwritingText`.

import { drawStroke, strokeBounds } from './render.js';
import { getEffectiveLanguage } from './i18n.js';

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('PNG encoding failed'));
      blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
    }, 'image/png');
  });
}

/** Renders a list of strokes onto a crisp high-contrast white canvas for optimal OCR accuracy. */
export async function renderStrokesForOcr(strokes, { maxEdge = 2200, pad = 40 } = {}) {
  const inkStrokes = (strokes || []).filter((s) => s.brushKind !== 'HIGHLIGHTER' && (s.points?.length || 0) > 0);
  if (inkStrokes.length === 0) return null;

  let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
  for (const s of inkStrokes) {
    const b = strokeBounds(s);
    if (b.left < left) left = b.left;
    if (b.top < top) top = b.top;
    if (b.right > right) right = b.right;
    if (b.bottom > bottom) bottom = b.bottom;
  }
  const w = Math.max(120, right - left + pad * 2);
  const h = Math.max(80, bottom - top + pad * 2);
  const scale = Math.min(2, maxEdge / Math.max(w, h));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(64, Math.ceil(w * scale));
  canvas.height = Math.max(64, Math.ceil(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(-left + pad, -top + pad);

  for (const s of inkStrokes) {
    // Normalize dark/colored handwriting to pure crisp black for highest OCR contrast
    drawStroke(ctx, { ...s, colorArgb: 0xff000000, alpha: 1 });
  }
  return canvasToPngBytes(canvas);
}

/** Recognizes handwriting in a subset of strokes (e.g., Lasso selection). */
export async function recognizeStrokesOcr(bridge, strokes) {
  const png = await renderStrokesForOcr(strokes);
  if (!png) return { ok: true, text: '', engine: 'empty' };
  const lang = getEffectiveLanguage() === 'de' ? 'de-DE' : 'en-US';
  if (!bridge.recognizeOcr) return { ok: false, text: '', engine: 'unavailable' };
  return bridge.recognizeOcr(png, lang);
}

/**
 * Indexes an entire notebook (or single page): combines offline Windows OCR of handwriting,
 * PDF background text layers, and text boxes into `notebook.extractedHandwritingText`.
 */
export async function indexNotebookText(bridge, notebook, pdfBg, { pageIndex = null } = {}) {
  const pagesToScan = pageIndex != null ? [notebook.pages[pageIndex]].filter(Boolean) : notebook.pages;
  const segments = [];
  let ocrAvailable = true;

  for (const page of pagesToScan) {
    // 1. Text boxes & checklists
    for (const box of page.payload.textBoxes || []) {
      if (box.text?.trim()) segments.push(box.text.trim());
    }
    // 2. Selectable text from PDF worksheets
    const bg = notebook.backgroundOf(page);
    if (bg && pdfBg) {
      const pdfText = await pdfBg.extractPageText(bg.entry, bg.pageIndex);
      if (pdfText) segments.push(pdfText);
    }
    // 3. Offline Windows OCR on handwritten strokes
    const visibleStrokes = (page.payload.strokes || []).filter((s) => notebook.isItemVisible(s));
    if (visibleStrokes.length > 0 && bridge.recognizeOcr) {
      const res = await recognizeStrokesOcr(bridge, visibleStrokes);
      if (res?.ok && res.text?.trim()) segments.push(res.text.trim());
      else if (res && res.engine === 'unavailable') ocrAvailable = false;
    }
  }

  const combined = [...new Set(segments.map((s) => s.trim()).filter(Boolean))].join('\n');
  if (pageIndex == null) {
    notebook.extractedHandwritingText = combined;
  } else if (combined) {
    const existing = notebook.extractedHandwritingText;
    notebook.extractedHandwritingText = existing
      ? `${existing}\n${combined}`.slice(0, 50000)
      : combined;
  }
  return { text: combined, ocrAvailable };
}
