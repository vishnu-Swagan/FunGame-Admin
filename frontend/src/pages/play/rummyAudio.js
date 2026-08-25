/**
 * Lightweight, procedural Rummy audio.
 *
 * Nothing is created or played until `enableFromGesture()` is called by a
 * click, pointer or key handler. The controller owns one AudioContext and must
 * be disposed when the table unmounts.
 */
import { isMuted as globalIsMuted, onMuteChange as globalOnMuteChange } from "@/lib/sound";

/**
 * Atomic settlement cues. The result UI owns their timing so sound cannot drift
 * away from card movement or announce a result before the server confirms it.
 */
export const RUMMY_SETTLEMENT_AUDIO_CUES = Object.freeze({
  CARD_SETTLE: "settlement-card-settle",
  GROUP_VALIDATION: "settlement-group-validation",
  ROYAL_RISE: "settlement-royal-rise",
  COIN_TICK: "settlement-coin-tick",
  FINAL_PAYOUT: "settlement-final-payout",
});

export const RUMMY_AUDIO_CUES = Object.freeze({
  CARD_SLIDE: "card-slide",
  DRAW: "draw",
  DISCARD: "discard",
  UI_TAP: "ui-tap",
  TURN: "turn",
  DECLARE: "declare",
  DROP: "drop",
  INVALID: "invalid",
  ...RUMMY_SETTLEMENT_AUDIO_CUES,
});

const VALID_CUES = new Set(Object.values(RUMMY_AUDIO_CUES));
const VALID_SETTLEMENT_CUES = new Set(Object.values(RUMMY_SETTLEMENT_AUDIO_CUES));
const DEFAULT_MASTER_GAIN = 0.38;
const MAX_MASTER_GAIN = 0.72;
const DEFAULT_AMBIENT_GAIN = 0.065;
const MAX_AMBIENT_GAIN = 0.12;
const MAX_LIVE_SOURCES = 24;
const COIN_TICK_MIN_INTERVAL = 0.045;
const SILENCE = 0.0001;
const AMBIENT_PROFILES = Object.freeze({
  "palace-hush": { root: 110, harmonics: [1, 1.5, 2], toneGain: 0.09, roomGain: 0.18, cutoff: 820 },
  "royal-focus": { root: 130.81, harmonics: [1, 1.25, 1.5, 2], toneGain: 0.085, roomGain: 0.16, cutoff: 1050 },
  "grand-hall": { root: 146.83, harmonics: [1, 1.5, 2, 2.25], toneGain: 0.1, roomGain: 0.2, cutoff: 1320 },
});

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const safely = (operation, fallback = undefined) => {
  try {
    return operation();
  } catch (_error) {
    return fallback;
  }
};

function defaultAudioContextFactory() {
  if (typeof window === "undefined") return null;
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) return null;
  return safely(() => new AudioContextConstructor({ latencyHint: "interactive" }))
    || safely(() => new AudioContextConstructor())
    || null;
}

function defaultReducedMotionQuery() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return safely(() => window.matchMedia("(prefers-reduced-motion: reduce)"), null);
}

function setValue(parameter, value, atTime = 0) {
  if (!parameter) return;
  if (typeof parameter.cancelScheduledValues === "function") safely(() => parameter.cancelScheduledValues(atTime));
  if (typeof parameter.setValueAtTime === "function") safely(() => parameter.setValueAtTime(value, atTime));
  else parameter.value = value;
}

function rampLinear(parameter, value, atTime) {
  if (!parameter) return;
  if (typeof parameter.linearRampToValueAtTime === "function") safely(() => parameter.linearRampToValueAtTime(value, atTime));
  else parameter.value = value;
}

function rampExponential(parameter, value, atTime) {
  if (!parameter) return;
  if (typeof parameter.exponentialRampToValueAtTime === "function") safely(() => parameter.exponentialRampToValueAtTime(Math.max(SILENCE, value), atTime));
  else parameter.value = value;
}

function disconnect(node) {
  if (node && typeof node.disconnect === "function") safely(() => node.disconnect());
}

/**
 * @param {object} [options]
 * @param {() => AudioContext|null} [options.audioContextFactory]
 * @param {() => boolean} [options.readMuted]
 * @param {(listener: (muted: boolean) => void) => (() => void)} [options.subscribeMuted]
 * @param {MediaQueryList|null} [options.mediaQueryList]
 * @param {Document|null} [options.documentTarget]
 * @param {Window|null} [options.windowTarget]
 * @param {number} [options.masterGain]
 * @param {number} [options.ambientGain]
 * @param {() => number} [options.random]
 */
export function createRummyAudioController(options = {}) {
  const audioContextFactory = options.audioContextFactory || defaultAudioContextFactory;
  const readMuted = options.readMuted || globalIsMuted;
  const subscribeMuted = options.subscribeMuted || globalOnMuteChange;
  const mediaQueryList = options.mediaQueryList === undefined ? defaultReducedMotionQuery() : options.mediaQueryList;
  const documentTarget = options.documentTarget === undefined ? (typeof document === "undefined" ? null : document) : options.documentTarget;
  const windowTarget = options.windowTarget === undefined ? (typeof window === "undefined" ? null : window) : options.windowTarget;
  const random = typeof options.random === "function" ? options.random : Math.random;

  let masterGainValue = clamp(options.masterGain, 0, MAX_MASTER_GAIN, DEFAULT_MASTER_GAIN);
  let ambientGainValue = clamp(options.ambientGain, 0, MAX_AMBIENT_GAIN, DEFAULT_AMBIENT_GAIN);
  let ambientPreset = AMBIENT_PROFILES[options.ambientPreset] ? options.ambientPreset : "palace-hush";
  let context = null;
  let masterNode = null;
  let limiterNode = null;
  let enabled = false;
  let disposed = false;
  let lifecycleGeneration = 0;
  let backgrounded = documentTarget?.visibilityState === "hidden";
  let ambientRequested = false;
  let ambientNodes = null;
  let idleTimer = null;
  let lastCoinTickAt = Number.NEGATIVE_INFINITY;
  let muted = Boolean(safely(() => readMuted(), false));
  let reducedMotion = Boolean(mediaQueryList?.matches);
  const liveSources = new Map();

  const now = () => Number(context?.currentTime || 0);

  const clearIdleTimer = () => {
    if (idleTimer != null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const scheduleIdleSuspend = (delay = 1200) => {
    clearIdleTimer();
    if (!context || disposed || ambientNodes || liveSources.size) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!disposed && !ambientNodes && !liveSources.size && context?.state === "running") {
        const pending = safely(() => context.suspend?.());
        pending?.catch?.(() => {});
      }
    }, delay);
  };

  const outputGain = () => (muted ? 0 : masterGainValue);

  const applyMasterGain = () => {
    if (!masterNode?.gain) return;
    const time = now();
    if (typeof masterNode.gain.setTargetAtTime === "function") {
      safely(() => masterNode.gain.setTargetAtTime(outputGain(), time, 0.018));
    } else {
      setValue(masterNode.gain, outputGain(), time);
    }
  };

  const ensureContext = () => {
    if (disposed) return null;
    if (context && context.state !== "closed") return context;
    context = safely(() => audioContextFactory(), null);
    if (!context || typeof context.createGain !== "function") {
      const unusableContext = context;
      context = null;
      const pendingClose = safely(() => unusableContext?.close?.());
      pendingClose?.catch?.(() => {});
      return null;
    }
    masterNode = safely(() => context.createGain(), null);
    if (!masterNode) {
      const unusableContext = context;
      context = null;
      const pendingClose = safely(() => unusableContext?.close?.());
      pendingClose?.catch?.(() => {});
      return null;
    }
    setValue(masterNode.gain, outputGain(), now());
    limiterNode = typeof context.createDynamicsCompressor === "function"
      ? safely(() => context.createDynamicsCompressor(), null)
      : null;
    if (limiterNode) {
      setValue(limiterNode.threshold, -12, now());
      setValue(limiterNode.knee, 6, now());
      setValue(limiterNode.ratio, 12, now());
      setValue(limiterNode.attack, 0.003, now());
      setValue(limiterNode.release, 0.18, now());
      safely(() => masterNode.connect(limiterNode));
      safely(() => limiterNode.connect(context.destination));
    } else {
      safely(() => masterNode.connect(context.destination));
    }
    return context;
  };

  const wakeContext = (targetContext = context) => {
    if (!targetContext || targetContext.state === "closed") return Promise.resolve(false);
    if (targetContext.state === "running") return Promise.resolve(true);
    if (typeof targetContext.resume !== "function") return Promise.resolve(false);
    try {
      return Promise.resolve(targetContext.resume())
        .then(() => targetContext.state === "running")
        .catch(() => false);
    } catch (_error) {
      return Promise.resolve(false);
    }
  };

  const releaseSource = (source, attachedNodes = liveSources.get(source) || []) => {
    liveSources.delete(source);
    disconnect(source);
    attachedNodes.forEach(disconnect);
    scheduleIdleSuspend();
  };

  const trackSource = (source, attachedNodes = []) => {
    if (!source) return;
    liveSources.set(source, attachedNodes);
    source.onended = () => releaseSource(source, attachedNodes);
  };

  const stopLiveSources = () => {
    liveSources.forEach((attachedNodes, source) => {
      source.onended = null;
      safely(() => source.stop());
      disconnect(source);
      attachedNodes.forEach(disconnect);
    });
    liveSources.clear();
  };

  const tone = ({ frequency, endFrequency, duration, gain, delay = 0, type = "sine" }) => {
    if (!context || !masterNode || liveSources.size >= MAX_LIVE_SOURCES) return false;
    const oscillator = safely(() => context.createOscillator(), null);
    const gainNode = safely(() => context.createGain(), null);
    if (!oscillator || !gainNode) {
      disconnect(oscillator);
      disconnect(gainNode);
      return false;
    }
    const start = now() + Math.max(0, delay);
    const finish = start + Math.max(0.025, duration);
    oscillator.type = type;
    setValue(oscillator.frequency, Math.max(30, frequency), start);
    if (endFrequency) rampExponential(oscillator.frequency, Math.max(30, endFrequency), finish);
    setValue(gainNode.gain, SILENCE, start);
    rampLinear(gainNode.gain, clamp(gain, 0, 0.2, 0.04), start + Math.min(0.014, duration / 3));
    rampExponential(gainNode.gain, SILENCE, finish);
    safely(() => oscillator.connect(gainNode));
    safely(() => gainNode.connect(masterNode));
    trackSource(oscillator, [gainNode]);
    const started = safely(() => { oscillator.start(start); oscillator.stop(finish + 0.025); return true; }, false);
    if (!started) {
      releaseSource(oscillator, [gainNode]);
      return false;
    }
    return true;
  };

  const noise = ({ duration, gain, delay = 0, frequency = 1500, endFrequency, filterType = "bandpass", q = 0.8 }) => {
    if (!context || !masterNode || liveSources.size >= MAX_LIVE_SOURCES || typeof context.createBuffer !== "function") return false;
    const sampleRate = clamp(context.sampleRate, 8000, 192000, 44100);
    const length = Math.max(1, Math.floor(sampleRate * Math.max(0.025, duration)));
    const buffer = safely(() => context.createBuffer(1, length, sampleRate), null);
    const source = safely(() => context.createBufferSource(), null);
    const filter = safely(() => context.createBiquadFilter(), null);
    const gainNode = safely(() => context.createGain(), null);
    const data = safely(() => buffer?.getChannelData(0), null);
    if (!buffer || !source || !filter || !gainNode || !data) {
      disconnect(source);
      disconnect(filter);
      disconnect(gainNode);
      return false;
    }
    for (let index = 0; index < data.length; index += 1) data[index] = random() * 2 - 1;
    const start = now() + Math.max(0, delay);
    const finish = start + Math.max(0.025, duration);
    source.buffer = buffer;
    filter.type = filterType;
    filter.Q.value = clamp(q, 0.01, 20, 0.8);
    setValue(filter.frequency, Math.max(30, frequency), start);
    if (endFrequency) rampExponential(filter.frequency, Math.max(30, endFrequency), finish);
    setValue(gainNode.gain, SILENCE, start);
    rampLinear(gainNode.gain, clamp(gain, 0, 0.16, 0.04), start + Math.min(0.01, duration / 3));
    rampExponential(gainNode.gain, SILENCE, finish);
    safely(() => source.connect(filter));
    safely(() => filter.connect(gainNode));
    safely(() => gainNode.connect(masterNode));
    trackSource(source, [filter, gainNode]);
    const started = safely(() => { source.start(start); source.stop(finish + 0.02); return true; }, false);
    if (!started) {
      releaseSource(source, [filter, gainNode]);
      return false;
    }
    return true;
  };

  const stopAmbientNow = () => {
    if (!ambientNodes) return;
    const nodes = ambientNodes;
    ambientNodes = null;
    nodes.sources.forEach((source) => {
      source.onended = null;
      safely(() => source.stop());
      disconnect(source);
    });
    nodes.nodes.forEach(disconnect);
    scheduleIdleSuspend();
  };

  const startAmbientNow = () => {
    if (!enabled || disposed || muted || backgrounded || ambientNodes || context?.state !== "running" || !masterNode) return Boolean(ambientNodes);
    if (typeof context.createBuffer !== "function") return false;
    clearIdleTimer();
    const sampleRate = clamp(context.sampleRate, 8000, 192000, 44100);
    const profile = AMBIENT_PROFILES[ambientPreset] || AMBIENT_PROFILES["palace-hush"];
    const duration = 4;
    const buffer = safely(() => context.createBuffer(1, sampleRate * duration, sampleRate), null);
    const source = safely(() => context.createBufferSource(), null);
    const filter = safely(() => context.createBiquadFilter(), null);
    const gainNode = safely(() => context.createGain(), null);
    const data = safely(() => buffer?.getChannelData(0), null);
    if (!buffer || !source || !filter || !gainNode || !data) {
      disconnect(source);
      disconnect(filter);
      disconnect(gainNode);
      return false;
    }
    let roomTone = 0;
    for (let index = 0; index < data.length; index += 1) {
      const white = random() * 2 - 1;
      roomTone = roomTone * 0.985 + white * 0.015;
      data[index] = roomTone * 0.65 + white * 0.035;
    }
    source.buffer = buffer;
    source.loop = true;
    filter.type = "lowpass";
    filter.frequency.value = 950;
    filter.Q.value = 0.3;
    const roomGain = safely(() => context.createGain(), null);
    if (!roomGain) {
      disconnect(source);
      disconnect(filter);
      disconnect(gainNode);
      return false;
    }
    gainNode.gain.value = ambientGainValue;
    roomGain.gain.value = profile.roomGain;
    filter.frequency.value = profile.cutoff;
    safely(() => source.connect(filter));
    safely(() => filter.connect(roomGain));
    safely(() => roomGain.connect(gainNode));
    safely(() => gainNode.connect(masterNode));
    const tonalSources = [];
    const tonalNodes = [];
    profile.harmonics.forEach((ratio, index) => {
      const oscillator = safely(() => context.createOscillator(), null);
      const voiceGain = safely(() => context.createGain(), null);
      if (!oscillator || !voiceGain) {
        disconnect(oscillator);
        disconnect(voiceGain);
        return;
      }
      oscillator.type = index === 0 ? "sine" : "triangle";
      oscillator.frequency.value = profile.root * ratio;
      voiceGain.gain.value = profile.toneGain / (1 + index * 0.7);
      safely(() => oscillator.connect(voiceGain));
      safely(() => voiceGain.connect(gainNode));
      tonalSources.push(oscillator);
      tonalNodes.push(voiceGain);
    });
    const allSources = [source, ...tonalSources];
    const started = safely(() => { allSources.forEach((node) => node.start()); return true; }, false);
    if (!started) {
      allSources.forEach((node) => safely(() => node.stop()));
      allSources.forEach(disconnect);
      [filter, roomGain, ...tonalNodes, gainNode].forEach(disconnect);
      scheduleIdleSuspend();
      return false;
    }
    ambientNodes = { sources: allSources, nodes: [filter, roomGain, ...tonalNodes, gainNode], gain: gainNode };
    return true;
  };

  const startAmbientWhenReady = async () => {
    if (!enabled || disposed || muted || backgrounded || !context || !masterNode) return false;
    const targetContext = context;
    const generation = lifecycleGeneration;
    const resumed = await wakeContext(targetContext);
    if (!resumed || disposed || generation !== lifecycleGeneration || context !== targetContext || muted || backgrounded) return false;
    return startAmbientNow();
  };

  const playCue = async (cue) => {
    if (!VALID_CUES.has(cue) || disposed || !enabled || muted || backgrounded || !context || !masterNode) return false;
    const targetContext = context;
    const generation = lifecycleGeneration;
    const resumed = await wakeContext(targetContext);
    if (!resumed || disposed || generation !== lifecycleGeneration || context !== targetContext || muted || backgrounded) return false;
    if (cue === RUMMY_SETTLEMENT_AUDIO_CUES.COIN_TICK && now() - lastCoinTickAt < COIN_TICK_MIN_INTERVAL) return false;
    clearIdleTimer();
    const short = reducedMotion;
    const before = liveSources.size;
    switch (cue) {
      case RUMMY_AUDIO_CUES.CARD_SLIDE:
        noise({ duration: short ? 0.07 : 0.13, gain: 0.055, frequency: 2300, endFrequency: 950, q: 0.65 });
        break;
      case RUMMY_AUDIO_CUES.DRAW:
        noise({ duration: short ? 0.08 : 0.16, gain: 0.06, frequency: 3100, endFrequency: 1200, q: 0.8 });
        tone({ frequency: 410, endFrequency: 620, duration: 0.08, gain: 0.026, type: "triangle", delay: 0.035 });
        break;
      case RUMMY_AUDIO_CUES.DISCARD:
        noise({ duration: short ? 0.07 : 0.14, gain: 0.065, frequency: 1800, endFrequency: 720, q: 0.7 });
        tone({ frequency: 190, endFrequency: 135, duration: 0.09, gain: 0.045, type: "sine", delay: 0.055 });
        break;
      case RUMMY_AUDIO_CUES.UI_TAP:
        noise({ duration: 0.045, gain: 0.052, frequency: 520, filterType: "lowpass", q: 0.5 });
        tone({ frequency: 1180, duration: 0.045, gain: 0.045, type: "triangle", delay: 0.008 });
        break;
      case RUMMY_AUDIO_CUES.TURN:
        tone({ frequency: 659.25, duration: 0.11, gain: 0.055, type: "sine" });
        tone({ frequency: 880, duration: 0.13, gain: 0.06, type: "sine", delay: short ? 0.07 : 0.1 });
        break;
      case RUMMY_AUDIO_CUES.DECLARE: {
        const notes = short ? [523.25, 783.99] : [392, 523.25, 659.25, 783.99, 1046.5];
        tone({ frequency: 98, endFrequency: 73, duration: short ? 0.2 : 0.34, gain: 0.055, type: "sine" });
        notes.forEach((frequency, index) => tone({
          frequency,
          duration: short ? 0.14 : 0.28,
          gain: short ? 0.065 : 0.085,
          type: index % 2 ? "sine" : "triangle",
          delay: index * (short ? 0.075 : 0.095),
        }));
        break;
      }
      case RUMMY_AUDIO_CUES.DROP:
        tone({ frequency: 196, endFrequency: 123, duration: short ? 0.14 : 0.25, gain: 0.055, type: "sine" });
        noise({ duration: 0.07, gain: 0.035, frequency: 430, filterType: "lowpass", q: 0.4, delay: 0.035 });
        break;
      case RUMMY_AUDIO_CUES.INVALID:
        tone({ frequency: 233, endFrequency: 196, duration: 0.12, gain: 0.045, type: "triangle" });
        tone({ frequency: 185, endFrequency: 155, duration: 0.14, gain: 0.038, type: "sine", delay: 0.085 });
        break;
      case RUMMY_SETTLEMENT_AUDIO_CUES.CARD_SETTLE:
        noise({
          duration: short ? 0.055 : 0.095,
          gain: short ? 0.036 : 0.046,
          frequency: 2200,
          endFrequency: 820,
          q: 0.58,
        });
        tone({
          frequency: 176,
          endFrequency: 132,
          duration: short ? 0.05 : 0.075,
          gain: 0.032,
          type: "sine",
          delay: short ? 0.012 : 0.028,
        });
        break;
      case RUMMY_SETTLEMENT_AUDIO_CUES.GROUP_VALIDATION: {
        const notes = short ? [523.25, 783.99] : [523.25, 659.25, 987.77];
        notes.forEach((frequency, index) => tone({
          frequency,
          endFrequency: frequency * 1.018,
          duration: short ? 0.09 : 0.15 + index * 0.018,
          gain: short ? 0.038 : index === 2 ? 0.03 : 0.048,
          type: index === 0 ? "triangle" : "sine",
          delay: index * (short ? 0.035 : 0.052),
        }));
        break;
      }
      case RUMMY_SETTLEMENT_AUDIO_CUES.ROYAL_RISE: {
        tone({
          frequency: 110,
          endFrequency: 146.83,
          duration: short ? 0.18 : 0.42,
          gain: short ? 0.042 : 0.058,
          type: "sine",
        });
        const notes = short ? [392, 659.25] : [329.63, 493.88, 659.25];
        notes.forEach((frequency, index) => tone({
          frequency,
          endFrequency: frequency * 1.012,
          duration: short ? 0.15 : 0.3 + index * 0.035,
          gain: short ? 0.045 : 0.058 - index * 0.006,
          type: index === 0 ? "triangle" : "sine",
          delay: (index + 1) * (short ? 0.045 : 0.085),
        }));
        break;
      }
      case RUMMY_SETTLEMENT_AUDIO_CUES.COIN_TICK:
        tone({
          frequency: 1567.98,
          endFrequency: 2093,
          duration: short ? 0.032 : 0.048,
          gain: short ? 0.026 : 0.035,
          type: "triangle",
        });
        noise({
          duration: 0.03,
          gain: short ? 0.012 : 0.018,
          frequency: 4300,
          endFrequency: 2900,
          q: 1.3,
          delay: 0.006,
        });
        break;
      case RUMMY_SETTLEMENT_AUDIO_CUES.FINAL_PAYOUT: {
        tone({
          frequency: 130.81,
          endFrequency: 98,
          duration: short ? 0.2 : 0.38,
          gain: short ? 0.036 : 0.048,
          type: "sine",
        });
        const notes = short ? [523.25, 783.99] : [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((frequency, index) => tone({
          frequency,
          endFrequency: frequency * 1.006,
          duration: short ? 0.16 : 0.32 + index * 0.025,
          gain: short ? 0.05 : 0.062 - index * 0.006,
          type: index === 0 ? "triangle" : "sine",
          delay: index * (short ? 0.04 : 0.052),
        }));
        break;
      }
      default:
        return false;
    }
    const producedAudio = liveSources.size > before;
    if (producedAudio && cue === RUMMY_SETTLEMENT_AUDIO_CUES.COIN_TICK) lastCoinTickAt = now();
    const isLongFormCue = cue === RUMMY_AUDIO_CUES.DECLARE
      || cue === RUMMY_SETTLEMENT_AUDIO_CUES.ROYAL_RISE
      || cue === RUMMY_SETTLEMENT_AUDIO_CUES.FINAL_PAYOUT;
    scheduleIdleSuspend(short ? 600 : isLongFormCue ? 1600 : 900);
    return producedAudio;
  };

  const onMute = (nextMuted) => {
    muted = Boolean(nextMuted);
    applyMasterGain();
    if (muted) stopAmbientNow();
    else if (ambientRequested) void startAmbientWhenReady();
  };

  const onReducedMotionChange = (event) => {
    reducedMotion = Boolean(event?.matches);
  };

  const suspendForBackground = () => {
    backgrounded = true;
    stopAmbientNow();
    stopLiveSources();
    clearIdleTimer();
    if (context && context.state === "running") {
      const pending = safely(() => context.suspend?.());
      pending?.catch?.(() => {});
    }
  };

  const onVisibilityChange = () => {
    if (documentTarget?.visibilityState === "hidden") {
      suspendForBackground();
      return;
    }
    backgrounded = false;
    if (ambientRequested) void startAmbientWhenReady();
  };

  const onPageHide = () => suspendForBackground();
  const onPageShow = () => {
    backgrounded = documentTarget?.visibilityState === "hidden";
    if (!backgrounded && ambientRequested) void startAmbientWhenReady();
  };

  let unsubscribeMuted = () => {};
  if (typeof subscribeMuted === "function") {
    const unsubscribe = safely(() => subscribeMuted(onMute), null);
    if (typeof unsubscribe === "function") unsubscribeMuted = unsubscribe;
  }
  if (mediaQueryList) {
    if (typeof mediaQueryList.addEventListener === "function") safely(() => mediaQueryList.addEventListener("change", onReducedMotionChange));
    else if (typeof mediaQueryList.addListener === "function") safely(() => mediaQueryList.addListener(onReducedMotionChange));
  }
  documentTarget?.addEventListener?.("visibilitychange", onVisibilityChange);
  windowTarget?.addEventListener?.("pagehide", onPageHide);
  windowTarget?.addEventListener?.("pageshow", onPageShow);

  return Object.freeze({
    async enableFromGesture() {
      if (disposed) return false;
      const targetContext = ensureContext();
      if (!targetContext) return false;
      const generation = lifecycleGeneration;
      const resumed = await wakeContext(targetContext);
      if (!resumed || disposed || generation !== lifecycleGeneration || context !== targetContext || targetContext.state === "closed") return false;
      enabled = true;
      muted = Boolean(safely(() => readMuted(), muted));
      applyMasterGain();
      if (ambientRequested) await startAmbientWhenReady();
      if (disposed || generation !== lifecycleGeneration || context !== targetContext || targetContext.state === "closed") return false;
      scheduleIdleSuspend();
      return true;
    },
    play: playCue,
    /**
     * Plays one UI-synchronized settlement cue. Non-settlement cue names are
     * rejected so integration code cannot accidentally schedule generic table
     * feedback as part of the result choreography.
     */
    playSettlementCue(cue) {
      if (!VALID_SETTLEMENT_CUES.has(cue)) return Promise.resolve(false);
      return playCue(cue);
    },
    async startAmbient() {
      ambientRequested = true;
      return startAmbientWhenReady();
    },
    stopAmbient() {
      ambientRequested = false;
      stopAmbientNow();
    },
    setVolume(value) {
      masterGainValue = clamp(value, 0, MAX_MASTER_GAIN, masterGainValue);
      applyMasterGain();
      return masterGainValue;
    },
    setAmbientVolume(value) {
      ambientGainValue = clamp(value, 0, MAX_AMBIENT_GAIN, ambientGainValue);
      if (ambientNodes?.gain?.gain) setValue(ambientNodes.gain.gain, ambientGainValue, now());
      return ambientGainValue;
    },
    setAmbientPreset(value) {
      if (!AMBIENT_PROFILES[value]) return ambientPreset;
      if (ambientPreset === value) return ambientPreset;
      ambientPreset = value;
      if (ambientNodes) {
        stopAmbientNow();
        if (ambientRequested) void startAmbientWhenReady();
      }
      return ambientPreset;
    },
    getState() {
      return Object.freeze({
        enabled,
        muted,
        reducedMotion,
        backgrounded,
        ambientRequested,
        ambientActive: Boolean(ambientNodes),
        supported: Boolean(context),
        disposed,
        masterGain: masterGainValue,
        ambientGain: ambientGainValue,
        ambientPreset,
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifecycleGeneration += 1;
      enabled = false;
      clearIdleTimer();
      unsubscribeMuted();
      if (mediaQueryList) {
        if (typeof mediaQueryList.removeEventListener === "function") safely(() => mediaQueryList.removeEventListener("change", onReducedMotionChange));
        else if (typeof mediaQueryList.removeListener === "function") safely(() => mediaQueryList.removeListener(onReducedMotionChange));
      }
      documentTarget?.removeEventListener?.("visibilitychange", onVisibilityChange);
      windowTarget?.removeEventListener?.("pagehide", onPageHide);
      windowTarget?.removeEventListener?.("pageshow", onPageShow);
      stopAmbientNow();
      stopLiveSources();
      disconnect(masterNode);
      disconnect(limiterNode);
      const ownedContext = context;
      masterNode = null;
      limiterNode = null;
      context = null;
      if (ownedContext && ownedContext.state !== "closed" && typeof ownedContext.close === "function") {
        await Promise.resolve(safely(() => ownedContext.close())).catch(() => {});
      }
    },
  });
}
