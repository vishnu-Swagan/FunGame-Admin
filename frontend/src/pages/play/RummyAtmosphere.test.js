import { act } from "react";
import { createRoot } from "react-dom/client";
import RummyAtmosphere, {
  RUMMY_ATMOSPHERE_PHASES,
  createRummyAtmosphereModel,
  getRummyAtmosphereBudget,
  normalizeRummyAtmospherePhase,
} from "./RummyAtmosphere";


const originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
const originalDocumentHidden = Object.getOwnPropertyDescriptor(document, "hidden");
const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
const originalResizeObserver = Object.getOwnPropertyDescriptor(window, "ResizeObserver");

let context;
let resizeObservers;
let requestAnimationFrameMock;
let cancelAnimationFrameMock;
let documentHidden;

function restoreProperty(target, property, descriptor) {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else delete target[property];
}

function gradient() {
  return { addColorStop: jest.fn() };
}

function makeContext() {
  return {
    setTransform: jest.fn(),
    clearRect: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    createRadialGradient: jest.fn(gradient),
    createLinearGradient: jest.fn(gradient),
    fillRect: jest.fn(),
    beginPath: jest.fn(),
    arc: jest.fn(),
    fill: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    quadraticCurveTo: jest.fn(),
    closePath: jest.fn(),
    stroke: jest.fn(),
    translate: jest.fn(),
    rotate: jest.fn(),
  };
}

function installBrowserMocks({ hidden = false } = {}) {
  documentHidden = hidden;
  context = makeContext();
  resizeObservers = [];
  let nextFrameId = 0;

  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => documentHidden,
  });
  requestAnimationFrameMock = jest.fn(() => {
    nextFrameId += 1;
    return nextFrameId;
  });
  cancelAnimationFrameMock = jest.fn();
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: requestAnimationFrameMock,
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: cancelAnimationFrameMock,
  });
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserverMock {
      constructor(callback) {
        this.callback = callback;
        this.observe = jest.fn();
        this.disconnect = jest.fn();
        resizeObservers.push(this);
      }
    },
  });

  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  jest.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 320,
    height: 568,
    top: 0,
    right: 320,
    bottom: 568,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function mount(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

beforeAll(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  installBrowserMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
  jest.restoreAllMocks();
  restoreProperty(window, "devicePixelRatio", originalDevicePixelRatio);
  restoreProperty(document, "hidden", originalDocumentHidden);
  restoreProperty(window, "requestAnimationFrame", originalRequestAnimationFrame);
  restoreProperty(window, "cancelAnimationFrame", originalCancelAnimationFrame);
  restoreProperty(window, "ResizeObserver", originalResizeObserver);
});

test("normalizes public phase aliases and falls back safely", () => {
  expect(normalizeRummyAtmospherePhase("win")).toBe(RUMMY_ATMOSPHERE_PHASES.VALID_DECLARE);
  expect(normalizeRummyAtmospherePhase("INVALID-DECLARE")).toBe(RUMMY_ATMOSPHERE_PHASES.INVALID);
  expect(normalizeRummyAtmospherePhase("unknown-state")).toBe(RUMMY_ATMOSPHERE_PHASES.TABLE);
});

test("builds deterministic particle models without Math.random and respects device budgets", () => {
  const random = jest.spyOn(Math, "random").mockImplementation(() => {
    throw new Error("The atmosphere must stay seeded");
  });
  const options = {
    seed: "table-42",
    eventId: 7,
    phase: "valid-declare",
    width: 320,
    height: 568,
  };
  const first = createRummyAtmosphereModel(options);
  const second = createRummyAtmosphereModel(options);
  const replay = createRummyAtmosphereModel({ ...options, eventId: 8 });

  expect(first).toEqual(second);
  expect(first.ambient).toEqual(replay.ambient);
  expect(first.celebration).not.toEqual(replay.celebration);
  expect(first.ambient).toHaveLength(24);
  expect(first.celebration).toHaveLength(34);
  expect(first.budget.dprCap).toBe(1.5);
  expect(getRummyAtmosphereBudget(1440, 900, false)).toEqual({
    compact: false,
    dprCap: 2,
    ambientCount: 46,
    celebrationCount: 64,
  });
  expect(getRummyAtmosphereBudget(1440, 900, true)).toEqual({
    compact: false,
    dprCap: 1.25,
    ambientCount: 8,
    celebrationCount: 12,
  });
  expect(random).not.toHaveBeenCalled();
});

test("renders as a non-interactive DPR-capped layer and cleans up browser resources", () => {
  const removeWindowListener = jest.spyOn(window, "removeEventListener");
  const removeDocumentListener = jest.spyOn(document, "removeEventListener");
  const { container, root } = mount(
    <RummyAtmosphere phase="draw" eventId={12} style={{ pointerEvents: "auto" }} />,
  );
  const canvas = container.querySelector("canvas");

  expect(canvas).not.toBeNull();
  expect(canvas.getAttribute("aria-hidden")).toBe("true");
  expect(canvas.dataset.rummyAtmosphere).toBe("draw");
  expect(canvas.style.pointerEvents).toBe("none");
  expect(canvas.width).toBe(480);
  expect(canvas.height).toBe(852);
  expect(context.setTransform).toHaveBeenCalledWith(1.5, 0, 0, 1.5, 0, 0);
  expect(resizeObservers).toHaveLength(1);
  expect(resizeObservers[0].observe).toHaveBeenCalledWith(container);
  expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);

  const queuedFrame = requestAnimationFrameMock.mock.calls[0][0];
  act(() => queuedFrame(performance.now() + 120));
  expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);

  act(() => root.unmount());
  expect(cancelAnimationFrameMock).toHaveBeenCalledWith(2);
  expect(resizeObservers[0].disconnect).toHaveBeenCalledTimes(1);
  expect(removeWindowListener).toHaveBeenCalledWith("resize", expect.any(Function));
  expect(removeWindowListener).toHaveBeenCalledWith("orientationchange", expect.any(Function));
  expect(removeDocumentListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
});

test("pauses the animation while the document is hidden and resumes without duplicating loops", () => {
  const { root } = mount(<RummyAtmosphere phase="discard" eventId={3} />);
  expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);

  documentHidden = true;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(cancelAnimationFrameMock).toHaveBeenCalledWith(1);

  documentHidden = false;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);

  act(() => root.unmount());
});

test("reduced motion paints one representative frame and schedules no animation", () => {
  const { container, root } = mount(
    <RummyAtmosphere phase="valid-declare" eventId={9} reducedMotion />,
  );
  const canvas = container.querySelector("canvas");

  expect(canvas.width).toBe(400);
  expect(canvas.height).toBe(710);
  expect(requestAnimationFrameMock).not.toHaveBeenCalled();
  expect(context.fillRect).toHaveBeenCalled();
  expect(context.arc).toHaveBeenCalled();

  act(() => root.unmount());
});
