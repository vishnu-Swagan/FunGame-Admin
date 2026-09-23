import { createChickenRoadAudio } from "./chickenRoadAudio";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function audioParam(value = 0) {
  return {
    value,
    setValueAtTime: jest.fn(),
    linearRampToValueAtTime: jest.fn(),
    exponentialRampToValueAtTime: jest.fn(),
    cancelScheduledValues: jest.fn(),
  };
}

function fakeContext(state = "running") {
  const context = {
    state,
    currentTime: 10,
    sampleRate: 8000,
    destination: {},
    nodes: [],
    sources: [],
    gains: [],
    buffers: [],
  };
  const node = (extra = {}) => {
    const result = { connect: jest.fn(), disconnect: jest.fn(), ...extra };
    context.nodes.push(result);
    return result;
  };
  const source = (extra = {}) => {
    const result = node({
      onended: null,
      loop: false,
      start: jest.fn(),
      stop: jest.fn(),
      ...extra,
    });
    context.sources.push(result);
    return result;
  };
  context.createGain = jest.fn(() => {
    const result = node({ gain: audioParam() });
    context.gains.push(result);
    return result;
  });
  context.createBiquadFilter = jest.fn(() => node({ frequency: audioParam(), Q: audioParam(), type: "lowpass" }));
  context.createOscillator = jest.fn(() => source({ frequency: audioParam(), type: "sine" }));
  context.createBufferSource = jest.fn(() => source({ buffer: null }));
  context.createBuffer = jest.fn((channels, length, sampleRate) => {
    const samples = new Float32Array(length);
    const result = { numberOfChannels: channels, length, sampleRate, getChannelData: () => samples };
    context.buffers.push(result);
    return result;
  });
  context.resume = jest.fn(async () => { context.state = "running"; });
  context.close = jest.fn(async () => { context.state = "closed"; });
  context.advanceTo = (time) => {
    context.currentTime = time;
    context.sources.forEach((item) => {
      const latestStop = item.stop.mock.calls[item.stop.mock.calls.length - 1]?.[0];
      if (latestStop <= time) item.onended?.();
    });
  };
  return context;
}

function fakeDocument() {
  const listeners = new Set();
  return {
    hidden: false,
    visibilityState: "visible",
    addEventListener: jest.fn((name, handler) => { if (name === "visibilitychange") listeners.add(handler); }),
    removeEventListener: jest.fn((name, handler) => { if (name === "visibilitychange") listeners.delete(handler); }),
    setHidden(value) {
      this.hidden = value;
      this.visibilityState = value ? "hidden" : "visible";
      listeners.forEach((handler) => handler());
    },
  };
}

function setup(state = "running") {
  const context = fakeContext(state);
  const document = fakeDocument();
  const factory = jest.fn(() => context);
  const audio = createChickenRoadAudio({ audioContextFactory: factory, document });
  return { context, document, factory, audio };
}

test("construction and attempted cues do not create audio before a gesture unlock", async () => {
  const { audio, context, factory } = setup();
  expect(factory).not.toHaveBeenCalled();
  expect(audio.playWalk()).toBe(false);
  expect(audio.playFire()).toBe(false);
  audio.setMuted(false);
  expect(factory).not.toHaveBeenCalled();
  expect(await audio.unlock()).toBe(true);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(context.sources).toHaveLength(0);
  expect(context.gains[0].gain.value).toBe(0);
  audio.dispose();
});

test("walking schedules staggered finite footfalls with a quiet bounded output", async () => {
  const { audio, context } = setup();
  await audio.unlock();
  expect(audio.playWalk()).toBe(true);
  const starts = context.sources.map((source) => source.start.mock.calls[0][0]);
  const stops = context.sources.map((source) => source.stop.mock.calls[0][0]);
  expect(new Set(starts).size).toBeGreaterThan(3);
  expect(Math.min(...starts)).toBeGreaterThanOrEqual(10);
  expect(Math.max(...stops)).toBeLessThanOrEqual(10.55);
  context.sources.forEach((source) => {
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(source.stop.mock.calls[0][0]).toBeGreaterThan(source.start.mock.calls[0][0]);
    expect(source.loop).toBe(false);
  });
  expect(context.gains[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0.32, 10);
  context.gains.slice(1).forEach(({ gain }) => {
    expect(gain.linearRampToValueAtTime.mock.calls[0][0]).toBeLessThanOrEqual(0.3);
    expect(gain.exponentialRampToValueAtTime.mock.calls[0][0]).toBe(0.0001);
  });
  audio.dispose();
});

test("natural source completion disconnects its nodes and releases voice ownership", async () => {
  const { audio, context } = setup();
  await audio.unlock();
  audio.playWalk();
  const sources = [...context.sources];
  context.advanceTo(11);
  sources.forEach((source) => {
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(source.onended).toBeNull();
  });
  audio.stopAll();
  sources.forEach((source) => expect(source.stop).toHaveBeenCalledTimes(1));
  audio.dispose();
});

test("fire replaces walking and contains a finite whoosh, crackles, and squawk", async () => {
  const { audio, context } = setup();
  await audio.unlock();
  audio.playWalk();
  const walkSources = [...context.sources];
  context.currentTime = 10.15;
  expect(audio.playFire()).toBe(true);
  walkSources.forEach((source) => {
    expect(source.stop).toHaveBeenLastCalledWith(10.15);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
  });
  const fireSources = context.sources.slice(walkSources.length);
  expect(fireSources.length).toBeGreaterThan(8);
  expect(fireSources.some((source) => source.frequency)).toBe(true);
  expect(fireSources.some((source) => source.buffer)).toBe(true);
  fireSources.forEach((source) => {
    expect(source.stop.mock.calls[0][0]).toBeLessThan(10.85);
    expect(source.loop).toBe(false);
  });
  expect(context.createBuffer).toHaveBeenCalledTimes(1);
  audio.dispose();
});

test("stopAll stops sources scheduled in the future, silences the bus, and requires a new unlock", async () => {
  const { audio, context } = setup();
  await audio.unlock();
  audio.playWalk();
  audio.stopAll();
  context.sources.forEach((source) => {
    expect(source.stop).toHaveBeenLastCalledWith(10);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
  });
  expect(context.gains[0].gain.cancelScheduledValues).toHaveBeenCalledWith(10);
  expect(context.gains[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0, 10);
  expect(audio.playFire()).toBe(false);
  expect(await audio.unlock()).toBe(true);
  expect(audio.playWalk()).toBe(true);
  audio.dispose();
});

test("muting stops every voice and unmuting neither plays nor resumes automatically", async () => {
  const { audio, context } = setup();
  await audio.unlock();
  audio.playFire();
  const count = context.sources.length;
  expect(audio.setMuted(true)).toBe(true);
  expect(audio.playWalk()).toBe(false);
  expect(await audio.unlock()).toBe(false);
  expect(audio.setMuted(false)).toBe(false);
  expect(context.sources).toHaveLength(count);
  expect(context.resume).not.toHaveBeenCalled();
  expect(audio.playFire()).toBe(false);
  await audio.unlock();
  expect(audio.playWalk()).toBe(true);
  audio.dispose();
});

test.each(["mute", "stop", "hide", "dispose"])("a delayed resume cannot start stale audio after %s", async (action) => {
  const { audio, context, document } = setup("suspended");
  const pending = deferred();
  context.resume.mockImplementation(() => pending.promise);
  const unlocking = audio.unlock();
  expect(context.resume).toHaveBeenCalledTimes(1);
  expect(audio.playWalk()).toBe(false);
  if (action === "mute") { audio.setMuted(true); audio.setMuted(false); }
  if (action === "stop") audio.stopAll();
  if (action === "hide") { document.setHidden(true); document.setHidden(false); }
  if (action === "dispose") audio.dispose();
  context.state = "running";
  pending.resolve();
  expect(await unlocking).toBe(false);
  expect(audio.playWalk()).toBe(false);
  expect(context.sources).toHaveLength(0);
  audio.dispose();
});

test("same-tick cancellation also invalidates an already-running context unlock", async () => {
  const { audio } = setup();
  const unlocking = audio.unlock();
  audio.stopAll();
  expect(await unlocking).toBe(false);
  expect(audio.playWalk()).toBe(false);
  audio.dispose();
});

test("hidden documents stop sound and returning to the page never replays it", async () => {
  const { audio, context, document, factory } = setup();
  document.setHidden(true);
  expect(await audio.unlock()).toBe(false);
  expect(factory).not.toHaveBeenCalled();
  document.setHidden(false);
  await audio.unlock();
  audio.playWalk();
  const count = context.sources.length;
  document.setHidden(true);
  context.sources.forEach((source) => expect(source.stop).toHaveBeenLastCalledWith(10));
  expect(audio.playFire()).toBe(false);
  document.setHidden(false);
  expect(audio.playFire()).toBe(false);
  expect(context.sources).toHaveLength(count);
  audio.dispose();
});

test("unsupported audio, construction failure, and rejected resume are nonfatal", async () => {
  const missing = createChickenRoadAudio({ audioContextFactory: () => null, document: null });
  expect(await missing.unlock()).toBe(false);
  expect(missing.playFire()).toBe(false);
  expect(() => missing.dispose()).not.toThrow();
  const broken = createChickenRoadAudio({ audioContextFactory: () => { throw new Error("unavailable"); }, document: null });
  expect(await broken.unlock()).toBe(false);
  broken.dispose();
  const { audio, context } = setup("suspended");
  context.resume.mockRejectedValueOnce(new Error("gesture rejected"));
  expect(await audio.unlock()).toBe(false);
  expect(audio.playWalk()).toBe(false);
  expect(await audio.unlock()).toBe(true);
  expect(audio.playWalk()).toBe(true);
  audio.dispose();
});

test("a newer user gesture can retry after a canceled resume without reviving the old request", async () => {
  const { audio, context } = setup("suspended");
  const pending = deferred();
  context.resume.mockImplementation(() => pending.promise);
  const oldUnlock = audio.unlock();
  audio.setMuted(true);
  audio.setMuted(false);
  const newUnlock = audio.unlock();
  expect(context.resume).toHaveBeenCalledTimes(1);
  context.state = "running";
  pending.resolve();
  expect(await oldUnlock).toBe(false);
  expect(await newUnlock).toBe(true);
  expect(audio.playWalk()).toBe(true);
  audio.dispose();
});

test("an audio graph error cleans already-created voices instead of throwing into gameplay", async () => {
  const { audio, context } = setup();
  await audio.unlock();
  context.createBufferSource.mockImplementationOnce(() => { throw new Error("resource limit"); });
  expect(audio.playWalk()).toBe(false);
  expect(context.sources).toHaveLength(1);
  expect(context.sources[0].stop).toHaveBeenLastCalledWith(10);
  expect(context.sources[0].disconnect).toHaveBeenCalledTimes(1);
  expect(audio.playFire()).toBe(false);
  audio.dispose();
});

test.each([NaN, Infinity, -1000, 0, 1e9, "480"])("duration %p cannot schedule an unbounded effect", async (duration) => {
  const { audio, context } = setup();
  await audio.unlock();
  expect(audio.playWalk(duration)).toBe(true);
  expect(context.sources.length).toBeLessThanOrEqual(17);
  context.sources.forEach((source) => {
    expect(source.stop.mock.calls[0][0]).toBeLessThan(11.25);
    expect(Number.isFinite(source.start.mock.calls[0][0])).toBe(true);
  });
  audio.dispose();
});

test("dispose is idempotent, removes its listener, closes audio, and prevents all future work", async () => {
  const { audio, context, document, factory } = setup();
  await audio.unlock();
  audio.playFire();
  const count = context.sources.length;
  context.close.mockRejectedValueOnce(new Error("already closing"));
  audio.dispose();
  audio.dispose();
  expect(context.close).toHaveBeenCalledTimes(1);
  expect(document.removeEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  expect(await audio.unlock()).toBe(false);
  audio.setMuted(false);
  expect(audio.playWalk()).toBe(false);
  expect(audio.playFire()).toBe(false);
  expect(context.sources).toHaveLength(count);
  expect(factory).toHaveBeenCalledTimes(1);
});

test("the browser factory falls back to webkitAudioContext and stays lazy", async () => {
  const standard = Object.getOwnPropertyDescriptor(window, "AudioContext");
  const legacy = Object.getOwnPropertyDescriptor(window, "webkitAudioContext");
  const context = fakeContext();
  const constructor = jest.fn(() => context);
  Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
  Object.defineProperty(window, "webkitAudioContext", { configurable: true, value: constructor });
  try {
    const audio = createChickenRoadAudio({ document: null });
    expect(constructor).not.toHaveBeenCalled();
    expect(await audio.unlock()).toBe(true);
    expect(constructor).toHaveBeenCalledWith({ latencyHint: "interactive" });
    audio.dispose();
  } finally {
    if (standard) Object.defineProperty(window, "AudioContext", standard); else delete window.AudioContext;
    if (legacy) Object.defineProperty(window, "webkitAudioContext", legacy); else delete window.webkitAudioContext;
  }
});
