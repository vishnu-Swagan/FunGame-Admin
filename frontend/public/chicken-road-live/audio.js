/*
 * Chicken Road - original layered audio, fully synthesised with the Web Audio
 * API. Nothing here is sampled, scraped, or copied: every sound is generated at
 * runtime from oscillators and filtered noise, so there are no third-party
 * recordings and no asset files to ship.
 *
 * Layers:
 *   1) traffic bed  - filtered noise + periodic doppler whooshes + rare horns
 *   2) hop/cluck    - short pitched chirps while the chicken runs
 *   3) crash        - tyre screech + thud + squawk (ducks the bed)
 *   4) win sting    - bright gold arpeggio
 *   5) ui tick      - tiny click on bet / cash-out
 *
 * Muted-until-gesture (browsers block autoplay); mute state persists.
 */
(function (root) {
  "use strict";

  var STORAGE_KEY = "cr_muted";

  function ChickenRoadAudio() {
    this.ctx = null;
    this.master = null;
    this.bedGain = null;
    this.muted = localStorage.getItem(STORAGE_KEY) === "1";
    this._bedStarted = false;
    this._noiseBuffer = null;
    this._trafficTimer = null;
  }

  ChickenRoadAudio.prototype.isMuted = function () {
    return this.muted;
  };

  ChickenRoadAudio.prototype.ensure = function () {
    if (this.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);
    this._noiseBuffer = this._makeNoise(2.0);
  };

  // Resume on a user gesture (required by autoplay policies).
  ChickenRoadAudio.prototype.resume = function () {
    this.ensure();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    if (!this._bedStarted) this._startBed();
  };

  ChickenRoadAudio.prototype.setMuted = function (muted) {
    this.muted = !!muted;
    localStorage.setItem(STORAGE_KEY, this.muted ? "1" : "0");
    if (this.master && this.ctx) {
      var t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, t, 0.05);
    }
  };

  ChickenRoadAudio.prototype.toggleMute = function () {
    this.setMuted(!this.muted);
    return this.muted;
  };

  ChickenRoadAudio.prototype._makeNoise = function (seconds) {
    var len = Math.floor(this.ctx.sampleRate * seconds);
    var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  // --- 1) traffic bed -------------------------------------------------------
  ChickenRoadAudio.prototype._startBed = function () {
    if (!this.ctx || this._bedStarted) return;
    this._bedStarted = true;
    var src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = true;
    var lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    lp.Q.value = 0.6;
    this.bedGain = this.ctx.createGain();
    this.bedGain.gain.value = 0.12;
    src.connect(lp);
    lp.connect(this.bedGain);
    this.bedGain.connect(this.master);
    src.start();
    this._scheduleTraffic();
  };

  ChickenRoadAudio.prototype._scheduleTraffic = function () {
    var self = this;
    var next = function () {
      if (!self.ctx) return;
      self._whoosh();
      if (Math.random() < 0.12) self._horn();
      self._trafficTimer = setTimeout(next, 900 + Math.random() * 1600);
    };
    this._trafficTimer = setTimeout(next, 700);
  };

  // A passing vehicle: filtered noise burst that sweeps pitch (doppler).
  ChickenRoadAudio.prototype._whoosh = function () {
    if (!this.ctx || this.muted) return;
    var t = this.ctx.currentTime;
    var src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    var bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(280, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.28);
    bp.frequency.exponentialRampToValueAtTime(220, t + 0.7);
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.8);
  };

  ChickenRoadAudio.prototype._horn = function () {
    if (!this.ctx || this.muted) return;
    var t = this.ctx.currentTime;
    var o1 = this.ctx.createOscillator();
    var o2 = this.ctx.createOscillator();
    o1.type = "sawtooth";
    o2.type = "sawtooth";
    o1.frequency.value = 330;
    o2.frequency.value = 440;
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.05);
    g.gain.setValueAtTime(0.09, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o1.connect(g);
    o2.connect(g);
    g.connect(this.master);
    o1.start(t); o2.start(t);
    o1.stop(t + 0.6); o2.stop(t + 0.6);
  };

  // --- 2) hop / cluck -------------------------------------------------------
  ChickenRoadAudio.prototype.hop = function () {
    if (!this.ctx || this.muted) return;
    var t = this.ctx.currentTime;
    var o = this.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(1500, t + 0.06);
    o.frequency.exponentialRampToValueAtTime(700, t + 0.13);
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.18);
  };

  // --- 3) crash -------------------------------------------------------------
  ChickenRoadAudio.prototype.crash = function () {
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    // duck the bed briefly
    if (this.bedGain) {
      this.bedGain.gain.cancelScheduledValues(t);
      this.bedGain.gain.setValueAtTime(this.bedGain.gain.value, t);
      this.bedGain.gain.exponentialRampToValueAtTime(0.02, t + 0.05);
      this.bedGain.gain.exponentialRampToValueAtTime(0.12, t + 1.1);
    }
    if (this.muted) return;
    // tyre screech: bandpass noise sweeping down
    var src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    var bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(2000, t);
    bp.frequency.exponentialRampToValueAtTime(600, t + 0.35);
    var sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.28, t + 0.03);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    src.connect(bp); bp.connect(sg); sg.connect(this.master);
    src.start(t); src.stop(t + 0.45);
    // thud
    var o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(140, t + 0.05);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.35);
    var og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, t + 0.05);
    og.gain.exponentialRampToValueAtTime(0.4, t + 0.09);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(og); og.connect(this.master);
    o.start(t + 0.05); o.stop(t + 0.42);
    // squawk
    var sq = this.ctx.createOscillator();
    sq.type = "sawtooth";
    sq.frequency.setValueAtTime(1200, t);
    sq.frequency.exponentialRampToValueAtTime(300, t + 0.22);
    var sqg = this.ctx.createGain();
    sqg.gain.setValueAtTime(0.0001, t);
    sqg.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    sqg.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    sq.connect(sqg); sqg.connect(this.master);
    sq.start(t); sq.stop(t + 0.27);
  };

  // --- 4) win sting ---------------------------------------------------------
  ChickenRoadAudio.prototype.win = function () {
    if (!this.ctx || this.muted) return;
    var t = this.ctx.currentTime;
    var notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    for (var i = 0; i < notes.length; i++) {
      var st = t + i * 0.09;
      var o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = notes[i];
      var g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.2, st + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.5);
      o.connect(g); g.connect(this.master);
      o.start(st); o.stop(st + 0.55);
    }
  };

  // --- 5) ui tick -----------------------------------------------------------
  ChickenRoadAudio.prototype.tick = function () {
    if (!this.ctx || this.muted) return;
    var t = this.ctx.currentTime;
    var o = this.ctx.createOscillator();
    o.type = "square";
    o.frequency.value = 660;
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.07);
  };

  root.ChickenRoadAudio = ChickenRoadAudio;
})(typeof self !== "undefined" ? self : this);