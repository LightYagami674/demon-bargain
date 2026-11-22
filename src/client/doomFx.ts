export interface DoomFxVars {
  tierClass: "doom-80" | "doom-50" | "";
  desat: number;
  vignetteOpacity: number;
  eyeOpacity: number;
  pulseMs: number;
}

/**
 * Computes CSS custom properties and tier class for Doom visual degradation.
 * - 50%+: selective chrome/rail desaturation (up to 78%) and micro-tremor
 * - 80%+: Entity Eye canvas and heartbeat-synced crimson radial edge vignette
 */
export function computeDoomFxVars(doomPct: number, bpm: number): DoomFxVars {
  const d = Math.max(0, Math.min(100, doomPct));
  const tierClass = d >= 80 ? "doom-80" : d >= 50 ? "doom-50" : "";
  const desat = d < 50 ? 0 : Math.min(0.78, ((d - 50) / 50) * 0.78);

  let vignetteOpacity = 0;
  if (d >= 80) {
    vignetteOpacity = 0.62 + ((d - 80) / 20) * 0.35;
  } else if (d >= 50) {
    vignetteOpacity = 0.22 + ((d - 50) / 30) * 0.25;
  }

  const eyeOpacity = d < 80 ? 0 : 0.45 + ((d - 80) / 20) * 0.45;
  const safeBpm = Math.max(1, bpm);
  const pulseMs = Math.round(60000 / safeBpm);

  return {
    tierClass,
    desat,
    vignetteOpacity,
    eyeOpacity,
    pulseMs,
  };
}

/**
 * Draws a single frame of the center-clear Entity Eye at 80%+ Doom.
 */
export function drawEntityEyeFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  eyePhase: number,
): void {
  ctx.clearRect(0, 0, w, h);
  if (w <= 0 || h <= 0) return;

  const cx = w * 0.5;
  const cy = h * 0.36;
  const openRatio = 0.52 + Math.sin(eyePhase * 0.7) * 0.12;
  const eyeW = w * 0.44;
  const eyeH = eyeW * 0.48 * openRatio;

  const grad = ctx.createRadialGradient(cx, cy, 8, cx, cy, eyeW * 1.15);
  grad.addColorStop(0, "rgba(225, 29, 72, 0.24)");
  grad.addColorStop(0.55, "rgba(136, 19, 55, 0.10)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - eyeW, cy);
  ctx.quadraticCurveTo(cx, cy - eyeH * 1.8, cx + eyeW, cy);
  ctx.quadraticCurveTo(cx, cy + eyeH * 1.8, cx - eyeW, cy);
  ctx.closePath();
  ctx.strokeStyle = "rgba(244, 63, 94, 0.32)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "rgba(20, 4, 10, 0.36)";
  ctx.fill();

  const driftX = Math.sin(eyePhase * 1.3) * 8;
  const driftY = Math.cos(eyePhase * 0.9) * 3;

  ctx.beginPath();
  ctx.ellipse(
    cx + driftX,
    cy + driftY,
    7,
    Math.max(12, eyeH * 0.85),
    0,
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = "rgba(225, 29, 72, 0.42)";
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(
    cx + driftX,
    cy + driftY,
    2.5,
    Math.max(8, eyeH * 0.65),
    0,
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  ctx.fill();
  ctx.restore();
}
