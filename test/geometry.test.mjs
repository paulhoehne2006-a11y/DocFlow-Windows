import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECOGNIZED_SHAPES, recognizeShape, isScribbleToErase } from '../src/js/shapes.js';
import {
  DEFAULT_PIXELS_PER_CM,
  createDefaultRuler,
  normalizeAngleDegrees,
  snapAngleToCommonIncrements,
  projectPointOntoRuler,
  snapPointIfEnabled,
  generateScaleTicks,
  formatDisplayAngle,
  hitTestGeodreieck,
  drawGeodreieckOverlay,
} from '../src/js/geodreieck.js';

function makeLine(x0, y0, x1, y1, steps = 24, jitter = 0) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const perp = jitter && i > 0 && i < steps ? Math.sin(i * 1.7) * jitter : 0;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    pts.push([x0 + dx * t + (-dy / len) * perp, y0 + dy * t + (dx / len) * perp, 0.6, 0, 0, i * 10]);
  }
  return pts;
}

function makePolygonLoop(vertices, stepsPerEdge = 16, jitter = 0) {
  const pts = [];
  let ms = 0;
  for (let e = 0; e < vertices.length; e++) {
    const [x0, y0] = vertices[e];
    const [x1, y1] = vertices[(e + 1) % vertices.length];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const startK = e === 0 ? 0 : 1;
    for (let k = startK; k <= stepsPerEdge; k++) {
      const t = k / stepsPerEdge;
      const w = jitter && k > 0 && k < stepsPerEdge ? Math.sin(k * 1.3) * jitter : 0;
      pts.push([x0 + dx * t + (-dy / len) * w, y0 + dy * t + (dx / len) * w, 0.5, 0, 0, ms]);
      ms += 10;
    }
  }
  return pts;
}

function makeEllipseLoop(cx, cy, rx, ry, angleDeg = 0, steps = 64) {
  const rad = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(rad);
  const sa = Math.sin(rad);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    const u = Math.cos(theta) * rx;
    const v = Math.sin(theta) * ry;
    pts.push([cx + u * ca - v * sa, cy + u * sa + v * ca, 0.55, 0, 0, i * 8]);
  }
  return pts;
}

// ---------------- shapes.js ----------------

test('RECOGNIZED_SHAPES lists all supported shape categories', () => {
  assert.deepEqual(RECOGNIZED_SHAPES, [
    'NONE', 'LINE', 'ARROW', 'RECTANGLE', 'CIRCLE_OR_ELLIPSE', 'TRIANGLE',
  ]);
});

test('recognizeShape rejects empty, tiny, single-point, and sub-threshold strokes', () => {
  assert.equal(recognizeShape([]).shapeType, 'NONE');
  assert.equal(recognizeShape([[10, 10]]).shapeType, 'NONE');
  assert.equal(recognizeShape([[0, 0], [5, 5]]).shapeType, 'NONE');
  assert.equal(recognizeShape([[0, 0], [20, 0]]).shapeType, 'NONE'); // length < 24
  assert.equal(recognizeShape([[0, 0], [10, 10], [0, 0]]).shapeType, 'NONE'); // diag < 16
});

test('recognizeShape recognizes LINE (tuple and object points) and snaps near-axis angles', () => {
  // Nearly horizontal (1.5 deg) -> snaps to exact y = 100
  const horiz = makeLine(100, 100, 400, 108, 20, 1);
  const resH = recognizeShape(horiz);
  assert.equal(resH.shapeType, 'LINE');
  assert.ok(resH.confidence >= 0.65);
  assert.ok(Math.abs(resH.snappedPoints[resH.snappedPoints.length - 1][1] - 100) < 0.05);

  // Nearly 45 deg using object points
  const diagObj = makeLine(0, 0, 200, 204, 20).map(([x, y, pressure, tiltX, tiltY, timestampMs]) => ({
    x, y, pressure, tiltX, tiltY, timestampMs,
  }));
  const resD = recognizeShape(diagObj);
  assert.equal(resD.shapeType, 'LINE');
  const last = resD.snappedPoints[resD.snappedPoints.length - 1];
  assert.ok(Math.abs(last[0] - last[1]) < 0.2);

  // Non-snapped 22 deg line preserves orientation
  const rad = (22 * Math.PI) / 180;
  const angled = makeLine(50, 50, 50 + Math.cos(rad) * 260, 50 + Math.sin(rad) * 260, 20);
  const resA = recognizeShape(angled);
  assert.equal(resA.shapeType, 'LINE');
  const end = resA.snappedPoints[resA.snappedPoints.length - 1];
  const actualDeg = (Math.atan2(end[1] - 50, end[0] - 50) * 180) / Math.PI;
  assert.ok(Math.abs(actualDeg - 22) < 1);
});

test('recognizeShape recognizes ARROW with shaft and barb', () => {
  const shaft = makeLine(100, 200, 360, 200, 20);
  const barb = makeLine(360, 200, 320, 165, 6).slice(1);
  const res = recognizeShape([...shaft, ...barb]);
  assert.equal(res.shapeType, 'ARROW');
  assert.ok(res.snappedPoints.length > 10);
  assert.ok(res.confidence >= 0.68);
});

test('recognizeShape recognizes axis-aligned and rotated RECTANGLE', () => {
  const axisRect = makePolygonLoop([[100, 100], [340, 100], [340, 260], [100, 260]], 16, 1.5);
  const res1 = recognizeShape(axisRect);
  assert.equal(res1.shapeType, 'RECTANGLE');
  assert.ok(res1.confidence >= 0.7);

  // Rotated 25 deg rectangle
  const rad = (25 * Math.PI) / 180;
  const rot = ([x, y]) => [
    300 + x * Math.cos(rad) - y * Math.sin(rad),
    300 + x * Math.sin(rad) + y * Math.cos(rad),
  ];
  const rotRect = makePolygonLoop([rot([-110, -70]), rot([110, -70]), rot([110, 70]), rot([-110, 70])], 16);
  const res2 = recognizeShape(rotRect);
  assert.equal(res2.shapeType, 'RECTANGLE');
});

test('recognizeShape recognizes TRIANGLE', () => {
  const tri = makePolygonLoop([[250, 80], [410, 340], [90, 340]], 18, 1);
  const res = recognizeShape(tri);
  assert.equal(res.shapeType, 'TRIANGLE');
  assert.ok(res.confidence >= 0.7);
});

test('recognizeShape recognizes CIRCLE_OR_ELLIPSE for circles and tilted ellipses', () => {
  const almostCircle = makeEllipseLoop(300, 300, 100, 96, 10, 64);
  const resC = recognizeShape(almostCircle);
  assert.equal(resC.shapeType, 'CIRCLE_OR_ELLIPSE');
  // Ratio > 0.88 snaps to exact circle
  const xs = resC.snappedPoints.map((p) => p[0]);
  const ys = resC.snappedPoints.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(w - h) < 1);

  const ellipse = makeEllipseLoop(400, 400, 160, 70, 30, 64);
  const resE = recognizeShape(ellipse);
  assert.equal(resE.shapeType, 'CIRCLE_OR_ELLIPSE');
  const exs = resE.snappedPoints.map((p) => p[0]);
  const eys = resE.snappedPoints.map((p) => p[1]);
  assert.ok(Math.max(...exs) - Math.min(...exs) > Math.max(...eys) - Math.min(...eys));
});

test('recognizeShape returns NONE for open wavy strokes', () => {
  const wave = [];
  for (let i = 0; i <= 40; i++) {
    wave.push([100 + i * 8, 200 + Math.sin(i * 0.4) * 45, 0.5, 0, 0, i * 10]);
  }
  assert.equal(recognizeShape(wave).shapeType, 'NONE');
});

test('isScribbleToErase detects compact back-and-forth scribbles and rejects normal shapes', () => {
  const scribble = [];
  for (let i = 0; i < 8; i++) {
    const y = 100 + i * 12;
    const xStart = i % 2 === 0 ? 100 : 220;
    const xEnd = i % 2 === 0 ? 220 : 100;
    for (let k = 0; k < 4; k++) {
      scribble.push([xStart + ((xEnd - xStart) * k) / 3, y, 0.5, 0, 0, (i * 4 + k) * 10]);
    }
  }
  assert.equal(isScribbleToErase(scribble), true);

  assert.equal(isScribbleToErase(makeLine(0, 0, 200, 0, 20)), false);
  assert.equal(isScribbleToErase(makeEllipseLoop(200, 200, 70, 70, 0, 40)), false);
  assert.equal(isScribbleToErase([[0, 0], [10, 10], [0, 20]]), false);
  // Too small (< 28 diag)
  assert.equal(isScribbleToErase(Array.from({ length: 16 }, (_, i) => [i % 2 ? 0 : 10, i, 0.5])), false);
  // Too large (> 420 diag)
  const huge = [];
  for (let i = 0; i < 8; i++) {
    huge.push([i % 2 === 0 ? 0 : 500, i * 60, 0.5]);
    huge.push([i % 2 === 0 ? 250 : 250, i * 60 + 20, 0.5]);
  }
  assert.equal(isScribbleToErase(huge), false);
});

// ---------------- geodreieck.js ----------------

test('createDefaultRuler & normalizeAngleDegrees', () => {
  const r = createDefaultRuler(500, 600);
  assert.deepEqual(r, {
    enabled: false,
    centerX: 500,
    centerY: 600,
    angleDegrees: 0,
    snapTolerancePx: 26,
    lengthCm: 14,
  });

  assert.equal(Object.is(normalizeAngleDegrees(-0), 0), true);
  assert.equal(normalizeAngleDegrees(180), 180);
  assert.equal(normalizeAngleDegrees(-180), 180);
  assert.equal(normalizeAngleDegrees(540), 180);
  assert.equal(normalizeAngleDegrees(-270), 90);
  assert.equal(normalizeAngleDegrees(270), -90);
  assert.equal(normalizeAngleDegrees(NaN), 0);
  assert.equal(normalizeAngleDegrees(Infinity), 0);
});

test('snapAngleToCommonIncrements respects threshold and disable flag', () => {
  assert.equal(snapAngleToCommonIncrements(43, 3), 45);
  assert.equal(snapAngleToCommonIncrements(-88, 3), -90);
  assert.equal(snapAngleToCommonIncrements(49, 3), 49);
  assert.equal(snapAngleToCommonIncrements(44, 0), 44);
  assert.equal(snapAngleToCommonIncrements(179, 3), 180);
});

test('projectPointOntoRuler & snapPointIfEnabled work at 0 deg and 45 deg', () => {
  const ruler = { ...createDefaultRuler(100, 200), enabled: true, angleDegrees: 0, snapTolerancePx: 20 };
  const p0 = projectPointOntoRuler(150, 212, ruler);
  assert.equal(p0.x, 150);
  assert.equal(p0.y, 200);
  assert.equal(p0.isSnapped, true);
  assert.equal(p0.perpendicularDistancePx, 12);
  assert.equal(p0.offsetAlongRulerPx, 50);

  const far = snapPointIfEnabled(150, 240, ruler);
  assert.equal(far.isSnapped, false);
  assert.equal(far.x, 150);
  assert.equal(far.y, 240);

  const disabled = snapPointIfEnabled(150, 205, { ...ruler, enabled: false });
  assert.equal(disabled.isSnapped, false);
  assert.equal(disabled.y, 205);

  const rot45 = { ...ruler, angleDegrees: 45 };
  const p45 = snapPointIfEnabled(150, 250, rot45);
  assert.equal(p45.isSnapped, true);
  assert.ok(Math.abs(p45.x - 150) < 1e-6);
  assert.ok(Math.abs(p45.y - 250) < 1e-6);
});

test('generateScaleTicks & formatDisplayAngle', () => {
  const centered = generateScaleTicks(14, DEFAULT_PIXELS_PER_CM, true);
  assert.equal(centered.length, 141);
  assert.equal(centered[0].distanceMm, -70);
  assert.equal(centered[70].distanceMm, 0);
  assert.equal(centered[70].isMajorCm, true);
  assert.equal(centered[70].label, '0');
  assert.equal(centered[75].isHalfCm, true);

  const uncentered = generateScaleTicks(10, DEFAULT_PIXELS_PER_CM, false);
  assert.equal(uncentered.length, 101);
  assert.equal(uncentered[0].distanceMm, 0);
  assert.equal(uncentered[100].distanceMm, 100);

  assert.deepEqual(generateScaleTicks(0), []);
  assert.deepEqual(generateScaleTicks(10, NaN), []);

  assert.equal(formatDisplayAngle(-0.2), '0°');
  assert.equal(formatDisplayAngle(-180), '180°');
  assert.equal(formatDisplayAngle(44.6), '45°');
});

test('hitTestGeodreieck handles disabled, body, rotate handles, rotation, and zoom', () => {
  const ruler = createDefaultRuler(500, 500);
  assert.equal(hitTestGeodreieck(500, 550, ruler), null);

  ruler.enabled = true;
  const halfW = (14 * DEFAULT_PIXELS_PER_CM) / 2; // 420
  assert.equal(hitTestGeodreieck(500, 550, ruler), 'body');
  assert.equal(hitTestGeodreieck(500 - halfW + 44, 544, ruler), 'rotate-left');
  assert.equal(hitTestGeodreieck(500 + halfW - 44, 544, ruler), 'rotate-right');
  assert.equal(hitTestGeodreieck(500, 490, ruler), null);

  // Rotated 90 deg: local +y becomes global -x
  const rotRuler = { ...ruler, angleDegrees: 90 };
  assert.equal(hitTestGeodreieck(450, 500, rotRuler), 'body');
  // At zoom 0.25, handleR = max(24, 22 / 0.25) = 88
  assert.equal(hitTestGeodreieck(456 - 70, 500 + halfW - 44, rotRuler, 0.25), 'rotate-right');
});

test('drawGeodreieckOverlay executes cleanly with mock CanvasRenderingContext2D', () => {
  const calls = [];
  const ctx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    translate: () => {},
    rotate: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    arc: () => {},
    roundRect: () => {},
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    measureText: () => ({ width: 30 }),
    fillText: () => calls.push('fillText'),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
  };

  const ruler = createDefaultRuler(400, 400);
  drawGeodreieckOverlay(ctx, ruler);
  assert.equal(calls.length, 0);

  ruler.enabled = true;
  ruler.angleDegrees = 30;
  drawGeodreieckOverlay(ctx, ruler, { isDark: false, zoom: 1.5, active: true });
  assert.ok(calls.includes('save'));
  assert.ok(calls.includes('restore'));
  assert.ok(calls.includes('fillText'));
});
