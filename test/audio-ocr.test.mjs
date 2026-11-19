import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioAudioController, formatAudioTime } from '../src/js/audio.js';
import { renderStrokesForOcr, recognizeStrokesOcr, indexNotebookText } from '../src/js/ocr.js';
import { createNotebook } from '../src/js/model.js';
import { setLanguage } from '../src/js/i18n.js';

// Minimal Audio & Canvas mocks for headless Node unit testing
class MockAudio {
  constructor() {
    this.src = '';
    this.currentTime = 0;
    this.duration = 12.4;
    this.playbackRate = 1;
    this.readyState = 4;
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  dispatch(type) {
    for (const fn of this.listeners.get(type) || []) fn();
  }
  async play() {
    this.dispatch('play');
  }
  pause() {
    this.dispatch('pause');
  }
  removeAttribute(attr) {
    if (attr === 'src') this.src = '';
  }
}

globalThis.Audio = MockAudio;

test('formatAudioTime formats milliseconds into MM:SS', () => {
  assert.equal(formatAudioTime(0), '00:00');
  assert.equal(formatAudioTime(-500), '00:00');
  assert.equal(formatAudioTime(9500), '00:09');
  assert.equal(formatAudioTime(65_000), '01:05');
  assert.equal(formatAudioTime(605_900), '10:05');
});

test('StudioAudioController manages playback, seek, jumpMode, and recording lifecycle', async () => {
  const states = [];
  const errors = [];
  const ctrl = new StudioAudioController({
    onStateChange: (st) => states.push(st),
    onError: (err) => errors.push(err),
  });

  const nb = createNotebook({ title: 'AudioTest', deviceId: 'win-1' });
  const bm1 = nb.addAudioEntry(new Uint8Array([1, 2, 3, 4]), {
    ext: 'wav',
    label: 'Vorlesung 1',
    pageIndex: 0,
    durationMs: 12_400,
  });

  ctrl.attachNotebook(nb);
  assert.equal(ctrl.activeEntryName, bm1.entryName);
  assert.equal(states[states.length - 1].entries.length, 1);

  // Jump mode & playback rate
  ctrl.setJumpMode(true);
  assert.equal(ctrl.jumpMode, true);
  ctrl.setPlaybackRate(1.5);
  assert.equal(ctrl.playbackRate, 1.5);

  // Toggle play & pause
  await ctrl.togglePlay();
  assert.equal(ctrl.isPlaying, true);
  await ctrl.togglePlay();
  assert.equal(ctrl.isPlaying, false);

  // Seek to offset
  await ctrl.seekToMs(4500);
  assert.equal(ctrl.currentOffsetMs, 4500);
  assert.equal(ctrl.isPlaying, true);
  ctrl.stopPlayback();
  assert.equal(ctrl.isPlaying, false);

  // Microphone denied when mediaDevices is missing
  const origNav = globalThis.navigator;
  const origRec = globalThis.MediaRecorder;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: null },
      configurable: true,
    });
    const okDenied = await ctrl.startRecording(0);
    assert.equal(okDenied, false);
    assert.ok(errors.includes('audioMicDenied'));

    // Successful recording with mocked MediaRecorder
    let stoppedTrack = false;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => { stoppedTrack = true; } }],
          }),
        },
      },
      configurable: true,
    });
    globalThis.MediaRecorder = class {
      static isTypeSupported(t) { return t === 'audio/webm'; }
      constructor(stream, opts) {
        this.stream = stream;
        this.mimeType = opts?.mimeType || 'audio/webm';
        this.ondataavailable = null;
        this.onstop = null;
      }
      start() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([10, 20, 30])]) });
      }
      stop() {
        this.onstop?.();
      }
    };

    const started = await ctrl.startRecording(0);
    assert.equal(started, true);
    assert.equal(ctrl.isRecording, true);
    const savedBm = await ctrl.stopRecording();
    assert.equal(ctrl.isRecording, false);
    assert.equal(stoppedTrack, true);
    assert.ok(savedBm);
    assert.equal(nb.listAudioEntries().length, 2);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: origNav, configurable: true });
    globalThis.MediaRecorder = origRec;
    ctrl.dispose();
  }
});

test('renderStrokesForOcr, recognizeStrokesOcr, and indexNotebookText index handwriting, textBoxes, and PDF text', async () => {
  const origDoc = globalThis.document;
  const drawnStrokes = [];
  globalThis.document = {
    documentElement: { lang: 'de' },
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`Unexpected tag: ${tag}`);
      const ctx = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        lineCap: 'round',
        lineJoin: 'round',
        fillRect: () => {},
        scale: () => {},
        translate: () => {},
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => {},
        fill: () => {},
        stroke: () => { drawnStrokes.push(ctx.strokeStyle); },
        setLineDash: () => {},
      };
      return {
        width: 0,
        height: 0,
        getContext: () => ctx,
        toBlob(cb) {
          cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]));
        },
      };
    },
  };

  try {
    // Empty or highlighter-only strokes return null
    assert.equal(await renderStrokesForOcr([]), null);
    assert.equal(await renderStrokesForOcr([{
      id: 'h1',
      brushKind: 'HIGHLIGHTER',
      points: [[0, 0, 0.5], [100, 100, 0.5]],
    }]), null);

    const inkStroke = {
      id: 's1',
      layerId: '1',
      brushKind: 'FINELINER',
      colorArgb: 0xff1d4ed8,
      strokeWidth: 4,
      points: [[10, 20, 0.6], [120, 40, 0.7], [220, 60, 0.6]],
    };
    const png = await renderStrokesForOcr([inkStroke]);
    assert.ok(png instanceof Uint8Array);
    assert.equal(png.length, 4);
    // Color normalized to pure black rgba(0,0,0,1)
    assert.ok(drawnStrokes.includes('rgba(0,0,0,1)'));

    // recognizeStrokesOcr uses active language and bridge.recognizeOcr
    setLanguage('de');
    let calledLang = null;
    const bridge = {
      recognizeOcr: async (_bytes, lang) => {
        calledLang = lang;
        return { ok: true, text: 'Kettenregel', engine: 'mock' };
      },
    };
    const res = await recognizeStrokesOcr(bridge, [inkStroke]);
    assert.equal(calledLang, 'de-DE');
    assert.equal(res.text, 'Kettenregel');

    // Unavailable bridge
    const unavail = await recognizeStrokesOcr({}, [inkStroke]);
    assert.equal(unavail.ok, false);
    assert.equal(unavail.engine, 'unavailable');

    // indexNotebookText combines textBoxes, PDF text, and handwriting OCR
    const nb = createNotebook({
      title: 'OCR Notebook',
      deviceId: 'win-1',
      pdfBytes: new Uint8Array([1, 2, 3]),
      pdfPageSizes: [{ width: 595, height: 842 }],
    });
    nb.pages[0].payload.textBoxes.push({ id: 'tb1', layerId: '2', text: 'Textbox Inhalt' });
    nb.pages[0].payload.strokes.push({ ...inkStroke, layerId: '2' });

    const fakePdfBg = {
      extractPageText: async () => 'PDF Arbeitsblatt Text',
    };
    const indexed = await indexNotebookText(bridge, nb, fakePdfBg);
    assert.equal(indexed.ocrAvailable, true);
    assert.ok(indexed.text.includes('Textbox Inhalt'));
    assert.ok(indexed.text.includes('PDF Arbeitsblatt Text'));
    assert.ok(indexed.text.includes('Kettenregel'));
    assert.equal(nb.extractedHandwritingText, indexed.text);
  } finally {
    globalThis.document = origDoc;
  }
});
