// PDF backgrounds (worksheets, scans) rendered with pdf.js. Rasters are cached per page and
// resolution bucket so scrolling never re-renders, and zooming in swaps to a sharper raster.

import * as pdfjs from '../vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const asset = (dir) => new URL(`../vendor/pdfjs/${dir}/`, import.meta.url).href;
const DOC_OPTIONS = {
  isEvalSupported: false,
  cMapUrl: asset('cmaps'),
  cMapPacked: true,
  standardFontDataUrl: asset('standard_fonts'),
  iccUrl: asset('iccs'),
  wasmUrl: asset('wasm'),
};

const BUCKETS = [800, 1400, 2200, 3200];

export class PdfBackgrounds {
  constructor() {
    this.docs = new Map(); // entry name → Promise<PDFDocumentProxy>
    this.rasters = new Map(); // `${entry}#${page}@${bucket}` → ImageBitmap | Promise
  }

  setSource(entries) {
    this.entries = entries;
  }

  document(entry) {
    if (!this.docs.has(entry)) {
      const bytes = this.entries[entry];
      // pdf.js transfers the buffer to its worker – hand it a copy so the bundle stays intact
      this.docs.set(entry, pdfjs.getDocument({ ...DOC_OPTIONS, data: bytes.slice() }).promise);
    }
    return this.docs.get(entry);
  }

  static bucketFor(widthPx) {
    return BUCKETS.find((b) => b >= widthPx) ?? BUCKETS[BUCKETS.length - 1];
  }

  /** Best raster available right now (maybe blurrier); kicks off rendering of the wanted one. */
  get(entry, pageIndex, targetWidthPx, onReady) {
    const bucket = PdfBackgrounds.bucketFor(targetWidthPx);
    const key = `${entry}#${pageIndex}@${bucket}`;
    const cached = this.rasters.get(key);
    if (cached && !(cached instanceof Promise)) return cached;
    if (!cached) {
      const job = this.render(entry, pageIndex, bucket)
        .then((bitmap) => { this.rasters.set(key, bitmap); onReady?.(); return bitmap; })
        .catch((err) => { console.warn('PDF render failed', err); this.rasters.delete(key); });
      this.rasters.set(key, job);
    }
    for (const b of [...BUCKETS].reverse()) {
      const other = this.rasters.get(`${entry}#${pageIndex}@${b}`);
      if (other && !(other instanceof Promise)) return other;
    }
    return null;
  }

  async render(entry, pageIndex, widthPx) {
    const doc = await this.document(entry);
    const page = await doc.getPage(Math.min(doc.numPages, Math.max(1, pageIndex + 1)));
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: widthPx / base.width });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    return canvas.transferToImageBitmap();
  }

  /** Page sizes in PDF points, used when a PDF is turned into a new notebook. */
  static async pageSizes(bytes) {
    const doc = await pdfjs.getDocument({ ...DOC_OPTIONS, data: bytes.slice() }).promise;
    const sizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
      sizes.push({ width: vp.width, height: vp.height });
    }
    await doc.destroy();
    return sizes;
  }

  dispose() {
    for (const p of this.docs.values()) p.then((d) => d.destroy()).catch(() => {});
    for (const r of this.rasters.values()) if (r && !(r instanceof Promise)) r.close?.();
    this.docs.clear();
    this.rasters.clear();
  }
}
