// Hold-to-Snap geometric shape recognition (ported from Android's ShapeRecognizer.kt)
// plus Scribble-to-Erase gesture detection for natural S-Pen / stylus workflows.

import { pointOf } from './model.js';

const MIN_STROKE_LENGTH_PX = 24;
const MIN_BBOX_DIAGONAL_PX = 16;
const DEDUP_MIN_STEP_PX = 1.5;
const CLOSED_RESAMPLE_COUNT = 72;

export const RECOGNIZED_SHAPES = ['NONE', 'LINE', 'ARROW', 'RECTANGLE', 'CIRCLE_OR_ELLIPSE', 'TRIANGLE'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function normalizePoints(rawPoints) {
  const out = [];
  for (const raw of rawPoints || []) {
    const p = pointOf(raw);
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      out.push({
        x: p.x,
        y: p.y,
        pressure: clamp(p.pressure ?? 0.5, 0.05, 1),
        tiltX: p.tiltX ?? 0,
        tiltY: p.tiltY ?? 0,
        timestampMs: Array.isArray(raw) ? (+raw[5] || 0) : (+raw.timestampMs || 0),
      });
    }
  }
  return out;
}

function deduplicateClosePoints(pts, minStep) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (dist(out[out.length - 1], pts[i]) >= minStep) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

function computeBounds(pts) {
  let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
  for (const p of pts) {
    if (p.x < left) left = p.x;
    if (p.y < top) top = p.y;
    if (p.x > right) right = p.x;
    if (p.y > bottom) bottom = p.y;
  }
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function perpendicularErrors(pts, a, b) {
  let maxPerp = 0;
  let sumSq = 0;
  for (const p of pts) {
    const d = distToSegment(p, a, b);
    if (d > maxPerp) maxPerp = d;
    sumSq += d * d;
  }
  return [maxPerp, Math.sqrt(sumSq / Math.max(1, pts.length))];
}

function resamplePolyline(pts, count) {
  if (pts.length <= 1 || count <= 1) return pts;
  const total = polylineLength(pts);
  if (total < 1e-4) return pts;
  const step = total / (count - 1);
  const out = [{ ...pts[0] }];
  let acc = 0;
  let i = 1;
  let prev = pts[0];
  while (i < pts.length && out.length < count) {
    const cur = pts[i];
    const seg = dist(prev, cur);
    if (acc + seg >= step) {
      const t = seg > 1e-6 ? (step - acc) / seg : 0;
      const nx = prev.x + (cur.x - prev.x) * t;
      const ny = prev.y + (cur.y - prev.y) * t;
      const np = { x: nx, y: ny, pressure: prev.pressure, tiltX: 0, tiltY: 0, timestampMs: prev.timestampMs };
      out.push(np);
      prev = np;
      acc = 0;
    } else {
      acc += seg;
      prev = cur;
      i++;
    }
  }
  while (out.length < count) out.push({ ...pts[pts.length - 1] });
  return out;
}

function resampleSegmentChain(vertices, segmentSteps, pressure, startMs, endMs) {
  const totalSteps = segmentSteps.reduce((a, b) => a + b, 0);
  const out = [];
  let idx = 0;
  for (let s = 0; s < segmentSteps.length; s++) {
    const a = vertices[s];
    const b = vertices[s + 1];
    const steps = Math.max(1, segmentSteps[s]);
    const startK = s === 0 ? 0 : 1;
    for (let k = startK; k <= steps; k++) {
      const t = k / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const time = Math.round(startMs + ((endMs - startMs) * idx) / Math.max(1, totalSteps));
      out.push([+x.toFixed(2), +y.toFixed(2), +pressure.toFixed(3), 0, 0, time]);
      idx++;
    }
  }
  return out;
}

function snapAxisAngle(first, last) {
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const len = Math.hypot(dx, dy);
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Gently snap nearly horizontal/vertical/45° lines within 4°
  for (const target of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) {
    if (Math.abs(deg - target) <= 4) {
      const rad = (target * Math.PI) / 180;
      return [[first.x, first.y], [first.x + Math.cos(rad) * len, first.y + Math.sin(rad) * len]];
    }
  }
  return [[first.x, first.y], [last.x, last.y]];
}

function tryRecognizeLine(pts, totalLength, pressure, startMs, endMs) {
  const first = pts[0];
  const last = pts[pts.length - 1];
  const chord = dist(first, last);
  if (chord < MIN_STROKE_LENGTH_PX) return null;
  if (chord / totalLength < 0.90) return null;

  const [maxPerp, rmsPerp] = perpendicularErrors(pts, first, last);
  const maxAllowedPerp = Math.max(12, chord * 0.08);
  const maxAllowedRms = Math.max(6, chord * 0.045);
  if (maxPerp > maxAllowedPerp || rmsPerp > maxAllowedRms) return null;

  const [fitStart, fitEnd] = snapAxisAngle(first, last);
  const steps = Math.max(2, Math.ceil(chord / 16));
  const snappedPoints = resampleSegmentChain([fitStart, fitEnd], [steps], pressure, startMs, endMs);
  const confidence = clamp(1 - (rmsPerp / maxAllowedRms) * 0.35, 0.65, 0.99);
  return { shapeType: 'LINE', snappedPoints, confidence };
}

function tryRecognizeArrow(pts, pressure, startMs, endMs) {
  const resampled = resamplePolyline(pts, 48);
  if (resampled.length < 8) return null;
  const start = resampled[0];
  const end = resampled[resampled.length - 1];

  const minTipIdx = clamp(Math.floor(resampled.length * 0.35), 2, resampled.length - 3);
  const dists = resampled.map((p) => dist(start, p));
  let globalMaxDist = -1;
  let fallbackTipIdx = minTipIdx;
  for (let i = minTipIdx; i < resampled.length - 1; i++) {
    if (dists[i] > globalMaxDist) {
      globalMaxDist = dists[i];
      fallbackTipIdx = i;
    }
  }
  const peakTol = Math.max(4, globalMaxDist * 0.03);
  let tipIdx = fallbackTipIdx;
  for (let i = minTipIdx; i < resampled.length - 1; i++) {
    if (dists[i] >= globalMaxDist - peakTol && dists[i] >= dists[i - 1] && dists[i] >= dists[i + 1]) {
      tipIdx = i;
      break;
    }
  }

  const tip = resampled[tipIdx];
  const shaftChord = dist(start, tip);
  if (shaftChord < 36) return null;
  if (dist(start, end) < shaftChord * 0.40) return null;

  const shaftPts = resampled.slice(0, tipIdx + 1);
  const shaftLen = polylineLength(shaftPts);
  if (shaftChord / shaftLen < 0.88) return null;

  const [shaftMaxPerp, shaftRmsPerp] = perpendicularErrors(shaftPts, start, tip);
  if (shaftMaxPerp > Math.max(12, shaftChord * 0.08) || shaftRmsPerp > Math.max(6, shaftChord * 0.045)) return null;

  const headPts = resampled.slice(tipIdx);
  if (headPts.length < 2) return null;

  const ux = (tip.x - start.x) / shaftChord;
  const uy = (tip.y - start.y) / shaftChord;
  const px = -uy;
  const py = ux;

  let maxDistFromTip = 0;
  let hasBarb = false;
  for (let i = 1; i < headPts.length; i++) {
    const dx = headPts[i].x - tip.x;
    const dy = headPts[i].y - tip.y;
    const d = Math.hypot(dx, dy);
    if (d > maxDistFromTip) maxDistFromTip = d;
    const forward = dx * ux + dy * uy;
    const lateral = Math.abs(dx * px + dy * py);
    if (forward > Math.max(10, shaftChord * 0.08)) return null;
    if (d >= 10 && forward <= -5 && lateral >= 4 && forward <= -0.25 * d) hasBarb = true;
  }
  if (!hasBarb || maxDistFromTip < 10 || maxDistFromTip > shaftChord * 0.48) return null;

  const headSize = clamp(shaftChord * 0.18, 14, 42);
  const wingBack = headSize * 0.86;
  const wingSpread = headSize * 0.50;
  const wing1 = [tip.x - ux * wingBack + px * wingSpread, tip.y - uy * wingBack + py * wingSpread];
  const wing2 = [tip.x - ux * wingBack - px * wingSpread, tip.y - uy * wingBack - py * wingSpread];
  const tipPair = [tip.x, tip.y];
  const shaftSteps = Math.max(6, Math.ceil(shaftChord / 16));

  const snappedPoints = resampleSegmentChain(
    [[start.x, start.y], tipPair, wing1, tipPair, wing2],
    [shaftSteps, 4, 4, 4],
    pressure,
    startMs,
    endMs,
  );
  const confidence = clamp(0.85 - (shaftRmsPerp / Math.max(6, shaftChord * 0.05)) * 0.15, 0.68, 0.98);
  return { shapeType: 'ARROW', snappedPoints, confidence };
}

function polygonSignedArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    area += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
  }
  return area * 0.5;
}

function fitEllipsePca(ring) {
  let cx = 0; let cy = 0;
  for (const p of ring) { cx += p.x; cy += p.y; }
  cx /= ring.length;
  cy /= ring.length;

  let sxx = 0; let syy = 0; let sxy = 0;
  for (const p of ring) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);

  let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
  for (const p of ring) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const u = dx * ca + dy * sa;
    const v = -dx * sa + dy * ca;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const midU = (minU + maxU) * 0.5;
  const midV = (minV + maxV) * 0.5;
  const centerX = cx + midU * ca - midV * sa;
  const centerY = cy + midU * sa + midV * ca;
  const rx = Math.max(1, (maxU - minU) * 0.5);
  const ry = Math.max(1, (maxV - minV) * 0.5);

  let errSum = 0;
  let maxErr = 0;
  for (const p of ring) {
    const dx = p.x - centerX;
    const dy = p.y - centerY;
    const u = dx * ca + dy * sa;
    const v = -dx * sa + dy * ca;
    const normR = Math.hypot(u / rx, v / ry);
    const radialErr = Math.abs(normR - 1);
    errSum += radialErr * radialErr;
    if (radialErr > maxErr) maxErr = radialErr;
  }
  const rmsRadialErr = Math.sqrt(errSum / ring.length);
  return { centerX, centerY, rx, ry, angle, semiMajor: Math.max(rx, ry), semiMinor: Math.min(rx, ry), rmsRadialErr, maxRadialErr: maxErr };
}

function rdp(pts, eps) {
  if (pts.length <= 2) return pts;
  let maxD = -1;
  let idx = 0;
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], first, last);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

function simplifyClosedPolygon(ring, eps, minEdge) {
  // Start at point farthest from centroid to break ring cleanly at a corner
  let cx = 0; let cy = 0;
  for (const p of ring) { cx += p.x; cy += p.y; }
  cx /= ring.length; cy /= ring.length;
  let startIdx = 0; let bestD = -1;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i].x - cx, ring[i].y - cy);
    if (d > bestD) { bestD = d; startIdx = i; }
  }
  const ordered = [...ring.slice(startIdx), ...ring.slice(0, startIdx), ring[startIdx]];
  let verts = rdp(ordered, eps);
  if (verts.length > 1 && dist(verts[0], verts[verts.length - 1]) < minEdge) verts.pop();

  // Merge collinear or tiny edges
  let changed = true;
  while (changed && verts.length > 3) {
    changed = false;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[(i - 1 + verts.length) % verts.length];
      const b = verts[i];
      const c = verts[(i + 1) % verts.length];
      if (dist(a, b) < minEdge || distToSegment(b, a, c) < eps * 0.55) {
        verts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return verts;
}

function polygonFitError(ring, verts, diag) {
  let sumSq = 0;
  for (const p of ring) {
    let best = Infinity;
    for (let i = 0; i < verts.length; i++) {
      const d = distToSegment(p, verts[i], verts[(i + 1) % verts.length]);
      if (d < best) best = d;
    }
    sumSq += best * best;
  }
  return Math.sqrt(sumSq / ring.length) / Math.max(1, diag);
}

function tryRecognizeClosedShape(pts, totalLength, diag, pressure, startMs, endMs) {
  const closureDist = dist(pts[0], pts[pts.length - 1]);
  if (closureDist > Math.max(42, diag * 0.30)) return null;

  const closedLoop = [...pts, pts[0]];
  const loopLen = totalLength + closureDist;
  const area = Math.abs(polygonSignedArea(closedLoop));
  if (loopLen <= 0 || area < diag * 4) return null;

  const isoperimetric = (4 * Math.PI * area) / (loopLen * loopLen);
  if (isoperimetric < 0.28) return null;

  const ring = resamplePolyline(closedLoop, CLOSED_RESAMPLE_COUNT);
  const ellipse = fitEllipsePca(ring);
  if (ellipse.semiMajor < 8 || ellipse.semiMinor < 4) return null;

  const simplified = simplifyClosedPolygon(ring, Math.max(8, diag * 0.065), diag * 0.12);
  const candidates = [];

  // Triangle candidate
  if (simplified.length === 3) {
    const err = polygonFitError(ring, simplified, diag);
    if (err < 0.065) {
      candidates.push({
        type: 'TRIANGLE',
        error: err,
        vertices: simplified.map((v) => [v.x, v.y]),
      });
    }
  }

  // Rectangle candidate (oriented bounding box from PCA)
  if (simplified.length === 4 || (simplified.length >= 3 && simplified.length <= 5)) {
    const { centerX, centerY, rx, ry, angle } = ellipse;
    // Snap near-axis-aligned rectangles within 6°
    let snapAngle = angle;
    const deg = (angle * 180) / Math.PI;
    for (const target of [-90, 0, 90, 180]) {
      if (Math.abs(deg - target) <= 6) { snapAngle = (target * Math.PI) / 180; break; }
    }
    const ca = Math.cos(snapAngle);
    const sa = Math.sin(snapAngle);
    const corners = [
      [-rx, -ry], [rx, -ry], [rx, ry], [-rx, ry],
    ].map(([u, v]) => ({ x: centerX + u * ca - v * sa, y: centerY + u * sa + v * ca }));
    const rectErr = polygonFitError(ring, corners, diag);
    if (rectErr < 0.068 && (simplified.length === 4 || rectErr < ellipse.rmsRadialErr * 0.72)) {
      candidates.push({
        type: 'RECTANGLE',
        error: rectErr,
        vertices: corners.map((c) => [c.x, c.y]),
      });
    }
  }

  // Circle / Ellipse candidate
  if (ellipse.rmsRadialErr < 0.145 && ellipse.maxRadialErr < 0.34) {
    candidates.push({
      type: 'CIRCLE_OR_ELLIPSE',
      error: ellipse.rmsRadialErr * 0.55,
      ellipse,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.error - b.error);
  const best = candidates[0];

  if (best.type === 'TRIANGLE' || best.type === 'RECTANGLE') {
    const closedVerts = [...best.vertices, best.vertices[0]];
    const steps = [];
    for (let i = 0; i < best.vertices.length; i++) {
      const a = closedVerts[i];
      const b = closedVerts[i + 1];
      steps.push(Math.max(4, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 14)));
    }
    const snappedPoints = resampleSegmentChain(closedVerts, steps, pressure, startMs, endMs);
    return { shapeType: best.type, snappedPoints, confidence: clamp(1 - best.error * 4, 0.7, 0.98) };
  }

  // Circle / Ellipse synthesis (snap nearly circular ellipses with ratio > 0.88 to exact circle)
  const e = best.ellipse;
  const ratio = e.semiMinor / e.semiMajor;
  const rx = ratio >= 0.88 ? (e.rx + e.ry) * 0.5 : e.rx;
  const ry = ratio >= 0.88 ? (e.rx + e.ry) * 0.5 : e.ry;
  const ca = Math.cos(e.angle);
  const sa = Math.sin(e.angle);
  const count = 64;
  const snappedPoints = [];
  for (let i = 0; i <= count; i++) {
    const theta = (i / count) * Math.PI * 2;
    const u = Math.cos(theta) * rx;
    const v = Math.sin(theta) * ry;
    const x = e.centerX + u * ca - v * sa;
    const y = e.centerY + u * sa + v * ca;
    const time = Math.round(startMs + ((endMs - startMs) * i) / count);
    snappedPoints.push([+x.toFixed(2), +y.toFixed(2), +pressure.toFixed(3), 0, 0, time]);
  }
  return { shapeType: 'CIRCLE_OR_ELLIPSE', snappedPoints, confidence: clamp(1 - e.rmsRadialErr * 2.5, 0.7, 0.99) };
}

/**
 * Analyzes raw stroke points (tuples or objects) and returns a snapped shape if recognized.
 */
export function recognizeShape(rawPoints) {
  const valid = normalizePoints(rawPoints);
  if (valid.length < 2) return { shapeType: 'NONE', snappedPoints: rawPoints, confidence: 0 };

  const cleaned = deduplicateClosePoints(valid, DEDUP_MIN_STEP_PX);
  if (cleaned.length < 2) return { shapeType: 'NONE', snappedPoints: rawPoints, confidence: 0 };

  const totalLength = polylineLength(cleaned);
  const bounds = computeBounds(cleaned);
  const diag = Math.hypot(bounds.width, bounds.height);
  if (totalLength < MIN_STROKE_LENGTH_PX || diag < MIN_BBOX_DIAGONAL_PX) {
    return { shapeType: 'NONE', snappedPoints: rawPoints, confidence: 0 };
  }

  const avgPressure = clamp(valid.reduce((s, p) => s + p.pressure, 0) / valid.length, 0.05, 1);
  const startMs = valid[0].timestampMs;
  const endMs = Math.max(startMs, valid[valid.length - 1].timestampMs);

  return (
    tryRecognizeLine(cleaned, totalLength, avgPressure, startMs, endMs)
    ?? tryRecognizeArrow(cleaned, avgPressure, startMs, endMs)
    ?? tryRecognizeClosedShape(cleaned, totalLength, diag, avgPressure, startMs, endMs)
    ?? { shapeType: 'NONE', snappedPoints: rawPoints, confidence: 0 }
  );
}

/**
 * Detects a quick back-and-forth scribble-to-erase gesture (≥ 3 sharp reversals, compact bbox,
 * high path-length-to-diagonal ratio) without false-triggering on normal cursive letters.
 */
export function isScribbleToErase(rawPoints) {
  const valid = normalizePoints(rawPoints);
  if (valid.length < 10) return false;
  const cleaned = deduplicateClosePoints(valid, 4);
  if (cleaned.length < 6) return false;

  const bounds = computeBounds(cleaned);
  const diag = Math.hypot(bounds.width, bounds.height);
  if (diag < 28 || diag > 420) return false;

  const totalLen = polylineLength(cleaned);
  // A scribble covers significantly more distance than its bounding diagonal
  if (totalLen / diag < 2.8) return false;

  let sharpReversals = 0;
  let lastDir = null;
  for (let i = 1; i < cleaned.length; i++) {
    const dx = cleaned[i].x - cleaned[i - 1].x;
    const dy = cleaned[i].y - cleaned[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (len < 6) continue;
    const dir = [dx / len, dy / len];
    if (lastDir) {
      const dot = dir[0] * lastDir[0] + dir[1] * lastDir[1];
      if (dot < -0.55) { // > ~123° reversal
        sharpReversals++;
        lastDir = dir;
      }
    } else {
      lastDir = dir;
    }
  }
  return sharpReversals >= 3;
}
