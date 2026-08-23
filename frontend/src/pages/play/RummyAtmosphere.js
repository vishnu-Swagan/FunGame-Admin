import { useEffect, useMemo, useRef } from "react";


export const RUMMY_ATMOSPHERE_PHASES = Object.freeze({
  IDLE: "idle",
  TABLE: "table",
  DRAW: "draw",
  DISCARD: "discard",
  VALID_DECLARE: "valid-declare",
  INVALID: "invalid",
  DROP: "drop",
});

const GOLD = "245, 214, 123";
const PALE_GOLD = "255, 239, 180";
const EMERALD = "67, 211, 155";
const DEEP_EMERALD = "15, 118, 85";
const RED = "214, 67, 76";
const DEEP_RED = "105, 24, 36";

const PHASE_ALIASES = Object.freeze({
  idle: RUMMY_ATMOSPHERE_PHASES.IDLE,
  table: RUMMY_ATMOSPHERE_PHASES.TABLE,
  draw: RUMMY_ATMOSPHERE_PHASES.DRAW,
  discard: RUMMY_ATMOSPHERE_PHASES.DISCARD,
  declare: RUMMY_ATMOSPHERE_PHASES.VALID_DECLARE,
  valid: RUMMY_ATMOSPHERE_PHASES.VALID_DECLARE,
  "valid-declare": RUMMY_ATMOSPHERE_PHASES.VALID_DECLARE,
  win: RUMMY_ATMOSPHERE_PHASES.VALID_DECLARE,
  invalid: RUMMY_ATMOSPHERE_PHASES.INVALID,
  "invalid-declare": RUMMY_ATMOSPHERE_PHASES.INVALID,
  drop: RUMMY_ATMOSPHERE_PHASES.DROP,
});

const EVENT_DURATION = Object.freeze({
  [RUMMY_ATMOSPHERE_PHASES.DRAW]: 720,
  [RUMMY_ATMOSPHERE_PHASES.DISCARD]: 720,
  [RUMMY_ATMOSPHERE_PHASES.VALID_DECLARE]: 1800,
  [RUMMY_ATMOSPHERE_PHASES.INVALID]: 900,
  [RUMMY_ATMOSPHERE_PHASES.DROP]: 1100,
});


export function normalizeRummyAtmospherePhase(value) {
  return PHASE_ALIASES[String(value || "table").trim().toLowerCase()]
    || RUMMY_ATMOSPHERE_PHASES.TABLE;
}

function hashSeed(value) {
  let hash = 2166136261;
  const input = String(value);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function getRummyAtmosphereBudget(width, height, reducedMotion = false) {
  const compact = Math.min(Number(width) || 0, Number(height) || 0) < 560
    || (Number(width) || 0) < 720;
  if (reducedMotion) {
    return { compact, dprCap: 1.25, ambientCount: 8, celebrationCount: 12 };
  }
  return compact
    ? { compact, dprCap: 1.5, ambientCount: 24, celebrationCount: 34 }
    : { compact, dprCap: 2, ambientCount: 46, celebrationCount: 64 };
}

/** Pure deterministic particle data, exported to make visual regressions testable. */
export function createRummyAtmosphereModel({
  seed = "chakri-rummy",
  eventId = 0,
  phase = RUMMY_ATMOSPHERE_PHASES.TABLE,
  width = 1280,
  height = 720,
  reducedMotion = false,
} = {}) {
  const normalizedPhase = normalizeRummyAtmospherePhase(phase);
  const budget = getRummyAtmosphereBudget(width, height, reducedMotion);
  const ambientRandom = seededRandom(hashSeed(`${seed}:ambient:${Math.round(width / 24)}:${Math.round(height / 24)}`));
  const eventRandom = seededRandom(hashSeed(`${seed}:event:${eventId}:${normalizedPhase}`));

  const ambient = Array.from({ length: budget.ambientCount }, (_, index) => ({
    x: ambientRandom(),
    y: ambientRandom(),
    radius: 0.7 + ambientRandom() * (budget.compact ? 1.2 : 1.8),
    alpha: 0.08 + ambientRandom() * 0.22,
    driftX: (ambientRandom() - 0.5) * 0.012,
    driftY: -0.004 - ambientRandom() * 0.014,
    pulse: ambientRandom() * Math.PI * 2,
    color: index % 5 === 0 ? PALE_GOLD : index % 2 === 0 ? GOLD : EMERALD,
  }));

  const celebration = Array.from({ length: budget.celebrationCount }, (_, index) => ({
    angle: -Math.PI * 0.92 + eventRandom() * Math.PI * 1.84,
    speed: 0.18 + eventRandom() * 0.54,
    size: 1.5 + eventRandom() * (budget.compact ? 3.2 : 5.2),
    delay: eventRandom() * 0.28,
    spin: (eventRandom() - 0.5) * 8,
    lift: 0.05 + eventRandom() * 0.16,
    color: index % 4 === 0 ? PALE_GOLD : index % 2 === 0 ? GOLD : EMERALD,
  }));

  return { budget, ambient, celebration };
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function easeOutCubic(value) {
  return 1 - ((1 - value) ** 3);
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function pointOnQuadratic(from, control, to, progress) {
  const inverse = 1 - progress;
  return {
    x: inverse * inverse * from.x + 2 * inverse * progress * control.x + progress * progress * to.x,
    y: inverse * inverse * from.y + 2 * inverse * progress * control.y + progress * progress * to.y,
  };
}

function roundedRect(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function drawAmbient(context, model, width, height, elapsed, phase) {
  const intensity = phase === RUMMY_ATMOSPHERE_PHASES.IDLE ? 0.58 : 1;
  const glow = context.createRadialGradient(
    width * 0.5, height * 0.48, 0,
    width * 0.5, height * 0.48, Math.max(width, height) * 0.58,
  );
  glow.addColorStop(0, `rgba(${DEEP_EMERALD}, ${0.07 * intensity})`);
  glow.addColorStop(0.52, `rgba(${GOLD}, ${0.025 * intensity})`);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  const seconds = elapsed / 1000;
  model.ambient.forEach((particle) => {
    const x = positiveModulo(particle.x + seconds * particle.driftX, 1) * width;
    const y = positiveModulo(particle.y + seconds * particle.driftY, 1) * height;
    const pulse = 0.68 + Math.sin(seconds * 0.72 + particle.pulse) * 0.32;
    context.beginPath();
    context.fillStyle = `rgba(${particle.color}, ${particle.alpha * pulse * intensity})`;
    context.arc(x, y, particle.radius, 0, Math.PI * 2);
    context.fill();
  });
}

function defaultTrail(phase) {
  if (phase === RUMMY_ATMOSPHERE_PHASES.DISCARD) {
    return {
      from: { x: 0.5, y: 0.79 },
      to: { x: 0.56, y: 0.43 },
      control: { x: 0.7, y: 0.58 },
    };
  }
  return {
    from: { x: 0.49, y: 0.43 },
    to: { x: 0.5, y: 0.79 },
    control: { x: 0.31, y: 0.6 },
  };
}

function normalizedPoint(value, fallback) {
  return {
    x: clamp(Number(value?.x ?? fallback.x)),
    y: clamp(Number(value?.y ?? fallback.y)),
  };
}

function drawCardTrail(context, width, height, progress, phase, trailFrom, trailTo) {
  if (progress >= 1) return;
  const defaults = defaultTrail(phase);
  const from = normalizedPoint(trailFrom, defaults.from);
  const to = normalizedPoint(trailTo, defaults.to);
  const control = defaults.control;
  const eased = easeOutCubic(progress);
  const tailStart = Math.max(0, eased - 0.24);
  const gradient = context.createLinearGradient(
    from.x * width, from.y * height, to.x * width, to.y * height,
  );
  gradient.addColorStop(0, `rgba(${EMERALD}, 0)`);
  gradient.addColorStop(0.55, `rgba(${EMERALD}, ${0.28 * (1 - progress)})`);
  gradient.addColorStop(1, `rgba(${PALE_GOLD}, ${0.78 * (1 - progress)})`);
  context.strokeStyle = gradient;
  context.lineCap = "round";
  context.lineWidth = Math.max(2, Math.min(width, height) * 0.006);
  context.beginPath();
  for (let step = 0; step <= 10; step += 1) {
    const amount = tailStart + ((eased - tailStart) * step) / 10;
    const point = pointOnQuadratic(from, control, to, amount);
    const x = point.x * width;
    const y = point.y * height;
    if (step === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();

  const point = pointOnQuadratic(from, control, to, eased);
  const cardHeight = clamp(Math.min(width, height) * 0.12, 36, 82);
  const cardWidth = cardHeight * 0.68;
  const opacity = clamp((1 - progress) * 2.2);
  context.save();
  context.translate(point.x * width, point.y * height);
  context.rotate((phase === RUMMY_ATMOSPHERE_PHASES.DISCARD ? 0.16 : -0.12) * (1 - progress));
  const cardGradient = context.createLinearGradient(0, -cardHeight / 2, 0, cardHeight / 2);
  cardGradient.addColorStop(0, `rgba(${PALE_GOLD}, ${0.86 * opacity})`);
  cardGradient.addColorStop(1, `rgba(${DEEP_EMERALD}, ${0.76 * opacity})`);
  roundedRect(context, -cardWidth / 2, -cardHeight / 2, cardWidth, cardHeight, cardWidth * 0.12);
  context.fillStyle = cardGradient;
  context.fill();
  context.strokeStyle = `rgba(${GOLD}, ${0.92 * opacity})`;
  context.lineWidth = 1.4;
  context.stroke();
  roundedRect(context, -cardWidth * 0.32, -cardHeight * 0.36, cardWidth * 0.64, cardHeight * 0.72, cardWidth * 0.08);
  context.strokeStyle = `rgba(${PALE_GOLD}, ${0.32 * opacity})`;
  context.stroke();
  context.restore();
}

function drawCelebration(context, model, width, height, progress) {
  const eased = easeOutCubic(progress);
  const fade = clamp((1 - progress) * 1.45);
  const centerX = width * 0.5;
  const centerY = height * 0.5;
  const scale = Math.min(width, height);
  const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, scale * 0.48);
  glow.addColorStop(0, `rgba(${PALE_GOLD}, ${0.18 * fade})`);
  glow.addColorStop(0.36, `rgba(${EMERALD}, ${0.13 * fade})`);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  context.beginPath();
  context.arc(centerX, centerY, scale * (0.08 + eased * 0.34), 0, Math.PI * 2);
  context.strokeStyle = `rgba(${GOLD}, ${0.38 * fade})`;
  context.lineWidth = Math.max(1, scale * 0.0035);
  context.stroke();

  model.celebration.forEach((particle) => {
    const local = clamp((progress - particle.delay) / (1 - particle.delay));
    if (local <= 0 || local >= 1) return;
    const travel = easeOutCubic(local) * particle.speed * scale;
    const x = centerX + Math.cos(particle.angle) * travel;
    const y = centerY + Math.sin(particle.angle) * travel
      - particle.lift * scale * Math.sin(local * Math.PI)
      + local * local * scale * 0.11;
    const alpha = Math.sin(local * Math.PI) * fade;
    context.save();
    context.translate(x, y);
    context.rotate(particle.angle + particle.spin * local);
    context.fillStyle = `rgba(${particle.color}, ${alpha})`;
    context.fillRect(-particle.size * 0.5, -particle.size * 1.4, particle.size, particle.size * 2.8);
    context.restore();
  });
}

function drawRedFade(context, width, height, progress, phase) {
  const fade = clamp(1 - progress);
  const strength = phase === RUMMY_ATMOSPHERE_PHASES.DROP ? 0.13 : 0.18;
  const gradient = context.createRadialGradient(
    width * 0.5, height * 0.53, Math.min(width, height) * 0.08,
    width * 0.5, height * 0.53, Math.max(width, height) * 0.72,
  );
  gradient.addColorStop(0, `rgba(${DEEP_RED}, 0)`);
  gradient.addColorStop(0.66, `rgba(${DEEP_RED}, ${strength * fade})`);
  gradient.addColorStop(1, `rgba(${RED}, ${strength * 0.72 * fade})`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function renderFrame({
  context, model, width, height, dpr, phase, elapsed,
  reducedMotion, trailFrom, trailTo,
}) {
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.save();
  drawAmbient(context, model, width, height, reducedMotion ? 0 : elapsed, phase);

  const duration = EVENT_DURATION[phase];
  const eventElapsed = reducedMotion && duration ? duration * 0.42 : elapsed;
  const progress = duration ? clamp(eventElapsed / duration) : 0;
  if (phase === RUMMY_ATMOSPHERE_PHASES.DRAW || phase === RUMMY_ATMOSPHERE_PHASES.DISCARD) {
    drawCardTrail(context, width, height, progress, phase, trailFrom, trailTo);
  } else if (phase === RUMMY_ATMOSPHERE_PHASES.VALID_DECLARE) {
    drawCelebration(context, model, width, height, progress);
  } else if (phase === RUMMY_ATMOSPHERE_PHASES.INVALID || phase === RUMMY_ATMOSPHERE_PHASES.DROP) {
    drawRedFade(context, width, height, progress, phase);
  }
  context.restore();
}

/**
 * Non-interactive Rummy atmosphere layer.
 *
 * `phase` selects the visual state. Increment `eventId` to replay two
 * consecutive events with the same phase. Optional trail points use normalized
 * 0..1 table coordinates, for example `{ x: 0.5, y: 0.8 }`.
 */
export default function RummyAtmosphere({
  phase = RUMMY_ATMOSPHERE_PHASES.TABLE,
  eventId = 0,
  reducedMotion = false,
  seed = "chakri-rummy",
  trailFrom,
  trailTo,
  className = "",
  style,
}) {
  const canvasRef = useRef(null);
  const normalizedPhase = normalizeRummyAtmospherePhase(phase);
  const trailCoordinates = useMemo(() => ({
    from: trailFrom ? { x: Number(trailFrom.x), y: Number(trailFrom.y) } : null,
    to: trailTo ? { x: Number(trailTo.x), y: Number(trailTo.y) } : null,
  }), [trailFrom, trailTo]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext?.("2d", { alpha: true });
    if (!context) return undefined;

    let animationFrame = 0;
    let visible = !document.hidden;
    let pausedAt = null;
    let startedAt = performance.now();
    let metrics = null;
    let model = null;

    const cancelFrame = () => {
      if (!animationFrame) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };

    const draw = (now) => {
      if (!metrics || !model) return;
      renderFrame({
        context,
        model,
        ...metrics,
        phase: normalizedPhase,
        elapsed: Math.max(0, now - startedAt),
        reducedMotion,
        trailFrom: trailCoordinates.from,
        trailTo: trailCoordinates.to,
      });
    };

    const queueFrame = () => {
      if (animationFrame || !visible || reducedMotion || !window.requestAnimationFrame) return;
      animationFrame = window.requestAnimationFrame((now) => {
        animationFrame = 0;
        draw(now);
        queueFrame();
      });
    };

    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width || canvas.clientWidth || 1));
      const height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 1));
      const budget = getRummyAtmosphereBudget(width, height, reducedMotion);
      const dpr = Math.min(budget.dprCap, Math.max(1, Number(window.devicePixelRatio) || 1));
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      metrics = { width, height, dpr };
      model = createRummyAtmosphereModel({
        seed, eventId, phase: normalizedPhase, width, height, reducedMotion,
      });
      draw(performance.now());
      queueFrame();
    };

    const onVisibilityChange = () => {
      visible = !document.hidden;
      if (!visible) {
        pausedAt = performance.now();
        cancelFrame();
        return;
      }
      if (pausedAt != null) {
        startedAt += performance.now() - pausedAt;
        pausedAt = null;
      }
      draw(performance.now());
      queueFrame();
    };

    const observedElement = canvas.parentElement || canvas;
    const observer = typeof window.ResizeObserver === "function"
      ? new window.ResizeObserver(measure)
      : null;
    observer?.observe(observedElement);
    window.addEventListener("resize", measure, { passive: true });
    window.addEventListener("orientationchange", measure, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    measure();

    return () => {
      cancelFrame();
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [eventId, normalizedPhase, reducedMotion, seed, trailCoordinates]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-rummy-atmosphere={normalizedPhase}
      className={className}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        zIndex: 1,
        ...style,
        pointerEvents: "none",
      }}
    />
  );
}
