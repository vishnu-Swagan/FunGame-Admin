// Procedural spatial audio for the casino floor. Everything is synthesized
// with the Web Audio API — no audio files — and positioned in 3D with
// PannerNodes (HRTF), so stations get louder and pan as you walk past them.
// Browsers output through whatever the OS gives (stereo, headphone spatial,
// or a surround receiver); the 3D panning survives all of them.

import { Vector3 } from "three";

export class FloorAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.emitters = [];
  }

  // Must be called from a user gesture (the Enter button).
  start() {
    if (this.ctx) {
      this.ctx.resume();
      this.enabled = true;
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
    this.enabled = true;
    this.ambience();
    this.riser();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return;
    this.master.gain.linearRampToValueAtTime(on ? 0.55 : 0, this.ctx.currentTime + 0.4);
  }

  /* ------------------------------ room tone ------------------------------ */

  ambience() {
    const ctx = this.ctx;
    // filtered noise = crowd murmur / air handling
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // brown-ish
      data[i] = last * 3.2;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.22;
    noise.connect(lp).connect(g).connect(this.master);
    noise.start();

    // slow warm pad (two detuned triangles through a gentle filter)
    const padG = ctx.createGain();
    padG.gain.value = 0.045;
    const padF = ctx.createBiquadFilter();
    padF.type = "lowpass";
    padF.frequency.value = 700;
    padF.connect(padG).connect(this.master);
    [110, 164.8, 220.5].forEach((f) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      o.detune.value = Math.random() * 8 - 4;
      o.connect(padF);
      o.start();
    });

    // sparse distant slot chimes
    const chime = () => {
      if (!this.enabled || this.ctx.state !== "running") return schedule();
      const notes = [880, 1108, 1318, 1760];
      const n = notes[Math.floor(Math.random() * notes.length)];
      this.pling(n, 0.05, 0.8, (Math.random() - 0.5) * 1.6);
      schedule();
    };
    const schedule = () => {
      this._chimeTimer = setTimeout(chime, 900 + Math.random() * 2600);
    };
    schedule();
  }

  riser() {
    // short cinematic swell on entry
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(60, t);
    o.frequency.exponentialRampToValueAtTime(240, t + 3);
    f.frequency.setValueAtTime(200, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 3);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 2.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
    o.connect(f).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 4.4);
  }

  /* --------------------------- one-shot helpers --------------------------- */

  pling(freq, gain, decay, pan = 0) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(p).connect(this.master);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  click() {
    this.pling(1600, 0.08, 0.09);
  }

  /* --------------------------- spatial emitters --------------------------- */

  // Attach a looping character sound to a world position.
  addEmitter(kind, position) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 2.5;
    panner.rolloffFactor = 1.6;
    panner.positionX.value = position[0];
    panner.positionY.value = 1.5;
    panner.positionZ.value = position[2];
    panner.connect(this.master);

    const fire = () => {
      if (!this.enabled || ctx.state !== "running") return;
      const t = ctx.currentTime;
      const g = ctx.createGain();
      g.connect(panner);
      const tone = (type, f0, f1, gain, dur) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f0, t);
        if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g);
        o.start(t);
        o.stop(t + dur + 0.05);
      };
      switch (kind) {
        case "slot":
          [660, 880, 1108].forEach((f, i) =>
            setTimeout(() => this.enabled && tone("square", f, 0, 0.05, 0.18), i * 90)
          );
          break;
        case "roulette":
          tone("triangle", 2200, 900, 0.05, 0.5); // ball whirr-down
          break;
        case "dice":
          tone("square", 180, 90, 0.09, 0.12);
          break;
        case "wheel":
          tone("sine", 520, 500, 0.05, 0.25); // clicker
          break;
        case "crash":
          tone("sawtooth", 140, 560, 0.045, 1.4); // rising engine
          break;
        case "cards":
          tone("triangle", 2600, 2200, 0.035, 0.06); // card flick
          break;
        default:
          tone("sine", 990, 0, 0.03, 0.3);
      }
    };
    const base = { slot: 3400, roulette: 5200, dice: 5000, wheel: 4500, crash: 6000, cards: 2600 }[kind] || 6000;
    const loop = () => {
      fire();
      timer.id = setTimeout(loop, base + Math.random() * 2500);
    };
    const timer = { id: setTimeout(loop, Math.random() * base) };
    this.emitters.push(timer);
  }

  // Called every frame with the camera so sound follows the player.
  updateListener(camera) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const L = this.ctx.listener;
    const p = camera.position;
    const fwd = camera.getWorldDirection(this._fwd || (this._fwd = new Vector3()));
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setTargetAtTime(p.x, t, 0.05);
      L.positionY.setTargetAtTime(p.y, t, 0.05);
      L.positionZ.setTargetAtTime(p.z, t, 0.05);
      L.forwardX.setTargetAtTime(fwd.x, t, 0.05);
      L.forwardY.setTargetAtTime(fwd.y, t, 0.05);
      L.forwardZ.setTargetAtTime(fwd.z, t, 0.05);
      L.upX.setTargetAtTime(0, t, 0.05);
      L.upY.setTargetAtTime(1, t, 0.05);
      L.upZ.setTargetAtTime(0, t, 0.05);
    } else if (L.setPosition) {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  dispose() {
    clearTimeout(this._chimeTimer);
    for (const e of this.emitters) clearTimeout(e.id);
    this.emitters = [];
    this.ctx?.close?.();
    this.ctx = null;
  }
}
