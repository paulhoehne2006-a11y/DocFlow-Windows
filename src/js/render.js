// Canvas drawing of notebook pages (1654 × 2339 px A4 or Infinite 2D Canvas), ported from
// DocFlow Android (StudioCanvasPane / StudioPaperTemplateRenderer) with Dark Paper smart invert,
// PDF side margin notes, embedded images, sticky notes, checklists, study tapes and laser beams.

import { pointOf, DEFAULT_MARGIN_WIDTH } from './model.js';

const PENCIL_TILT_THRESHOLD = 0.42;
const CALLIGRAPHY_TILT_THRESHOLD = 0.15;
const DEFAULT_ITALIC_NIB = (40 * Math.PI) / 180;

const LIGHT_PAPER = {
  paper: '#FCFDFE',
  marginBg: '#F6F8FC',
  marginDivider: 'rgba(99, 102, 241, 0.28)',
  linePrimary: 'rgba(148,163,184,0.34)',
  lineMajor: 'rgba(100,116,139,0.42)',
  dot: 'rgba(100,116,139,0.45)',
  marginRule: 'rgba(220,38,38,0.34)',
  axis: 'rgba(51,65,85,0.78)',
  staff: 'rgba(71,85,105,0.46)',
};

const DARK_PAPER = {
  paper: '#161B26',
  marginBg: '#121620',
  marginDivider: 'rgba(129, 140, 248, 0.34)',
  linePrimary: 'rgba(148,163,184,0.16)',
  lineMajor: 'rgba(148,163,184,0.28)',
  dot: 'rgba(148,163,184,0.32)',
  marginRule: 'rgba(248,113,113,0.32)',
  axis: 'rgba(203,213,225,0.72)',
  staff: 'rgba(148,163,184,0.36)',
};

export function paperPalette(darkPaper = false) {
  return darkPaper ? DARK_PAPER : LIGHT_PAPER;
}

/** Smartly maps dark ink colors to crisp light ink on Dark Paper while preserving vivid hues. */
export function adaptArgbForDarkPaper(argb, darkPaper = false) {
  const v = Number(argb) >>> 0;
  if (!darkPaper) return v;
  const a = (v >>> 24) & 0xff;
  const r = (v >>> 16) & 0xff;
  const g = (v >>> 8) & 0xff;
  const b = v & 0xff;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // Low-saturation dark inks (black, charcoal, slate) invert cleanly to crisp off-white
  if (sat < 0.28 && lum < 0.42) {
    const nr = Math.min(245, 255 - r);
    const ng = Math.min(248, 255 - g);
    const nb = Math.min(252, 255 - b);
    return (((a << 24) | (nr << 16) | (ng << 8) | nb) >>> 0);
  }
  // Very dark saturated colors get lifted for readable contrast on dark slate paper
  if (lum < 0.26) {
    const lift = 90;
    return (((a << 24) | (Math.min(255, r + lift) << 16) | (Math.min(255, g + lift) << 8) | Math.min(255, b + lift)) >>> 0);
  }
  return v;
}

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
  const h = String(hex || '#0f172a').replace('#', '');
  return (0xff000000 + parseInt(h.slice(0, 6), 16)) >>> 0;
}

export function argbToHex(argb) {
  const v = Number(argb) >>> 0;
  return `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
}

function line(ctx, x1, y1, x2, y2, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawGrid(ctx, w, h, P) {
  const step = w * (5 / 210);
  ctx.lineCap = 'butt';
  for (let x = step, col = 1; x < w - 1; x += step, col++) {
    const major = col % 5 === 0;
    line(ctx, x, 0, x, h, major ? P.lineMajor : P.linePrimary, major ? 1.7 : 1.1);
  }
  for (let y = step, row = 1; y < h - 1; y += step, row++) {
    const major = row % 5 === 0;
    line(ctx, 0, y, w, y, major ? P.lineMajor : P.linePrimary, major ? 1.7 : 1.1);
  }
}

function drawLined(ctx, w, h, P) {
  const stepY = w * (8 / 210);
  for (let y = stepY * 2.2; y < h - stepY; y += stepY) line(ctx, 0, y, w, y, P.linePrimary, 1.4);
  line(ctx, w * 0.14, 0, w * 0.14, h, P.marginRule, 2);
}

function drawDotted(ctx, w, h, P) {
  const step = w * (5 / 210);
  const r = Math.min(3.2, Math.max(1.6, w * 0.0014));
  ctx.fillStyle = P.dot;
  for (let y = step; y < h - step * 0.5; y += step) {
    for (let x = step; x < w - step * 0.5; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCornell(ctx, w, h, P) {
  const headerY = h * 0.085;
  const summaryY = h * 0.84;
  const cueX = w * 0.28;
  const stepY = w * (8 / 210);
  for (let y = headerY + stepY; y < summaryY - stepY * 0.3; y += stepY) line(ctx, cueX + 12, y, w - 24, y, P.linePrimary, 1.3);
  for (let y = summaryY + stepY; y < h - stepY * 0.5; y += stepY) line(ctx, 24, y, w - 24, y, P.linePrimary, 1.3);
  line(ctx, 0, headerY, w, headerY, P.lineMajor, 2.4);
  line(ctx, cueX, headerY, cueX, summaryY, P.marginRule, 2.4);
  line(ctx, 0, summaryY, w, summaryY, P.lineMajor, 2.4);
}

function drawCoordinate(ctx, w, h, P) {
  drawGrid(ctx, w, h, P);
  const step = w * (5 / 210);
  const cx = w * 0.5;
  const cy = h * 0.5;
  ctx.lineCap = 'round';
  line(ctx, step, cy, w - step, cy, P.axis, 3);
  line(ctx, cx, h - step, cx, step, P.axis, 3);
  const len = step * 0.45;
  const spread = step * 0.24;
  ctx.beginPath();
  ctx.moveTo(w - step - len, cy - spread); ctx.lineTo(w - step, cy); ctx.lineTo(w - step - len, cy + spread);
  ctx.moveTo(cx - spread, step + len); ctx.lineTo(cx, step); ctx.lineTo(cx + spread, step + len);
  ctx.stroke();
  const tick = step * 2;
  const half = step * 0.16;
  ctx.lineCap = 'butt';
  for (let x = cx + tick; x < w - step * 1.5; x += tick) line(ctx, x, cy - half, x, cy + half, P.axis, 2);
  for (let x = cx - tick; x > step * 1.5; x -= tick) line(ctx, x, cy - half, x, cy + half, P.axis, 2);
  for (let y = cy + tick; y < h - step * 1.5; y += tick) line(ctx, cx - half, y, cx + half, y, P.axis, 2);
  for (let y = cy - tick; y > step * 1.5; y -= tick) line(ctx, cx - half, y, cx + half, y, P.axis, 2);
}

function drawMusic(ctx, w, h, P) {
  const pad = w * 0.06;
  const gap = w * 0.009;
  for (let top = h * 0.07; top + gap * 4 < h - h * 0.05; top += gap * 11.5) {
    for (let i = 0; i < 5; i++) line(ctx, pad, top + i * gap, w - pad, top + i * gap, P.staff, 1.6);
    line(ctx, pad, top, pad, top + gap * 4, P.staff, 2.2);
    line(ctx, w - pad, top, w - pad, top + gap * 4, P.staff, 2.2);
  }
}

/** Paper plus the page's ruling. Supports Light & Dark Paper. */
export function drawPaper(ctx, template, w, h, { withRuling = true, darkPaper = false } = {}) {
  const P = paperPalette(darkPaper);
  ctx.fillStyle = P.paper;
  ctx.fillRect(0, 0, w, h);
  if (!withRuling) return;
  ctx.save();
  switch (template) {
    case 'GRID_5MM': drawGrid(ctx, w, h, P); break;
    case 'LINED': drawLined(ctx, w, h, P); break;
    case 'DOTTED': drawDotted(ctx, w, h, P); break;
    case 'CORNELL': drawCornell(ctx, w, h, P); break;
    case 'COORDINATE': drawCoordinate(ctx, w, h, P); break;
    case 'MUSIC': drawMusic(ctx, w, h, P); break;
    default: break;
  }
  ctx.restore();
}

/** Collapsible annotation margin drawn to the right of a page (PDF or paper). */
export function drawMarginNotes(ctx, xStart, h, { width = DEFAULT_MARGIN_WIDTH, darkPaper = false, template = 'GRID_5MM' } = {}) {
  const P = paperPalette(darkPaper);
  ctx.save();
  ctx.fillStyle = P.marginBg;
  ctx.fillRect(xStart, 0, width, h);
  // Subtle accent separator between PDF worksheet and margin
  line(ctx, xStart, 0, xStart, h, P.marginDivider, 3);
  const step = 1654 * (5 / 210);
  if (template === 'LINED') {
    const stepY = 1654 * (8 / 210);
    for (let y = stepY * 2; y < h - stepY; y += stepY) line(ctx, xStart + 18, y, xStart + width - 18, y, P.linePrimary, 1.3);
  } else if (template === 'DOTTED') {
    ctx.fillStyle = P.dot;
    for (let y = step; y < h - step * 0.5; y += step) {
      for (let x = xStart + step; x < xStart + width - step * 0.5; x += step) {
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else {
    for (let x = xStart + step, col = 1; x < xStart + width - 4; x += step, col++) {
      const major = col % 5 === 0;
      line(ctx, x, 0, x, h, major ? P.lineMajor : P.linePrimary, major ? 1.5 : 1);
    }
    for (let y = step, row = 1; y < h - 4; y += step, row++) {
      const major = row % 5 === 0;
      line(ctx, xStart, y, xStart + width, y, major ? P.lineMajor : P.linePrimary, major ? 1.5 : 1);
    }
  }
  ctx.restore();
}

/** Infinite 2D canvas background tiled seamlessly across any viewport bounds. */
export function drawInfinitePaper(ctx, template, left, top, right, bottom, { darkPaper = false } = {}) {
  const P = paperPalette(darkPaper);
  ctx.save();
  ctx.fillStyle = P.paper;
  ctx.fillRect(left, top, right - left, bottom - top);
  const step = 40;
  if (template === 'GRID_5MM' || template === 'COORDINATE') {
    const startX = Math.floor(left / step) * step;
    const startY = Math.floor(top / step) * step;
    for (let x = startX; x <= right; x += step) {
      const major = Math.round(x / step) % 5 === 0;
      line(ctx, x, top, x, bottom, major ? P.lineMajor : P.linePrimary, major ? 1.6 : 1);
    }
    for (let y = startY; y <= bottom; y += step) {
      const major = Math.round(y / step) % 5 === 0;
      line(ctx, left, y, right, y, major ? P.lineMajor : P.linePrimary, major ? 1.6 : 1);
    }
    if (template === 'COORDINATE') {
      line(ctx, left, 0, right, 0, P.axis, 2.8);
      line(ctx, 0, top, 0, bottom, P.axis, 2.8);
    }
  } else if (template === 'LINED' || template === 'CORNELL') {
    const stepY = 64;
    const startY = Math.floor(top / stepY) * stepY;
    for (let y = startY; y <= bottom; y += stepY) line(ctx, left, y, right, y, P.linePrimary, 1.4);
  } else if (template === 'DOTTED') {
    const startX = Math.floor(left / step) * step;
    const startY = Math.floor(top / step) * step;
    ctx.fillStyle = P.dot;
    for (let y = startY; y <= bottom; y += step) {
      for (let x = startX; x <= right; x += step) {
        ctx.beginPath();
        ctx.arc(x, y, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (template === 'MUSIC') {
    const gap = 15;
    const period = gap * 11.5;
    const startY = Math.floor((top - gap * 4) / period) * period;
    for (let y = startY; y <= bottom; y += period) {
      for (let i = 0; i < 5; i++) {
        const ly = y + i * gap;
        if (ly >= top - 2 && ly <= bottom + 2) {
          line(ctx, left, ly, right, ly, P.staff, 1.6);
        }
      }
    }
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

/** Draws one stroke matching Android's dry-ink renderer, with Dark Paper & layer opacity support. */
export function drawStroke(ctx, stroke, { selected = false, darkPaper = false, opacity = 1, audioActive = false } = {}) {
  const pts = (stroke.points || []).map(pointOf);
  if (pts.length === 0) return;
  const alpha = clamp((stroke.alpha ?? 1) * opacity, 0, 1);
  const kind = stroke.brushKind || 'FINELINER';
  const width = stroke.strokeWidth || 3;
  const rawArgb = stroke.colorArgb ?? 0xff000000;
  const argb = kind === 'HIGHLIGHTER' ? rawArgb : adaptArgbForDarkPaper(rawArgb, darkPaper);
  const factor = kind === 'HIGHLIGHTER' ? 0.34 * alpha : kind === 'PENCIL' ? 0.72 * alpha : alpha;
  const color = argbToCss(argb, factor);

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

  if (selected || audioActive) {
    smoothPath(ctx, pts);
    ctx.strokeStyle = audioActive ? 'rgba(129, 140, 248, 0.42)' : 'rgba(99, 102, 241, 0.28)';
    ctx.lineWidth = width + 10;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  switch (kind) {
    case 'PENCIL': {
      smoothPath(ctx, pts);
      ctx.strokeStyle = argbToCss(argb, 0.72 * alpha * 0.28);
      ctx.lineWidth = Math.max(1.5, width * 1.32);
      ctx.lineCap = 'round';
      ctx.setLineDash([3.5, 2.5]);
      ctx.stroke();
      ctx.setLineDash([]);
      const baseAlpha = (((Number(argb) >>> 24) & 0xff) / 255) * 0.72 * alpha;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const p = clamp((a.pressure + b.pressure) / 2, 0.15, 1);
        const [sw, sa] = pencilWidthAlpha(width, p, (a.tiltX + b.tiltX) / 2, (a.tiltY + b.tiltY) / 2, baseAlpha);
        ctx.strokeStyle = argbToCss((Number(argb) & 0xffffff) | 0xff000000, clamp(sa, 0, 1));
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

/** Glowing laser pointer beam that fades smoothly over time. */
export function drawLaserBeam(ctx, beam, now = performance.now()) {
  const age = now - beam.createdAtMs;
  const life = 1100;
  if (age >= life || !beam.points?.length) return false;
  const t = 1 - age / life;
  const pts = beam.points;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (pts.length > 1) {
    smoothPath(ctx, pts);
    ctx.strokeStyle = `rgba(239, 68, 68, ${(0.28 * t).toFixed(3)})`;
    ctx.lineWidth = 22;
    ctx.stroke();
    ctx.strokeStyle = `rgba(248, 113, 113, ${(0.62 * t).toFixed(3)})`;
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255, 255, 255, ${(0.95 * t).toFixed(3)})`;
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  const head = pts[pts.length - 1];
  ctx.fillStyle = `rgba(239, 68, 68, ${(0.9 * t).toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(head.x, head.y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(255, 255, 255, ${t.toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(head.x, head.y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  return true;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
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

export function drawTextBox(ctx, box, { darkPaper = false, opacity = 1, selected = false } = {}) {
  const w = Math.max(60, box.width ?? 420);
  const h = Math.max(36, box.height ?? 140);
  const hasBg = Number(box.backgroundColorArgb ?? 0) !== 0;
  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  if (hasBg) {
    ctx.shadowColor = 'rgba(15, 23, 42, 0.14)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = argbToCss(box.backgroundColorArgb);
    roundRect(ctx, box.left, box.top, w, h, 18);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.08)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  const text = box.isChecklist ? `${box.isChecked ? '☑' : '☐'} ${box.text ?? ''}` : (box.text ?? '');
  if (text) {
    const size = clamp((box.fontSizeSp ?? 16) * 2, 16, 96);
    ctx.font = `${box.isItalic ? 'italic ' : ''}${box.isBold ? '700 ' : '400 '}${size}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
    const rawColor = box.textColorArgb ?? 0xff0f172a;
    ctx.fillStyle = argbToCss(hasBg ? rawColor : adaptArgbForDarkPaper(rawColor, darkPaper));
    ctx.textBaseline = 'top';
    const pad = hasBg ? 18 : 6;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.left, box.top, w, h);
    ctx.clip();
    let y = box.top + pad;
    for (const l of wrapLines(ctx, text, Math.max(24, w - pad * 2))) {
      ctx.fillText(l, box.left + pad, y);
      y += size * 1.28;
    }
    ctx.restore();
  }
  if (selected) {
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    roundRect(ctx, box.left - 3, box.top - 3, w + 6, h + 6, 12);
    ctx.stroke();
    ctx.setLineDash([]);
    // Bottom-right resize handle
    ctx.fillStyle = '#6366f1';
    ctx.beginPath();
    ctx.arc(box.left + w, box.top + h, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawImageItem(ctx, imgItem, bitmap, { opacity = 1, selected = false } = {}) {
  const left = Math.min(imgItem.left, imgItem.right);
  const top = Math.min(imgItem.top, imgItem.bottom);
  const w = Math.max(20, Math.abs(imgItem.right - imgItem.left));
  const h = Math.max(20, Math.abs(imgItem.bottom - imgItem.top));
  const cx = left + w / 2;
  const cy = top + h / 2;
  const rad = ((imgItem.rotationDegrees || 0) * Math.PI) / 180;

  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  ctx.translate(cx, cy);
  ctx.rotate(rad);
  if (bitmap) {
    ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  } else {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
    ctx.lineWidth = 2;
    roundRect(ctx, -w / 2, -h / 2, w, h, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.font = '600 22px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('IMG', 0, 0);
  }
  if (selected) {
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4);
    ctx.setLineDash([]);
    // Resize handle (bottom-right) & rotate handle (top-center)
    ctx.fillStyle = '#6366f1';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -h / 2);
    ctx.lineTo(0, -h / 2 - 32);
    ctx.stroke();
    ctx.fillStyle = '#a78bfa';
    ctx.beginPath();
    ctx.arc(0, -h / 2 - 34, 10, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawTape(ctx, tape, { studyMode = false, opacity = 1 } = {}) {
  const left = Math.min(tape.left, tape.right);
  const top = Math.min(tape.top, tape.bottom);
  const w = Math.max(12, Math.abs(tape.right - tape.left));
  const h = Math.max(12, Math.abs(tape.bottom - tape.top));
  const revealed = studyMode && !!tape.isRevealed;

  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  if (revealed) {
    ctx.fillStyle = argbToCss(tape.colorArgb ?? 0xff1d4ed8, 0.12);
    roundRect(ctx, left, top, w, h, 10);
    ctx.fill();
    ctx.strokeStyle = argbToCss(tape.colorArgb ?? 0xff1d4ed8, 0.58);
    ctx.lineWidth = 2.4;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = argbToCss(tape.colorArgb ?? 0xff1d4ed8, 0.96);
    roundRect(ctx, left, top, w, h, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Subtle study-tape diagonal sheen stripes
    const inset = Math.min(4, w / 4, h / 4);
    const innerLeft = left + inset;
    const innerRight = left + w - inset;
    const innerTop = top + inset;
    const innerBottom = top + h - inset;
    const innerH = innerBottom - innerTop;
    if (innerRight > innerLeft && innerH > 0) {
      ctx.save();
      roundRect(ctx, left, top, w, h, 10);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 6;
      ctx.lineCap = 'butt';
      for (let x = innerLeft - innerH; x < innerRight; x += 28) {
        const t0 = Math.max(0, (innerLeft - x) / innerH);
        const t1 = Math.min(1, (innerRight - x) / innerH);
        if (t1 <= t0) continue;
        const x0 = x + t0 * innerH;
        const y0 = innerBottom - t0 * innerH;
        const x1 = x + t1 * innerH;
        const y1 = innerBottom - t1 * innerH;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * All visible content of a page in Android's order: images, highlighters under ink, then ink,
 * text boxes and occlusion tapes on top.
 */
export function drawPageContent(ctx, payload, isVisible, {
  selectedIds = null,
  selectedBoxId = null,
  selectedImageId = null,
  darkPaper = false,
  studyMode = false,
  layerOpacity = () => 1,
  getImageBitmap = () => null,
  activeAudioOffsetMs = null,
} = {}) {
  for (const img of (payload.images || []).filter(isVisible)) {
    drawImageItem(ctx, img, getImageBitmap(img.imagePath), {
      opacity: layerOpacity(img),
      selected: img.id === selectedImageId,
    });
  }
  const strokes = (payload.strokes || []).filter(isVisible);
  const isAudioActive = (s) => activeAudioOffsetMs != null && s.audioOffsetMs != null
    && Math.abs(s.audioOffsetMs - activeAudioOffsetMs) < 1200;
  for (const s of strokes) {
    if (s.brushKind === 'HIGHLIGHTER') {
      drawStroke(ctx, s, {
        selected: selectedIds?.has(s.id),
        darkPaper,
        opacity: layerOpacity(s),
        audioActive: isAudioActive(s),
      });
    }
  }
  for (const s of strokes) {
    if (s.brushKind !== 'HIGHLIGHTER') {
      drawStroke(ctx, s, {
        selected: selectedIds?.has(s.id),
        darkPaper,
        opacity: layerOpacity(s),
        audioActive: isAudioActive(s),
      });
    }
  }
  for (const box of (payload.textBoxes || []).filter(isVisible)) {
    drawTextBox(ctx, box, { darkPaper, opacity: layerOpacity(box), selected: box.id === selectedBoxId });
  }
  for (const tape of (payload.tapes || []).filter(isVisible)) {
    drawTape(ctx, tape, { studyMode, opacity: layerOpacity(tape) });
  }
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

/**
 * Area / precision segment eraser: splits a stroke around points inside the eraser circle,
 * returning 0, 1 or multiple remaining stroke fragments.
 */
export function eraseStrokeSegments(stroke, x, y, radius) {
  if (!strokeHit(stroke, x, y, radius)) return [stroke];
  const rawPts = stroke.points || [];
  const reach = radius + (stroke.strokeWidth || 3) / 2;
  const chunks = [];
  let cur = [];
  for (const raw of rawPts) {
    const p = pointOf(raw);
    if (Math.hypot(p.x - x, p.y - y) <= reach) {
      if (cur.length >= 2) chunks.push(cur);
      cur = [];
    } else {
      cur.push(raw);
    }
  }
  if (cur.length >= 2) chunks.push(cur);
  if (chunks.length === 0) return [];
  if (chunks.length === 1 && chunks[0].length === rawPts.length) return [stroke];
  return chunks.map((pts, idx) => ({
    ...stroke,
    id: idx === 0 ? stroke.id : `${stroke.id}_seg_${Date.now()}_${idx}`,
    points: pts,
  }));
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

export function hitTestTape(tapes, x, y) {
  for (let i = tapes.length - 1; i >= 0; i--) {
    const tp = tapes[i];
    const left = Math.min(tp.left, tp.right);
    const right = Math.max(tp.left, tp.right);
    const top = Math.min(tp.top, tp.bottom);
    const bottom = Math.max(tp.top, tp.bottom);
    if (x >= left && x <= right && y >= top && y <= bottom) return tp;
  }
  return null;
}

export function hitTestTextBox(boxes, x, y) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    const w = Math.max(60, b.width ?? 420);
    const h = Math.max(36, b.height ?? 140);
    if (Math.hypot(x - (b.left + w), y - (b.top + h)) <= 22) return { item: b, handle: 'resize' };
    if (b.isChecklist) {
      const hasBg = Number(b.backgroundColorArgb ?? 0) !== 0;
      const pad = hasBg ? 18 : 6;
      const size = clamp((b.fontSizeSp ?? 16) * 2, 16, 96);
      const cbRight = Math.min(b.left + w, b.left + pad + Math.max(28, size * 1.15) + 8);
      const cbBottom = Math.min(b.top + h, b.top + pad + Math.max(28, size * 1.28) + 6);
      if (x >= b.left && x <= cbRight && y >= b.top && y <= cbBottom) {
        return { item: b, handle: 'checkbox' };
      }
    }
    if (x >= b.left && x <= b.left + w && y >= b.top && y <= b.top + h) return { item: b, handle: 'body' };
  }
  return null;
}

export function hitTestImage(images, x, y) {
  for (let i = images.length - 1; i >= 0; i--) {
    const img = images[i];
    const left = Math.min(img.left, img.right);
    const top = Math.min(img.top, img.bottom);
    const w = Math.max(20, Math.abs(img.right - img.left));
    const h = Math.max(20, Math.abs(img.bottom - img.top));
    const cx = left + w / 2;
    const cy = top + h / 2;
    const rad = -((img.rotationDegrees || 0) * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
    if (Math.hypot(lx - w / 2, ly - h / 2) <= 22) return { item: img, handle: 'resize' };
    if (Math.hypot(lx, ly - (-h / 2 - 34)) <= 22) return { item: img, handle: 'rotate' };
    if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return { item: img, handle: 'body' };
  }
  return null;
}
