// Virtual Geodreieck / Straightedge math & translucent Canvas overlay renderer.
// Pure math functions are a 1:1 port of Android's GeodreieckMath.kt.

export const DEFAULT_PIXELS_PER_CM = 60;
const COMMON_ANGLES_DEG = [
  -150, -135, -120, -90, -60, -45, -30, 0,
  30, 45, 60, 90, 120, 135, 150, 180,
];

export function createDefaultRuler(centerX = 827, centerY = 720) {
  return {
    enabled: false,
    centerX,
    centerY,
    angleDegrees: 0,
    snapTolerancePx: 26,
    lengthCm: 14,
  };
}

/** Normalizes an angle in degrees into (-180, 180], avoiding -0. */
export function normalizeAngleDegrees(angleDegrees) {
  if (!Number.isFinite(angleDegrees)) return 0;
  let norm = ((angleDegrees % 360) + 360) % 360;
  if (norm > 180) norm -= 360;
  if (norm <= -180) norm = 180;
  return norm === 0 ? 0 : norm;
}

/** Snaps angleDegrees to standard Geodreieck increments (0°, ±30°, ±45°, ±60°, ±90°, etc.). */
export function snapAngleToCommonIncrements(angleDegrees, snapThresholdDeg = 3) {
  const norm = normalizeAngleDegrees(angleDegrees);
  if (snapThresholdDeg <= 0) return norm;
  for (const target of COMMON_ANGLES_DEG) {
    const delta = Math.abs(normalizeAngleDegrees(norm - target));
    if (delta <= snapThresholdDeg) return target;
  }
  return norm;
}

/** Projects (x, y) orthogonally onto the straightedge defined by ruler. */
export function projectPointOntoRuler(x, y, ruler) {
  const rad = (ruler.angleDegrees * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const dx = x - ruler.centerX;
  const dy = y - ruler.centerY;
  const along = dx * ux + dy * uy;
  const perpDist = Math.abs(dx * -uy + dy * ux);
  const projX = ruler.centerX + along * ux;
  const projY = ruler.centerY + along * uy;
  const tol = Math.max(0, ruler.snapTolerancePx ?? 24);
  return {
    x: projX,
    y: projY,
    isSnapped: perpDist <= tol,
    perpendicularDistancePx: perpDist,
    offsetAlongRulerPx: along,
  };
}

/** Snaps (x, y) onto ruler when enabled and within snapTolerancePx. */
export function snapPointIfEnabled(x, y, ruler) {
  const projection = projectPointOntoRuler(x, y, ruler);
  if (ruler?.enabled && projection.isSnapped) return projection;
  return { ...projection, x, y, isSnapped: false };
}

/** Generates mm/cm tick marks along the Geodreieck hypotenuse. */
export function generateScaleTicks(lengthCm = 14, pixelsPerCm = DEFAULT_PIXELS_PER_CM, centered = true) {
  if (lengthCm <= 0 || pixelsPerCm <= 0 || !Number.isFinite(pixelsPerCm)) return [];
  const pxPerMm = pixelsPerCm / 10;
  const halfMm = Math.floor((lengthCm * 10) / 2);
  const minMm = centered ? -halfMm : 0;
  const maxMm = centered ? halfMm : lengthCm * 10;
  const ticks = [];
  for (let mm = minMm; mm <= maxMm; mm++) {
    const isMajorCm = mm % 10 === 0;
    const isHalfCm = !isMajorCm && Math.abs(mm % 10) === 5;
    ticks.push({
      distanceMm: mm,
      offsetPx: mm * pxPerMm,
      isMajorCm,
      isHalfCm,
      label: isMajorCm ? String(Math.abs(mm / 10)) : null,
    });
  }
  return ticks;
}

export function formatDisplayAngle(angleDegrees) {
  const rounded = Math.round(normalizeAngleDegrees(angleDegrees));
  const clean = rounded === -180 ? 180 : rounded === 0 ? 0 : rounded;
  return `${clean}°`;
}

/**
 * Hit-tests a document point (x, y) against the Geodreieck body & rotation handles.
 * Returns 'rotate-left' | 'rotate-right' | 'body' | null.
 */
export function hitTestGeodreieck(x, y, ruler, zoom = 1) {
  if (!ruler?.enabled) return null;
  const halfW = ((ruler.lengthCm ?? 14) * DEFAULT_PIXELS_PER_CM) / 2;
  const height = halfW; // Classic 45°-90°-45° Geodreieck right isosceles triangle
  const rad = (ruler.angleDegrees * Math.PI) / 180;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const dx = x - ruler.centerX;
  const dy = y - ruler.centerY;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;

  const handleR = Math.max(24, 22 / zoom);
  // Rotate handles near the left/right corners just below the hypotenuse
  if (Math.hypot(lx - (halfW - 44), ly - 44) <= handleR) return 'rotate-right';
  if (Math.hypot(lx - (-halfW + 44), ly - 44) <= handleR) return 'rotate-left';

  // Inside triangle: ly in [0, height] and |lx| <= halfW - ly
  if (ly >= 0 && ly <= height && Math.abs(lx) <= halfW - ly) return 'body';
  return null;
}

/**
 * Renders the interactive translucent Geodreieck in document coordinates.
 */
export function drawGeodreieckOverlay(ctx, ruler, { isDark = true, zoom = 1, active = false } = {}) {
  if (!ruler?.enabled) return;
  const lengthCm = ruler.lengthCm ?? 14;
  const halfW = (lengthCm * DEFAULT_PIXELS_PER_CM) / 2;
  const height = halfW;
  const rad = (ruler.angleDegrees * Math.PI) / 180;

  ctx.save();
  ctx.translate(ruler.centerX, ruler.centerY);
  ctx.rotate(rad);

  // Translucent glass triangle body
  ctx.beginPath();
  ctx.moveTo(-halfW, 0);
  ctx.lineTo(halfW, 0);
  ctx.lineTo(0, height);
  ctx.closePath();

  ctx.fillStyle = isDark ? 'rgba(27, 32, 44, 0.72)' : 'rgba(255, 255, 255, 0.78)';
  ctx.fill();

  ctx.lineWidth = Math.max(1.5, 2 / zoom);
  ctx.strokeStyle = active
    ? (isDark ? '#818CF8' : '#4F46E5')
    : (isDark ? 'rgba(129, 140, 248, 0.62)' : 'rgba(79, 70, 229, 0.55)');
  ctx.stroke();

  // Accent straightedge highlight along the drawing edge (y = 0)
  ctx.beginPath();
  ctx.moveTo(-halfW, 0);
  ctx.lineTo(halfW, 0);
  ctx.lineWidth = Math.max(2.5, 3 / zoom);
  ctx.strokeStyle = isDark ? '#818CF8' : '#4F46E5';
  ctx.stroke();

  // Parallel guide lines every 1 cm
  ctx.lineWidth = 1;
  ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.24)' : 'rgba(100, 116, 139, 0.26)';
  for (let cm = 1; cm < lengthCm / 2; cm++) {
    const y = cm * DEFAULT_PIXELS_PER_CM;
    const span = halfW - y - 10;
    if (span <= 16) break;
    ctx.beginPath();
    ctx.moveTo(-span, y);
    ctx.lineTo(span, y);
    ctx.stroke();
  }

  // Center 90° perpendicular line
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, height - 12);
  ctx.strokeStyle = isDark ? 'rgba(129, 140, 248, 0.45)' : 'rgba(79, 70, 229, 0.42)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Protractor semicircle arc (0°–180°)
  const arcR = halfW * 0.44;
  ctx.beginPath();
  ctx.arc(0, 0, arcR, 0, Math.PI);
  ctx.strokeStyle = isDark ? 'rgba(167, 139, 250, 0.48)' : 'rgba(124, 58, 237, 0.42)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Angle degree ticks around protractor
  for (let deg = 10; deg < 180; deg += 10) {
    const a = (deg * Math.PI) / 180;
    const major = deg % 30 === 0 || deg === 45 || deg === 135;
    const r0 = arcR - (major ? 14 : 7);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * arcR, Math.sin(a) * arcR);
    ctx.strokeStyle = major
      ? (isDark ? 'rgba(167, 139, 250, 0.72)' : 'rgba(124, 58, 237, 0.65)')
      : (isDark ? 'rgba(148, 163, 184, 0.35)' : 'rgba(100, 116, 139, 0.35)');
    ctx.lineWidth = major ? 1.5 : 1;
    ctx.stroke();
  }

  // Millimeter & centimeter scale ticks along the hypotenuse
  const ticks = generateScaleTicks(lengthCm, DEFAULT_PIXELS_PER_CM, true);
  ctx.font = '600 13px "Segoe UI Variable Text", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tk of ticks) {
    const len = tk.isMajorCm ? 20 : tk.isHalfCm ? 13 : 7;
    ctx.beginPath();
    ctx.moveTo(tk.offsetPx, 0);
    ctx.lineTo(tk.offsetPx, len);
    ctx.strokeStyle = tk.isMajorCm
      ? (isDark ? '#E2E8F0' : '#0F172A')
      : (isDark ? 'rgba(148, 163, 184, 0.55)' : 'rgba(100, 116, 139, 0.55)');
    ctx.lineWidth = tk.isMajorCm ? 1.6 : 1;
    ctx.stroke();
    if (tk.label != null && Math.abs(tk.offsetPx) < halfW - 14) {
      ctx.fillStyle = isDark ? '#CBD5E1' : '#334155';
      ctx.fillText(tk.label, tk.offsetPx, 23);
    }
  }

  // Rotate handle badges
  for (const hx of [-halfW + 44, halfW - 44]) {
    ctx.beginPath();
    ctx.arc(hx, 44, 15, 0, Math.PI * 2);
    ctx.fillStyle = isDark ? 'rgba(129, 140, 248, 0.22)' : 'rgba(79, 70, 229, 0.14)';
    ctx.fill();
    ctx.strokeStyle = isDark ? '#818CF8' : '#4F46E5';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // Little curved arrow icon
    ctx.beginPath();
    ctx.arc(hx, 44, 6.5, -Math.PI * 0.75, Math.PI * 0.45);
    ctx.stroke();
  }

  // Center live angle readout pill (unrotated text for instant legibility)
  ctx.save();
  ctx.translate(0, height * 0.56);
  ctx.rotate(-rad);
  const label = formatDisplayAngle(ruler.angleDegrees);
  ctx.font = '700 16px "Segoe UI Variable Text", "Segoe UI", sans-serif';
  const tw = ctx.measureText(label).width;
  const pw = Math.max(58, tw + 24);
  const ph = 30;
  ctx.beginPath();
  ctx.roundRect(-pw / 2, -ph / 2, pw, ph, 15);
  ctx.fillStyle = isDark ? '#262B5A' : '#4F46E5';
  ctx.fill();
  ctx.fillStyle = isDark ? '#E0E7FF' : '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 1);
  ctx.restore();

  ctx.restore();
}
