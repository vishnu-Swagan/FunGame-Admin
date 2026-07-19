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

/* Master bus: louder output tamed by a compressor so nothing clips */
let masterBus = null;
const bus = (c) => {
  if (!masterBus) {
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    masterBus = c.createGain();
    masterBus.gain.value = 1.5;
    masterBus.connect(comp);
    comp.connect(c.destination);
  }
  return masterBus;
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
    o.connect(g).connect(bus(c));
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
    src.connect(f).connect(g).connect(bus(c));
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

  /* crowd atmosphere */
  cheer: (big = false) => {
    // crowd roar: filtered noise swell + a handful of gliding "voices"
    const dur = big ? 2.2 : 1.4;
    noise({ dur, vol: big ? 0.2 : 0.13, freq: 900, q: 0.5 });
    noise({ dur: dur * 0.8, vol: 0.09, when: 0.12, freq: 2200, q: 0.7 });
    const voices = big ? 8 : 5;
    for (let i = 0; i < voices; i++) {
      const f = 280 + Math.random() * 320;
      tone({ freq: f, dur: 0.5 + Math.random() * 0.45, type: "sawtooth", vol: 0.03, when: Math.random() * 0.5, slideTo: f * (1.12 + Math.random() * 0.25) });
    }
    if (big) tone({ freq: 1400, dur: 0.5, type: "sine", vol: 0.08, when: 0.35, slideTo: 2500 }); // whistle
  },
  clap: (big = false) => {
    // rhythmic applause from a couple of overlapping "clappers"
    const n = big ? 16 : 10;
    let t = 0.05;
    for (let i = 0; i < n; i++) {
      noise({ dur: 0.045, vol: 0.15, when: t + Math.random() * 0.02, freq: 1200 + Math.random() * 600, q: 2 });
      noise({ dur: 0.04, vol: 0.1, when: t + 0.035 + Math.random() * 0.02, freq: 900 + Math.random() * 500, q: 2 });
      t += 0.11 + Math.random() * 0.03;
    }
  },
  aww: () => {
    // crowd "hoooooo" of disappointment - detuned voices gliding down
    for (let i = 0; i < 6; i++) {
      const f = 330 + Math.random() * 90;
      tone({ freq: f, dur: 1.1 + Math.random() * 0.35, type: "sine", vol: 0.055, when: Math.random() * 0.18, slideTo: f * 0.55 });
    }
    noise({ dur: 1.25, vol: 0.06, freq: 500, q: 0.6 });
  },
  winCelebration: () => {
    sfx.win();
    sfx.cheer(false);
    sfx.clap(false);
  },
  bigWinCelebration: () => {
    sfx.bigWin();
    sfx.cheer(true);
    sfx.clap(true);
  },

  /* ---- slot cabinets (distinct per machine) ---- */
  lever: () => {
    // mechanical arm pull: clunk + spring + latch
    noise({ dur: 0.09, vol: 0.18, freq: 650, filter: "lowpass" });
    tone({ freq: 230, dur: 0.14, type: "square", vol: 0.07, when: 0.05, slideTo: 110 });
    noise({ dur: 0.06, vol: 0.13, when: 0.18, freq: 1500, q: 2 });
  },
  reelStop: () => {
    noise({ dur: 0.05, vol: 0.2, freq: 900, filter: "lowpass" });
    tone({ freq: 330, dur: 0.05, type: "square", vol: 0.09 });
  },
  slotBell: () => {
    // classic Vegas payout bell
    [1568, 1568, 2093].forEach((f, i) => tone({ freq: f, dur: 0.38, type: "triangle", vol: 0.16, when: i * 0.17 }));
  },
  lever777: () => {
    sfx.lever();
    for (let i = 0; i < 16; i++) tone({ freq: 300 + (i % 3) * 80, dur: 0.03, type: "square", vol: 0.05, when: 0.25 + i * 0.09 });
  },
  jokerLaugh: () => {
    // sneering descending "ha-ha-ha-ha"
    [659, 587, 523, 440].forEach((f, i) =>
      tone({ freq: f, dur: 0.17, type: "sawtooth", vol: 0.06, when: i * 0.16, slideTo: f * 0.8 })
    );
  },
  jokerSpin: () => {
    for (let i = 0; i < 14; i++) tone({ freq: 520 + (i % 4) * 140, dur: 0.035, type: "square", vol: 0.04, when: i * 0.09 });
    noise({ dur: 1.2, vol: 0.03, freq: 1700, q: 0.8 });
  },
  gong: () => {
    tone({ freq: 196, dur: 1.7, type: "sine", vol: 0.2 });
    tone({ freq: 294, dur: 1.25, type: "sine", vol: 0.09, when: 0.02 });
    tone({ freq: 392, dur: 0.9, type: "triangle", vol: 0.05, when: 0.05 });
    noise({ dur: 0.22, vol: 0.08, freq: 2600, q: 0.8 });
  },
  coinShower: () => {
    for (let i = 0; i < 11; i++)
      tone({ freq: 2100 + Math.random() * 1500, dur: 0.05, type: "triangle", vol: 0.07, when: i * 0.06 + Math.random() * 0.03 });
  },
  luckySpin: () => {
    // pentatonic pluck run (guzheng-like)
    [523, 587, 659, 784, 880].forEach((f, i) => tone({ freq: f * 2, dur: 0.1, type: "triangle", vol: 0.055, when: i * 0.13 }));
    noise({ dur: 1.1, vol: 0.028, freq: 1300, q: 0.7 });
  },
};

/* ---------------- Aviator flight engine (continuous, real plane feel) ----------------
   Twin detuned sawtooth "pistons" through a lowpass + looped air noise + a prop
   LFO throbbing the volume. Pitch/brightness rise with the multiplier; on crash
   the plane "flies away" with a doppler pitch drop and a long fade. */
let flightNodes = null;

export const flight = {
  start() {
    if (muted || flightNodes) return;
    const c = ac();
    if (!c) return;
    try {
      const out = c.createGain();
      out.gain.setValueAtTime(0.0001, c.currentTime);
      out.connect(bus(c));

      // engine core
      const o1 = c.createOscillator();
      o1.type = "sawtooth";
      o1.frequency.value = 84;
      const o2 = c.createOscillator();
      o2.type = "sawtooth";
      o2.frequency.value = 86.5; // slight detune = engine growl
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 260;
      lp.Q.value = 0.9;
      o1.connect(lp);
      o2.connect(lp);
      lp.connect(out);

      // air rushing past the fuselage
      const len = c.sampleRate * 2;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const air = c.createBufferSource();
      air.buffer = buf;
      air.loop = true;
      const airF = c.createBiquadFilter();
      airF.type = "bandpass";
      airF.frequency.value = 950;
      airF.Q.value = 0.5;
      const airG = c.createGain();
      airG.gain.value = 0.16;
      air.connect(airF).connect(airG).connect(out);

      // propeller throb
      const lfo = c.createOscillator();
      lfo.frequency.value = 12;
      const lfoG = c.createGain();
      lfoG.gain.value = 0.05;
      lfo.connect(lfoG);
      lfoG.connect(out.gain);

      // spool up like a real takeoff
      out.gain.exponentialRampToValueAtTime(0.2, c.currentTime + 1.4);
      o1.start();
      o2.start();
      air.start();
      lfo.start();
      flightNodes = { c, out, o1, o2, lp, air, lfo };
    } catch (e) {
      flightNodes = null;
    }
  },
  /* climb: pitch + brightness follow the multiplier */
  set(mult) {
    if (!flightNodes) return;
    try {
      const { c, o1, o2, lp, lfo } = flightNodes;
      const m = Math.min(10, Math.max(1, mult));
      const f = 84 + (m - 1) * 13;
      o1.frequency.setTargetAtTime(f, c.currentTime, 0.25);
      o2.frequency.setTargetAtTime(f * 1.03, c.currentTime, 0.25);
      lp.frequency.setTargetAtTime(260 + (m - 1) * 110, c.currentTime, 0.3);
      lfo.frequency.setTargetAtTime(12 + (m - 1) * 1.5, c.currentTime, 0.4);
    } catch (e) {
      /* ignore */
    }
  },
  /* the plane flew away: doppler pitch drop + long fade into the distance */
  flyAway() {
    if (!flightNodes) return;
    try {
      const { c, out, o1, o2, lp } = flightNodes;
      const t = c.currentTime;
      o1.frequency.setTargetAtTime(58, t, 0.55);
      o2.frequency.setTargetAtTime(59, t, 0.55);
      lp.frequency.setTargetAtTime(140, t, 0.5);
      out.gain.setTargetAtTime(0.0001, t + 0.15, 0.6);
    } catch (e) {
      /* ignore */
    }
    const nodes = flightNodes;
    flightNodes = null;
    setTimeout(() => flight._kill(nodes), 2800);
  },
  stop() {
    if (!flightNodes) return;
    const nodes = flightNodes;
    flightNodes = null;
    try {
      nodes.out.gain.setTargetAtTime(0.0001, nodes.c.currentTime, 0.08);
    } catch (e) {
      /* ignore */
    }
    setTimeout(() => flight._kill(nodes), 400);
  },
  _kill(nodes) {
    if (!nodes) return;
    try {
      nodes.o1.stop();
      nodes.o2.stop();
      nodes.air.stop();
      nodes.lfo.stop();
      nodes.out.disconnect();
    } catch (e) {
      /* ignore */
    }
  },
};

// stop the engine immediately if the player mutes mid-flight
listeners.add((m) => {
  if (m) flight.stop();
});

/* ---------------- Ambient casino music (generative, no files) ---------------- */
const CHORDS = [
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
  [261.63, 329.63, 392.0], // C
  [196.0, 246.94, 293.66], // G
];
let musicTimer = null;
let musicBeat = 0;
let musicNext = 0;

function musicNote(c, freq, t, dur, vol, type = "triangle") {
  try {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus(c));
    o.start(t);
    o.stop(t + dur + 0.05);
  } catch (e) {
    /* ignore */
  }
}

export const music = {
  start: () => {
    if (musicTimer || muted) return;
    const c = ac();
    if (!c) return;
    musicNext = c.currentTime + 0.15;
    musicBeat = 0;
    musicTimer = setInterval(() => {
      const c2 = ac();
      if (!c2 || muted) return;
      if (musicNext < c2.currentTime - 1) musicNext = c2.currentTime + 0.05; // catch up after tab sleep
      while (musicNext < c2.currentTime + 0.7) {
        const b = musicBeat;
        const chord = CHORDS[Math.floor(b / 8) % CHORDS.length];
        const note = chord[b % 3] * (b % 8 >= 4 ? 2 : 1);
        musicNote(c2, note, musicNext, 0.3, 0.028); // soft pluck
        if (b % 4 === 0) musicNote(c2, chord[0] / 2, musicNext, 0.6, 0.045, "sine"); // bass
        if (b % 8 === 6) musicNote(c2, chord[2] * 2, musicNext + 0.16, 0.22, 0.02); // sparkle
        musicNext += 0.32;
        musicBeat++;
      }
    }, 240);
  },
  stop: () => {
    clearInterval(musicTimer);
    musicTimer = null;
  },
};
