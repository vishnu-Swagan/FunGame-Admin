import { fitDesignCanvas, installViewportMetrics, readViewportMetrics } from "@/lib/viewport";

describe("readViewportMetrics", () => {
  test("prefers the live VisualViewport rectangle", () => {
    expect(readViewportMetrics({
      innerWidth: 430,
      innerHeight: 932,
      visualViewport: { width: 390.4, height: 721.6, offsetLeft: 3.2, offsetTop: 48.7, scale: 1 },
      document: { documentElement: { clientWidth: 430, clientHeight: 932 } },
    })).toEqual({ width: 390, height: 722, left: 3, top: 49, scale: 1 });
  });

  test("falls back safely when VisualViewport is unavailable", () => {
    expect(readViewportMetrics({
      innerWidth: 360,
      innerHeight: 640,
      document: { documentElement: { clientWidth: 360, clientHeight: 640 } },
    })).toEqual({ width: 360, height: 640, left: 0, top: 0, scale: 1 });
  });

  test("coalesces visual viewport events and removes every listener", () => {
    const windowListeners = {};
    const viewportListeners = {};
    const setProperty = jest.fn();
    const requestAnimationFrame = jest.fn((callback) => {
      requestAnimationFrame.callback = callback;
      return 17;
    });
    const cancelAnimationFrame = jest.fn();
    const visualViewport = {
      width: 375,
      height: 635,
      offsetLeft: 0,
      offsetTop: 44,
      scale: 1,
      addEventListener: jest.fn((name, handler) => { viewportListeners[name] = handler; }),
      removeEventListener: jest.fn(),
    };
    const target = {
      innerWidth: 390,
      innerHeight: 844,
      visualViewport,
      document: { documentElement: { style: { setProperty } } },
      requestAnimationFrame,
      cancelAnimationFrame,
      addEventListener: jest.fn((name, handler) => { windowListeners[name] = handler; }),
      removeEventListener: jest.fn(),
    };

    const cleanup = installViewportMetrics(target);
    expect(setProperty).toHaveBeenCalledWith("--fg-viewport-h", "635px");
    windowListeners.resize();
    viewportListeners.scroll();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    visualViewport.height = 590;
    requestAnimationFrame.callback();
    expect(setProperty).toHaveBeenCalledWith("--fg-viewport-h", "590px");

    windowListeners.orientationchange();
    cleanup();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);
    expect(target.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(visualViewport.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  test.each([
    ["iPhone portrait", 390, 763, 1600, 900, true],
    ["Android portrait", 360, 720, 500, 884, false],
    ["phone landscape", 780, 360, 1600, 900, true],
    ["desktop", 1440, 900, 1600, 900, false],
  ])("fits a fixed game canvas without clipping on %s", (_name, width, height, designWidth, designHeight, allowRotate) => {
    const fit = fitDesignCanvas({
      availableWidth: width,
      availableHeight: height,
      designWidth,
      designHeight,
      allowRotate,
    });
    const renderedWidth = (fit.rotate ? designHeight : designWidth) * fit.scale;
    const renderedHeight = (fit.rotate ? designWidth : designHeight) * fit.scale;
    expect(renderedWidth).toBeLessThanOrEqual(width + 0.001);
    expect(renderedHeight).toBeLessThanOrEqual(height + 0.001);
    expect(fit.scale).toBeGreaterThan(0);
  });
});
