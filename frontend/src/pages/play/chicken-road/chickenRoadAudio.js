const MASTER_VOLUME = 0.32;
const SILENCE = 0.0001;

function browserAudioContext() {
  if (typeof window === "undefined") return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try { return new AudioContextClass({ latencyHint: "interactive" }); }
  catch { return new AudioContextClass(); }
}

function ignoreFailure(action) {
  try {
    const result = action();
    if (result?.catch) result.catch(() => {});
  } catch { /* Audio is optional; browser interruptions must not affect play. */ }
}

/**
 * Small, local-only sound effects. Construction is silent and does not create
 * an AudioContext. Call unlock() directly from a user gesture, then await its
 * boolean result before the first cue. Cues are never queued during resume.
 *
 * Every source is finite and owned by this controller. stopAll(), muting,
 * hiding the document, and disposal invalidate pending unlocks as well as
 * stopping current/future sources. A new gesture/unlock is needed afterward.
 *
 * Optional factory/document arguments are test seams; normal use needs none.
 */
export function createChickenRoadAudio(options = {}) {
  const createContext = options.audioContextFactory || browserAudioContext;
  const doc = options.document === undefined
    ? (typeof document === "undefined" ? null : document) : options.document;
  let context = null;
  let master = null;
  let noise = null;
  let resumePromise = null;
  let unlocked = false;
  let muted = false;
  let disposed = false;
  let generation = 0;
  let seed = 0x43a1b7;
  const voices = new Set();

  // A deterministic noise source avoids network assets and keeps the sound
  // texture consistent without consuming the game's outcome randomness.
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const hidden = () => doc?.hidden === true || doc?.visibilityState === "hidden";
  const canPlay = () => !disposed && !muted && !hidden() && unlocked && context?.state === "running";

  const removeVoice = (voice) => {
    if (!voices.delete(voice)) return;
    voice.source.onended = null;
    voice.nodes.forEach((node) => ignoreFailure(() => node.disconnect()));
  };

  const silence = () => {
    const now = context?.currentTime || 0;
    if (master) ignoreFailure(() => {
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(0, now);
      master.gain.value = 0;
    });
    [...voices].forEach((voice) => {
      ignoreFailure(() => voice.source.stop(now));
      removeVoice(voice);
    });
  };

  const stopAll = () => {
    generation += 1;
    unlocked = false;
    silence();
  };

  const ensureContext = () => {
    if (context) return context.state !== "closed";
    let candidate = null;
    let output = null;
    try {
      candidate = createContext();
      if (!candidate || candidate.state === "closed") return false;
      output = candidate.createGain();
      output.gain.value = 0;
      output.connect(candidate.destination);
      context = candidate;
      master = output;
      return true;
    } catch {
      if (output) ignoreFailure(() => output.disconnect());
      if (candidate) ignoreFailure(() => candidate.close());
      return false;
    }
  };

  const unlock = async () => {
    if (disposed || muted || hidden()) return false;
    const requestedGeneration = generation;
    if (!ensureContext()) return false;
    try {
      if (context.state !== "running") {
        if (!resumePromise) {
          // Calling resume before awaiting preserves the original gesture.
          resumePromise = Promise.resolve(context.resume());
          const pending = resumePromise;
          const clearPending = () => { if (resumePromise === pending) resumePromise = null; };
          pending.then(clearPending, clearPending);
        }
        await resumePromise;
      } else {
        // Include running contexts in cancellation semantics for same-tick mute.
        await Promise.resolve();
      }
      if (requestedGeneration !== generation || disposed || muted || hidden() || context.state !== "running") return false;
      unlocked = true;
      return true;
    } catch {
      return false;
    }
  };

  const getNoise = () => {
    if (noise) return noise;
    noise = context.createBuffer(1, Math.ceil(context.sampleRate * 1.4), context.sampleRate);
    const samples = noise.getChannelData(0);
    let grain = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const white = random() * 2 - 1;
      grain = grain * 0.91 + white * 0.09;
      samples[index] = white * 0.62 + grain * 0.38;
    }
    return noise;
  };

  const envelope = (parameter, at, duration, peak, attack) => {
    parameter.setValueAtTime(SILENCE, at);
    parameter.linearRampToValueAtTime(peak, at + Math.min(attack, duration * 0.3));
    parameter.exponentialRampToValueAtTime(SILENCE, at + duration);
  };

  const connectVoice = (source, filter, at, duration, peak, attack) => {
    const gain = context.createGain();
    const voice = { source, nodes: [source, filter, gain] };
    voices.add(voice);
    source.onended = () => removeVoice(voice);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    envelope(gain.gain, at, duration, peak, attack);
    return voice;
  };

  const noiseVoice = (at, duration, peak, frequency, endFrequency = frequency, attack = 0.009, type = "bandpass") => {
    const source = context.createBufferSource();
    source.buffer = getNoise();
    source.loop = false;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.Q.value = 0.65;
    filter.frequency.setValueAtTime(frequency, at);
    filter.frequency.exponentialRampToValueAtTime(endFrequency, at + duration);
    connectVoice(source, filter, at, duration, peak, attack);
    source.start(at, random() * 0.12);
    source.stop(at + duration + 0.01);
  };

  const toneVoice = (at, duration, peak, pitches, type = "triangle") => {
    const source = context.createOscillator();
    source.type = type;
    source.frequency.setValueAtTime(pitches[0][1], at);
    pitches.slice(1).forEach(([position, frequency]) => {
      source.frequency.exponentialRampToValueAtTime(frequency, at + duration * position);
    });
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    filter.Q.value = 0.5;
    connectVoice(source, filter, at, duration, peak, 0.008);
    source.start(at);
    source.stop(at + duration + 0.01);
  };

  const cue = (schedule) => {
    if (!canPlay()) return false;
    // One foreground action at a time: a collision replaces its walking tail.
    silence();
    try {
      const at = context.currentTime + 0.006;
      master.gain.setValueAtTime(MASTER_VOLUME, context.currentTime);
      schedule(at);
      return true;
    } catch {
      stopAll();
      return false;
    }
  };

  const playWalk = (durationMs = 480) => cue((at) => {
    const duration = Math.min(1200, Math.max(160, Number.isFinite(durationMs) ? durationMs : 480)) / 1000;
    const steps = Math.max(2, Math.min(5, Math.round(duration / 0.17)));
    const stride = (duration - 0.11) / (steps - 1);
    for (let index = 0; index < steps; index += 1) {
      const foot = at + 0.014 + index * stride;
      const weight = index % 2 ? 0.85 : 1;
      // The low body and filtered grain read as feet meeting a rough surface.
      toneVoice(foot, 0.085, 0.13 * weight, [[0, 178 + index * 9], [0.35, 112], [1, 69]], "sine");
      noiseVoice(foot + 0.003, 0.072, 0.18 * weight, 1050, 430, 0.004, "lowpass");
      noiseVoice(foot + 0.027, 0.06, 0.025, 3500, 1800, 0.012);
    }
    // A restrained two-part cluck sits below the footfall volume.
    toneVoice(at + duration * 0.18, 0.078, 0.046, [[0, 430], [0.18, 610], [1, 285]]);
    toneVoice(at + duration * 0.18 + 0.063, 0.058, 0.027, [[0, 370], [0.2, 460], [1, 225]]);
  });

  const playFire = () => cue((at) => {
    // Fast air movement, a soft low body, and irregular dry crackles; no loop.
    noiseVoice(at, 0.62, 0.3, 1800, 350, 0.07, "lowpass");
    noiseVoice(at + 0.018, 0.38, 0.12, 700, 2900, 0.025);
    toneVoice(at, 0.32, 0.13, [[0, 112], [0.2, 78], [1, 43]], "sine");
    for (let index = 0; index < 9; index += 1) {
      const crack = at + 0.065 + index * 0.057 + random() * 0.026;
      noiseVoice(crack, 0.018 + random() * 0.021, 0.08 + random() * 0.07, 2300 + random() * 2200, 1050, 0.002);
    }
    toneVoice(at + 0.042, 0.23, 0.057, [[0, 490], [0.2, 1080], [0.55, 740], [1, 295]]);
    noiseVoice(at + 0.058, 0.17, 0.035, 1450, 750, 0.012);
  });

  const setMuted = (value) => {
    muted = Boolean(value);
    if (muted) stopAll();
    return muted;
  };

  const onVisibilityChange = () => { if (hidden()) stopAll(); };
  doc?.addEventListener?.("visibilitychange", onVisibilityChange);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopAll();
    doc?.removeEventListener?.("visibilitychange", onVisibilityChange);
    if (master) ignoreFailure(() => master.disconnect());
    if (context) ignoreFailure(() => context.close());
    noise = null;
  };

  return { unlock, setMuted, playWalk, playFire, stopAll, dispose };
}
