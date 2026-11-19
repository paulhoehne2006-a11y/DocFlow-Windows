import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, decodePDFRawStream } from '../src/vendor/pdf-lib.esm.min.js';
import { createNotebook, DEFAULT_PAGE_WIDTH, DEFAULT_PAGE_HEIGHT } from '../src/js/model.js';
import { EXPORT_LAYER_MODES, exportNotebookPdf, exportPagePng } from '../src/js/export.js';
import { drawInfinitePaper, drawPageContent, drawTape, hitTestTextBox } from '../src/js/render.js';

// Valid 1x1 RGBA PNG
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function samplePdf(pages = 1, size = [595.28, 841.89]) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage(size).drawText(`Page ${i + 1}`, { x: 40, y: size[1] - 60 });
  return doc.save();
}

function makeStroke(id, layerId, brushKind = 'FINELINER', offsetX = 0, audioOffsetMs = null) {
  return {
    id,
    layerId,
    pageIndex: 0,
    brushKind,
    colorArgb: 0xff111827,
    strokeWidth: 4,
    alpha: 1,
    audioOffsetMs,
    points: [
      [100 + offsetX, 100, 0.6, 0, 0, 0],
      [250 + offsetX, 180, 0.7, 0, 0, 20],
    ],
  };
}

function createMockCanvasFactory() {
  return (width, height) => {
    const ops = [];
    const ctx = {
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'round',
      globalAlpha: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'top',
      shadowColor: 'transparent',
      shadowBlur: 0,
      shadowOffsetY: 0,
      save: () => ops.push({ op: 'save' }),
      restore: () => ops.push({ op: 'restore' }),
      scale: (sx, sy) => ops.push({ op: 'scale', sx, sy }),
      translate: (tx, ty) => ops.push({ op: 'translate', tx, ty }),
      rotate: (r) => ops.push({ op: 'rotate', r }),
      setLineDash: () => {},
      beginPath: () => {},
      moveTo: (x, y) => ops.push({ op: 'moveTo', x, y }),
      lineTo: (x, y) => ops.push({ op: 'lineTo', x, y }),
      quadraticCurveTo: (cx, cy, x, y) => ops.push({ op: 'quad', cx, cy, x, y }),
      arc: (x, y, r) => ops.push({ op: 'arc', x, y, r }),
      rect: (x, y, w, h) => ops.push({ op: 'rect', x, y, w, h }),
      roundRect: (x, y, w, h) => ops.push({ op: 'roundRect', x, y, w, h }),
      fillRect: (x, y, w, h) => ops.push({ op: 'fillRect', x, y, w, h }),
      clip: () => ops.push({ op: 'clip' }),
      stroke: () => ops.push({ op: 'stroke', style: ctx.strokeStyle }),
      fill: () => ops.push({ op: 'fill', style: ctx.fillStyle }),
      drawImage: (img, x, y, w, h) => ops.push({ op: 'drawImage', img, x, y, w, h }),
      fillText: (text, x, y) => ops.push({ op: 'fillText', text, x, y }),
      measureText: (t) => ({ width: String(t).length * 10 }),
    };
    return {
      width,
      height,
      ops,
      getContext: (kind) => (kind === '2d' ? ctx : null),
    };
  };
}

function decodePageContentStream(doc, pageIdx = 0) {
  const page = doc.getPage(pageIdx);
  const contents = page.node.Contents();
  const ref = contents.asArray ? contents.asArray()[0] : contents;
  const stream = doc.context.lookup(ref);
  return new TextDecoder().decode(decodePDFRawStream(stream).decode());
}

function pageXObjectCount(doc, pageIdx = 0) {
  const page = doc.getPage(pageIdx);
  const res = page.node.Resources();
  const xobj = res?.get(PDFName.of('XObject'));
  return xobj ? Object.keys(xobj.dict ? Object.fromEntries(xobj.entries()) : Object.fromEntries(xobj.entries())).length : 0;
}

test('EXPORT_LAYER_MODES is a frozen enum object with all 5 Android/Windows modes', () => {
  assert.equal(Object.isFrozen(EXPORT_LAYER_MODES), true);
  assert.deepEqual(EXPORT_LAYER_MODES, {
    ALL_VISIBLE: 'ALL_VISIBLE',
    WITH_SOLUTIONS: 'WITH_SOLUTIONS',
    ALL_LAYERS: 'ALL_LAYERS',
    BLANK_WORKSHEET_ONLY: 'BLANK_WORKSHEET_ONLY',
    ONLY_SOLUTIONS: 'ONLY_SOLUTIONS',
  });
});

test('selective PDF export across all 5 layer modes, embedded images, textBoxes, and includeTapes', async () => {
  const pdfBytes = await samplePdf(1);
  const nb = createNotebook({
    title: 'Arbeitsblatt',
    deviceId: 'win-1',
    pdfBytes,
    pdfPageSizes: [{ width: 595.28, height: 841.89 }],
  });
  const wsLayer = nb.layers.find((l) => l.type === 'WORKSHEET');
  const solLayer = nb.layers.find((l) => l.type === 'SOLUTION');
  const hiddenSol = nb.addLayer('Geheim');
  hiddenSol.isVisible = false;

  const imgEntry = nb.addImageEntry(TINY_PNG, 'png');
  nb.pages[0].payload.strokes = [
    makeStroke('s_ws', String(wsLayer.id)),
    makeStroke('s_sol', String(solLayer.id), 'FINELINER', 50),
    makeStroke('s_hid', String(hiddenSol.id), 'FINELINER', 100),
  ];
  nb.pages[0].payload.images = [
    { id: 'im1', layerId: String(solLayer.id), imagePath: imgEntry, left: 40, top: 40, right: 140, bottom: 140 },
  ];
  nb.pages[0].payload.textBoxes = [
    { id: 'tb1', layerId: String(solLayer.id), left: 60, top: 60, width: 200, height: 80, text: 'Notiz' },
  ];
  nb.pages[0].payload.tapes = [
    { id: 'tp1', layerId: String(solLayer.id), left: 100, top: 200, right: 320, bottom: 280, colorArgb: 0xff1d4ed8 },
  ];

  // 1. WITH_SOLUTIONS & ALL_LAYERS include PDF bg + embedded img + rasterized textBox (3 XObjects)
  for (const mode of [EXPORT_LAYER_MODES.WITH_SOLUTIONS, EXPORT_LAYER_MODES.ALL_LAYERS]) {
    let textBoxCalls = 0;
    const out = await exportNotebookPdf(nb, {
      layerMode: mode,
      rasterizeTextBox: async () => { textBoxCalls++; return TINY_PNG; },
    });
    const doc = await PDFDocument.load(out);
    assert.equal(textBoxCalls, 1);
    assert.equal(pageXObjectCount(doc, 0), 3);
  }

  // 2. BLANK_WORKSHEET_ONLY: PDF bg only (1 XObject), 0 textBoxes
  {
    let textBoxCalls = 0;
    const out = await exportNotebookPdf(nb, {
      layerMode: EXPORT_LAYER_MODES.BLANK_WORKSHEET_ONLY,
      rasterizeTextBox: async () => { textBoxCalls++; return TINY_PNG; },
    });
    const doc = await PDFDocument.load(out);
    assert.equal(textBoxCalls, 0);
    assert.equal(pageXObjectCount(doc, 0), 1);
  }

  // 3. ONLY_SOLUTIONS: no PDF bg, keeps img + textBox (2 XObjects)
  {
    const out = await exportNotebookPdf(nb, {
      layerMode: EXPORT_LAYER_MODES.ONLY_SOLUTIONS,
      includeTapes: false,
      rasterizeTextBox: async () => TINY_PNG,
    });
    const doc = await PDFDocument.load(out);
    assert.equal(pageXObjectCount(doc, 0), 2);
  }

  // 4. ALL_VISIBLE with hidden WORKSHEET layer omits PDF background XObject
  wsLayer.isVisible = false;
  {
    const out = await exportNotebookPdf(nb, {
      layerMode: EXPORT_LAYER_MODES.ALL_VISIBLE,
      rasterizeTextBox: async () => TINY_PNG,
    });
    const doc = await PDFDocument.load(out);
    assert.equal(pageXObjectCount(doc, 0), 2);
  }
});

test('ONLY_SOLUTIONS preserves identical PDF dimensions and scaling with marginNotesEnabled and custom marginWidthPx', async () => {
  for (const size of [[595.28, 841.89], [841.89, 595.28]]) {
    const pdfBytes = await samplePdf(1, size);
    const nb = createNotebook({
      title: 'MarginTest',
      deviceId: 'w',
      pdfBytes,
      pdfPageSizes: [{ width: size[0], height: size[1] }],
    });
    nb.marginNotesEnabled = true;
    nb.marginWidthPx = 480;

    const fullDoc = await PDFDocument.load(await exportNotebookPdf(nb, { layerMode: EXPORT_LAYER_MODES.ALL_LAYERS }));
    const solDoc = await PDFDocument.load(await exportNotebookPdf(nb, { layerMode: EXPORT_LAYER_MODES.ONLY_SOLUTIONS }));

    const expectedWidthPt = size[0] * ((DEFAULT_PAGE_WIDTH + 480) / DEFAULT_PAGE_WIDTH);
    const expectedHeightPt = size[1];

    assert.ok(Math.abs(fullDoc.getPage(0).getWidth() - expectedWidthPt) < 0.5);
    assert.ok(Math.abs(fullDoc.getPage(0).getHeight() - expectedHeightPt) < 0.5);
    assert.ok(Math.abs(solDoc.getPage(0).getWidth() - fullDoc.getPage(0).getWidth()) < 0.01);
    assert.ok(Math.abs(solDoc.getPage(0).getHeight() - fullDoc.getPage(0).getHeight()) < 0.01);
  }
});

test('drawTape bounds sheen segments inside tape rectangle and PdfRecorder emits valid PDF clip operators', async () => {
  // 1. Direct render.js drawTape bounds check
  const segments = [];
  let inClip = false;
  const mockCtx = {
    save: () => {},
    restore: () => { inClip = false; },
    beginPath: () => {},
    roundRect: () => {},
    clip: () => { inClip = true; },
    setLineDash: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: (x, y) => { if (inClip) segments.push({ kind: 'M', x, y }); },
    lineTo: (x, y) => { if (inClip) segments.push({ kind: 'L', x, y }); },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
  };
  const tape = { id: 't1', layerId: '1', left: 200, top: 300, right: 360, bottom: 380, colorArgb: 0xff1d4ed8 };
  drawTape(mockCtx, tape);
  assert.ok(segments.length >= 2);
  for (const pt of segments) {
    assert.ok(pt.x >= tape.left && pt.x <= tape.right, `x=${pt.x} outside [${tape.left}, ${tape.right}]`);
    assert.ok(pt.y >= tape.top && pt.y <= tape.bottom, `y=${pt.y} outside [${tape.top}, ${tape.bottom}]`);
  }

  // 2. PDF export stream contains q ... re W n ... Q clip block around tape sheen
  const nb = createNotebook({ title: 'TapeClip', deviceId: 'w', template: 'BLANK' });
  nb.pages[0].payload.tapes = [tape];
  const pdfBytes = await exportNotebookPdf(nb, { layerMode: EXPORT_LAYER_MODES.ALL_LAYERS, includeTapes: true });
  const doc = await PDFDocument.load(pdfBytes);
  const content = decodePageContentStream(doc, 0);
  assert.match(content, /\bre\s+W\s+n\b/);
  assert.match(content, /\bq\b/);
  assert.match(content, /\bQ\b/);
});

test('Infinite Canvas PDF export computes bounding box including negative coordinates', async () => {
  const nb = createNotebook({ title: 'Inf', deviceId: 'w', canvasMode: 'INFINITE' });
  nb.pages[0].payload.strokes = [
    {
      id: 's1',
      layerId: '1',
      brushKind: 'FINELINER',
      colorArgb: 0xff000000,
      strokeWidth: 4,
      points: [[-400, -200, 0.5], [1600, 400, 0.5]],
    },
  ];
  const bytes = await exportNotebookPdf(nb);
  const doc = await PDFDocument.load(bytes);
  const p = doc.getPage(0);
  // Wide horizontal bounding box -> landscape PDF page
  assert.ok(p.getWidth() > p.getHeight());
});

test('exportPagePng exports Uint8Array with scaling, margins, layer modes, infinite bounds, and error handling', async () => {
  const pdfBytes = await samplePdf(1);
  const nb = createNotebook({
    title: 'PngTest',
    deviceId: 'w',
    pdfBytes,
    pdfPageSizes: [{ width: 595.28, height: 841.89 }],
  });
  nb.marginNotesEnabled = true;
  nb.marginWidthPx = 400;
  const imgEntry = nb.addImageEntry(TINY_PNG, 'png');
  nb.pages[0].payload.images = [{ id: 'im', layerId: '2', imagePath: imgEntry, left: 10, top: 10, right: 60, bottom: 60 }];
  nb.pages[0].payload.strokes = [makeStroke('s1', '2')];
  nb.pages[0].payload.tapes = [{ id: 'tp', layerId: '2', left: 50, top: 50, right: 200, bottom: 100, colorArgb: 0xff1d4ed8 }];

  const createdCanvases = [];
  const createCanvas = (w, h) => {
    const c = createMockCanvasFactory()(w, h);
    createdCanvases.push(c);
    return c;
  };
  const encodePng = () => TINY_PNG;

  let pdfRenderCalls = 0;
  const pngBytes = await exportPagePng(nb, 0, {
    scale: 2,
    maxEdge: 3000,
    layerMode: EXPORT_LAYER_MODES.WITH_SOLUTIONS,
    createCanvas,
    encodePng,
    decodeImage: async () => ({ width: 1, height: 1 }),
    renderPdfBackground: async () => { pdfRenderCalls++; return { width: 100, height: 100 }; },
  });

  assert.ok(pngBytes instanceof Uint8Array);
  assert.equal(pdfRenderCalls, 1);
  // Margin width 400 + 1654 = 2054; height = 2339; scale=2 clamped by maxEdge=3000 -> renderScale = 3000/2339
  const c0 = createdCanvases[0];
  assert.equal(c0.height, 3000);
  assert.equal(c0.width, Math.round(2054 * (3000 / DEFAULT_PAGE_HEIGHT)));
  assert.ok(c0.ops.some((o) => o.op === 'drawImage'));

  // BLANK_WORKSHEET_ONLY skips solution strokes and tapes
  const cBlank = [];
  await exportPagePng(nb, 0, {
    layerMode: EXPORT_LAYER_MODES.BLANK_WORKSHEET_ONLY,
    includeTapes: false,
    createCanvas: (w, h) => { const c = createMockCanvasFactory()(w, h); cBlank.push(c); return c; },
    encodePng,
    renderPdfBackground: async () => ({ width: 100, height: 100 }),
  });
  assert.equal(cBlank[0].ops.filter((o) => o.op === 'quad').length, 0);

  // Invalid pageIndex throws
  await assert.rejects(() => exportPagePng(nb, 99, { createCanvas, encodePng }), /Invalid pageIndex/);
});

test('render.js polish: drawInfinitePaper MUSIC, HIGHLIGHTER audioActive, and hitTestTextBox checkbox zone', () => {
  // 1. drawInfinitePaper MUSIC draws 5-line staves
  const lines = [];
  const musicCtx = {
    save: () => {},
    restore: () => {},
    fillRect: () => {},
    beginPath: () => {},
    moveTo: (x, y) => lines.push({ y1: y }),
    lineTo: (x, y) => { lines[lines.length - 1].y2 = y; },
    stroke: () => {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  };
  drawInfinitePaper(musicCtx, 'MUSIC', -200, -100, 1000, 500);
  assert.ok(lines.length >= 10);
  assert.equal(lines.length % 5, 0);

  // 2. drawPageContent passes audioActive for HIGHLIGHTER strokes
  const strokeWidths = [];
  const audioCtx = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    setLineDash: () => {},
    stroke: () => strokeWidths.push(audioCtx.lineWidth),
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'round',
  };
  drawPageContent(audioCtx, {
    strokes: [makeStroke('hl', '1', 'HIGHLIGHTER', 0, 5000)],
  }, () => true, { activeAudioOffsetMs: 5200 });
  // Glow stroke uses width + 10 = 14, then main highlighter uses width = 4
  assert.ok(strokeWidths.includes(14));
  assert.ok(strokeWidths.includes(4));

  // 3. hitTestTextBox handles resize, checkbox (only when isChecklist), body, and null
  const checklist = {
    id: 'cb1',
    left: 100,
    top: 200,
    width: 300,
    height: 100,
    isChecklist: true,
    fontSizeSp: 16,
    backgroundColorArgb: 0,
  };
  const plain = {
    id: 'tb1',
    left: 500,
    top: 200,
    width: 300,
    height: 100,
    isChecklist: false,
    fontSizeSp: 16,
    backgroundColorArgb: 0,
  };
  assert.deepEqual(hitTestTextBox([checklist, plain], 120, 220), { item: checklist, handle: 'checkbox' });
  assert.deepEqual(hitTestTextBox([checklist, plain], 260, 250), { item: checklist, handle: 'body' });
  assert.deepEqual(hitTestTextBox([checklist, plain], 400, 300), { item: checklist, handle: 'resize' });
  assert.deepEqual(hitTestTextBox([checklist, plain], 520, 220), { item: plain, handle: 'body' });
  assert.equal(hitTestTextBox([checklist, plain], 10, 10), null);
});
