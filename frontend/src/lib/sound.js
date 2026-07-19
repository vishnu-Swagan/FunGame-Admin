/**
 * FunGame sound engine - lightweight WebAudio synth (no audio files needed).
 * Global mute persisted in localStorage; context resumes on first user gesture.
 */
let ctx = null;
let muted = typeof localStorage !== "undefined" && localStorage.getItem("fg_sound_muted") === "1";
const listeners = new Set();

export const isMuted = () => muted;
export const setMuted = (m) => {
  muted = m;
  try {
    localStorage.setItem("fg_sound_muted", m ? "1" : "0");
  } catch (e) {
    /* private mode */
  }
  listeners.forEach((f) => f(m));
};
export const toggleMuted = () => setMuted(!muted);
export const onMuteChange = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

const ac = () => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
};

// Unlock audio on the first user gesture (browser autoplay policy)
if (typeof window !== "undefined") {
  const unlock = () => {
    ac();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

function tone({ freq = 440, dur = 0.15, type = "sine", vol = 0.15, when = 0, slideTo = 0 }) {
  if (muted) return;
  const c = ac();
  if (!c) return;
  try {
    const t0 = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.06);
  } catch (e) {
    /* ignore */
  }
}

function noise({ dur = 0.2, vol = 0.12, when = 0, freq = 1800, q = 1, filter = "bandpass" }) {
  if (muted) return;
  const c = ac();
  if (!c) return;
  try {
    const t0 = c.currentTime + when;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t0);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  } catch (e) {
    /* ignore */
  }
}

export const sfx = {
  /* chips + outcomes (all games) */
  chip: () => {
    tone({ freq: 1900, dur: 0.05, type: "triangle", vol: 0.12 });
    tone({ freq: 2600, dur: 0.06, type: "triangle", vol: 0.09, when: 0.035 });
  },
  win: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.2, type: "triangle", vol: 0.16, when: i * 0.085 }));
  },
  bigWin: () => {
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone({ freq: f, dur: 0.22, type: "triangle", vol: 0.17, when: i * 0.08 }));
  },
  lose: () => {
    tone({ freq: 240, dur: 0.22, type: "sawtooth", vol: 0.05, slideTo: 150 });
    tone({ freq: 160, dur: 0.3, type: "sine", vol: 0.12, when: 0.05, slideTo: 90 });
  },
  push: () => tone({ freq: 520, dur: 0.14, type: "sine", vol: 0.1 }),

  /* reveal effects */
  dice: () => {
    for (let i = 0; i < 9; i++) {
      noise({ dur: 0.05, vol: 0.13, when: i * 0.12 + Math.random() * 0.04, freq: 900 + Math.random() * 2200, q: 2 });
    }
  },
  diceLand: () => {
    noise({ dur: 0.09, vol: 0.22, freq: 450, filter: "lowpass" });
    noise({ dur: 0.07, vol: 0.12, when: 0.09, freq: 600, filter: "lowpass" });
  },
  reel: () => {
    for (let i = 0; i < 12; i++) tone({ freq: 380 + (i % 3) * 90, dur: 0.04, type: "square", vol: 0.045, when: i * 0.09 });
  },
  deal: () => {
    [0, 0.12, 0.24].forEach((w) => noise({ dur: 0.055, vol: 0.11, when: w, freq: 3400, q: 1.4 }));
  },
  flick: () => {
    noise({ dur: 0.05, vol: 0.1, freq: 3200, q: 1.6 });
  },
  flip: () => {
    noise({ dur: 0.06, vol: 0.08, freq: 2400, q: 1.2 });
    tone({ freq: 1500, dur: 0.05, type: "triangle", vol: 0.05, when: 0.02 });
  },
  hold: () => {
    tone({ freq: 1200, dur: 0.07, type: "triangle", vol: 0.1 });
  },
  spin: () => {
    noise({ dur: 0.8, vol: 0.05, freq: 900, q: 0.8 });
    for (let i = 0; i < 8; i++) tone({ freq: 2100, dur: 0.02, type: "square", vol: 0.05, when: i * 0.12 });
  },
  draw: () => {
    for (let i = 0; i < 6; i++) tone({ freq: 1400 + i * 120, dur: 0.04, type: "sine", vol: 0.07, when: i * 0.14 });
  },

  /* roulette */
  ballSpin: () => {
    // decelerating ball ticks (~4.8s, like a real ball on the track)
    let t = 0;
    let gap = 0.055;
    while (t < 4.4) {
      tone({ freq: 2300, dur: 0.018, type: "square", vol: 0.05, when: t });
      t += gap;
      gap *= 1.09;
    }
    noise({ dur: 0.4, vol: 0.06, when: 4.5, freq: 700, filter: "lowpass" });
  },
  ballLand: () => {
    noise({ dur: 0.08, vol: 0.18, freq: 500, filter: "lowpass" });
    tone({ freq: 1200, dur: 0.06, type: "triangle", vol: 0.1, when: 0.04 });
  },

  /* aviator */
  takeoff: () => {
    tone({ freq: 140, dur: 1.4, type: "sawtooth", vol: 0.07, slideTo: 520 });
    noise({ dur: 1.2, vol: 0.045, freq: 800, q: 0.6 });
  },
  cashout: () => {
    [880, 1174, 1568].forEach((f, i) => tone({ freq: f, dur: 0.14, type: "triangle", vol: 0.18, when: i * 0.07 }));
  },
  crash: () => {
    noise({ dur: 0.5, vol: 0.25, freq: 320, filter: "lowpass", q: 0.7 });
    tone({ freq: 130, dur: 0.5, type: "sawtooth", vol: 0.14, slideTo: 55 });
  },
};
