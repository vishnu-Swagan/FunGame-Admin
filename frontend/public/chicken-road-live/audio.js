/*
 * Chicken Road - original layered audio, fully synthesised with the Web Audio
 * API. Nothing here is sampled, scraped, or copied.
 *
 * Layers:
 *   1) traffic bed  - filtered noise + periodic whooshes + rare horns
 *   2) hop/cluck    - short pitched chirps on each lane hop
 *   3) crash        - tyre screech + thud + squawk (ducks the bed)
 *   4) win sting    - bright daylight arpeggio
 *   5) ui tick      - tiny click
 *   6) music        - quiet looping ostinato, independently togglable
 */
(function (root) {
  "use strict";

  var SOUND_KEY = "cr_sound";
  var MUSIC_KEY = "cr_music";

  function ChickenRoadAudio() {
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.bedGain = null;
    this.soundOn = localStorage.getItem(SOUND_KEY) !== "0";
    this.musicOn = localStorage.getItem(MUSIC_KEY) !== "0";
    this._bedStarted = false;
    this._musicStarted = false;
    this._noiseBuffer = null;
    this._trafficTimer = null;
  }

  ChickenRoadAudio.prototype.ensure = function () {
    if (this.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.soundOn ? 0.9 : 0;
    this.sfxGain.connect(this.master);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.musicOn ? 0.18 : 0;
    this.musicGain.connect(this.master);
    this._noiseBuffer = this._makeNoise(2.0);
  };

  ChickenRoadAudio.prototype.resume = function () {
    this.ensure();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    if (!this._bedStarted) this._startBed();
    if (!this._musicStarted) this._startMusic();
  };

  ChickenRoadAudio.prototype.setSound = function (on) {
    this.soundOn = !!on;
    localStorage.setItem(SOUND_KEY, this.soundOn ? "1" : "0");
    if (this.sfxGain && this.ctx) {
      var t = this.ctx.currentTime;
      this.sfxGain.gain.cancelScheduledValues(t);
      this.sfxGain.gain.setTargetAtTime(this.soundOn ? 0.9 : 0, t, 0.05);
    }
  };

  ChickenRoadAudio.prototype.setMusic = function (on) {
    this.musicOn = !!on;
    localStorage.setItem(MUSIC_KEY, this.musicOn ? "1" : "0");
    if (this.musicGain && this.ctx) {
      var t = this.ctx.currentTime;
      this.musicGain.gain.cancelScheduledValues(t);
      this.musicGain.gain.setTargetAtTime(this.musicOn ? 0.18 : 0, t, 0.08);
    }
  };

  ChickenRoadAudio.prototype._makeNoise = function (seconds) {
    var len = Math.floor(this.ctx.sampleRate * seconds);
    var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  ChickenRoadAudio.prototype._startBed = function () {
    if (!this.ctx || this._bedStarted) return;
    this._bedStarted = true;
    var src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = true;
    var lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 480;
    lp.Q.value = 0.5;
    this.bedGain = this.ctx.createGain();
    this.bedGain.gain.value = 0.10;
    src.connect(lp);
    lp.connect(this.bedGain);
    this.bedGain.connect(this.sfxGain);
    src.start();
    this._scheduleTraffic();
  };

  ChickenRoadAudio.prototype._scheduleTraffic = function () {
    var self = this;
    var next = function () {
      if (!self.ctx) return;
      self._whoosh();
      if (Math.random() < 0.10) self._horn();
      self._trafficTimer = setTimeout(next, 800 + Math.random() * 1400);
    };
    this._trafficTimer = setTimeout(next, 600);
  };

  ChickenRoadAudio.prototype._whoosh = function () {
    if (!this.ctx || !this.soundOn) return;
    var t = this.ctx.currentTime;
    var src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    var bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(820, t + 0.28);
    bp.frequency.exponentialRampToValueAtTime(200, t + 0.7);
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.16);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    src.connect(bp); bp.connect(g); g.connect(this.sfxGain);
    src.start(t); src.stop(t + 0.8);
  };

  ChickenRoadAudio.prototype._horn = function () {
    if (!this.ctx || !this.soundOn) return;
    var t = this.ctx.currentTime;
    var o1 = this.ctx.createOscillator();
    var o2 = this.ctx.createOscillator();
    o1.type = "sawtooth"; o2.type = "sawtooth";
    o1.frequency.value = 330; o2.frequency.value = 392;
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.04);
    g.gain.setValueAtTime(0.07, t + 0.28);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
    o1.connect(g); o2.connect(g); g.connect(this.sfxGain);
    o1.start(t); o2.start(t); o1.stop(t + 0.5); o2.stop(t + 0.5);
  };

  ChickenRoadAudio.prototype.hop = function () {
    if (!this.ctx || !this.soundOn) return;
    var t = this.ctx.currentTime;
    var o = this.ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(1480, t + 0.07);
    o.frequency.exponentialRampToValueAtTime(640, t + 0.16);
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g); g.connect(this.sfxGain);
    o.start(t); o.stop(t + 0.2);
  };

  ChickenRoadAudio.prototype.crash = function () {
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    if (this.bedGain) {
      this.bedGain.gain.cancelScheduledValues(t);
      this.bedGain.gain.setValueAtTime(this.bedGain.gain.value, t);
      this.bedGain.gain.exponentialRampToValueAtTime(0.02, t + 0.05);
      this.bedGain.gain.exponentialRampToValueAtTime(0.10, t + 1.0);
    }
    if (!this.soundOn) return;
    var src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    var bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 6;
    bp.frequency.setValueAtTime(1800, t);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.32);
    var sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.28, t + 0.03);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    src.connect(bp); bp.connect(sg); sg.connect(this.sfxGain);
    src.start(t); src.stop(t + 0.42);
    var o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(130, t + 0.04);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.32);
    var og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, t + 0.04);
    og.gain.exponentialRampToValueAtTime(0.38, t + 0.08);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o.connect(og); og.connect(this.sfxGain);
    o.start(t + 0.04); o.stop(t + 0.4);
    var sq = this.ctx.createOscillator();
    sq.type = "sawtooth";
    sq.frequency.setValueAtTime(1100, t);
    sq.frequency.exponentialRampToValueAtTime(280, t + 0.22);
    var sqg = this.ctx.createGain();
    sqg.gain.setValueAtTime(0.0001, t);
    sqg.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
    sqg.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    sq.connect(sqg); sqg.connect(this.sfxGain);
    sq.start(t); sq.stop(t + 0.26);
  };

  ChickenRoadAudio.prototype.win = function () {
    if (!this.ctx || !this.soundOn) return;
    var t = this.ctx.currentTime;
    var notes = [523.25, 659.25, 783.99, 1046.5];
    for (var i = 0; i < notes.length; i++) {
      var st = t + i * 0.08;
      var o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = notes[i];
      var g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.22, st + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.48);
      o.connect(g); g.connect(this.sfxGain);
      o.start(st); o.stop(st + 0.52);
    }
  };

  ChickenRoadAudio.prototype.tick = function () {
    if (!this.ctx || !this.soundOn) return;
    var t = this.ctx.currentTime;
    var o = this.ctx.createOscillator();
    o.type = "square";
    o.frequency.value = 720;
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g); g.connect(this.sfxGain);
    o.start(t); o.stop(t + 0.06);
  };

  ChickenRoadAudio.prototype._startMusic = function () {
    if (!this.ctx || this._musicStarted) return;
    this._musicStarted = true;
    var self = this;
    var pattern = [392, 494, 587, 659, 587, 494, 392, 330];
    var step = 0;
    var beat = 0.42;
    var playStep = function () {
      if (!self.ctx) return;
      var t = self.ctx.currentTime;
      var freq = pattern[step % pattern.length];
      step += 1;
      var o = self.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = freq;
      var g = self.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.9);
      o.connect(g); g.connect(self.musicGain);
      o.start(t); o.stop(t + beat);
      // quiet fifth pad
      var p = self.ctx.createOscillator();
      p.type = "sine";
      p.frequency.value = freq / 2;
      var pg = self.ctx.createGain();
      pg.gain.setValueAtTime(0.0001, t);
      pg.gain.exponentialRampToValueAtTime(0.12, t + 0.04);
      pg.gain.exponentialRampToValueAtTime(0.0001, t + beat);
      p.connect(pg); pg.connect(self.musicGain);
      p.start(t); p.stop(t + beat);
      self._musicTimer = setTimeout(playStep, beat * 1000);
    };
    playStep();
  };

  root.ChickenRoadAudio = ChickenRoadAudio;
})(typeof self !== "undefined" ? self : this);
