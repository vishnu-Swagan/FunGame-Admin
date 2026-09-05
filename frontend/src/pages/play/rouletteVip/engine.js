import { MARKUP } from "./markup.js";
import { CLIENT_BETTING_GUARD_SECONDS, secondsUntil } from "@/lib/serverClock";

export function gateRouletteWheelAssets(phone) {
  if (!phone) return () => {};
  phone.dataset.mode = "bet";
  phone.dataset.wheelReady = "false";
  const images = Array.from(phone.querySelectorAll(".topimg"));
  if (!images.length) return () => {};
  const loaded = new Set();
  let active = true;
  const revealIfComplete = (image) => {
    if (!active || loaded.has(image)) return;
    loaded.add(image);
    if (loaded.size === images.length) phone.dataset.wheelReady = "true";
  };
  const listeners = images.map((image) => {
    const onLoad = () => revealIfComplete(image);
    image.addEventListener("load", onLoad, { once: true });
    if (image.complete && image.naturalWidth > 0) revealIfComplete(image);
    return [image, onLoad];
  });
  return () => {
    active = false;
    listeners.forEach(([image, onLoad]) => image.removeEventListener("load", onLoad));
  };
}

/**
 * The roulette table, mounted into a plain DOM node.
 *
 * The game positions every chip, anchor, racetrack point and the ball itself by
 * measuring real element rectangles. That work is already written and tested
 * against this exact markup, so it stays as imperative DOM code rather than
 * being re-expressed as React components — React owns the mount point, this owns
 * what is inside it.
 *
 * Crucially the engine is not authoritative: it never draws a winner, never
 * moves the balance on its own account and never settles a bet. It renders the
 * state the server hands it and reports taps back through the callbacks.
 *
 * @param {HTMLElement} root      empty node to mount into
 * @param {object}      opts
 * @param {function}    opts.onPlaceBet (bet_type, value, amount, key)
 * @param {function}    opts.onUndo
 * @param {function}    opts.onClear
 * @returns {{applyState:function, setHistory:function, destroy:function}}
 */
export function mountRoulette(root, opts) {
  opts = opts || {};
  root.classList.add('rvip');
  // parsed rather than assigned: the markup is ours and static, but parsing it
  // through DOMParser keeps the innerHTML idiom out of the app entirely
  const parsed = new DOMParser().parseFromString('<div>' + MARKUP + '</div>', 'text/html');
  root.replaceChildren(...parsed.body.firstChild.childNodes);
  const initialNeighbourCost = root.querySelector('#nbCost');
  if (initialNeighbourCost) initialNeighbourCost.textContent = 'Stake 5';
  const stakePicker = root.querySelector('#chipslot');
  if (stakePicker) stakePicker.setAttribute('aria-label', 'Stake value');
  const lowBalanceCopy = root.querySelector('#scrim .modal p');
  if (lowBalanceCopy) lowBalanceCopy.textContent = 'Your available balance is too low to cover that bet. Reduce the stake or deposit funds in your wallet.';
  const tableName = root.querySelector('.tablename');
  const onPlaceBet = opts.onPlaceBet || (() => {});
  const onUndo = opts.onUndo || (() => {});
  const onClear = opts.onClear || (() => {});
  const onSoundChange = opts.onSoundChange || (() => {});
  const onExit = opts.onExit || null;
  'use strict';

  const RED  = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  /* The American double-zero wheel. Not the European order with 00 inserted — a
     different sequence, with 0 and 00 diametrically opposite. Pockets are LABELS
     rather than numbers, because "00" is not one: as an integer it collapses onto
     0 and every bet on it would settle as a bet on the single zero. */
  const POCKETS = ['0','28','9','26','30','11','7','20','32','17','5','22','34','15','3','24','36','13','1','00',
                   '27','10','25','29','12','8','19','31','18','6','21','33','16','4','23','35','14','2'];
  const NP = POCKETS.length;
  const isZero = s => s === '0' || s === '00';
  const hueOf = s => isZero(s) ? 'green' : (RED.has(+s) ? 'red' : 'black');
  const EURO = POCKETS;               // the wheel-order sequence, whatever the wheel
  const SEG  = 360 / NP;
  const CHIPS = [10, 50, 100, 500, 1000];
  let timing = { bettingSeconds: 30, spinSeconds: 20, resultSeconds: 10, roundSeconds: 60 };
  let tableLimits = { minimum: 10, even_money_position_max: 2000, position_max: 10000 };

  /* ---- calibrated projective model of the photographed wheel ----
     A circle photographed in perspective does NOT map equal wheel angles onto
     equal steps around a plain ellipse — the far side compresses. Earlier builds
     used a centred ellipse with a fixed angle per pocket, which was right near
     its anchor and up to two pockets out on the opposite side; that is why the
     ball kept stopping beside the wrong printed number.

         u = cos(t) / (1 + e*sin(t))      x = cx + a*s*u
         v = sin(t) / (1 + e*sin(t))      y = cy + b*s*v

     Fitted against the wheel's own red/black sequence with the green zero as a
     HARD anchor — the zero is the only feature that breaks the R,B,R,B
     alternation, so without pinning it a shift of an even number of pockets
     scores identically and the fit drifts. 36/37 pockets verify against their
     printed colour, each judged against its own neighbours. */
  /* rectify.py built the overhead image on these same two numbers, so a pocket's
     angle is identical in the photograph and in the rectified circle */
  const PDIR = 1;                       // sequence runs clockwise in image angle
  const PTH0 = -1.218953;               // angle of the green zero, radians
  const SEG_R = 2 * Math.PI / NP;

  const pocketTheta = n => PTH0 + PDIR * POCKETS.indexOf(String(n)) * SEG_R;

  const $ = id => root.querySelector('#' + id);
  const phone = $('phone'), board = $('board');
  const releaseWheelAssetGate = gateRouletteWheelAssets(phone);
  const ball = $('ball'), bshadow = $('bshadow');
  const pastEl = $('past'), latestEl = $('latest'), ringval = $('ringval'), toastEl = $('toast');
  const timerEl = $('bettimer');
  // The wheel stage intentionally collapses while betting. Keep the clock in
  // the fixed history strip: it remains visible in every phase/orientation and
  // never covers a betting target (particularly the portrait outside column).
  const historyStrip = root.querySelector('.history');
  if (historyStrip && timerEl) historyStrip.appendChild(timerEl);

  let chipIdx = 0, balance = 12500;
  let bets = [], lastBets = [];
  let acceptingBets = false;
  let history = [];
  let rafId = 0;


  /* ================= sound =================
     Every sound here is synthesised. The artifact's CSP blocks requests to any
     external host, so there is no sample to load — which suits a roulette ball
     anyway: a rolling ball is filtered noise whose brightness tracks its speed,
     and that is far better done from the physics than from a fixed loop that
     would drift out of step with the animation.

     Browsers will not start audio without a gesture, and this table runs its own
     rounds whether or not anyone touches it, so the context is created suspended
     and resumed by the first tap anywhere. Until then everything below is a
     no-op rather than an error. */
  const Sound = (() => {
    let ctx = null, master = null, bedGain = null, on = true, started = false;
    let noiseBuf = null;
    let roll = null;                       // the persistent rolling voice
    let bedTimer = 0, bedStep = 0;

    const now = () => ctx.currentTime;

    function makeNoise() {
      const n = ctx.sampleRate * 2;
      const b = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = b.getChannelData(0);
      // brown-ish noise: a roll is weighted low, white noise reads as hiss
      let last = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2 + w * 0.35;
      }
      return b;
    }

    function init() {
      if (ctx) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = on ? 0.9 : 0;
      /* A dry path retains precise ball/chip transients; a short stereo room
         send gives the cabinet physical space. The compressor protects phone
         speakers when the rolling voice, countdown and result sting overlap. */
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.knee.value = 10;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.22;
      master.connect(compressor);
      compressor.connect(ctx.destination);
      try {
        const length = Math.floor(ctx.sampleRate * 1.15);
        const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let channel = 0; channel < 2; channel++) {
          const data = impulse.getChannelData(channel);
          for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.1);
          }
        }
        const delay = ctx.createDelay();
        delay.delayTime.value = 0.014;
        const room = ctx.createConvolver();
        room.buffer = impulse;
        const wet = ctx.createGain();
        wet.gain.value = 0.11;
        master.connect(delay);
        delay.connect(room);
        room.connect(wet);
        wet.connect(compressor);
      } catch (e) { /* the dry mix remains complete on older browsers */ }
      bedGain = ctx.createGain();
      bedGain.gain.value = 0.0;
      bedGain.connect(master);
      noiseBuf = makeNoise();
      return true;
    }

    /* --- the bed: a slow four-chord turn, kept quiet enough to sit under the
       table talk. Warm and moving rather than dramatic; a loop this long is
       going to be heard for a long time. --- */
    const CHORDS = [
      [147.0, 220.0, 261.6, 329.6],       // D3 A3 C4 E4
      [130.8, 196.0, 246.9, 311.1],       // C3 G3 B3 D#4
      [110.0, 164.8, 220.0, 277.2],       // A2 E3 A3 C#4
      [123.5, 185.0, 233.1, 293.7],       // B2 F#3 A#3 D4
    ];

    function pad(freqs, dur) {
      const t = now();
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(0, t + dur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(700, t);
      lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.4);
      lp.frequency.linearRampToValueAtTime(600, t + dur);
      lp.Q.value = 0.6;
      g.connect(lp); lp.connect(bedGain);
      freqs.forEach((f, i) => {
        const o = ctx.createOscillator();
        o.type = i === 0 ? 'sine' : 'triangle';
        o.frequency.value = f;
        // a touch of detune so the chord breathes instead of sitting dead still
        o.detune.value = (i % 2 ? 5 : -5) + Math.sin(bedStep + i) * 3;
        const vg = ctx.createGain();
        vg.gain.value = i === 0 ? 0.5 : 0.26;
        o.connect(vg); vg.connect(g);
        o.start(t); o.stop(t + dur + 0.1);
      });
    }

    function bedTick() {
      const dur = 4.2;
      pad(CHORDS[bedStep % CHORDS.length], dur);
      bedStep++;
      bedTimer = setTimeout(bedTick, dur * 900);
    }

    function startBed() {
      if (!ctx || bedTimer) return;
      bedGain.gain.cancelScheduledValues(now());
      bedGain.gain.setValueAtTime(bedGain.gain.value, now());
      bedGain.gain.linearRampToValueAtTime(0.085, now() + 3);
      bedTick();
    }

    /* --- the ball --- */
    function rollStart() {
      if (!ctx || roll) return;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.5;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start();
      roll = { src, bp, g };
    }

    /* `speed` is normalised: 1 at full pelt on the apron, 0 seated. */
    function rollSet(speed, seated) {
      if (!roll) return;
      const t = now();
      const s = Math.max(0, Math.min(1, speed));
      const target = seated ? 0 : 0.05 + 0.20 * s;
      roll.g.gain.setTargetAtTime(target, t, 0.05);
      roll.bp.frequency.setTargetAtTime(520 + 1750 * s, t, 0.08);
      roll.bp.Q.setTargetAtTime(1.2 + 2.4 * (1 - s), t, 0.1);
    }

    function rollStop() {
      if (!roll) return;
      const r = roll; roll = null;
      const t = now();
      r.g.gain.setTargetAtTime(0, t, 0.08);
      setTimeout(() => { try { r.src.stop(); } catch (e) {} }, 600);
    }

    /* a strike: noise transient through a resonator, so wood and brass differ
       only by where the resonance sits */
    function strike(freq, mag, dur, q) {
      if (!ctx || !on) return;
      const t = now();
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.playbackRate.value = 1.4;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(Math.min(0.5, mag), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(t); src.stop(t + dur + 0.02);
    }

    const clack = mag => strike(1500 + Math.random() * 700, 0.34 * mag, 0.10, 5);
    const fret  = mag => strike(2400 + Math.random() * 1400, 0.20 * mag, 0.055, 9);
    const seat  = ()  => { strike(420, 0.30, 0.20, 3); strike(1100, 0.12, 0.09, 6); };

    function chipTick() {
      if (!ctx || !on) return;
      strike(2600 + Math.random() * 500, 0.16, 0.045, 12);
    }

    /* a short rising figure on a win, its length scaled by how big the win is —
       a 10-chip return should not sound like a jackpot */
    function win(ratio) {
      if (!ctx || !on) return;
      const steps = ratio >= 20 ? [0, 4, 7, 12, 16, 19] : ratio >= 5 ? [0, 4, 7, 12] : [0, 7];
      steps.forEach((semi, i) => {
        const t = now() + i * 0.085;
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = 392 * Math.pow(2, semi / 12);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.15, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0008, t + 0.42);
        o.connect(g); g.connect(master);
        o.start(t); o.stop(t + 0.45);
      });
    }

    /* The last three seconds. Two short square-wave blips a semitone apart,
       rising each second, so the urgency is audible without watching the ring.
       Louder than the rest of the mix on purpose — it is the one sound that has
       to cut through, and the final second gets a longer, lower tone so "closed"
       sounds different from "hurry". */
    function alarm(secondsLeft) {
      if (!ctx || !on) return;
      const last = secondsLeft <= 0;
      const base = last ? 300 : 620 * Math.pow(2, (3 - secondsLeft) * 2 / 12);
      const beeps = last ? [[0, 0.34]] : [[0, 0.075], [0.115, 0.075]];
      beeps.forEach(([off, dur]) => {
        const t = now() + off;
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.setValueAtTime(base, t);
        if (last) o.frequency.exponentialRampToValueAtTime(base * 0.6, t + dur);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 2600;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(last ? 0.20 : 0.15, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
        o.connect(lp); lp.connect(g); g.connect(master);
        o.start(t); o.stop(t + dur + 0.02);
      });
    }

    function lose() {
      if (!ctx || !on) return;
      strike(300, 0.10, 0.22, 2);
    }

    function setOn(v) {
      on = v;
      if (master) master.gain.setTargetAtTime(v ? 0.9 : 0, now(), 0.05);
      if (v && ctx && ctx.state === 'suspended') ctx.resume();
    }

    /* the first gesture is the only chance to start audio, whatever it was for */
    function unlock() {
      if (started) return;
      if (!init()) return;
      started = true;
      ctx.resume().then(() => { if (on) startBed(); }).catch(() => {});
    }

    return {
      unlock, setOn,
      isOn: () => on,
      ready: () => started && ctx && ctx.state === 'running',
      rollStart, rollSet, rollStop,
      clack, fret, seat, chipTick, win, lose, alarm,
    };
  })();

  window.addEventListener('pointerdown', Sound.unlock, { capture: true });
  window.addEventListener('keydown', Sound.unlock, { capture: true });

  /* ---------- ball placement ----------
     The ball is only ever shown over the rectified overhead wheel, which is a
     true circle, so this is plain polar geometry — no perspective term, and no
     near-side size cheat, because from directly above there is no near side.

     `scale` is the orbit radius as a multiple of the pocket ring: S_TRACK out on
     the apron, S_POCKET seated. `lift` raises it off the surface for deflector
     strikes and fret rattle. Seen from overhead a lift moves the ball nowhere,
     so it reads as the ball growing and its shadow sliding out from under it. */
  const TOP_R = 0.306;                  // pocket ring radius, fraction of the square
  const S_TRACK = 1.45;                 // the apron the ball runs on, just outside the numbers
  const S_POCKET = 0.97;                // seated on a pocket floor

  /* The head turns, so a pocket's angle in the IMAGE is no longer its angle on
     SCREEN — the screen angle is the image angle plus however far the head has
     turned. Every use of a pocket position has to go through this, or the ball
     lands on the number that used to be there. */
  let wheelPhi = 0;
  const headEl = $('tophead');

  function setWheel(phi) {
    wheelPhi = phi;
    headEl.style.transform = 'rotate(' + (phi * 180 / Math.PI).toFixed(3) + 'deg)';
  }
  const screenTheta = n => pocketTheta(n) + wheelPhi;

  function setBall(theta, scale, lift) {
    const x = 0.5 + TOP_R * scale * Math.cos(theta);
    const y = 0.5 + TOP_R * scale * Math.sin(theta);

    ball.style.left = (x * 100) + '%';
    ball.style.top = (y * 100) + '%';
    ball.style.transform = `translate(-50%, -50%) scale(${(1 + lift * 9).toFixed(3)})`;

    // the key light is up and to the left, so the shadow slides down and right
    bshadow.style.left = ((x + lift * 0.9) * 100) + '%';
    bshadow.style.top = ((y + lift * 0.9) * 100) + '%';
    bshadow.style.opacity = String(Math.max(0.12, 0.5 - lift * 6));
  }

  /* ---------- the spin ----------
     The wheel never turns, so the target is fixed: the ball has to arrive at the
     winning pocket's own angle in the calibrated model. */
  function spin(winning, durationMs) {
    cancelAnimationFrame(rafId);

    const D = durationMs;

    /* The head turns one way and the ball the other, as on a real table. The
       head's travel is decided up front so the ball's landing angle can be
       computed from it: the ball must arrive at the winning pocket's angle ON
       SCREEN, which is its image angle plus the head's FINAL rotation. Both ease
       to a stop together, so the dead stop still holds. */
    const phi0 = wheelPhi;
    const headTurn = -(5 + Math.random() * 2) * 2 * Math.PI;   // counter to the ball
    const easeHead = x => 1 - Math.pow(1 - x, 2.4);
    const phiEnd = phi0 + headTurn;

    const tEnd = pocketTheta(winning) + phiEnd;
    const laps = 11 + Math.floor(Math.random() * 4);
    const t0 = tEnd - PDIR * (laps * 2 * Math.PI + Math.random() * Math.PI);

    const dropAt = 0.46 + Math.random() * 0.06;
    const rattleAt = 0.82 + Math.random() * 0.04;
    const ease = x => 1 - Math.pow(1 - x, 3.1);
    const smooth = x => x * x * (3 - 2 * x);

    const hit = { mag: 0, at: 0 };
    let lastSector = -1;
    const start = performance.now();

    /* The roll is driven off the ball's own angular speed rather than a timer, so
       it slows exactly as the ball does and the pitch never drifts out of step
       with what is on screen. Fret ticks come from counting pocket boundaries
       crossed, which is also how the strikes are detected — proximity would let
       a fast ball slip past a fret between two frames. */
    Sound.rollStart();
    let prevTheta = null, prevNow = start, lastFret = null;
    const TOP_SPEED = 26;                  // rad/s, roughly the opening pace

    const frame = now => {
      const x = Math.min(1, (now - start) / D);
      setWheel(phi0 + headTurn * easeHead(x));
      const theta = t0 + (tEnd - t0) * ease(x);

      let p, lift = 0;                        // p: 1 on the track, 0 seated
      if (x < dropAt) {
        p = 1;
      } else if (x < rattleAt) {
        const q = smooth((x - dropAt) / (rattleAt - dropAt));
        p = 1 - q;

        /* deflector strikes, by sector crossing rather than proximity so a fast
           ball can never skip a diamond between two frames. The diamonds are on
           the bowl, so these are counted in SCREEN angle, not the head's. */
        const deg = ((theta * 180 / Math.PI) % 360 + 360) % 360;
        const sector = Math.floor(deg / 45);
        if (sector !== lastSector) {
          if (lastSector !== -1 && q < 0.8) {
            hit.mag = (0.55 + Math.random() * 0.8) * (1 - q);
            hit.at = x;
            Sound.clack(hit.mag);
          }
          lastSector = sector;
        }
        if (hit.mag > 0) {
          const age = (x - hit.at) / 0.06;
          if (age < 1) {
            const k = Math.sin(age * Math.PI) * (1 - age) * hit.mag;
            p += k * 0.13;
            lift = Math.abs(k) * 0.026;
          } else {
            hit.mag = 0;
          }
        }
      } else {
        // fret rattle, damping into the pocket
        const q = (x - rattleAt) / (1 - rattleAt);
        const damp = Math.pow(1 - q, 2.5);
        p = Math.sin(q * 30) * 0.07 * damp;
        lift = Math.abs(Math.sin(q * 24)) * 0.02 * damp;
      }

      const scale = S_POCKET + (S_TRACK - S_POCKET) * Math.max(0, p);
      ball.classList.toggle('fast', x < 0.55);
      setBall(theta, scale, lift);

      // --- sound, from the same numbers that move the ball ---
      const dt = Math.max(1, now - prevNow) / 1000;
      const omega = prevTheta === null ? TOP_SPEED : Math.abs(theta - prevTheta) / dt;
      prevTheta = theta; prevNow = now;
      Sound.rollSet(omega / TOP_SPEED, false);

      // one tick per fret, but only once the ball is slow enough to hear them
      // individually — at speed they merge into the roll and would just buzz.
      // Fret crossings are RELATIVE to the head, so the head's turn counts too.
      if (omega < 9) {
        const fretIdx = Math.round((theta - wheelPhi - PTH0) / (PDIR * SEG_R));
        if (lastFret !== null && fretIdx !== lastFret) {
          Sound.fret(Math.min(1, 0.35 + (9 - omega) / 9));
        }
        lastFret = fretIdx;
      } else {
        lastFret = null;
      }

      if (x < 1) {
        rafId = requestAnimationFrame(frame);
      } else {
        // dead stop: head parked, ball seated in the winning pocket, nothing drifts
        setWheel(phiEnd);
        ball.classList.remove('fast');
        setBall(tEnd, S_POCKET, 0);
        Sound.rollSet(0, true);
        Sound.rollStop();
        Sound.seat();
      }
    };
    rafId = requestAnimationFrame(frame);
  }

  /* Park the ball in a pocket and leave it there. */
  function restAt(number) {
    cancelAnimationFrame(rafId);
    ball.classList.remove('fast');
    setBall(screenTheta(number), S_POCKET, 0);
  }


  /* ---------- history ---------- */
  function renderHistory() {
    latestEl.textContent = history[0];
    const frag = document.createDocumentFragment();
    history.slice(1, 14).forEach(n => {
      const s = document.createElement('span');
      s.className = 'h-' + { green: 'green', red: 'red', black: 'black' }[hueOf(String(n))];
      s.textContent = n;
      frag.appendChild(s);
    });
    pastEl.replaceChildren(frag);
  }

  /* ---------- board ---------- */
  function mkCell(cls, key, node, style) {
    const b = document.createElement('button');
    b.className = 'cell ' + cls;
    b.dataset.bet = key;
    if (node) b.appendChild(node);
    Object.assign(b.style, style);
    board.appendChild(b);
    return b;
  }
  const vLabel = txt => { const s = document.createElement('span'); s.textContent = txt; return s; };

  /* The layout is generated, not written out, so it can be built either way up.

     Portrait stacks twelve rows of three, which is the phone-native arrangement.
     Landscape uses the CLASSIC table — three rows of twelve — because a phone on
     its side has only about 250px of height whatever else is done, and thirteen
     stacked rows in that space gives 16px cells that cannot be bet on reliably.
     Five rows in the same space gives about 45px. Same DOM, same keys, same
     settlement; only the grid placement differs. */
  /* Use the wide casino layout on sideways phones as well as tablets and
     desktops. Below 560px the 14-column board is too narrow for dependable
     split/corner taps, so the roomier portrait topology remains. */
  const LAND_MQ = window.matchMedia('(orientation: landscape) and (min-width: 560px)');

  const OUTSIDES_ROW = [
    { key: 'range:low',   label: '1-18'  },
    { key: 'parity:even', label: 'EVEN'  },
    { key: 'color:red',   dia: ''        },
    { key: 'color:black', dia: 'blk'     },
    { key: 'parity:odd',  label: 'ODD'   },
    { key: 'range:high',  label: '19-36' },
  ];

  function buildBoard(land) {
    board.replaceChildren();
    board.classList.toggle('land', !!land);

    /* The zero has to be IN the grid in landscape. As a wide arc above the board
       it is geometrically adjacent to nothing: the anchors for 0/1, 0/2, 0/3 and
       the two trios are midpoints between the arc's centre and cells 1, 2 and 3,
       which in portrait sit directly beneath it — but in landscape 1, 2 and 3 are
       the leftmost COLUMN, so those midpoints landed in the middle of the number
       grid and quietly stole taps from real numbers. As a cell spanning the three
       rows at the end of the layout — where a real table puts it — the same
       geometric rule gives the right answer. */
    if (land) {
      /* Six half-rows for the numbers so the end column can be split in two:
         a number spans two of them, each zero spans three. */
      [['0', '1 / span 3'], ['00', '4 / span 3']].forEach(([lab, row]) => {
        const z = mkCell('zero', 'straight:' + lab, null, { gridColumn: '1', gridRow: row });
        z.append(lab);
      });
    }

    OUTSIDES_ROW.forEach((o, i) => {
      let node;
      if (o.label) node = vLabel(o.label);
      else { node = document.createElement('span'); node.className = 'diamond ' + o.dia; }
      mkCell('outside', o.key, node, land
        ? { gridColumn: `${2 + i * 2} / span 2`, gridRow: '8' }
        : { gridColumn: '1', gridRow: `${i * 2 + 1} / span 2` });
    });

    [['1', 'ST'], ['2', 'ND'], ['3', 'RD']].forEach(([n, ord], i) => {
      const sp = document.createElement('span');
      sp.append(n);
      const sup = document.createElement('sup');
      sup.textContent = ord;
      sp.append(sup, ' 12');
      mkCell('dozen', 'dozen:' + n, sp, land
        ? { gridColumn: `${2 + i * 4} / span 4`, gridRow: '7' }
        : { gridColumn: '2', gridRow: `${i * 4 + 1} / span 4` });
    });

    for (let n = 1; n <= 36; n++) {
      /* Landscape runs the classic way: the top row is 3, 6, 9 … 36, so a
         number's row is counted up from the bottom and its column is its trio. */
      const style = land
        ? { gridColumn: String(1 + Math.ceil(n / 3)),
            gridRow: ((3 - ((n - 1) % 3)) * 2 - 1) + ' / span 2' }
        : { gridColumn: String(((n - 1) % 3) + 3), gridRow: String(Math.ceil(n / 3)) };
      const c = mkCell(RED.has(n) ? 'red' : 'black', 'straight:' + n, null, style);
      c.append(String(n));
    }

    for (let col = 0; col < 3; col++) {
      // the 2 TO 1 for the row that column ends up on: landscape's top row is the
      // third column of numbers, so the order inverts
      const c = mkCell('col21', 'column:' + (col + 1), null, land
        ? { gridColumn: '14', gridRow: ((3 - col) * 2 - 1) + ' / span 2' }
        : { gridColumn: String(col + 3), gridRow: '13' });
      /* .cell is display:grid, so EVERY child becomes its own grid item and
         they stack vertically — nowrap cannot save it. The whole label has to
         be a single element. */
      const lab = document.createElement('span');
      lab.className = 'c21';
      lab.append('2');
      const to = document.createElement('span');
      to.className = 'to';
      to.textContent = 'TO';
      lab.append(to, '1');
      c.append(lab);
    }
  }

  buildBoard(LAND_MQ.matches);
  // rebuilding on rotation also invalidates the anchors, so relayout follows
  const onOrient = () => { buildBoard(LAND_MQ.matches); relayout(); };
  if (LAND_MQ.addEventListener) LAND_MQ.addEventListener('change', onOrient);
  else LAND_MQ.addListener(onOrient);

  /* ---------- money / bets ---------- */
  const fmt = n => Number(n || 0).toLocaleString('en-IN');
  const syncTableLimits = () => {
    const range = tableName && tableName.querySelector('b');
    if (range) range.textContent = `${fmt(tableLimits.minimum)} – ${fmt(tableLimits.position_max)}`;
  };
  syncTableLimits();

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('on'), 1600);
  }

  /* The balance is counted up rather than snapped, and flashes gold, because a
     silent number change is easy to miss — which reads as "I wasn't paid". */
  let balShown = balance;
  let balAnim = 0;
  function creditBalance(to) {
    cancelAnimationFrame(balAnim);
    const from = balShown, D = 700, t0 = performance.now();
    const el = $('balance');
    el.classList.add('credit');
    const step = now => {
      const k = Math.min(1, (now - t0) / D);
      const eased = 1 - Math.pow(1 - k, 3);
      balShown = Math.round(from + (to - from) * eased);
      el.textContent = fmt(balShown);
      if (k < 1) balAnim = requestAnimationFrame(step);
      else { balShown = to; el.textContent = fmt(to); setTimeout(() => el.classList.remove('credit'), 700); }
    };
    balAnim = requestAnimationFrame(step);
  }

  function refreshMoney() {
    $('totalbet').textContent = fmt(bets.reduce((s, b) => s + b.amount, 0));
    if (balShown !== balance) { balShown = balance; }
    $('balance').textContent  = fmt(balance);
    $('undo').disabled = bets.length === 0;
    $('dbl').disabled  = bets.length === 0;
    // repeat depends on the round BEFORE this one, not on what is on the felt
    $('rebet').disabled = lastBets.length === 0;
  }

  /* colour a stack by the largest denomination it could be paid in, so a 1,650
     stake wears the 1K chip's gold rather than always the base red */
  const denomFor = amt => CHIPS.reduce((best, v) => (amt >= v ? v : best), CHIPS[0]);

  /* ---------- where a bet can go ----------
     Built from the cells' real geometry rather than a table of magic numbers, so
     it stays correct at any size. Each entry is a point the chip snaps to: cell
     centres for straight-ups, edge midpoints for splits and streets, and the
     crosses for corners and six lines. */
  let anchors = [], outsideRects = [], outsidePoints = [], wrapBox = null;
  let cellW = 0, cellH = 0, fitK = 1;

  /* The table is scaled to fit the handset, and that splits the two coordinate
     systems this file uses apart. getBoundingClientRect answers in SCREEN
     pixels, already multiplied by the scale; CSS left/top are read back in
     LAYOUT pixels, before it. They are the same number only at full size.

     Mixing them is silent and quadratic: an anchor measured off a rect and then
     written to style.left lands at scale-squared of where it belongs, so a chip
     drifts further from the tap the further it sits from the corner the table
     scales about — while the bet itself resolves correctly, because both sides
     of that comparison came from rects.

     So everything below works in layout pixels, and every rect is divided by
     this on the way in. */
  function fitScale(el) {
    const w = el.offsetWidth;
    if (!w) return 1;
    const k = el.getBoundingClientRect().width / w;
    return k > 0.05 ? k : 1;
  }

  function buildAnchors() {
    anchorSig = '';
    const wrap = root.querySelector('.tablewrap');
    const wb = wrap.getBoundingClientRect();
    const k = fitScale(wrap);
    fitK = k;
    wrapBox = wb;
    const box = el => {
      const r = el.getBoundingClientRect();
      return { l: (r.left - wb.left) / k, t: (r.top - wb.top) / k,
               r: (r.right - wb.left) / k, b: (r.bottom - wb.top) / k,
               cx: ((r.left + r.right) / 2 - wb.left) / k,
               cy: ((r.top + r.bottom) / 2 - wb.top) / k };
    };
    const N = {};
    for (let n = 1; n <= 36; n++) {
      const el = root.querySelector(`[data-bet="straight:${n}"]`);
      if (el) N[n] = box(el);
    }
    if (!N[1] || !N[36]) return false;
    cellW = N[1].r - N[1].l;
    cellH = N[1].b - N[1].t;

    anchors = [];
    const add = (key, x, y, edge) => anchors.push({ key, x, y, edge: !!edge });

    /* Every bet point is derived from where the cells ACTUALLY are, not from an
       assumed direction. The old code hardcoded portrait: n and n+1 side by side,
       n and n+3 stacked. Landscape swaps those axes, so hardcoding either one
       breaks the other layout. A split is the midpoint of the two cells it joins
       and a corner is the mean of its four — both true whichever way up the
       layout is built. */
    const mid = (...ns) => ({
      x: ns.reduce((t, n) => t + N[n].cx, 0) / ns.length,
      y: ns.reduce((t, n) => t + N[n].cy, 0) / ns.length,
    });

    for (let n = 1; n <= 36; n++) add('straight:' + n, N[n].cx, N[n].cy);
    /* Both zeros, wherever the layout put them */
    const zeroEl = lab => board.querySelector(`[data-bet="straight:${lab}"]`) ||
                          root.querySelector(`.pennant [data-bet="straight:${lab}"]`);
    const Z = {}, zmiss = [];
    ['0', '00'].forEach(lab => { const el = zeroEl(lab); if (el) Z[lab] = box(el); else zmiss.push(lab); });
    if (zmiss.length) return false;
    add('straight:0', Z['0'].cx, Z['0'].cy);
    add('straight:00', Z['00'].cx, Z['00'].cy);

    /* Streets and six lines sit on the OUTER edge of their block — the side the
       dozens are on. That side is left in portrait and below in landscape, so it
       is read off the dozens' own position rather than assumed. */
    const vals = Object.values(N);
    const G = { l: Math.min(...vals.map(v => v.l)), t: Math.min(...vals.map(v => v.t)),
                r: Math.max(...vals.map(v => v.r)), b: Math.max(...vals.map(v => v.b)) };
    const dz = root.querySelector('[data-bet="dozen:2"]');
    let ox = -1, oy = 0;
    if (dz) {
      const D = box(dz), vx = D.cx - (G.l + G.r) / 2, vy = D.cy - (G.t + G.b) / 2;
      if (Math.abs(vx) >= Math.abs(vy)) { ox = Math.sign(vx); oy = 0; }
      else { ox = 0; oy = Math.sign(vy); }
    }
    const streetPt = a => {
      const c = [N[a], N[a + 1], N[a + 2]];
      const bl = Math.min(...c.map(v => v.l)), br = Math.max(...c.map(v => v.r));
      const bt = Math.min(...c.map(v => v.t)), bb = Math.max(...c.map(v => v.b));
      if (ox < 0) return { x: bl, y: (bt + bb) / 2 };
      if (ox > 0) return { x: br, y: (bt + bb) / 2 };
      if (oy < 0) return { x: (bl + br) / 2, y: bt };
      return { x: (bl + br) / 2, y: bb };
    };

    for (let n = 1; n <= 36; n++) {
      // n with n+1 only inside a trio; n with n+3 is always the neighbouring trio
      if (n % 3 !== 0) { const m = mid(n, n + 1); add(`grp:${n}-${n + 1}`, m.x, m.y, true); }
      if (n + 3 <= 36) { const m = mid(n, n + 3); add(`grp:${n}-${n + 3}`, m.x, m.y, true); }
      if (n % 3 !== 0 && n + 4 <= 36) {
        const m = mid(n, n + 1, n + 3, n + 4);
        add(`grp:${n}-${n + 1}-${n + 3}-${n + 4}`, m.x, m.y, true);
      }
    }
    for (let a = 1; a <= 34; a += 3) {
      const p = streetPt(a);
      add(`grp:${a}-${a + 1}-${a + 2}`, p.x, p.y, true);
    }
    for (let a = 1; a <= 31; a += 3) {
      const p = streetPt(a), q = streetPt(a + 3);
      add(`grp:${a}-${a + 1}-${a + 2}-${a + 3}-${a + 4}-${a + 5}`,
          (p.x + q.x) / 2, (p.y + q.y) / 2, true);
    }
    /* The American zero area. Which of 1, 2 and 3 each zero touches depends on
       how the layout was built, so it is found by PROXIMITY rather than written
       down — the same reason the splits and streets are geometric. 0 and 00 each
       take their two nearest numbers; together with the 0/00 split and the
       five-number basket that is the whole zero end of the table. */
    const nearestTwo = zb => [1, 2, 3]
      .map(n => ({ n, d: Math.hypot(N[n].cx - zb.cx, N[n].cy - zb.cy) }))
      .sort((a, b) => a.d - b.d).slice(0, 2).map(o => o.n).sort((a, b) => a - b);

    ['0', '00'].forEach(lab => {
      const zb = Z[lab], pair = nearestTwo(zb);
      pair.forEach(n => add(`grp:${lab}-${n}`, (zb.cx + N[n].cx) / 2, (zb.cy + N[n].cy) / 2, true));
      add(`grp:${lab}-${pair[0]}-${pair[1]}`,
          (zb.cx + N[pair[0]].cx + N[pair[1]].cx) / 3,
          (zb.cy + N[pair[0]].cy + N[pair[1]].cy) / 3, true);
    });
    add('grp:0-00', (Z['0'].cx + Z['00'].cx) / 2, (Z['0'].cy + Z['00'].cy) / 2, true);
    // the five-number basket, at the mean of all five it covers
    add('grp:0-00-1-2-3',
        (Z['0'].cx + Z['00'].cx + N[1].cx + N[2].cx + N[3].cx) / 5,
        (Z['0'].cy + Z['00'].cy + N[1].cy + N[2].cy + N[3].cy) / 5, true);

    // outside boxes resolve by containment: a tap anywhere inside means that bet
    outsideRects = [...root.querySelectorAll('.cell.outside, .cell.dozen, .cell.col21')]
      .map(el => ({ key: el.dataset.bet, ...box(el) }));
    /* Kept apart from `anchors` on purpose: resolveTap walks `anchors` to find the
       nearest bet POINT, and an outside box is not a point — it is claimed by
       containment. These exist only so a placed chip has somewhere to sit. */
    outsidePoints = outsideRects.map(o => ({ key: o.key, x: o.cx, y: o.cy, edge: false }));
    anchorSig = layoutSig();
    return true;
  }

  const anchorFor = key =>
    anchors.find(a => a.key === key) || outsidePoints.find(a => a.key === key);

  /* ---------- chips ---------- */
  const chipEls = new Map();

  function drawChip(key, amount, animate) {
    const a = anchorFor(key);
    let c = chipEls.get(key);
    const normalizedAmount = Number(amount) || 0;
    const isNew = !c;
    const previousAmount = c ? Number(c.dataset.amount) : null;
    if (!c) {
      c = document.createElement('span');
      c.className = 'placed' + (a && a.edge ? ' edge' : '');
      c.appendChild(document.createElement('b'));
      c.addEventListener('animationend', () => c.classList.remove('drop'));
      $('betlayer').appendChild(c);
      chipEls.set(key, c);
    }
    if (a) { c.style.left = a.x + 'px'; c.style.top = a.y + 'px'; }
    const [c1, c2] = CHIP_LOOK[denomFor(normalizedAmount)];
    c.style.setProperty('--c', c1);
    c.style.setProperty('--c-dk', c2);
    c.dataset.amount = String(normalizedAmount);
    c.querySelector('b').textContent =
      normalizedAmount >= 1000 ? (Math.round(normalizedAmount / 100) / 10) + 'K' : String(normalizedAmount);
    /* Only a new stake/top-up should land. Responsive relayouts merely move the
       existing element and must never restart its animation — doing so made
       every chip flash whenever ResizeObserver reported the same board again. */
    if (animate !== false && (isNew || previousAmount !== normalizedAmount)) {
      c.classList.remove('drop');
      void c.offsetWidth;
      c.classList.add('drop');
    }
  }

  function removeChip(key) {
    const c = chipEls.get(key);
    if (c) { c.remove(); chipEls.delete(key); }
  }

  /* A chip is a REQUEST, not a fact. The stake leaves the balance only when the
     server says it did — the optimistic chip below is replaced wholesale by the
     server's own record of this round's bets on the next poll, so a refused bet
     (table limit, closed window, not enough chips) simply vanishes again. */
  function place(key, opts) {
    if (!betsOpenNow()) { toast('No more bets — the wheel is in play'); return false; }
    const amt = (opts && opts.amount) || CHIPS[chipIdx];
    if (amt > balance) { $('scrim').classList.add('on'); return false; }
    const mapped = toServerBet(key);
    if (!mapped) { toast('That bet is not offered at this table'); return false; }
    const found = bets.find(b => b.key === key);
    if (found) found.amount += amt; else bets.push({ key, amount: amt });
    balance -= amt;                       // optimistic; the poll corrects it
    drawChip(key, bets.find(b => b.key === key).amount);
    refreshMoney();
    opts && opts.silent || sfxPlace();
    onPlaceBet(mapped.bet_type, mapped.value, amt, key);
    return true;
  }

  const sfxPlace = () => sfxTick();

  /* Called by the wrapper when the server refuses a stake. The optimistic chip
     has to come back off the felt immediately and the reason has to be visible
     on the table — a chip that quietly disappears a second later reads as the
     game losing the bet. */
  function rejectBet(key, amount, message) {
    const b = bets.find(x => x.key === key);
    if (b) {
      b.amount -= amount;
      if (b.amount <= 0) { bets = bets.filter(x => x !== b); removeChip(key); }
      else drawChip(key, b.amount);
    }
    balance += amount;
    refreshMoney();
    if ($('rtlayer')) drawRtChips();
    toast(message || 'That bet was not accepted');
  }


  function clearBets() {
    chipEls.forEach(c => c.remove());
    chipEls.clear();
    bets = [];
    refreshMoney();
    if (typeof drawRtChips === 'function' && $('rtlayer')) drawRtChips();
  }

  /* ---------- the tap resolves to the NEAREST bet point ----------
     One handler over the whole layout instead of a mesh of invisible circles.
     Nearest-point wins, so a tap on a line becomes the split and a tap in the
     middle of a box becomes the straight-up — no dead zones, and the chip lands
     exactly on the point it resolved to. pointerdown, not click, so it responds
     on touch rather than after the tap completes. */
  function resolveTap(px, py) {
    /* Distance has to be measured in CELL widths, not pixels. A number box is
       about 77x21, so a plain Euclidean nearest-point makes the vertical splits
       enormously easier to hit than the horizontal ones: anything more than a
       few pixels off centre is nearer the line above or below than the middle of
       its own box, and the tap becomes a split you never asked for. Normalising
       each axis by the cell size makes the two directions behave the same.

       On top of that, boundary bets carry a handicap. Without it the box splits
       50/50 between "straight up" and "the nearest line", which is not how a
       table is played — the middle of a number should give you that number, and
       a split should need you to actually aim at the line. EDGE_BIAS of 0.25
       leaves the inner 75% of every box to its own number. */
    const cw = cellW || 60, chh = cellH || 20;
    const EDGE_BIAS = 0.25;
    let best = null, bestD = Infinity, bestPx = Infinity;
    for (const a of anchors) {
      const d = Math.hypot((a.x - px) / cw, (a.y - py) / chh) + (a.edge ? EDGE_BIAS : 0);
      if (d < bestD) { bestD = d; best = a; bestPx = Math.hypot(a.x - px, a.y - py); }
    }
    /* An outside box owns its own interior. Measuring in cell widths made the
       priority window about 58px across, which is wider than the 60px dozens
       column — so every tap in a dozen was claimed by the six line printed on
       its border and the dozens became unreachable.

       Containment therefore comes first, and the only thing allowed to take a
       tap away from a box it landed inside is a boundary bet printed ON that
       box's border — the streets and six lines share the dozens' edge — and only
       when the tap is genuinely on the line. That window is in pixels, not cell
       widths, because it is a question of fingertip precision on an edge. */
    for (const o of outsideRects) {
      if (px >= o.l && px <= o.r && py >= o.t && py <= o.b) {
        /* 9 pixels of SCREEN, which is what a fingertip actually has to work
           with, converted into the layout pixels this function measures in. A
           flat 9 here would shrink with the table and demand finer aim on the
           smallest phones, which are the ones that can least afford it. */
        if (best && best.edge && bestPx <= 9 / fitK) return best.key;
        return o.key;
      }
    }
    return best && bestD <= 4 ? best.key : null;
  }

  /* The felt speaks in keys; the API speaks in (bet_type, value). Anything the
     server does not offer returns null and is refused before a chip is drawn,
     rather than being posted and bounced. */
  const SERVER_SECTORS = { zeroside: 'zeroside', dzeroside: 'dzeroside', zerofour: 'zeroneighbours' };
  function toServerBet(key) {
    const [t, v] = key.split(':');
    if (t === 'straight') {
      // "00" is the only pocket that must travel as a string; the rest are plain
      // numbers, which is what the API has always expected for a straight up
      return { bet_type: 'straight', value: v === '00' ? '00' : Number(v) };
    }
    if (t === 'color' || t === 'parity' || t === 'range') return { bet_type: t, value: v };
    if (t === 'dozen' || t === 'column') return { bet_type: t, value: Number(v) };
    if (t === 'grp') {
      const nums = v.split('-');
      const named = Object.entries(SECTORS).find(([, list]) => list.join('-') === v);
      if (named) return { bet_type: 'sector', value: SERVER_SECTORS[named[0]] || named[0] };
      const shape = { 2: 'split', 3: 'street', 4: 'corner', 5: 'basket', 6: 'sixline' }[nums.length];
      return shape ? { bet_type: shape, value: v } : null;
    }
    return null;
  }

  const BET_NAME = key => {
    const [t, v] = key.split(':');
    if (t === 'straight') return 'STRAIGHT ' + v;
    if (t === 'color') return v.toUpperCase();
    if (t === 'parity') return v.toUpperCase();
    if (t === 'range') return v === 'low' ? '1-18' : '19-36';
    if (t === 'dozen') return ['1ST', '2ND', '3RD'][v - 1] + ' DOZEN';
    if (t === 'column') return ['1ST', '2ND', '3RD'][v - 1] + ' COLUMN';
    if (t === 'sector') return v.toUpperCase();
    const n = v.split('-');
    const call = CALL_NAME[key];
    if (call) return call;
    const label = { 2: 'SPLIT', 3: 'STREET', 4: 'CORNER', 5: 'BASKET', 6: 'SIX LINE' }[n.length] || 'GROUP';
    return label + ' ' + n.join('·');
  };

  /* Anchors have to describe the layout as it is AT THE TAP. Trusting the
     ResizeObserver to have kept them current is not safe: it fires on every
     frame of the stage's height transition, and because that callback writes
     styles the browser may drop the notification that would have followed, so
     the cache can be left describing a layout that was still moving. The tap
     then resolves against stale geometry and the chip lands away from the
     finger.

     Rebuilding on every touch is correct but expensive — it forces forty-odd
     synchronous layout reads before the chip can be drawn, which on a cheap
     handset is felt. So the geometry is verified instead of rebuilt: if the
     board occupies exactly the rectangle it did when the anchors were built,
     and is still in the same orientation, then nothing inside it can have
     moved, because everything inside is laid out by that box. One rect read
     replaces forty, and a rebuild happens only when the answer would differ. */
  let anchorSig = '';

  function layoutSig() {
    const w = root.querySelector('.tablewrap');
    if (!w) return '';
    const r = w.getBoundingClientRect();
    return [r.left.toFixed(2), r.top.toFixed(2), r.width.toFixed(2), r.height.toFixed(2),
            board.className, $('racetrack').classList.contains('on') ? 'rt' : ''].join('|');
  }

  function anchorsUsable() {
    const sig = layoutSig();
    if (!sig) return false;
    if (sig === anchorSig && anchors.length) return true;
    return buildAnchors();
  }

  function tapBoard(ev) {
    if (!anchorsUsable()) return;
    const wrapEl = root.querySelector('.tablewrap');
    const wrap = wrapEl.getBoundingClientRect();
    // the pointer arrives in screen pixels; the anchors live in layout pixels
    const k = fitScale(wrapEl);
    const key = resolveTap((ev.clientX - wrap.left) / k, (ev.clientY - wrap.top) / k);
    if (!key) return;
    if (place(key)) toast(BET_NAME(key) + '  ·  ' + fmt(CHIPS[chipIdx]));
  }

  function sfxTick() {
    Sound.chipTick();
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
  }

  root.querySelector('.tablewrap').addEventListener('pointerdown', tapBoard);

  /* The anchors are pixel geometry, so they are stale the moment the layout
     moves — a rotation, the wheel band collapsing, a webfont landing, anything.
     A resize listener is not enough (it never fires for a CSS-driven reflow), so
     the layout itself is observed and the anchors and chips are rebuilt with it. */
  let relayoutFrame = 0;
  let orientationTimer = 0;
  let layoutObserver = null;
  const relayout = () => {
    cancelAnimationFrame(relayoutFrame);
    relayoutFrame = requestAnimationFrame(() => {
      if (buildAnchors()) bets.forEach(b => drawChip(b.key, b.amount, false));
      if ($('racetrack').classList.contains('on')) { buildRacetrack(); drawRtChips(); }
    });
  };
  if (window.ResizeObserver) {
    layoutObserver = new ResizeObserver(relayout);
    layoutObserver.observe(root.querySelector('.tablewrap'));
    layoutObserver.observe(board);
  }
  window.addEventListener('resize', relayout);
  // the last frame of a height transition may never reach the observer, so take
  // the settled measurement explicitly
  const wheelStage = root.querySelector('.wheelstage');
  wheelStage.addEventListener('transitionend', relayout);
  const onOrientationChange = () => {
    clearTimeout(orientationTimer);
    orientationTimer = setTimeout(relayout, 120);
  };
  window.addEventListener('orientationchange', onOrientationChange);

  /* ---------- chip tray ----------
     All five denominations are laid out at once and stay tappable, so picking a
     stake is one tap rather than cycling through the others to reach it. */
  const CHIP_LOOK = {
    10:   ['#b0201c', '#6d100e'],   // red
    50:   ['#1f7a44', '#0d4425'],   // green
    100:  ['#26262b', '#0e0e11'],   // black
    500:  ['#6d2f8e', '#3c1550'],   // purple
    1000: ['#c99a1b', '#7d5c07'],   // gold
  };
  const chipLabel = v => (v >= 1000 ? (v / 1000) + 'K' : String(v));

  function buildChipTray() {
    const tray = $('chipslot');
    CHIPS.forEach((v, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.dataset.chip = String(v);
      b.style.setProperty('--c', CHIP_LOOK[v][0]);
      b.style.setProperty('--c-dk', CHIP_LOOK[v][1]);
      b.setAttribute('aria-label', 'Stake ' + v);
      b.setAttribute('aria-pressed', String(i === chipIdx));
      const s = document.createElement('span');
      s.textContent = chipLabel(v);
      b.appendChild(s);
      b.addEventListener('click', () => {
        chipIdx = i;
        [...tray.children].forEach((c, k) =>
          c.setAttribute('aria-pressed', String(k === i)));
        if ($('nbCost')) refreshNb();
      });
      tray.appendChild(b);
    });
  }

  $('undo').addEventListener('click', () => {
    if (!betsOpenNow()) { toast('No more bets — the wheel is in play'); return; }
    if (!bets.length) return;
    onUndo();                             // the server refunds; the poll redraws
  });

  /* Doubling is not a local edit to the chips — it is a second stake on every
     bet already standing, and it has to be posted like any other. Left as it
     was, the felt showed doubled chips for one second and the next poll put
     them back, because the server had never been told. */
  $('dbl').addEventListener('click', () => {
    if (!betsOpenNow()) { toast('No more bets — the wheel is in play'); return; }
    if (!bets.length) { toast('Nothing on the table to double'); return; }
    const plan = bets.map(b => ({ key: b.key, amount: b.amount }));
    const cost = plan.reduce((t, b) => t + b.amount, 0);
    if (cost > balance) { $('scrim').classList.add('on'); return; }
    // snapshot first: place() mutates `bets` as it goes
    plan.forEach(b => place(b.key, { amount: b.amount, silent: true }));
    sfxTick();
    toast('Doubled  ·  ' + fmt(cost) + ' more staked');
  });

  /* Repeat had two faults. lastBets was declared and then never written to, so
     it was always empty and the button could only ever say there was nothing to
     repeat. And like the double, it moved chips around locally without telling
     the server, so even once it had something to replay the next poll removed
     it. It now replays through place(), the same path a tapped bet takes. */
  $('rebet').addEventListener('click', async () => {
    if (!betsOpenNow()) { toast('No more bets — the wheel is in play'); return; }
    if (!lastBets.length) { toast('No previous round to repeat'); return; }
    const plan = lastBets.map(b => ({ key: b.key, amount: b.amount }));
    const cost = plan.reduce((t, b) => t + b.amount, 0);
    if (cost > balance) { $('scrim').classList.add('on'); return; }
    /* Repeat replaces what is on the table, so anything already down has to go
       first — and the clear has to LAND before the new stakes are posted, or the
       server may apply them in the other order and wipe the round. */
    if (bets.length) {
      try { await onClear(); } catch (e) { /* the poll re-syncs either way */ }
      clearBets();
    }
    plan.forEach(b => place(b.key, { amount: b.amount, silent: true }));
    sfxTick();
    toast('Repeated  ·  ' + fmt(cost) + ' staked');
  });

  $('collapse').addEventListener('click', () => toast('Table view toggled'));
  $('modalclose').addEventListener('click', () => $('scrim').classList.remove('on'));


  /* ================= wheel-order betting: the racetrack =================
     The layout bets by number; the racetrack bets by POSITION ON THE WHEEL.
     Tap a number and it covers that pocket plus N neighbours either side in
     wheel order, or tap a sector for the classic French calls.

     The sectors are placed as one group bet paying 36/count. A casino builds
     them from specific splits and corners with uneven chip counts; a single
     group bet has the same expected value and cannot be mis-split. */
  /* Voisins du Zéro, Tier du Cylindre and Orphelins are defined by the EUROPEAN
     wheel's arrangement — they do not exist on a double-zero wheel, and carrying
     the old number lists over would have named sectors that are no longer
     contiguous on this cylinder. They are replaced by the two halves either side
     of the zeros, which is the equivalent idea on an American wheel: each is a
     genuine unbroken arc, derived from the sequence rather than typed out. */
  const arcFrom = (startLabel, count) => {
    const i = POCKETS.indexOf(startLabel), out = [];
    for (let k = 0; k < count; k++) out.push(POCKETS[(i + k) % NP]);
    return out;
  };
  const SECTORS = {
    zeroside:  arcFrom('0', 19),        // 0 round to 1, the half containing 0
    dzeroside: arcFrom('00', 19),       // 00 round to 2, the half containing 00
    zerofour:  arcFrom('27', 3).concat(arcFrom('1', 1), ['0', '00']),
  };
  const SECTOR_ORDER = [
    ['zeroside',  '0 SIDE'],
    ['dzeroside', '00 SIDE'],
  ];
  const CALL_LABEL = {
    zeroside: 'ZERO HALF', dzeroside: 'DOUBLE-ZERO HALF', zerofour: 'ZERO NEIGHBOURS',
  };
  const CALL_NAME = Object.fromEntries(
    Object.entries(SECTORS).map(([k, v]) => ['grp:' + v.join('-'), CALL_LABEL[k]]));
  let nbCount = 2;

  function buildRacetrack() {
    const rt = $('racetrack');
    const W = rt.clientWidth, H = rt.clientHeight;
    if (!W || !H) return;
    rt.querySelectorAll('.rtnum, .rtsec, .rtring').forEach(e => e.remove());

    /* A racetrack is a LANDSCAPE stadium: two semicircular caps joined by
       straights. 37 numbers on an 840px perimeter is 22px each, which is why
       real tables print them small — the geometry, not the art direction,
       sets the type size. */
    /* 13px of padding, not 9: the number boxes are centred ON the ring, so the
       track has to sit half a box in from the edge or pocket 0 hangs off it. */
    const PAD = 13;
    const ovalW = W - PAD * 2;
    /* the box is only ~190px tall, so the oval takes all of it bar the 46px the
       neighbour control needs underneath */
    const NB_H = 46, TOP = 11;
    const r = Math.min(88, (H - NB_H - TOP * 2) / 2);
    const ovalH = r * 2;
    const straight = ovalW - ovalH;
    const cx = W / 2, cy = TOP + r;
    const lcx = cx - straight / 2, rcx = cx + straight / 2;
    const q = Math.PI * r / 2;
    const P = 2 * Math.PI * r + 2 * straight;

    const nb = rt.querySelector('.rtnb');
    nb.style.top = (cy + r + 15) + 'px';
    nb.style.bottom = 'auto';

    const ring = document.createElement('div');
    ring.className = 'rtring';
    ring.style.left = PAD + 'px';
    ring.style.top = (cy - r) + 'px';
    ring.style.width = ovalW + 'px';
    ring.style.height = ovalH + 'px';
    rt.appendChild(ring);

    /* arc length from the left cap's outer point, running clockwise up over the
       top — the direction the wheel sequence runs on a real racetrack */
    const at = sd => {
      let d = ((sd % P) + P) % P;
      if (d < q) { const a = Math.PI - d / r; return [lcx + r * Math.cos(a), cy - r * Math.sin(a)]; }
      d -= q;
      if (d < straight) return [lcx + d, cy - r];
      d -= straight;
      if (d < 2 * q) { const a = Math.PI / 2 - d / r; return [rcx + r * Math.cos(a), cy - r * Math.sin(a)]; }
      d -= 2 * q;
      if (d < straight) return [rcx - d, cy + r];
      d -= straight;
      const a = -Math.PI / 2 - d / r; return [lcx + r * Math.cos(a), cy - r * Math.sin(a)];
    };

    EURO.forEach((n, i) => {
      const [x, y] = at((i / 37) * P);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rtnum ' + hueOf(String(n));
      b.textContent = n;
      b.style.left = x + 'px';
      b.style.top = y + 'px';
      b.addEventListener('pointerdown', e => { e.stopPropagation(); betNeighbours(n); });
      rt.appendChild(b);
    });

    /* Each call sits over the numbers it covers. Starting the sequence at the
       left cap puts Voisins on the left, Tier on the right and Orphelins split
       across the middle — which is exactly the arrangement on a real table, so
       the labels are placed by where their own numbers landed, not by taste. */
    const inW = straight + r * 0.9, inH = ovalH - 34;
    const inL = cx - inW / 2, inT = cy - inH / 2;
    const topH = inH * 0.58, botH = inH - topH - 3;
    const cols = [['zeroside', 'ZERO HALF', 0.50], ['dzeroside', 'DOUBLE-ZERO HALF', 0.50]];
    let ax = inL;
    const cells = cols.map(([key, label, frac]) => {
      const w = inW * frac - 3;
      const c = { key, label, l: ax, t: inT, w, h: topH };
      ax += inW * frac;
      return c;
    });
    cells.push({ key: 'zerofour', label: 'ZERO NEIGHBOURS', l: inL, t: inT + topH + 3, w: inW - 3, h: botH });

    cells.forEach(c => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'rtsec';
      el.textContent = c.label;
      el.dataset.key = 'grp:' + SECTORS[c.key].join('-');
      el.style.left = c.l + 'px';
      el.style.top = c.t + 'px';
      el.style.width = c.w + 'px';
      el.style.height = c.h + 'px';
      el.addEventListener('pointerdown', e => {
        e.stopPropagation();
        if (place(el.dataset.key)) {
          toast(c.label + '  ·  ' + SECTORS[c.key].length + ' numbers  ·  ' + fmt(CHIPS[chipIdx]));
          drawRtChips();
        }
      });
      rt.appendChild(el);
    });
  }

  /* The racetrack draws its own chips. #betlayer belongs to the layout and is
     hidden while the racetrack is up, so stakes are re-derived from `bets` here
     rather than mirrored — a mirror can drift, a projection cannot. */
  function drawRtChips() {
    const rt = $('racetrack');
    let layer = $('rtlayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'rtlayer'; layer.id = 'rtlayer';
      rt.appendChild(layer);
    }
    layer.replaceChildren();
    const stake = key => {
      const b = bets.find(x => x.key === key);
      return b ? b.amount : 0;
    };
    const put = (host, amount) => {
      const [c1, c2] = CHIP_LOOK[denomFor(amount)];
      const c = document.createElement('span');
      c.className = 'rtchip';
      c.style.setProperty('--c', c1);
      c.style.setProperty('--c-dk', c2);
      c.textContent = amount >= 1000 ? (Math.round(amount / 100) / 10) + 'K' : String(amount);
      const r = host.getBoundingClientRect(), o = rt.getBoundingClientRect();
      // rects are screen pixels, style.left is layout pixels — see fitScale
      const k = fitScale(rt);
      // offset off a number so the numeral stays readable underneath; sectors
      // are large enough to take the chip dead centre
      const off = host.classList.contains('rtnum') ? 5 : 0;
      c.style.left = ((r.left - o.left + r.width / 2) / k + off) + 'px';
      c.style.top  = ((r.top  - o.top  + r.height / 2) / k + off) + 'px';
      layer.appendChild(c);
    };
    rt.querySelectorAll('.rtnum').forEach(el => {
      const a = stake('straight:' + el.textContent);
      if (a) put(el, a);
    });
    rt.querySelectorAll('.rtsec').forEach(el => {
      const a = stake(el.dataset.key);
      if (a) put(el, a);
    });
  }

  /* a number plus N pockets either side, in WHEEL order — not table order */
  function betNeighbours(n) {
    const i = POCKETS.indexOf(String(n));
    const picks = [];
    for (let k = -nbCount; k <= nbCount; k++) picks.push(POCKETS[(i + k + NP) % NP]);
    const cost = picks.length * CHIPS[chipIdx];
    if (cost > balance) { $('scrim').classList.add('on'); return; }
    let ok = 0;
    picks.forEach(v => { if (place('straight:' + v, { silent: true })) ok++; });
    if (ok) {
      sfxTick();
      toast(n + ' + ' + nbCount + ' neighbours  ·  ' + ok + ' bets  ·  ' + fmt(cost));
      drawRtChips();
    }
  }

  function refreshNb() {
    $('nbVal').textContent = nbCount;
    const k = 2 * nbCount + 1;
    $('nbCost').textContent = k + ' × ' + fmt(CHIPS[chipIdx]) + ' = ' + fmt(k * CHIPS[chipIdx]);
  }
  $('nbUp').addEventListener('click', () => { nbCount = Math.min(5, nbCount + 1); refreshNb(); });
  $('nbDown').addEventListener('click', () => { nbCount = Math.max(0, nbCount - 1); refreshNb(); });

  let rtOpen = false;
  function toggleRacetrack(force) {
    rtOpen = force === undefined ? !rtOpen : force;
    $('racetrack').classList.toggle('on', rtOpen);
    $('racetrack').setAttribute('aria-hidden', String(!rtOpen));
    root.querySelector('.tablewrap').classList.toggle('rt', rtOpen);
    if (rtOpen) { buildRacetrack(); drawRtChips(); refreshNb(); }
  }
  $('rtbtn').addEventListener('click', () => toggleRacetrack());


  /* ================= statistics =================
     The display strip keeps 14 results. Statistics needs the whole shoe, so the
     spin log is kept separately and uncapped — `history` is a view of `spins`,
     not the other way round. Seeded with 500 fair spins so the panel has real
     numbers to show on the first open rather than an empty state. */
  /* Seeded from the server's own round history. The standalone build invented
     500 spins so the panel had something to draw; real statistics have to be
     real, so it starts with whatever the table has actually produced. */
  let spins = history.slice();

  let statTab = 'hot', statWindow = 200;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const hue = n => hueOf(String(n));

  /* Counted by POCKET INDEX, not by number: 0 and 00 are different pockets that
     share an integer, so an array indexed by value would merge them. */
  function counts(win) {
    const slice = spins.slice(0, win);
    const c = new Array(NP).fill(0);
    slice.forEach(lab => { const i = POCKETS.indexOf(String(lab)); if (i >= 0) c[i]++; });
    return { c, n: slice.length };
  }

  /* one number, its share of the window, and a tap that bets on it */
  function numberRow(n, hits, total, max, bar) {
    const b = el('button', 'strow');
    b.type = 'button';
    const pip = el('span', 'stpip ' + hue(n), String(n));
    const track = el('span', 'stbar');
    const fill = el('i');
    fill.style.width = Math.max(3, (hits / (max || 1)) * 100) + '%';
    track.style.setProperty('--bar', bar);
    track.appendChild(fill);
    const val = el('span', 'stval', hits + '  ·  ' + (total ? (hits * 100 / total).toFixed(1) : '0.0') + '%');
    b.append(pip, track, val);
    b.addEventListener('click', () => {
      if (place('straight:' + n)) {
        toast('STRAIGHT ' + n + '  ·  ' + fmt(CHIPS[chipIdx]));
        closeSheets();
      }
    });
    return b;
  }

  /* a two-sided proportion, drawn against a centre rule so the eye reads the
     DEVIATION from even rather than the raw lengths */
  function splitRow(label, aName, aHits, bName, bHits, aCol, bCol) {
    const wrap = el('div', 'stpair');
    const head = el('div', 'stpairhead');
    const l = el('span'); l.append(el('b', null, aName), document.createTextNode(' ' + aHits));
    const rr = el('span'); rr.append(document.createTextNode(bHits + ' '), el('b', null, bName));
    head.append(l, rr);
    const bar = el('div', 'stsplitbar');
    const tot = aHits + bHits || 1;
    const ua = el('u'); ua.style.width = (aHits * 100 / tot) + '%'; ua.style.background = aCol;
    const ub = el('u'); ub.style.width = (bHits * 100 / tot) + '%'; ub.style.background = bCol;
    bar.append(ua, ub);
    wrap.append(head, bar);
    return wrap;
  }

  function renderStats() {
    const body = $('statbody');
    body.replaceChildren();

    if (statTab === 'hot') {
      const { c, n } = counts(statWindow);
      body.appendChild(windowSlider());
      const ranked = c.map((hits, i) => ({ num: POCKETS[i], hits }))
                      .sort((a, b) => b.hits - a.hits || (+a.num) - (+b.num));
      const max = ranked[0].hits;
      const cols = el('div', 'sttwo');
      [['HOTTEST', ranked.slice(0, 6), '#c9342f'],
       ['COLDEST', ranked.slice(-6).reverse(), '#3d7fb8']].forEach(([cap, rows, bar]) => {
        const side = el('div');
        side.appendChild(el('p', 'stcap', cap));
        const list = el('div', 'stnums');
        rows.forEach(r => list.appendChild(numberRow(r.num, r.hits, n, max, bar)));
        side.appendChild(list);
        cols.appendChild(side);
      });
      body.appendChild(cols);
      body.appendChild(el('p', 'sthint',
        'Over ' + n + ' spins an even wheel gives each pocket about ' +
        (n / NP).toFixed(1) + ' hits. Tap any number to bet it.'));
      return;
    }

    if (statTab === 'adv') {
      const { c, n } = counts(statWindow);
      const sum = pred => c.reduce((s, h, i) => s + (pred(POCKETS[i]) ? h : 0), 0);
      body.appendChild(windowSlider());

      const split = el('div', 'stsplit');
      const num = x => isZero(x) ? null : +x;
      split.appendChild(splitRow('colour', 'RED', sum(x => num(x) && RED.has(num(x))),
        'BLACK', sum(x => num(x) && !RED.has(num(x))), '#a8302b', '#2b2528'));
      split.appendChild(splitRow('parity', 'ODD', sum(x => num(x) && num(x) % 2 === 1),
        'EVEN', sum(x => num(x) && num(x) % 2 === 0), '#6a5aa8', '#3a7f74'));
      split.appendChild(splitRow('half', '1–18', sum(x => num(x) && num(x) <= 18),
        '19–36', sum(x => num(x) && num(x) >= 19), '#b07a2c', '#2f6f8f'));
      const sec = el('div', 'sheetsec'); sec.appendChild(el('h4', null, 'EVEN-MONEY CHANCES'));
      sec.appendChild(split);
      body.appendChild(sec);

      const zeros = sum(isZero);
      const groups = [
        ['DOZENS', [['1ST', x => num(x) && num(x) <= 12], ['2ND', x => num(x) >= 13 && num(x) <= 24],
                    ['3RD', x => num(x) >= 25]]],
        ['COLUMNS', [['1ST', x => num(x) && num(x) % 3 === 1], ['2ND', x => num(x) && num(x) % 3 === 2],
                     ['3RD', x => num(x) && num(x) % 3 === 0]]],
        ['WHEEL HALVES', [['0 SIDE', x => SECTORS.zeroside.includes(String(x))],
                          ['00 SIDE', x => SECTORS.dzeroside.includes(String(x))]]],
      ];
      groups.forEach(([title, rows]) => {
        const g = el('div', 'sheetsec');
        g.appendChild(el('h4', null, title));
        const list = el('div', 'stnums');
        const vals = rows.map(([, pred]) => sum(pred));
        const mx = Math.max(...vals, 1);
        rows.forEach(([name, pred], i) => {
          const r = el('div', 'strow grp');
          r.appendChild(el('span', 'stname', name));
          const track = el('span', 'stbar');
          track.style.setProperty('--bar', 'var(--cyan)');
          const fill = el('i');
          fill.style.width = Math.max(3, vals[i] * 100 / mx) + '%';
          track.appendChild(fill);
          r.appendChild(track);
          r.appendChild(el('span', 'stval', vals[i] + '  ·  ' + (vals[i] * 100 / n).toFixed(1) + '%'));
          list.appendChild(r);
        });
        g.appendChild(list);
        body.appendChild(g);
      });
      body.appendChild(el('p', 'sthint',
        'Zero came up ' + zeros + ' time' + (zeros === 1 ? '' : 's') + ' in ' + n +
        ' spins. Zero and double zero are excluded from the even-money groups above.'));
      return;
    }

    // every pocket, in wheel order
    const { c, n } = counts(statWindow);
    body.appendChild(windowSlider());
    const max = Math.max(...c, 1);
    const chart = el('div', 'sthist');
    const expLine = el('div', 'stexp');
    expLine.style.bottom = ((n / NP) / max * 100) + '%';
    expLine.appendChild(el('b', null, 'EXPECTED ' + (n / NP).toFixed(1)));
    chart.appendChild(expLine);
    const axis = el('div', 'sthistax');
    POCKETS.forEach((num, i) => {
      const b = el('button'); b.type = 'button';
      b.setAttribute('aria-label', num + ': ' + c[i] + ' hits');
      const bar = el('i');
      bar.style.height = (c[i] * 100 / max) + '%';
      bar.style.background = { green: '#2f9d78', red: '#c1332e', black: '#7b7378' }[hueOf(num)];
      b.appendChild(bar);
      b.addEventListener('click', () => {
        if (place('straight:' + num)) {
          toast('STRAIGHT ' + num + '  ·  ' + fmt(CHIPS[chipIdx]));
          closeSheets();
        }
      });
      chart.appendChild(b);
      axis.appendChild(el('span', null, String(num)));
    });
    const sec = el('div', 'sheetsec');
    sec.appendChild(el('h4', null, 'HITS PER POCKET, IN WHEEL ORDER'));
    sec.append(chart, axis);
    body.appendChild(sec);
    body.appendChild(el('p', 'sthint',
      'Left to right is the order the pockets sit on the wheel, not the layout — a ' +
      'biased wheel shows up as a run of tall neighbours. Tap a bar to bet that pocket.'));
  }

  function windowSlider() {
    const w = el('div', 'stwin');
    const lab = el('label', null, 'LAST');
    lab.setAttribute('for', 'statwin');
    const inp = el('input');
    inp.type = 'range'; inp.id = 'statwin';
    inp.min = '50'; inp.max = String(spins.length); inp.step = '10';
    inp.value = String(Math.min(statWindow, spins.length));
    const out = el('b', null, String(Math.min(statWindow, spins.length)));
    inp.addEventListener('input', () => {
      statWindow = +inp.value;
      out.textContent = statWindow;
      // repaint only the data, so dragging never yanks the slider out from under the thumb
      const keep = document.activeElement === inp;
      renderStats();
      if (keep) { const nx = $('statwin'); if (nx) nx.focus(); }
    });
    w.append(lab, inp, out);
    return w;
  }

  function closeSheets() {
    root.querySelectorAll('.sheet').forEach(s => s.classList.remove('on'));
    $('sheetscrim').classList.remove('on');
  }
  function openSheet(id) {
    closeSheets();
    toggleRacetrack(false);
    $(id).classList.add('on');
    $('sheetscrim').classList.add('on');
  }
  $('sheetscrim').addEventListener('click', closeSheets);
  $('statx').addEventListener('click', closeSheets);
  $('statbtn').addEventListener('click', () => { renderStats(); openSheet('statsheet'); });
  $('statsheet').querySelectorAll('.sheettab').forEach(t => {
    t.addEventListener('click', () => {
      statTab = t.dataset.tab;
      $('statsheet').querySelectorAll('.sheettab').forEach(o =>
        o.setAttribute('aria-selected', String(o === t)));
      renderStats();
    });
  });


  /* ================= favourites, autoplay, menu =================
     Everything in here funnels through placeMany, which is all-or-nothing: a
     Complete bet on 17 is a dozen separate stakes, and half of it landing
     because the balance ran out mid-way would be worse than none of it. */
  function betCost(list) { return list.reduce((s, [, u]) => s + u * CHIPS[chipIdx], 0); }

  function placeMany(list, label) {
    if (!betsOpenNow()) { toast('No more bets — the wheel is in play'); return false; }
    const cost = betCost(list);
    if (cost > balance) { $('scrim').classList.add('on'); return false; }
    list.forEach(([key, units]) => place(key, { amount: units * CHIPS[chipIdx] }));
    if ($('rtlayer')) drawRtChips();
    toast(label + '  ·  ' + list.length + (list.length === 1 ? ' bet  ·  ' : ' bets  ·  ') + fmt(cost));
    return true;
  }

  /* --- the special bets, all derived rather than tabulated --- */
  // finale en plein 7 = 7, 17, 27 — every number ending in that digit
  const finalePlein = d => {
    const out = [];
    for (let n = d; n <= 36; n += 10) out.push('straight:' + n);
    return out.map(k => [k, 1]);
  };
  // finale à cheval 4/7 = the split 4-7 and every split ten higher
  const finaleCheval = d => {
    const out = [];
    for (let a = d; a + 3 <= 36; a += 10) out.push(['grp:' + a + '-' + (a + 3), 1]);
    return out;
  };
  /* a complete bet is every inside bet that covers the number. Rather than
     tabulate 37 of those by hand, ask the layout: the anchor set already holds
     every legal inside bet, so filter it. */
  const completeBet = n => anchors
    .filter(a => {
      const [t, v] = a.key.split(':');
      // matched as labels, so 0 and 00 keep their own complete bets
      return (t === 'straight' || t === 'grp') && v.split('-').includes(String(n));
    })
    .map(a => [a.key, 1]);

  const OUTSIDES = [
    ['RED', 'color:red'], ['BLACK', 'color:black'],
    ['ODD', 'parity:odd'], ['EVEN', 'parity:even'],
    ['1–18', 'range:low'], ['19–36', 'range:high'],
    ['1ST DOZEN', 'dozen:1'], ['2ND DOZEN', 'dozen:2'], ['3RD DOZEN', 'dozen:3'],
    ['1ST COLUMN', 'column:1'], ['2ND COLUMN', 'column:2'], ['3RD COLUMN', 'column:3'],
  ];

  /* --- saved bets ---
     A favourite that does not survive leaving the table is not a favourite. The
     slots lived in a local that was rebuilt every time the engine mounted, so a
     reload — or simply going back to the lobby and returning — emptied all six.
     They are kept on the device instead, and read back defensively: storage can
     be full, disabled in private mode, or hold something from an older build,
     and none of those may stop the table from opening. */
  const FAV_KEY = 'cc_roulette_favs_v1';
  const BLANK_SLOTS = [null, null, null, null, null, null];

  function loadSlots() {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (!raw) return BLANK_SLOTS.slice();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return BLANK_SLOTS.slice();
      return BLANK_SLOTS.map((_, i) => {
        const sl = parsed[i];
        if (!sl || !Array.isArray(sl.list) || !sl.list.length) return null;
        const list = sl.list
          .filter(b => b && typeof b.key === 'string' && Number(b.amount) > 0)
          .map(b => ({ key: b.key, amount: Number(b.amount) }));
        if (!list.length) return null;
        return { list, total: list.reduce((t, b) => t + b.amount, 0) };
      });
    } catch (e) {
      return BLANK_SLOTS.slice();
    }
  }

  function saveSlots() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(slots)); }
    catch (e) { /* private mode or a full quota — the slots still work this session */ }
  }

  let slots = loadSlots();

  function summarise(list) {
    return list.map(b => BET_NAME(b.key)).join(', ');
  }

  function renderFav() {
    const body = $('favbody');
    body.replaceChildren();

    if (favTab === 'saved') {
      const live = bets.length;
      slots.forEach((sl, i) => {
        const row = el('div', 'slot' + (sl ? '' : ' empty'));
        const main = el('button'); main.type = 'button';
        if (sl) {
          main.appendChild(el('div', 'stitle', 'SLOT ' + (i + 1) + '  ·  ' + fmt(sl.total) + ' staked'));
          main.appendChild(el('div', 'ssub', summarise(sl.list)));
        } else {
          main.appendChild(el('div', 'stitle',
            live ? 'SAVE CURRENT BET TO SLOT ' + (i + 1) : 'SLOT ' + (i + 1) + ' — EMPTY'));
          if (live) main.appendChild(el('div', 'ssub', summarise(bets)));
        }
        main.addEventListener('click', () => {
          if (sl) {
            /* replay at the saved stakes, not the current chip: a saved bet that
               silently changed size would be the worst kind of surprise */
            const list = sl.list.map(b => [b.key, b.amount]);
            const cost = list.reduce((s, [, a]) => s + a, 0);
            if (!betsOpenNow()) { toast('No more bets — the wheel is in play'); return; }
            if (cost > balance) { $('scrim').classList.add('on'); return; }
            list.forEach(([key, amount]) => place(key, { amount }));
            if ($('rtlayer')) drawRtChips();
            toast('SLOT ' + (i + 1) + ' replayed  ·  ' + fmt(cost));
            closeSheets();
          } else if (live) {
            slots[i] = {
              list: bets.map(b => ({ key: b.key, amount: b.amount })),
              total: bets.reduce((s, b) => s + b.amount, 0),
            };
            saveSlots();
            renderFav();
          } else {
            toast('Place a bet on the table first, then save it here');
          }
        });
        row.appendChild(main);
        const del = el('button', 'sdel', '×');
        del.type = 'button';
        del.setAttribute('aria-label', 'Clear slot ' + (i + 1));
        del.addEventListener('click', () => { slots[i] = null; saveSlots(); renderFav(); });
        row.appendChild(del);
        body.appendChild(row);
      });
      body.appendChild(el('p', 'sthint',
        live ? 'Tap an empty slot to store the ' + bets.length + ' bet' +
               (bets.length === 1 ? '' : 's') + ' on the table. Saved slots replay at their own stakes.'
             : 'Build a bet on the table, then come back to store it in a slot.'));
      return;
    }

    if (favTab === 'special') {
      const grid = (title, items) => {
        const sec = el('div', 'sheetsec');
        sec.appendChild(el('h4', null, title));
        const g = el('div', 'gridbtns c5');
        items.forEach(([label, list, name]) => {
          const b = el('button', 'gb small'); b.type = 'button';
          b.appendChild(el('b', null, label));
          b.appendChild(el('i', null, list.length + (list.length === 1 ? ' BET' : ' BETS')));
          b.addEventListener('click', () => { if (placeMany(list, name)) closeSheets(); });
          g.appendChild(b);
        });
        sec.appendChild(g);
        return sec;
      };

      body.appendChild(grid('FINALE EN PLEIN',
        Array.from({ length: 10 }, (_, d) => [String(d), finalePlein(d), 'FINALE EN PLEIN ' + d])));
      body.appendChild(grid('FINALE À CHEVAL',
        Array.from({ length: 10 }, (_, d) => [d + '/' + (d + 3), finaleCheval(d),
          'FINALE À CHEVAL ' + d + '/' + (d + 3)])));

      const sec = el('div', 'sheetsec');
      sec.appendChild(el('h4', null, 'COMPLETE BETS'));
      const g = el('div', 'gridbtns c5');
      for (const n of POCKETS.slice().sort((a,b) => (+a) - (+b) || a.length - b.length)) {
        const list = completeBet(n);
        const b = el('button', 'gb small ' + ({green:'', red:'red', black:'blk'}[hueOf(String(n))]));
        b.type = 'button';
        b.appendChild(el('b', null, String(n)));
        b.appendChild(el('i', null, list.length + ' CH'));
        b.addEventListener('click', () => {
          if (!list.length) { toast('Open the table once so the layout can be measured'); return; }
          if (placeMany(list, 'COMPLETE ' + n)) closeSheets();
        });
        g.appendChild(b);
      }
      sec.appendChild(g);
      body.appendChild(sec);
      body.appendChild(el('p', 'sthint',
        'A complete bet covers a number with every inside bet it belongs to — the ' +
        'straight up plus each split, street, corner and six line through it.'));
      return;
    }

    // call bets: the even-money chances, dozens, columns and the French calls
    const s1 = el('div', 'sheetsec');
    s1.appendChild(el('h4', null, 'EVEN MONEY, DOZENS & COLUMNS'));
    const g1 = el('div', 'gridbtns c2');
    OUTSIDES.forEach(([label, key]) => {
      const b = el('button', 'gb small' +
        (key === 'color:red' ? ' red' : key === 'color:black' ? ' blk' : ''));
      b.type = 'button';
      b.appendChild(el('b', null, label));
      b.appendChild(el('i', null, key.startsWith('dozen') || key.startsWith('column') ? 'PAYS 2 TO 1' : 'PAYS 1 TO 1'));
      b.addEventListener('click', () => { if (placeMany([[key, 1]], label)) closeSheets(); });
      g1.appendChild(b);
    });
    s1.appendChild(g1);
    body.appendChild(s1);

    const s2 = el('div', 'sheetsec');
    s2.appendChild(el('h4', null, 'WHEEL SECTORS'));
    const g2 = el('div', 'gridbtns c2');
    [['zeroside', 'ZERO HALF'], ['dzeroside', 'DOUBLE-ZERO HALF'],
     ['zerofour', 'ZERO NEIGHBOURS']].forEach(([k, label]) => {
      const nums = SECTORS[k];
      const b = el('button', 'gb small'); b.type = 'button';
      b.appendChild(el('b', null, label));
      const odds = 36 / nums.length - 1;
      b.appendChild(el('i', null, nums.length + ' NUMBERS  ·  PAYS ' +
        (Math.abs(odds - Math.round(odds)) < .005 ? String(Math.round(odds)) : odds.toFixed(2)) + ' TO 1'));
      b.addEventListener('click', () => {
        if (placeMany([['grp:' + nums.join('-'), 1]], label)) closeSheets();
      });
      g2.appendChild(b);
    });
    s2.appendChild(g2);
    body.appendChild(s2);
    body.appendChild(el('p', 'sthint',
      'These cover a slice of the wheel rather than a block of the layout. A ' +
      'double-zero wheel has no Voisins, Tier or Orphelins — those arcs are ' +
      'defined by the European cylinder — so the halves either side of the two ' +
      'zeros stand in their place. The racetrack does the same thing by hand.'));
  }

  let favTab = 'saved';
  $('favsheet').querySelectorAll('.sheettab').forEach(t => {
    t.addEventListener('click', () => {
      favTab = t.dataset.fav;
      $('favsheet').querySelectorAll('.sheettab').forEach(o =>
        o.setAttribute('aria-selected', String(o === t)));
      renderFav();
    });
  });
  $('favbtn').addEventListener('click', () => { renderFav(); openSheet('favsheet'); });

  /* --- autoplay --- */
  let autoLeft = 0, autoPlan = null, autoRounds = 10;

  function renderAuto() {
    const body = $('autobody');
    body.replaceChildren();
    const stake = bets.reduce((s, b) => s + b.amount, 0);

    const sec = el('div', 'sheetsec');
    sec.appendChild(el('h4', null, 'ROUNDS'));
    const g = el('div', 'gridbtns c4');
    [5, 10, 25, 100].forEach(n => {
      const b = el('button', 'gb'); b.type = 'button';
      b.appendChild(el('b', null, String(n)));
      b.appendChild(el('i', null, stake ? fmt(n * stake) : '—'));
      b.style.background = n === autoRounds ? 'rgba(45,212,191,.16)' : '';
      b.addEventListener('click', () => { autoRounds = n; renderAuto(); });
      g.appendChild(b);
    });
    sec.appendChild(g);
    body.appendChild(sec);

    const kv = el('div');
    const row = (k, v) => { const d = el('div', 'kv'); d.append(el('span', null, k), el('b', null, v)); kv.appendChild(d); };
    row('Bet per round', stake ? fmt(stake) : 'no bet on the table');
    row('Rounds', String(autoRounds));
    row('Total committed', stake ? fmt(stake * autoRounds) : '—');
    row('Balance', fmt(balance));
    body.appendChild(kv);

    if (autoLeft > 0) {
      const stop = el('button', 'bigbtn stop', 'STOP  ·  ' + autoLeft + ' ROUNDS LEFT');
      stop.type = 'button';
      stop.addEventListener('click', () => { autoLeft = 0; autoPlan = null; renderAuto(); toast('Autoplay stopped'); });
      body.appendChild(stop);
    } else {
      const start = el('button', 'bigbtn', 'START AUTOPLAY');
      start.type = 'button';
      start.disabled = !stake;
      start.addEventListener('click', () => {
        autoPlan = bets.map(b => ({ key: b.key, amount: b.amount }));
        autoLeft = autoRounds;
        renderAuto();
        toast('Autoplay armed  ·  ' + autoRounds + ' rounds  ·  ' + fmt(stake) + ' a round');
        closeSheets();
      });
      body.appendChild(start);
    }
    body.appendChild(el('p', 'sthint', stake
      ? 'The bet on the table right now is repeated each round. Autoplay stops early ' +
        'if the balance cannot cover the next round.'
      : 'Place a bet on the table first — autoplay repeats whatever is on it.'));
  }

  /* replay the plan at the top of each betting phase, and stop honestly rather
     than half-placing a round the balance cannot cover */
  function autoTick() {
    if (autoLeft <= 0 || !autoPlan) return;
    const cost = autoPlan.reduce((s, b) => s + b.amount, 0);
    if (cost > balance) {
      autoLeft = 0; autoPlan = null;
      toast('Autoplay stopped — balance will not cover another round');
      return;
    }
    autoPlan.forEach(b => place(b.key, { amount: b.amount, silent: true }));
    autoLeft--;
    toast('Autoplay  ·  ' + fmt(cost) + ' staked  ·  ' + autoLeft + ' round' + (autoLeft === 1 ? '' : 's') + ' left');
    if ($('autosheet').classList.contains('on')) renderAuto();
  }

  /* --- menu --- */
  /* There are two mute buttons on this screen: the app's, in the header, and the
     table's, in the rail. They were driving separate flags, so muting from one
     left the other still playing and neither looked like it had worked. The
     table no longer owns the state — it reports the change and is told what the
     answer is, so whichever button is pressed, both agree. */
  let soundOn = opts.soundOn !== false;

  function applySound(v, announce) {
    soundOn = v;
    Sound.setOn(v);
    $('sndbtn').setAttribute('aria-pressed', String(v));
    const m = $('menubody') && $('menubody').querySelector('.menurow[aria-pressed]');
    if (m) m.setAttribute('aria-pressed', String(v));
    if (!v && window.speechSynthesis) window.speechSynthesis.cancel();
    if (announce) toast(v ? 'Sound on' : 'Sound muted');
  }
  function setSound(v) {
    applySound(v, true);
    onSoundChange(v);          // the app shell keeps the authoritative flag
  }
  applySound(soundOn, false);
  $('sndbtn').addEventListener('click', () => setSound(!soundOn));

  const ICONS = {
    lobby: 'M4 11l8-6 8 6v8a1 1 0 01-1 1h-5v-6h-4v6H5a1 1 0 01-1-1z',
    stats: 'M6 19V10M12 19V5M18 19v-6',
    star: 'M12 3.5l2.6 5.3 5.9.85-4.3 4.2 1 5.85L12 16.9l-5.2 2.8 1-5.85-4.3-4.2 5.9-.85z',
    auto: 'M20 12a8 8 0 11-2.4-5.7M20 4.2v3.9h-3.9',
    hist: 'M12 7v5l4 2M4 12a8 8 0 1116 0 8 8 0 01-16 0z',
    coin: 'M4 8c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3M4 8v4c0 1.7 3.6 3 8 3s8-1.3 8-3V8M4 12v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4',
    help: 'M12 3.6a8.4 8.4 0 100 16.8 8.4 8.4 0 000-16.8M9.7 9.4a2.5 2.5 0 114.7 1.2c-.4.8-1.4 1.2-1.9 1.8-.4.4-.5.9-.5 1.5M12 16.8v.5',
    sound: 'M5 10v4h3l4 3V7l-4 3zM16 9.5a4 4 0 010 5',
    chat: 'M20 12a7 7 0 01-9.7 6.5L5 20l1.5-4.5A7 7 0 1120 12z',
  };
  function icon(d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  const PAYOUTS = [
    ['Straight up', '1 number', '35 to 1'],
    ['Basket (0-00-1-2-3)', '5 numbers', '6.2 to 1'],
    ['Split', '2 numbers', '17 to 1'],
    ['Street / trio', '3 numbers', '11 to 1'],
    ['Corner', '4 numbers', '8 to 1'],
    ['Six line', '6 numbers', '5 to 1'],
    ['Dozen / column', '12 numbers', '2 to 1'],
    ['Wheel half (0 / 00 side)', '19 numbers', '0.89 to 1'],
    ['Red / black, odd / even, halves', '18 numbers', '1 to 1'],
  ];

  function renderMenu(view) {
    const body = $('menubody');
    body.replaceChildren();
    $('menusheet').querySelector('h3').textContent =
      { history: 'Game history', payouts: 'Payouts and limits', how: 'How to play' }[view] || 'Menu';

    if (view === 'history') {
      const sec = el('div', 'sheetsec');
      sec.appendChild(el('h4', null, 'LAST 60 RESULTS, NEWEST FIRST'));
      const g = el('div', 'gridbtns c5');
      spins.slice(0, 60).forEach(n => {
        const b = el('button', 'gb small ' + ({green:'', red:'red', black:'blk'}[hueOf(String(n))]));
        b.type = 'button';
        b.appendChild(el('b', null, String(n)));
        b.addEventListener('click', () => {
          if (place('straight:' + n)) { toast('STRAIGHT ' + n + '  ·  ' + fmt(CHIPS[chipIdx])); closeSheets(); }
        });
        g.appendChild(b);
      });
      sec.appendChild(g);
      body.appendChild(sec);
      body.appendChild(backRow());
      return;
    }

    if (view === 'payouts') {
      const t = el('table', 'paytable');
      const thead = el('thead'); const hr = el('tr');
      ['BET', 'COVERS', 'PAYS'].forEach(h => hr.appendChild(el('th', null, h)));
      thead.appendChild(hr); t.appendChild(thead);
      const tb = el('tbody');
      PAYOUTS.forEach(r => {
        const tr = el('tr');
        r.forEach(c => tr.appendChild(el('td', null, c)));
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      body.appendChild(t);
      const kv = el('div');
      [['Table minimum', fmt(tableLimits.minimum)],
       ['Position maximum', fmt(tableLimits.position_max)],
       ['Even-money maximum', fmt(tableLimits.even_money_position_max)],
       ['Wheel', 'American double zero, 38 pockets']].forEach(([k, v]) => {
        const d = el('div', 'kv'); d.append(el('span', null, k), el('b', null, v)); kv.appendChild(d);
      });
      body.appendChild(kv);
      body.appendChild(el('p', 'sthint',
        'Payouts are shown before a bet is placed and are rounded to whole balance values.'));
      body.appendChild(backRow());
      return;
    }

    if (view === 'how') {
      const steps = [
        ['Choose a stake', 'The tray sets the stake for your next tap. Every denomination is available at once.'],
        ['Tap the layout', 'A tap lands on the nearest bet point, so the middle of a box is the number and a line is the split, street or corner it sits on.'],
        ['Or use the racetrack', 'The racetrack bets by position on the wheel: a number plus its neighbours, or one of the French calls.'],
        ['Wait for the ball', 'Betting closes when the wheel goes into play. The ball is simulated — deflectors, fret rattle and all.'],
        ['Get paid', 'Winnings land back on the balance as the result is announced, and the ticker shows what was paid and your net for the round.'],
      ];
      const list = el('div');
      steps.forEach(([h, p], i) => {
        const d = el('div', 'sheetsec');
        d.appendChild(el('h4', null, (i + 1) + '.  ' + h.toUpperCase()));
        const par = el('p', 'sthint', p);
        par.style.textAlign = 'left';
        par.style.margin = '0';
        d.appendChild(par);
        list.appendChild(d);
      });
      body.appendChild(list);
      body.appendChild(backRow());
      return;
    }

    const list = el('div', 'menulist');
    const row = (ic, label, note, onTap) => {
      const b = el('button', 'menurow'); b.type = 'button';
      b.appendChild(icon(ICONS[ic]));
      b.appendChild(el('span', null, label));
      if (note) b.appendChild(el('em', null, note));
      b.addEventListener('click', onTap);
      list.appendChild(b);
      return b;
    };
    /* "Chakri.Casino Casino" was a find-and-replace landing on top of the word
       it was replacing. And a row that only says it cannot do the thing is not
       a menu row — Lobby leaves the table when the shell gives it somewhere to
       go, and says so plainly when it does not. */
    row('lobby', 'Lobby', 'Game lobby',
        onExit ? () => { closeSheets(); onExit(); }
               : () => toast('Use the back arrow above the table'));
    row('stats', 'Statistics', String(spins.length) + ' spins', () => { renderStats(); openSheet('statsheet'); });
    row('star', 'Favourite bets', slots.filter(Boolean).length + ' saved', () => { renderFav(); openSheet('favsheet'); });
    row('auto', 'Autoplay', autoLeft > 0 ? autoLeft + ' rounds left' : 'off', () => { renderAuto(); openSheet('autosheet'); });
    row('hist', 'Game history', '', () => renderMenu('history'));
    row('coin', 'Payouts and limits', '', () => renderMenu('payouts'));
    row('help', 'How to play', '', () => renderMenu('how'));
    row('chat', 'Live support', '', () => toast('Support is in the app menu, outside the table'));

    const snd = row('sound', 'Sound', '', () => setSound(!soundOn));
    snd.setAttribute('aria-pressed', String(soundOn));
    snd.appendChild(el('span', 'toggle'));
    snd.querySelector('span').style.flex = 'none';

    body.appendChild(list);
  }

  function backRow() {
    const b = el('button', 'bigbtn', 'BACK TO MENU');
    b.type = 'button';
    b.style.background = 'rgba(255,255,255,.14)';
    b.style.color = '#fff';
    b.style.marginTop = '18px';
    b.addEventListener('click', () => renderMenu());
    return b;
  }

  $('menubtn').addEventListener('click', () => { renderMenu(); openSheet('menusheet'); });
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));


  /* ================= the table's winners =================
     The standalone build invented eight players so the board had something to
     show. Simulated names cannot ship: on a live table they would present
     fiction as fact to real users. The board now shows only what the server
     reports — this round's result and the player's own settled figure. */
  function showTableWins(win, settled) {
    const host = $('winboard');
    host.replaceChildren();
    const rows = [];
    if (settled && (settled.payout || 0) > 0) {
      rows.push({ name: 'You', ret: settled.payout, me: true });
    }
    if (!rows.length) { host.classList.remove('on'); return; }
    const head = el('div', 'wbhead');
    head.append(el('span', null, 'THIS ROUND'), el('b', null, String(rows.length)));
    host.appendChild(head);
    rows.forEach((r, i) => {
      const row = el('div', 'wbrow' + (r.me ? ' me' : '') + (i === 0 ? ' top' : ''));
      row.append(el('span', 'wbname', r.name), el('span', 'wbamt', '+' + fmt(r.ret)));
      host.appendChild(row);
    });
    host.classList.add('on');
  }

  const hideTableWins = () => $('winboard').classList.remove('on');


  /* ================= the call =================
     Spoken through the Web Speech API, which uses the voices already installed on
     the device — nothing is fetched, so the artifact's CSP is not involved and it
     works offline.

     Voices load asynchronously and the list is empty on the first tick in most
     browsers, so the choice is deferred until first use and re-resolved if the
     list changes. There is no gender field in the API, so a female voice has to be
     picked by name against the known system voices, falling back to any English
     voice rather than going silent. */
  const Voice = (() => {
    const synth = window.speechSynthesis;
    /* Ordered softest first. Ava, Serena and Fiona are the warm, breathy voices;
       Samantha and Zira are flatter and more clipped, so they drop down the list
       and only get picked when nothing gentler is installed. */
    const FEMALE = ['ava', 'serena', 'fiona', 'moira', 'karen', 'tessa', 'allison',
                    'google uk english female', 'sonia', 'emma', 'amy', 'joanna', 'salli',
                    'kate', 'victoria', 'samantha', 'susan', 'zira', 'microsoft zira',
                    'google us english', 'female'];
    let picked = null, resolved = false;

    function choose() {
      if (!synth) return null;
      const all = synth.getVoices();
      if (!all.length) return null;
      /* macOS ships novelty voices (Bells, Bubbles, Bad News, Organ…) that are
         English and would win a naive "first English voice" fallback. Built from a
         list rather than one long literal — a regex literal cannot span lines. */
      const JOKE = ['bad news','good news','bahh','bells','boing','bubbles','cellos','jester',
        'organ','trinoids','whisper','wobble','zarvox','albert','superstar','junior','ralph',
        'fred','deranged','hysterical','pipe','grandma','grandpa','rocko','shelley','sandy',
        'eddy','flo','reed','rishi'];
      const silly = n => JOKE.some(j => n.toLowerCase().includes(j));
      const en = all.filter(v => /^en/i.test(v.lang) && !silly(v.name));
      const pool = en.length ? en : all.filter(v => /^en/i.test(v.lang));
      for (const want of FEMALE) {
        const v = pool.find(x => x.name.toLowerCase().includes(want));
        if (v) return v;
      }
      return pool[0] || null;
    }

    if (synth && synth.addEventListener) {
      synth.addEventListener('voiceschanged', () => { picked = choose(); resolved = !!picked; });
    }

    function say(text) {
      if (!synth || !soundOn) return;
      if (!resolved) { picked = choose(); resolved = !!picked; }
      // never let one call queue up behind another; the latest result is the only
      // one worth hearing
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (picked) u.voice = picked;
      u.lang = (picked && picked.lang) || 'en-GB';
      u.rate = 0.84;           // unhurried — a rushed call never sounds gentle
      u.pitch = 1.22;          // lifted, but short of shrill
      u.volume = 0.78;         // softer than the table sounds, not louder
      synth.speak(u);
    }

    return { say, voiceName: () => (picked ? picked.name : (choose() || {}).name || 'none') };
  })();

  /* "Nineteen, red" — the way it is called at the table, not "the winning
     number is". Both zeros are green and neither is odd, even, red nor black. */
  const WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten',
    'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen',
    'twenty','twenty one','twenty two','twenty three','twenty four','twenty five','twenty six',
    'twenty seven','twenty eight','twenty nine','thirty','thirty one','thirty two','thirty three',
    'thirty four','thirty five','thirty six'];

  function announce(label) {
    const l = String(label);
    const spoken = l === '00' ? 'double zero' : WORDS[+l];
    const colour = hueOf(l);
    Voice.say(spoken + ' … ' + colour + '.');
  }

  /* The pocket the ball actually came to rest in, ringed on the wheel. The head
     has stopped by now, so the marker is placed once at the final screen angle
     and stays put. */
  function markPocket(label) {
    const el = $('pockethl');
    const th = screenTheta(label);
    el.style.left = ((0.5 + TOP_R * S_POCKET * Math.cos(th)) * 100) + '%';
    el.style.top = ((0.5 + TOP_R * S_POCKET * Math.sin(th)) * 100) + '%';
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }
  const clearPocket = () => $('pockethl').classList.remove('on');

  /* ---------- driven by the server ----------
     The standalone build ran its own clock and drew its own winner. Neither can
     survive contact with a real table: the round number, the phase, the countdown
     and the winning pocket are all decided once on the server and handed to every
     player, which is what makes the spin universal. Everything below reacts to
     that state; nothing here decides anything. */
  function winFlash(amount) {
    const f = $('winflash');
    f.replaceChildren(document.createTextNode('+' + fmt(amount) + ' WINNINGS'));
    f.classList.remove('hide');
    void f.offsetWidth;
    f.classList.add('show');
    setTimeout(() => { f.classList.remove('show'); f.classList.add('hide'); }, 2600);
  }

  function callout(text, cls) {
    const c = $('callout');
    c.textContent = text;
    c.className = 'callout ' + cls;
    setTimeout(() => c.classList.add('hide'), 2400);
  }

  const goldSpan = txt => { const sp = document.createElement('span'); sp.className = 'win'; sp.textContent = txt; return sp; };
  const CIRC = 2 * Math.PI * 24;   // the back button's progress ring
  const clock = () => {
    const d = new Date();
    return '# ' + [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(v => String(v).padStart(2, '0')).join(':');
  };
  const idleTicker = () => $('ticker').replaceChildren(document.createTextNode('Place your bets'));

  let phase = null, roundNo = null, spunRound = null, shownRound = null;
  let winCells = [];
  let clockPhase = null, phaseDeadlineMs = 0, roundDeadlineMs = 0;
  let lastAlarm = null;

  function betsOpenNow(nowMs = Date.now()) {
    return clockPhase === 'BETTING'
      && secondsUntil(phaseDeadlineMs, nowMs) >= CLIENT_BETTING_GUARD_SECONDS;
  }

  function renderRoundClock(nowMs = Date.now()) {
    if (!timerEl || !clockPhase || !phaseDeadlineMs || !roundDeadlineMs) return;
    const phaseLeftRaw = secondsUntil(phaseDeadlineMs, nowMs);
    const roundLeftRaw = secondsUntil(roundDeadlineMs, nowMs);
    const phaseLeft = Math.max(0, Math.ceil(phaseLeftRaw));
    const roundLeft = Math.max(0, Math.ceil(roundLeftRaw));
    acceptingBets = betsOpenNow(nowMs);
    phone.dataset.betOpen = String(acceptingBets);

    const tsec = $('btsec'), tval = $('btval'), label = timerEl.querySelector('em');
    const T_CIRC = 2 * Math.PI * 28;
    tsec.textContent = roundLeft;
    if (label) {
      label.textContent = clockPhase === 'BETTING'
        ? (acceptingBets ? `BET ${phaseLeft}s` : 'BETS LOCKED')
        : clockPhase === 'SPINNING' ? `SPIN ${phaseLeft}s` : `NEXT ${phaseLeft}s`;
    }
    const total = Math.max(1, Number(timing.roundSeconds) || 60);
    tval.style.strokeDashoffset = (T_CIRC * (1 - Math.min(1, roundLeftRaw / total))).toFixed(1);
    if (ringval) {
      ringval.style.strokeDashoffset = (CIRC * (1 - Math.min(1, roundLeftRaw / total))).toFixed(1);
    }
    timerEl.dataset.phase = clockPhase.toLowerCase();
    timerEl.dataset.state = clockPhase === 'BETTING'
      ? phaseLeft <= 3 ? 'urgent' : phaseLeft <= 6 ? 'warn' : ''
      : '';
    if (clockPhase === 'BETTING' && phaseLeft >= 1 && phaseLeft <= 3 && phaseLeft !== lastAlarm) {
      lastAlarm = phaseLeft;
      Sound.alarm(phaseLeft);
    } else if (clockPhase !== 'BETTING' || phaseLeft > 3) {
      lastAlarm = null;
    }
  }

  function syncRoundClock(st) {
    if (!st || st.secondsLeft == null) return;
    const now = Date.now();
    clockPhase = st.phase || phase;
    phaseDeadlineMs = Number.isFinite(st.phaseDeadlineMs)
      ? st.phaseDeadlineMs : now + Math.max(0, Number(st.secondsLeft) || 0) * 1000;
    roundDeadlineMs = Number.isFinite(st.roundDeadlineMs)
      ? st.roundDeadlineMs
      : now + Math.max(0, Number(st.roundSecondsLeft ?? st.secondsLeft) || 0) * 1000;
    renderRoundClock(now);
  }

  /* One entry point. React polls the API and calls this; the engine never asks
     for anything itself. */
  function applyState(st) {
    if (!st) return;
    balance = st.balance != null ? st.balance : balance;
    if (st.chipValues) CHIPS.splice(0, CHIPS.length, ...st.chipValues);
    if (st.timing) timing = { ...timing, ...st.timing };
    if (st.limits) {
      tableLimits = { ...tableLimits, ...st.limits };
      syncTableLimits();
    }

    /* --- the chips on the felt are the server's record of them, not ours ---
       null is not an empty felt. It means the caller has a bet in flight and the
       server's list cannot be trusted this tick, because the stake it just
       posted is not in it yet. Reading that as "no bets" swept every chip off
       the table for the second it took the POST to land.

       And the reconciliation is per chip, not wholesale. Clearing the layer and
       redrawing it replaced chips that had not changed, and since a chip
       re-drops when it is drawn, every chip on the felt re-animated on every
       poll — a second of blank table followed by the whole board flashing, once
       a second, for as long as anyone kept betting. */
    if (st.myBets != null) {
      const want = new Map(st.myBets.map(b => [b.key, Number(b.amount) || 0]));
      for (const key of Array.from(chipEls.keys())) {
        if (!want.has(key)) removeChip(key);
      }
      const have = new Map(bets.map(b => [b.key, Number(b.amount) || 0]));
      const toDraw = [];
      want.forEach((amount, key) => {
        // a chip is only redrawn when it is new or its stake moved, so an
        // untouched chip keeps sitting where it landed
        if (!chipEls.has(key) || have.get(key) !== amount) toDraw.push([key, amount]);
      });
      bets = Array.from(want, ([key, amount]) => ({ key, amount }));
      if (toDraw.length && buildAnchors()) {
        toDraw.forEach(([key, amount]) => drawChip(key, amount));
      }
    }
    refreshMoney();
    // Set the true sub-second betting lock before phase-entry actions such as
    // autoplay run. This prevents an optimistic chip in the backend's 0.4s
    // safety window even if the phase poll has not flipped yet.
    syncRoundClock(st);

    // --- phase ---
    const newRound = st.roundNumber != null && st.roundNumber !== roundNo;
    if (newRound) {
      roundNo = st.roundNumber;
      hideTableWins();
      winCells.forEach(e => e.classList.remove('win'));
      winCells = [];
      clearPocket();
    }
    if (st.phase && st.phase !== phase) {
      const was = phase;
      phase = st.phase;
      if (phase === 'BETTING') {
        phone.dataset.mode = 'bet';
        callout('PLACE YOUR BETS', 'open');
        $('clock').textContent = clock();
        /* Autoplay is armed in its sheet and then has to be RUN, and nothing
           was running it — the plan sat there while round after round went by.
           The top of a betting phase is the only place it can go. */
        autoTick();
      } else if (phase === 'SPINNING') {
        phone.dataset.mode = 'spin';
        toggleRacetrack(false);
        callout('NO MORE BETS', 'close');
        Sound.alarm(0);
      }
      /* Whatever was standing when betting closed is what "repeat" repeats. It
         has to be captured here: by the time the next round opens the server has
         cleared the table and the bets are gone. */
      if (was === 'BETTING' && phase !== 'BETTING' && bets.length) {
        lastBets = bets.map(b => ({ key: b.key, amount: b.amount }));
        refreshMoney();
      }
    }

    // --- the spin: start it once per round, timed to the phase that is left ---
    if (st.winningNumber != null && st.phase !== 'BETTING' && spunRound !== st.roundNumber) {
      spunRound = st.roundNumber;
      const spinLeft = phaseDeadlineMs ? secondsUntil(phaseDeadlineMs) : Math.max(0, Number(st.secondsLeft) || 0);
      const dur = st.phase === 'SPINNING' ? Math.max(1200, Math.round(spinLeft * 1000)) : 1600;
      spin(String(st.winningNumber), dur);
    }

    // --- the result, once the ball is down ---
    if (st.phase === 'RESULT' && st.winningNumber != null && shownRound !== st.roundNumber) {
      shownRound = st.roundNumber;
      showResult(String(st.winningNumber), st.settled);
    }
  }
  function showResult(win, settled) {
    phone.dataset.mode = 'result';
    const i = POCKETS.indexOf(win);
    $('nbL').textContent = POCKETS[(i - 1 + NP) % NP];
    $('nbR').textContent = POCKETS[(i + 1) % NP];
    const pk = $('pocket');
    pk.textContent = win;
    pk.style.animation = 'none'; void pk.offsetWidth; pk.style.animation = '';

    winCells = [...root.querySelectorAll('[data-bet="straight:' + win + '"]')];
    winCells.forEach(e => e.classList.add('win'));
    markPocket(win);
    announce(win);

    history.unshift(win);
    history = history.slice(0, 14);
    spins.unshift(win);
    renderHistory();

    /* The figures are the server's settlement, not a local calculation — the
       client no longer decides what anything paid. */
    if (settled && settled.total_bet > 0) {
      const staked = settled.total_bet, payout = settled.payout || 0;
      if (payout > 0) {
        const net = payout - staked;
        const parts = [document.createTextNode('PAYOUT '), goldSpan(fmt(payout))];
        const n = document.createElement('span');
        n.className = net >= 0 ? 'netup' : 'netdown';
        n.textContent = (net >= 0 ? '  net +' : '  net ') + fmt(net);
        parts.push(n);
        $('ticker').replaceChildren(...parts);
        creditBalance(balance);
        winFlash(payout);
        Sound.win(payout / staked);
      } else {
        const sp = document.createElement('span');
        sp.className = 'muted';
        sp.textContent = 'No win — staked ' + fmt(staked);
        $('ticker').replaceChildren(sp);
        Sound.lose();
      }
    } else {
      idleTicker();
    }
    showTableWins(win, settled);
  }

  buildChipTray();
  requestAnimationFrame(() => requestAnimationFrame(buildAnchors));
  renderHistory();
  idleTicker();
  refreshMoney();
  restAt('0');
  const roundClockTimer = window.setInterval(() => renderRoundClock(), 100);

  /* The handle React holds. Nothing in here starts a round or decides a result;
     it only renders what the server has already settled. */
  return {
    applyState,
    rejectBet,
    /* so the header's mute button can drive the table's audio too */
    setSound(v) { applySound(!!v, false); },
    setHistory(list) {
      history = (list || []).map(String).slice(0, 14);
      spins = (list || []).map(String);
      renderHistory();
    },
    destroy() {
      releaseWheelAssetGate();
      clearInterval(roundClockTimer);
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(relayoutFrame);
      clearTimeout(orientationTimer);
      if (layoutObserver) layoutObserver.disconnect();
      window.removeEventListener('resize', relayout);
      window.removeEventListener('orientationchange', onOrientationChange);
      window.removeEventListener('pointerdown', Sound.unlock, { capture: true });
      window.removeEventListener('keydown', Sound.unlock, { capture: true });
      wheelStage.removeEventListener('transitionend', relayout);
      try { Sound.rollStop(); } catch (e) {}
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    },
  };}
