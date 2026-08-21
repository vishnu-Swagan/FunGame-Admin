/**
 * Keep CSS in step with the part of the screen that is actually visible.
 *
 * `100vh` is the layout viewport on older iOS/Android browsers, so an installed
 * game can end up underneath the status bar, browser controls, or the on-screen
 * keyboard.  The Visual Viewport API reports the live, unobscured rectangle.
 * Publishing it as CSS variables gives every game engine one shared source of
 * truth without forcing each canvas/cabinet to maintain its own resize code.
 */
export function readViewportMetrics(targetWindow = window) {
  const viewport = targetWindow.visualViewport;
  const documentElement = targetWindow.document?.documentElement;
  const width = viewport?.width || targetWindow.innerWidth || documentElement?.clientWidth || 0;
  const height = viewport?.height || targetWindow.innerHeight || documentElement?.clientHeight || 0;

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    left: Math.max(0, Math.round(viewport?.offsetLeft || 0)),
    top: Math.max(0, Math.round(viewport?.offsetTop || 0)),
    scale: Math.max(0.1, Number(viewport?.scale || 1)),
  };
}

/** Fit a fixed game canvas into an available rectangle without cropping it. */
export function fitDesignCanvas({
  availableWidth,
  availableHeight,
  designWidth,
  designHeight,
  allowRotate = false,
  maxScale = Number.POSITIVE_INFINITY,
}) {
  const width = Math.max(1, Number(availableWidth) || 1);
  const height = Math.max(1, Number(availableHeight) || 1);
  const canvasWidth = Math.max(1, Number(designWidth) || 1);
  const canvasHeight = Math.max(1, Number(designHeight) || 1);
  const flat = Math.min(width / canvasWidth, height / canvasHeight, maxScale);
  const turned = allowRotate
    ? Math.min(height / canvasWidth, width / canvasHeight, maxScale)
    : -1;
  return turned > flat ? { scale: turned, rotate: true } : { scale: flat, rotate: false };
}

export function installViewportMetrics(targetWindow = window) {
  if (!targetWindow?.document?.documentElement) return () => {};

  const root = targetWindow.document.documentElement;
  let frame = 0;

  const publish = () => {
    frame = 0;
    const metrics = readViewportMetrics(targetWindow);
    root.style.setProperty("--fg-viewport-w", `${metrics.width}px`);
    root.style.setProperty("--fg-viewport-h", `${metrics.height}px`);
    root.style.setProperty("--fg-viewport-left", `${metrics.left}px`);
    root.style.setProperty("--fg-viewport-top", `${metrics.top}px`);
    root.style.setProperty("--fg-viewport-scale", String(metrics.scale));
  };

  const schedule = () => {
    if (frame) return;
    frame = targetWindow.requestAnimationFrame(publish);
  };

  publish();
  targetWindow.addEventListener("resize", schedule, { passive: true });
  targetWindow.addEventListener("orientationchange", schedule, { passive: true });
  targetWindow.addEventListener("pageshow", schedule, { passive: true });
  targetWindow.visualViewport?.addEventListener("resize", schedule, { passive: true });
  targetWindow.visualViewport?.addEventListener("scroll", schedule, { passive: true });

  return () => {
    if (frame) targetWindow.cancelAnimationFrame(frame);
    targetWindow.removeEventListener("resize", schedule);
    targetWindow.removeEventListener("orientationchange", schedule);
    targetWindow.removeEventListener("pageshow", schedule);
    targetWindow.visualViewport?.removeEventListener("resize", schedule);
    targetWindow.visualViewport?.removeEventListener("scroll", schedule);
  };
}
