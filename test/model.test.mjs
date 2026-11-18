import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8, unzipSync, strFromU8 } from '../src/vendor/fflate.js';
import { PDFDocument } from '../src/vendor/pdf-lib.esm.min.js';
import {
  readBundle, writeBundle, createNotebook, mergeRemote, sanitizeFileStem, SOURCE_PDF_ENTRY,
} from '../src/js/model.js';
import { exportNotebookPdf } from '../src/js/export.js';
import { strokeHit, strokeInLasso, argbToCss } from '../src/js/render.js';

async function samplePdf(pages = 2) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]).drawText(`Seite ${i + 1}`, { x: 50, y: 780 });
  return doc.save();
}

const stroke = (id, layerId, brushKind = 'FINELINER') => ({
  id, layerId, pageIndex: 0, brushKind, colorArgb: 4278190080, strokeWidth: 5.5, alpha: 1,
  isShapeSnapped: false, points: [[100, 100, 0.5, 0, 0, 0], [300, 120, 0.8, 0.1, 0.2, 10], [500, 400, 0.6, 0, 0, 20]],
});

/** A bundle exactly like the Android app writes it (StudioNoteBundleCodec). */
async function androidBundle() {
  const manifest = {
    schemaVersion: 1, format: 'docflownote', exportedAtMillis: 1000, hasExportedPdf: false, hasSourcePdf: true,
    deviceId: 'phone-1', notebook: { title: 'Mathe', canvasMode: 'PAGES', defaultTemplate: 'LINED', pageCount: 2, localId: 7, updatedAt: 900 },
    layers: [
      { id: 11, name: '', type: 'WORKSHEET', isVisible: true, isLocked: true, sortOrder: 0, createdAt: 1 },
      { id: 12, name: 'Solution', type: 'SOLUTION', isVisible: true, isLocked: false, sortOrder: 1, createdAt: 1 },
    ],
    pages: [0, 1].map((i) => ({ pageIndex: i, template: 'LINED', widthPx: 1654, heightPx: 2339,
      payloadEntry: `pages/page_${i}.json`, backgroundPdfPageIndex: i, backgroundPdfEntry: null, updatedAt: 500 })),
  };
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'pages/page_0.json': strToU8(JSON.stringify({ version: 1, isBookmarked: false, strokes: [stroke('a', '12')], tapes: [], textBoxes: [], images: [], futureField: 42 })),
    'pages/page_1.json': strToU8(''),
    [SOURCE_PDF_ENTRY]: await samplePdf(2),
    'audio/rec.m4a': new Uint8Array([1, 2, 3]),
  });
}

test('reads an Android bundle with legacy source PDF and translated layer names', async () => {
  const nb = readBundle(await androidBundle(), 'Mathe.docflownote');
  assert.equal(nb.title, 'Mathe');
  assert.equal(nb.pages.length, 2);
  assert.equal(nb.pages[0].payload.strokes.length, 1);
  assert.deepEqual(nb.backgroundOf(nb.pages[1]), { entry: SOURCE_PDF_ENTRY, pageIndex: 1 });
  const t = (k, v) => (k === 'layerBackground' ? 'Hintergrund' : `Ebene ${v}`);
  assert.deepEqual(nb.sortedLayers().map((l) => nb.layerDisplayName(l, t)), ['Hintergrund', 'Ebene 1']);
});

test('saving keeps unknown entries and fields and only re-dates edited pages', async () => {
  const nb = readBundle(await androidBundle(), 'Mathe.docflownote');
  nb.pages[1].payload.strokes.push(stroke('b', '12'));
  nb.pages[1].dirty = true;
  const bytes = writeBundle(nb, { deviceId: 'windows-x', now: 5000 });
  const entries = unzipSync(bytes);
  assert.deepEqual([...entries['audio/rec.m4a']], [1, 2, 3]);
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  assert.equal(manifest.deviceId, 'windows-x');
  assert.equal(manifest.exportedAtMillis, 5000);
  assert.equal(manifest.notebook.localId, 7);
  assert.deepEqual(manifest.pages.map((p) => p.updatedAt), [500, 5000]);
  assert.equal(JSON.parse(strFromU8(entries['pages/page_0.json'])).futureField, 42);
  assert.equal(JSON.parse(strFromU8(entries['pages/page_1.json'])).strokes[0].id, 'b');
  assert.ok(!nb.isDirty);
});

test('new layers and pages get ids that cannot clash with the phone', async () => {
  const nb = readBundle(await androidBundle());
  const layer = nb.addLayer();
  assert.ok(layer.id > 1e12);
  assert.equal(layer.sortOrder, 2);
  const page = nb.addPage();
  assert.equal(page.pageIndex, 2);
  assert.equal(page.template, 'LINED');
  assert.equal(nb.backgroundOf(page), null);
});

test('merging a newer phone upload keeps pages edited here and takes the rest', async () => {
  const local = readBundle(await androidBundle());
  local.pages[0].payload.strokes = [];
  local.pages[0].dirty = true;
  const remote = readBundle(await androidBundle());
  remote.pages[1].payload.strokes = [stroke('phone', '12')];
  mergeRemote(local, remote);
  assert.equal(local.pages[0].payload.strokes.length, 0);
  assert.equal(local.pages[1].payload.strokes[0].id, 'phone');
  assert.ok(local.isDirty);
});

test('a PDF becomes a notebook with one page per PDF page', async () => {
  const pdf = await samplePdf(3);
  const nb = createNotebook({ title: 'Scan: Rechnung', deviceId: 'windows-x', pdfBytes: pdf, pdfPageSizes: [
    { width: 595.28, height: 841.89 }, { width: 595.28, height: 841.89 }, { width: 841.89, height: 595.28 }] });
  assert.equal(nb.fileName, 'Scan__Rechnung.docflownote');
  assert.equal(nb.pages.length, 3);
  assert.ok(nb.pages[2].heightPx < nb.pages[2].widthPx);
  const reread = readBundle(writeBundle(nb, { deviceId: 'windows-x' }));
  assert.equal(reread.manifest.createdOn, 'windows');
  assert.equal(reread.layers[0].type, 'WORKSHEET');
  assert.deepEqual(reread.backgroundOf(reread.pages[1]), { entry: 'backgrounds/bg_0.pdf', pageIndex: 1 });
});

test('PDF export embeds the background pages and draws every brush', async () => {
  const nb = readBundle(await androidBundle());
  const brushes = ['FOUNTAIN_PEN', 'FINELINER', 'BRUSH_PEN', 'BALLPOINT_PEN', 'PENCIL', 'CALLIGRAPHY_PEN', 'HIGHLIGHTER'];
  nb.pages[0].payload.strokes = brushes.map((b, i) => stroke(`s${i}`, '12', b));
  nb.pages[0].payload.tapes = [{ id: 't', layerId: '12', left: 10, top: 10, right: 200, bottom: 80, colorArgb: 4280163870 }];
  const blank = createNotebook({ title: 'Leer', deviceId: 'w', template: 'DOTTED' });
  for (const book of [nb, blank]) {
    const bytes = await exportNotebookPdf(book);
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), book.pages.length);
    assert.ok(Math.abs(doc.getPage(0).getWidth() - 595.28) < 0.5);
  }
});

test('hit testing and lasso', () => {
  const s = stroke('a', '1');
  assert.ok(strokeHit(s, 300, 125, 4));
  assert.ok(!strokeHit(s, 900, 900, 4));
  assert.ok(strokeInLasso(s, [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 600 }, { x: 0, y: 600 }]));
  assert.equal(argbToCss(0xff1d4ed8), 'rgba(29,78,216,1)');
  assert.equal(sanitizeFileStem('  Mein   Heft '), 'Mein_Heft');
  assert.equal(sanitizeFileStem('Bio/Klausur'), 'Bio_Klausur');
});
