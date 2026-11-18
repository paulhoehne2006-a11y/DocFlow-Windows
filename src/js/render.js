// Canvas drawing of notebook pages in page coordinates (1654 × 2339 px for A4), ported from the
// Android renderer (StudioCanvasPane / StudioPaperTemplateRenderer) so both look the same.

import { pointOf } from './model.js';

const PENCIL_TILT_THRESHOLD = 0.42;
const CALLIGRAPHY_TILT_THRESHOLD = 0.15;
const DEFAULT_ITALIC_NIB = (40 * Math.PI) / 180;

const PAPER = {
  paper: '#FCFDFE',
  linePrimary: 'rgba(148,163,184,0.34)',
  lineMajor: 'rgba(100,116,139,0.42)',
  dot: 'rgba(100,116,139,0.45)',
  marginRule: 'rgba(220,38,38,0.34)',
  axis: 'rgba(51,65,85,0.78)',
  staff: 'rgba(71,85,105,0.46)',
};

/** ARGB long (as stored by Android) → CSS rgba() with an extra alpha factor. */
export function argbToCss(argb, alphaFactor = 1) {
  const v = Number(argb) >>> 0;
  const a = ((v >>> 24) & 0xff) / 255;
  const r = (v >>> 16) & 0xff;
  const g = (v >>> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${+(a * alphaFactor).toFixed(4)})`;
}

export function cssHexToArgb(hex) {
  const h = hex.replace('#', '');
  return (0xff000000 + parseInt(h.slice(0, 6), 16)) >>> 0;
}

function line(ctx, x1, y1, x2, y2, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawGrid(ctx, w, h) {
  const step = w * (5 / 210);
  ctx.lineCap = 'butt';
  for (let x = step, col = 1; x < w - 1; x += step, col++) {
    const major = col % 5 === 0;
    line(ctx, x, 0, x, h, major ? PAPER.lineMajor : PAPER.linePrimary, major ? 1.7 : 1.1);
  }
  for (let y = step, row = 1; y < h - 1; y += step, row++) {
    const major = row % 5 === 0;
    line(ctx, 0, y, w, y, major ? PAPER.lineMajor : PAPER.linePrimary, major ? 1.7 : 1.1);
  }
}

function drawLined(ctx, w, h) {
  const stepY = w * (8 / 210);
  for (let y = stepY * 2.2; y < h - stepY; y += stepY) line(ctx, 0, y, w, y, PAPER.linePrimary, 1.4);
  line(ctx, w * 0.14, 0, w * 0.14, h, PAPER.marginRule, 2);
}

function drawDotted(ctx, w, h) {
  const step = w * (5 / 210);
  const r = Math.min(3.2, Math.max(1.6, w * 0.0014));
  ctx.fillStyle = PAPER.dot;
  for (let y = step; y < h - step * 0.5; y += step) {
    for (let x = step; x < w - step * 0.5; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCornell(ctx, w, h) {
  const headerY = h * 0.085;
  const summaryY = h * 0.84;
  const cueX = w * 0.28;
  const stepY = w * (8 / 210);
  const faint = 'rgba(148,163,184,0.28)';
  for (let y = headerY + stepY; y < summaryY - stepY * 0.3; y += stepY) line(ctx, cueX + 12, y, w - 24, y, faint, 1.3);
  for (let y = summaryY + stepY; y < h - stepY * 0.5; y += stepY) line(ctx, 24, y, w - 24, y, faint, 1.3);
  line(ctx, 0, headerY, w, headerY, PAPER.lineMajor, 2.4);
  line(ctx, cueX, headerY, cueX, summaryY, PAPER.marginRule, 2.4);
  line(ctx, 0, summaryY, w, summaryY, PAPER.lineMajor, 2.4);
}

function drawCoordinate(ctx, w, h) {
  drawGrid(ctx, w, h);
  const step = w * (5 / 210);
  const cx = w * 0.5;
  const cy = h * 0.5;
  ctx.lineCap = 'round';
  line(ctx, step, cy, w - step, cy, PAPER.axis, 3);
  line(ctx, cx, h - step, cx, step, PAPER.axis, 3);
  const len = step * 0.45;
  const spread = step * 0.24;
  ctx.beginPath();
  ctx.moveTo(w - step - len, cy - spread); ctx.lineTo(w - step, cy); ctx.lineTo(w - step - len, cy + spread);
  ctx.moveTo(cx - spread, step + len); ctx.lineTo(cx, step); ctx.lineTo(cx + spread, step + len);
  ctx.stroke();
  const tick = step * 2;
  const half = step * 0.16;
  ctx.lineCap = 'butt';
  for (let x = cx + tick; x < w - step * 1.5; x += tick) line(ctx, x, cy - half, x, cy + half, PAPER.axis, 2);
  for (let x = cx - tick; x > step * 1.5; x -= tick) line(ctx, x, cy - half, x, cy + half, PAPER.axis, 2);
  for (let y = cy + tick; y < h - step * 1.5; y += tick) line(ctx, cx - half, y, cx + half, y, PAPER.axis, 2);
  for (let y = cy - tick; y > step * 1.5; y -= tick) line(ctx, cx - half, y, cx + half, y, PAPER.axis, 2);
}

function drawMusic(ctx, w, h) {
  const pad = w * 0.06;
  const gap = w * 0.009;
  for (let top = h * 0.07; top + gap * 4 < h - h * 0.05; top += gap * 11.5) {
    for (let i = 0; i < 5; i++) line(ctx, pad, top + i * gap, w - pad, top + i * gap, PAPER.staff, 1.6);
    line(ctx, pad, top, pad, top + gap * 4, PAPER.staff, 2.2);
    line(ctx, w - pad, top, w - pad, top + gap * 4, PAPER.staff, 2.2);
  }
}

/** White paper plus the page's ruling. Skipped under PDF backgrounds. */
export function drawPaper(ctx, template, w, h, { withRuling = true } = {}) {
  ctx.fillStyle = PAPER.paper;
  ctx.fillRect(0, 0, w, h);
  if (!withRuling) return;
  ctx.save();
  switch (template) {
    case 'GRID_5MM': drawGrid(ctx, w, h); break;
    case 'LINED': drawLined(ctx, w, h); break;
    case 'DOTTED': drawDotted(ctx, w, h); break;
    case 'CORNELL': drawCornell(ctx, w, h); break;
    case 'COORDINATE': drawCoordinate(ctx, w, h); break;
    case 'MUSIC': drawMusic(ctx, w, h); break;
    default: break;
  }
  ctx.restore();
}

function smoothPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i];
    const n = pts[i + 1];
    ctx.quadraticCurveTo(c.x, c.y, (c.x + n.x) / 2, (c.y + n.y) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const tiltMag = (tx, ty) => clamp(Math.hypot(tx || 0, ty || 0), 0, 1);

export function pencilWidthAlpha(baseWidth, pressure, tiltX, tiltY, baseAlpha) {
  const upright = baseWidth * (0.75 + 0.5 * clamp(pressure, 0, 1));
  const mag = tiltMag(tiltX, tiltY);
  if (mag <= PENCIL_TILT_THRESHOLD) return [upright, baseAlpha];
  const f = clamp((mag - PENCIL_TILT_THRESHOLD) / (1 - PENCIL_TILT_THRESHOLD), 0, 1);
  const minAlpha = Math.min(0.36, baseAlpha);
  return [upright + (baseWidth * 2.5 - upright) * f, baseAlpha - (baseAlpha - minAlpha) * f];
}

export function calligraphyMultiplier(dx, dy, tiltX, tiltY) {
  if (Math.hypot(dx, dy) < 1e-4) return 1;
  const nib = tiltMag(tiltX, tiltY) > CALLIGRAPHY_TILT_THRESHOLD ? Math.atan2(tiltY, tiltX) : DEFAULT_ITALIC_NIB;
  const cross = clamp(Math.abs(Math.sin(Math.atan2(dy, dx) - nib)), 0, 1);
  return 0.28 + (1.65 - 0.28) * cross;
}

/** Width of the segment a→b for pressure-sensitive brushes, or null for constant-width ones. */
export function segmentWidth(stroke, a, b) {
  const w = stroke.strokeWidth || 3;
  switch (stroke.brushKind) {
    case 'FOUNTAIN_PEN':
    case 'BRUSH_PEN': {
      const brush = stroke.brushKind === 'BRUSH_PEN';
      const lo = brush ? 0.35 : 0.55;
      const hi = brush ? 1.55 : 1.25;
      const p = clamp((a.pressure + b.pressure) / 2, 0.1, 1);
      return w * (lo + (hi - lo) * p);
    }
    case 'CALLIGRAPHY_PEN': {
      const p = clamp((a.pressure + b.pressure) / 2, 0.15, 1);
      const mult = calligraphyMultiplier(b.x - a.x, b.y - a.y, (a.tiltX + b.tiltX) / 2, (a.tiltY + b.tiltY) / 2);
      return Math.max(1, w * mult * (0.75 + 0.5 * p));
    }
    default:
      return null;
  }
}

/** Draws one stroke exactly like the Android "dry ink" renderer. */
export function drawStroke(ctx, stroke, { selected = false } = {}) {
  const pts = (stroke.points || []).map(pointOf);
  if (pts.length === 0) return;
  const alpha = clamp(stroke.alpha ?? 1, 0, 1);
  const kind = stroke.brushKind || 'FINELINER';
  const width = stroke.strokeWidth || 3;
  const factor = kind === 'HIGHLIGHTER' ? 0.34 * alpha : kind === 'PENCIL' ? 0.72 * alpha : alpha;
  const color = argbToCss(stroke.colorArgb ?? 0xff000000, factor);

  ctx.save();
  ctx.lineJoin = 'round';
  if (pts.length === 1) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, Math.max(1, width / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (selected) {
    smoothPath(ctx, pts);
    ctx.strokeStyle = 'rgba(59,130,246,0.28)';
    ctx.lineWidth = width + 8;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  switch (kind) {
    case 'PENCIL': {
      smoothPath(ctx, pts);
      ctx.strokeStyle = argbToCss(stroke.colorArgb, 0.72 * alpha * 0.28);
      ctx.lineWidth = Math.max(1.5, width * 1.32);
      ctx.lineCap = 'round';
      ctx.setLineDash([3.5, 2.5]);
      ctx.stroke();
      ctx.setLineDash([]);
      const baseAlpha = (((Number(stroke.colorArgb) >>> 24) & 0xff) / 255) * 0.72 * alpha;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const p = clamp((a.pressure + b.pressure) / 2, 0.15, 1);
        const [sw, sa] = pencilWidthAlpha(width, p, (a.tiltX + b.tiltX) / 2, (a.tiltY + b.tiltY) / 2, baseAlpha);
        ctx.strokeStyle = argbToCss((Number(stroke.colorArgb) & 0xffffff) | 0xff000000, clamp(sa, 0, 1));
        ctx.lineWidth = Math.max(1, sw);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      break;
    }
    case 'CALLIGRAPHY_PEN':
    case 'FOUNTAIN_PEN':
    case 'BRUSH_PEN': {
      ctx.strokeStyle = color;
      ctx.lineCap = kind === 'CALLIGRAPHY_PEN' ? 'square' : 'round';
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        ctx.lineWidth = segmentWidth(stroke, a, b);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      break;
    }
    default: {
      smoothPath(ctx, pts);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = kind === 'HIGHLIGHTER' ? 'square' : 'round';
      ctx.stroke();
    }
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) { out.push(''); continue; }
    let current = '';
    for (const word of paragraph.split(/(\s+)/)) {
      const next = current + word;
      if (ctx.measureText(next).width > maxWidth && current.trim()) {
        out.push(current.trimEnd());
        current = word.trimStart();
      } else {
        current = next;
      }
    }
    out.push(current);
  }
  return out;
}

export function drawTextBox(ctx, box) {
  const w = Math.max(40, box.width ?? 420);
  const h = Math.max(24, box.height ?? 140);
  const hasBg = Number(box.backgroundColorArgb ?? 0) !== 0;
  ctx.save();
  if (hasBg) {
    ctx.fillStyle = argbToCss(box.backgroundColorArgb);
    roundRect(ctx, box.left, box.top, w, h, 16);
    ctx.fill();
  }
  const text = box.isChecklist ? `${box.isChecked ? '[✓]' : '[ ]'} ${box.text ?? ''}` : (box.text ?? '');
  if (text) {
    const size = clamp((box.fontSizeSp ?? 16) * 2, 14, 96);
    ctx.font = `${box.isItalic ? 'italic ' : ''}${box.isBold ? '700 ' : '400 '}${size}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = argbToCss(box.textColorArgb ?? 0xff0f172a);
    ctx.textBaseline = 'top';
    const pad = hasBg ? 16 : 4;
    ctx.beginPath();
    ctx.rect(box.left, box.top, w, h);
    ctx.clip();
    let y = box.top + pad;
    for (const l of wrapLines(ctx, text, Math.max(24, w - pad * 2))) {
      ctx.fillText(l, box.left + pad, y);
      y += size * 1.25;
    }
  }
  ctx.restore();
}

export function drawTape(ctx, tape) {
  const left = Math.min(tape.left, tape.right);
  const top = Math.min(tape.top, tape.bottom);
  const w = Math.abs(tape.right - tape.left);
  const h = Math.abs(tape.bottom - tape.top);
  ctx.save();
  ctx.fillStyle = argbToCss(tape.colorArgb ?? 0xff3a3a3c, 0.96);
  roundRect(ctx, left, top, w, h, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/**
 * All visible content of a page in Android's order: highlighters under ink, then text boxes and
 * occlusion tapes on top. [isVisible] filters by layer.
 */
export function drawPageContent(ctx, payload, isVisible, { selectedIds = null } = {}) {
  const strokes = payload.strokes.filter(isVisible);
  for (const s of strokes) if (s.brushKind === 'HIGHLIGHTER') drawStroke(ctx, s, { selected: selectedIds?.has(s.id) });
  for (const s of strokes) if (s.brushKind !== 'HIGHLIGHTER') drawStroke(ctx, s, { selected: selectedIds?.has(s.id) });
  for (const t of payload.textBoxes.filter(isVisible)) drawTextBox(ctx, t);
  for (const t of payload.tapes.filter(isVisible)) drawTape(ctx, t);
}

/** Bounding box of a stroke including its width, in page coordinates. */
export function strokeBounds(stroke) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const raw of stroke.points || []) {
    const p = pointOf(raw);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = (stroke.strokeWidth || 3) * 1.7 + 2;
  return { left: minX - pad, top: minY - pad, right: maxX + pad, bottom: maxY + pad };
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - a.x) * dx + (py - a.y) * dy) / len2, 0, 1);
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Whether a circle of [radius] around (x, y) touches [stroke]. */
export function strokeHit(stroke, x, y, radius) {
  const b = strokeBounds(stroke);
  if (x < b.left - radius || x > b.right + radius || y < b.top - radius || y > b.bottom + radius) return false;
  const pts = (stroke.points || []).map(pointOf);
  const reach = radius + (stroke.strokeWidth || 3) / 2;
  if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(x, y, pts[i - 1], pts[i]) <= reach) return true;
  }
  return false;
}

/** Ray-casting point-in-polygon for the lasso. */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A stroke is lassoed when most of its points lie inside the polygon. */
export function strokeInLasso(stroke, poly) {
  const pts = (stroke.points || []).map(pointOf);
  if (pts.length === 0) return false;
  const inside = pts.filter((p) => pointInPolygon(p.x, p.y, poly)).length;
  return inside / pts.length >= 0.6;
}
