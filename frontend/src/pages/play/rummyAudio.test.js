jest.mock("@/lib/sound", () => ({
  isMuted: () => false,
  onMuteChange: () => () => {},
}));

import { createRummyAudioController, RUMMY_AUDIO_CUES } from "./rummyAudio";

class FakeAudioParam {
  constructor(value = 0) { this.value = value; this.calls = []; }
  record(method, value, time) { this.value = value; this.calls.push({ method, value, time }); }
  cancelScheduledValues(time) { this.calls.push({ method: "cancel", time }); }
  setValueAtTime(value, time) { this.record("set", value, time); }
  linearRampToValueAtTime(value, time) { this.record("linear", value, time); }
  exponentialRampToValueAtTime(value, time) { this.record("exponential", value, time); }
  setTargetAtTime(value, time) { this.record("target", value, time); }
}

class FakeNode {
  constructor() { this.connections = []; this.disconnected = false; }
  connect(destination) { this.connections.push(destination); return destination; }
  disconnect() { this.disconnected = true; }
}

class FakeSource extends FakeNode {
  constructor(kind) {
    super();
    this.kind = kind;
    this.start = jest.fn();
    this.stop = jest.fn();
    this.onended = null;
    this.loop = false;
    this.buffer = null;
    this.frequency = kind === "oscillator" ? new FakeAudioParam(440) : undefined;
    this.type = "sine";
  }
}

function createFakeContext(initialState = "suspended", resumeFailure = false) {
  const context = {
    state: initialState,
    currentTime: 10,
    sampleRate: 8000,
    destination: new FakeNode(),
    gains: [],
    filters: [],
    compressors: [],
    sources: [],
    createGain: jest.fn(() => {
      const node = new FakeNode();
      node.gain = new FakeAudioParam(1);
      context.gains.push(node);
      return node;
    }),
    createOscillator: jest.fn(() => {
      const source = new FakeSource("oscillator");
      context.sources.push(source);
      return source;
    }),
    createBufferSource: jest.fn(() => {
      const source = new FakeSource("buffer");
      context.sources.push(source);
      return source;
    }),
    createBiquadFilter: jest.fn(() => {
      const node = new FakeNode();
      node.frequency = new FakeAudioParam(350);
      node.Q = new FakeAudioParam(1);
      node.type = "lowpass";
      context.filters.push(node);
      return node;
    }),
    createDynamicsCompressor: jest.fn(() => {
      const node = new FakeNode();
      node.threshold = new FakeAudioParam();
      node.knee = new FakeAudioParam();
      node.ratio = new FakeAudioParam();
      node.attack = new FakeAudioParam();
      node.release = new FakeAudioParam();
      context.compressors.push(node);
      return node;
    }),
    createBuffer: jest.fn((_channels, length) => {
      const channel = new Float32Array(length);
      return { getChannelData: () => channel };
    }),
    resume: jest.fn(() => {
      if (resumeFailure) return Promise.reject(new Error("gesture required"));
      context.state = "running";
      return Promise.resolve();
    }),
    suspend: jest.fn(() => { context.state = "suspended"; return Promise.resolve(); }),
    close: jest.fn(() => { context.state = "closed"; return Promise.resolve(); }),
  };
  return context;
}

function createMediaQuery(matches = false) {
  const listeners = new Set();
  return {
    matches,
    listeners,
    addEventListener: jest.fn((_event, listener) => listeners.add(listener)),
    removeEventListener: jest.fn((_event, listener) => listeners.delete(listener)),
    change(nextMatches) {
      this.matches = nextMatches;
      listeners.forEach((listener) => listener({ matches: nextMatches }));
    },
  };
}

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    listeners,
    addEventListener: jest.fn((type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    }),
    removeEventListener: jest.fn((type, listener) => listeners.get(type)?.delete(listener)),
    dispatch(type) { listeners.get(type)?.forEach((listener) => listener({ type })); },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => jest.useRealTimers());

test("does not create or play an AudioContext before explicit gesture opt-in", async () => {
  const context = createFakeContext();
  const factory = jest.fn(() => context);
  const controller = createRummyAudioController({ audioContextFactory: factory, mediaQueryList: null, random: () => 0.5 });

  await expect(controller.play(RUMMY_AUDIO_CUES.DRAW)).resolves.toBe(false);
  await expect(controller.startAmbient()).resolves.toBe(false);
  expect(factory).not.toHaveBeenCalled();

  await expect(controller.enableFromGesture()).resolves.toBe(true);
  await expect(controller.enableFromGesture()).resolves.toBe(true);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(context.resume).toHaveBeenCalledTimes(1);
  expect(controller.getState().ambientActive).toBe(true);

  await controller.dispose();
  await controller.dispose();
  expect(context.close).toHaveBeenCalledTimes(1);
});

test("synthesizes every bounded Rummy cue and clamps public gain controls", async () => {
  const context = createFakeContext();
  const controller = createRummyAudioController({ audioContextFactory: () => context, mediaQueryList: null, random: () => 0.5 });
  await controller.enableFromGesture();

  for (const cue of Object.values(RUMMY_AUDIO_CUES)) await expect(controller.play(cue)).resolves.toBe(true);
  await expect(controller.play("unknown-cue")).resolves.toBe(false);
  expect(context.createOscillator).toHaveBeenCalled();
  expect(context.createBufferSource).toHaveBeenCalled();
  expect(context.createDynamicsCompressor).toHaveBeenCalledTimes(1);
  expect(context.sources.every((source) => source.start.mock.calls.length === 1)).toBe(true);
  const burstResults = [];
  for (let index = 0; index < 20; index += 1) burstResults.push(await controller.play(RUMMY_AUDIO_CUES.UI_TAP));
  expect(context.sources.length).toBeLessThanOrEqual(24);
  expect(burstResults).toContain(false);
  expect(controller.setVolume(99)).toBe(0.72);
  expect(controller.setVolume(-4)).toBe(0);
  expect(controller.setAmbientVolume(99)).toBe(0.06);
  expect(controller.setAmbientVolume(-4)).toBe(0);
  expect(controller.getState()).toMatchObject({ masterGain: 0, ambientGain: 0 });

  await controller.dispose();
  expect(context.sources.every((source) => source.stop.mock.calls.length >= 1)).toBe(true);
  expect(context.gains.every((node) => node.disconnected)).toBe(true);
  expect(context.filters.every((node) => node.disconnected)).toBe(true);
  expect(context.compressors.every((node) => node.disconnected)).toBe(true);
});

test("global mute stops ambience while reduced motion preserves user-requested audio", async () => {
  let muted = false;
  const muteListeners = new Set();
  const media = createMediaQuery(false);
  const context = createFakeContext();
  const controller = createRummyAudioController({
    audioContextFactory: () => context,
    readMuted: () => muted,
    subscribeMuted: (listener) => { muteListeners.add(listener); return () => muteListeners.delete(listener); },
    mediaQueryList: media,
    random: () => 0.5,
  });

  await controller.startAmbient();
  await controller.enableFromGesture();
  expect(controller.getState()).toMatchObject({ ambientRequested: true, ambientActive: true });
  const firstLoop = context.sources.find((source) => source.loop);

  muted = true;
  muteListeners.forEach((listener) => listener(true));
  expect(firstLoop.stop).toHaveBeenCalled();
  await expect(controller.play(RUMMY_AUDIO_CUES.TURN)).resolves.toBe(false);
  expect(controller.getState()).toMatchObject({ muted: true, ambientRequested: true, ambientActive: false });

  muted = false;
  muteListeners.forEach((listener) => listener(false));
  await Promise.resolve();
  expect(controller.getState().ambientActive).toBe(true);
  media.change(true);
  expect(controller.getState()).toMatchObject({ reducedMotion: true, ambientRequested: true, ambientActive: true });
  await expect(controller.play(RUMMY_AUDIO_CUES.DECLARE)).resolves.toBe(true);
  media.change(false);
  await Promise.resolve();
  expect(controller.getState().ambientActive).toBe(true);

  controller.stopAmbient();
  expect(controller.getState()).toMatchObject({ ambientRequested: false, ambientActive: false });
  await controller.dispose();
  expect(muteListeners.size).toBe(0);
  expect(media.listeners.size).toBe(0);
});

test("suspends an idle opted-in context without recurring audio work", async () => {
  jest.useFakeTimers();
  const context = createFakeContext("running");
  const controller = createRummyAudioController({ audioContextFactory: () => context, mediaQueryList: null });

  await controller.enableFromGesture();
  expect(context.suspend).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1300);
  await Promise.resolve();
  expect(context.suspend).toHaveBeenCalledTimes(1);

  await controller.dispose();
  expect(context.close).toHaveBeenCalledTimes(1);
});

test("fails closed on unsupported audio and on a rejected gesture resume", async () => {
  const unsupported = createRummyAudioController({ audioContextFactory: () => null, mediaQueryList: null });
  await expect(unsupported.enableFromGesture()).resolves.toBe(false);
  await expect(unsupported.play(RUMMY_AUDIO_CUES.UI_TAP)).resolves.toBe(false);
  await expect(unsupported.dispose()).resolves.toBeUndefined();

  const context = createFakeContext("suspended", true);
  const rejected = createRummyAudioController({ audioContextFactory: () => context, mediaQueryList: null });
  await expect(rejected.enableFromGesture()).resolves.toBe(false);
  expect(rejected.getState().enabled).toBe(false);
  await expect(rejected.play(RUMMY_AUDIO_CUES.UI_TAP)).resolves.toBe(false);
  await rejected.dispose();
  expect(context.close).toHaveBeenCalledTimes(1);
});

test("dispose wins an in-flight gesture resume and cannot resurrect the controller", async () => {
  const resume = deferred();
  const context = createFakeContext("suspended");
  context.resume.mockImplementation(() => resume.promise.then(() => {
    if (context.state !== "closed") context.state = "running";
  }));
  const controller = createRummyAudioController({ audioContextFactory: () => context, mediaQueryList: null });

  const enabling = controller.enableFromGesture();
  await controller.dispose();
  resume.resolve();
  await expect(enabling).resolves.toBe(false);
  expect(controller.getState()).toMatchObject({ enabled: false, disposed: true });
  expect(context.close).toHaveBeenCalledTimes(1);
});

test("background lifecycle stops work and restores requested ambience only when visible", async () => {
  const documentTarget = createEventTarget({ visibilityState: "visible" });
  const windowTarget = createEventTarget();
  const context = createFakeContext();
  const controller = createRummyAudioController({
    audioContextFactory: () => context,
    mediaQueryList: null,
    documentTarget,
    windowTarget,
    random: () => 0.5,
  });

  await controller.enableFromGesture();
  await controller.startAmbient();
  const firstLoop = context.sources.find((source) => source.loop);
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatch("visibilitychange");
  expect(firstLoop.stop).toHaveBeenCalled();
  expect(controller.getState()).toMatchObject({ backgrounded: true, ambientRequested: true, ambientActive: false });
  expect(context.suspend).toHaveBeenCalled();
  await expect(controller.play(RUMMY_AUDIO_CUES.DRAW)).resolves.toBe(false);

  documentTarget.visibilityState = "visible";
  documentTarget.dispatch("visibilitychange");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(context.resume).toHaveBeenCalledTimes(2);
  expect(controller.getState()).toMatchObject({ backgrounded: false, ambientActive: true });

  windowTarget.dispatch("pagehide");
  expect(controller.getState().ambientActive).toBe(false);
  windowTarget.dispatch("pageshow");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(controller.getState().ambientActive).toBe(true);

  await controller.dispose();
  expect(documentTarget.listeners.get("visibilitychange")?.size || 0).toBe(0);
  expect(windowTarget.listeners.get("pagehide")?.size || 0).toBe(0);
  expect(windowTarget.listeners.get("pageshow")?.size || 0).toBe(0);
});

test("resumes Safari interrupted state and reports a later resume failure honestly", async () => {
  const context = createFakeContext("interrupted");
  const controller = createRummyAudioController({ audioContextFactory: () => context, mediaQueryList: null });
  await expect(controller.enableFromGesture()).resolves.toBe(true);
  expect(context.resume).toHaveBeenCalledTimes(1);

  context.state = "interrupted";
  context.resume.mockImplementationOnce(() => Promise.reject(new Error("still interrupted")));
  const sourceCount = context.sources.length;
  await expect(controller.play(RUMMY_AUDIO_CUES.DRAW)).resolves.toBe(false);
  expect(context.sources).toHaveLength(sourceCount);

  await controller.dispose();
});
