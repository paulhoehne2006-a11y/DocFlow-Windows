import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8, unzipSync, strFromU8 } from '../src/vendor/fflate.js';
import { PDFDocument } from '../src/vendor/pdf-lib.esm.min.js';
import {
  readBundle,
  writeBundle,
  createNotebook,
  mergeRemote,
  inspectBundleSummary,
  sanitizeFileStem,
  SOURCE_PDF_ENTRY,
  DEFAULT_PAGE_WIDTH,
  DEFAULT_MARGIN_WIDTH,
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
    deviceId: 'phone-1',
    originDeviceId: 'phone-origin',
    notebook: {
      title: 'Mathe',
      originDeviceId: 'phone-origin',
      canvasMode: 'PAGES',
      defaultTemplate: 'LINED',
      pageCount: 2,
      localId: 7,
      updatedAt: 900,
    },
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
  assert.equal(nb.originDeviceId, 'phone-origin');
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
  assert.equal(manifest.notebook.originDeviceId, 'phone-origin');
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

test('createNotebook stores originDeviceId in manifest.notebook and preserves across saves', () => {
  const nb = createNotebook({ title: 'Physik', deviceId: 'win-origin-1' });
  assert.equal(nb.manifest.originDeviceId, 'win-origin-1');
  assert.equal(nb.manifest.notebook.originDeviceId, 'win-origin-1');
  assert.equal(nb.manifest.notebook.marginWidthPx, DEFAULT_MARGIN_WIDTH);
  assert.equal(nb.originDeviceId, 'win-origin-1');

  const bytes = writeBundle(nb, { deviceId: 'other-pc', now: 12345 });
  const reread = readBundle(bytes, nb.fileName);
  assert.equal(reread.manifest.deviceId, 'other-pc');
  assert.equal(reread.manifest.notebook.originDeviceId, 'win-origin-1');
  assert.equal(reread.originDeviceId, 'win-origin-1');

  const summary = inspectBundleSummary(bytes, nb.fileName);
  assert.equal(summary.originDeviceId, 'win-origin-1');
  assert.equal(summary.deviceId, 'other-pc');
});

test('writeBundle prunes unreferenced images/* while preserving basename-referenced, audio/*, and unknown entries', async () => {
  const nb = createNotebook({ title: 'Bilder', deviceId: 'win-1' });
  nb.entries['images/used_full.png'] = new Uint8Array([1, 2, 3]);
  nb.entries['images/used_base.png'] = new Uint8Array([4, 5, 6]);
  nb.entries['images/used_win.png'] = new Uint8Array([7, 8, 9]);
  nb.entries['images/unused.png'] = new Uint8Array([9, 9, 9]);
  nb.entries['audio/lecture.m4a'] = new Uint8Array([10, 11]);
  nb.entries['custom/android_meta.json'] = strToU8('{"keep":true}');

  nb.pages[0].payload.images = [
    { id: 'i1', layerId: '1', imagePath: 'images/used_full.png', left: 0, top: 0, right: 100, bottom: 100 },
    { id: 'i2', layerId: '1', imagePath: '/storage/emulated/0/DocFlow/used_base.png', left: 10, top: 10, right: 50, bottom: 50 },
    { id: 'i3', layerId: '1', imagePath: 'images\\used_win.png', left: 20, top: 20, right: 60, bottom: 60 },
  ];
  nb.pages[0].dirty = true;

  let bytes = writeBundle(nb, { deviceId: 'win-1' });
  let entries = unzipSync(bytes);
  assert.ok(entries['images/used_full.png']);
  assert.ok(entries['images/used_base.png']);
  assert.ok(entries['images/used_win.png']);
  assert.equal(entries['images/unused.png'], undefined);
  assert.deepEqual([...entries['audio/lecture.m4a']], [10, 11]);
  assert.equal(strFromU8(entries['custom/android_meta.json']), '{"keep":true}');

  // Removing image item and re-saving prunes its binary entry
  const nb2 = readBundle(bytes, nb.fileName);
  assert.deepEqual([...nb2.getImageBytes('/storage/emulated/0/DocFlow/used_base.png')], [4, 5, 6]);
  assert.deepEqual([...nb2.getImageBytes('images\\used_win.png')], [7, 8, 9]);
  nb2.pages[0].payload.images = nb2.pages[0].payload.images.filter((im) => im.id !== 'i1');
  nb2.pages[0].dirty = true;
  bytes = writeBundle(nb2, { deviceId: 'win-1' });
  entries = unzipSync(bytes);
  assert.equal(entries['images/used_full.png'], undefined);
  assert.ok(entries['images/used_base.png']);
});

test('Notebook helpers: renameLayer, setFolder, folderId/folderPath, title, and marginWidthPx', async () => {
  const pdf = await samplePdf(1);
  const nb = createNotebook({
    title: 'Chemie',
    deviceId: 'win-1',
    pdfBytes: pdf,
    pdfPageSizes: [{ width: 595.28, height: 841.89 }],
  });
  assert.equal(nb.isDirty, true);
  writeBundle(nb, { deviceId: 'win-1' });
  assert.equal(nb.isDirty, false);

  const t = (k, v) => (k === 'layerBackground' ? 'Hintergrund' : `Ebene ${v}`);
  const solLayer = nb.layers.find((l) => l.type === 'SOLUTION');
  assert.equal(nb.renameLayer(solLayer, 'Vokabeln'), true);
  assert.equal(nb.layerDisplayName(solLayer, t), 'Vokabeln');
  assert.equal(nb.metaDirty, true);
  assert.equal(nb.renameLayer(solLayer.id, ''), true);
  assert.equal(nb.layerDisplayName(solLayer, t), 'Ebene 1');
  assert.equal(nb.renameLayer('missing-id', 'X'), false);

  nb.title = '  Organische Chemie  ';
  assert.equal(nb.title, 'Organische Chemie');
  nb.title = '   '; // blank ignored
  assert.equal(nb.title, 'Organische Chemie');

  nb.setFolder('fld_1', 'Uni / Chemie');
  assert.equal(nb.folderId, 'fld_1');
  assert.equal(nb.folderPath, 'Uni / Chemie');

  // marginWidthPx validation + pageTotalWidth
  assert.equal(nb.marginWidthPx, DEFAULT_MARGIN_WIDTH);
  assert.equal(nb.pageTotalWidth(nb.pages[0]), DEFAULT_PAGE_WIDTH);
  nb.marginNotesEnabled = true;
  nb.marginWidthPx = 480;
  assert.equal(nb.marginWidthPx, 480);
  assert.equal(nb.pageTotalWidth(nb.pages[0]), DEFAULT_PAGE_WIDTH + 480);

  nb.marginWidthPx = -10;
  assert.equal(nb.marginWidthPx, DEFAULT_MARGIN_WIDTH);
  nb.marginWidthPx = 500;

  const reread = readBundle(writeBundle(nb, { deviceId: 'win-1' }), nb.fileName);
  assert.equal(reread.isDirty, false);
  assert.equal(reread.title, 'Organische Chemie');
  assert.equal(reread.folderId, 'fld_1');
  assert.equal(reread.folderPath, 'Uni / Chemie');
  assert.equal(reread.marginNotesEnabled, true);
  assert.equal(reread.marginWidthPx, 500);
  assert.equal(reread.pageTotalWidth(reread.pages[0]), DEFAULT_PAGE_WIDTH + 500);

  reread.canvasMode = 'INFINITE';
  assert.equal(reread.pageTotalWidth(reread.pages[0]), DEFAULT_PAGE_WIDTH);
});

test('addPage, duplicatePage, deletePage, reorderPages, appendPdfPages keep pageIndex gapless', async () => {
  const nb = createNotebook({ title: 'Seiten', deviceId: 'w' });
  const pStart = nb.addPage('BLANK', 0);
  assert.equal(pStart.pageIndex, 0);
  const pMid = nb.addPage('DOTTED', 1);
  assert.equal(pMid.pageIndex, 1);
  assert.deepEqual(nb.pages.map((p) => p.pageIndex), [0, 1, 2]);
  assert.deepEqual(nb.pages.map((p) => p.payloadEntry), ['pages/page_0.json', 'pages/page_1.json', 'pages/page_2.json']);

  // Sparse gap from external manifest
  nb.pages[2].pageIndex = 5;
  nb.pages[2].payloadEntry = 'pages/page_5.json';
  nb.addPage('LINED');
  assert.deepEqual(nb.pages.map((p) => p.pageIndex), [0, 1, 2, 3]);
  assert.deepEqual(nb.pages.map((p) => p.payloadEntry), [
    'pages/page_0.json', 'pages/page_1.json', 'pages/page_2.json', 'pages/page_3.json',
  ]);

  // Duplicate, reorder, template, bookmark, delete
  nb.pages[0].payload.strokes.push(stroke('orig', '1'));
  const dup = nb.duplicatePage(0);
  assert.equal(dup.pageIndex, 1);
  assert.notEqual(dup.payload.strokes[0].id, 'orig');
  assert.equal(nb.pages.length, 5);

  assert.equal(nb.reorderPages(0, 4), true);
  assert.deepEqual(nb.pages.map((p) => p.pageIndex), [0, 1, 2, 3, 4]);
  assert.equal(nb.setPageTemplate(0, 'MUSIC'), true);
  assert.equal(nb.pages[0].template, 'MUSIC');
  assert.equal(nb.setPageTemplate(0, 'UNKNOWN_TPL'), false);
  assert.equal(nb.toggleBookmark(0), true);
  assert.equal(nb.toggleBookmark(0), false);

  assert.equal(nb.deletePage(4), true);
  assert.equal(nb.pages.length, 4);

  // Append PDF pages
  const extraPdf = await samplePdf(2);
  const added = nb.appendPdfPages(extraPdf, [{ width: 595.28, height: 841.89 }, { width: 841.89, height: 595.28 }]);
  assert.equal(added.length, 2);
  assert.deepEqual(nb.pages.map((p) => p.pageIndex), [0, 1, 2, 3, 4, 5]);
  assert.ok(nb.entries['backgrounds/bg_0.pdf']);

  // Cannot delete last remaining page
  while (nb.pages.length > 1) assert.equal(nb.deletePage(0), true);
  assert.equal(nb.deletePage(0), false);
});

test('mergeRemote preserves local metaDirty metadata (including null folderId) and unions audioBookmarks', async () => {
  const baseBytes = await androidBundle();
  const local = readBundle(baseBytes, 'Mathe.docflownote');
  assert.equal(local.isDirty, false);
  assert.equal(local.metaDirty, false);

  local.title = 'Mathe Klausur';
  local.isFavorite = true;
  local.coverColorArgb = 0xff4f46e5;
  local.setFolder(null, '');
  local.marginNotesEnabled = true;
  local.marginWidthPx = 460;
  local.extractedHandwritingText = 'Integralrechnung';
  local.entries['images/local_dirty.png'] = new Uint8Array([42, 43]);
  local.pages[0].payload.images.push({
    id: 'img_local',
    layerId: '12',
    imagePath: '/phone/cache/local_dirty.png',
    left: 0,
    top: 0,
    right: 50,
    bottom: 50,
  });
  local.pages[0].dirty = true;
  const localBm = local.addAudioEntry(new Uint8Array([9, 8, 7]), { ext: 'webm', label: 'Win Audio', durationMs: 2500 });

  const remote = readBundle(baseBytes, 'Mathe.docflownote');
  remote.manifest.notebook.title = 'Mathe Alt';
  remote.manifest.notebook.isFavorite = false;
  remote.manifest.notebook.coverColorArgb = 0xff1e293b;
  remote.manifest.notebook.folderId = 'fld_remote';
  remote.manifest.notebook.folderPath = 'Schule / Mathe';
  remote.manifest.notebook.marginNotesEnabled = false;
  remote.manifest.notebook.marginWidthPx = 620;
  remote.manifest.notebook.extractedHandwritingText = 'Remote OCR';
  remote.manifest.audioBookmarks = [{ id: 5, entryName: 'audio/rec.m4a', fileName: 'rec.m4a', label: 'Phone' }];
  remote.pages[1].payload.strokes.push(stroke('remote_s', '12'));

  mergeRemote(local, remote);

  assert.equal(local.title, 'Mathe Klausur');
  assert.equal(local.isFavorite, true);
  assert.equal(local.coverColorArgb, 0xff4f46e5);
  assert.equal(local.folderId, null);
  assert.equal(local.folderPath, '');
  assert.equal(local.marginNotesEnabled, true);
  assert.equal(local.marginWidthPx, 460);
  assert.equal(local.extractedHandwritingText, 'Integralrechnung');
  assert.equal(local.audioBookmarks.length, 2);
  assert.ok(local.audioBookmarks.some((b) => b.entryName === localBm.entryName));
  assert.ok(local.audioBookmarks.some((b) => b.entryName === 'audio/rec.m4a'));
  assert.deepEqual([...local.getImageBytes('/phone/cache/local_dirty.png')], [42, 43]);
  assert.equal(local.pages[1].payload.strokes[0].id, 'remote_s');
  assert.equal(local.isDirty, true);

  // Clean local adopts remote metadata
  const cleanLocal = readBundle(baseBytes, 'Mathe.docflownote');
  assert.equal(cleanLocal.metaDirty, false);
  mergeRemote(cleanLocal, remote);
  assert.equal(cleanLocal.title, 'Mathe Alt');
  assert.equal(cleanLocal.folderId, 'fld_remote');
  assert.equal(cleanLocal.folderPath, 'Schule / Mathe');
  assert.equal(cleanLocal.extractedHandwritingText, 'Remote OCR');
  assert.equal(cleanLocal.metaDirty, false);
});
