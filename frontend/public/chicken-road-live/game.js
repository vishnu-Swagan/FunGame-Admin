/*
 * Chicken Road - Canvas 2D hop-across-lanes cabinet.
 *
 * Portrait daylight street. The chicken hops right onto manhole covers.
 * Play / GO / CASH OUT are server-authoritative; this file only draws and
 * posts those three verbs. No Aviator climb, no gold trail, no IN OUT branding.
 */
(function () {
  "use strict";

  var E = window.ChickenRoadEngine;
  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var params = new URLSearchParams(window.location.search);
  function resolveApiBase() {
    var fromParam = params.get("api");
    if (fromParam) return fromParam.replace(/\/$/, "");
    var remembered = window.localStorage.getItem("cc_api_base");
    if (remembered) return remembered.replace(/\/$/, "");
    return window.location.origin;
  }
  var API = resolveApiBase() + "/api";
  var TOKEN = window.localStorage.getItem("fg_token") || "";

  function authHeaders(extra) {
    var h = extra || {};
    if (TOKEN) h.Authorization = "Bearer " + TOKEN;
    return h;
  }
  async function apiGet(path) {
    var r = await fetch(API + path, { headers: authHeaders() });
    if (!r.ok) throw { status: r.status };
    return r.json();
  }
  async function apiPost(path, body) {
    var r = await fetch(API + path, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body || {}),
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw { status: r.status, detail: j.detail };
    return j;
  }

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $("scene");
  var ctx = canvas.getContext("2d");
  var audio = new window.ChickenRoadAudio();

  function postToParent(msg) {
    msg.source = "chakri-chicken-road";
    try { window.parent.postMessage(msg, window.location.origin); } catch (e) {}
  }

  var toastTimer = null;
  function toast(text) {
    var el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2400);
  }

  function fmtChips(n) {
    return Math.round(Number(n) || 0).toLocaleString("en-IN");
  }
  function setBalance(v) {
    if (v == null) return;
    $("balance").textContent = fmtChips(v);
    postToParent({ type: "balance", balance: Number(v) });
  }

  // ---- layout / world -----------------------------------------------------
  var SIDEWALK_W = 150;
  var LANE_W = 96;
  var LANE_COUNT = 30;
  var CHIPS = [20, 50, 100, 500];
  var DEFAULT_EASY = [1.01, 1.03, 1.06, 1.10, 1.15, 1.19, 1.24, 1.31, 1.39, 1.48, 1.58, 1.70, 1.84, 2.00, 2.20, 2.45, 2.75, 3.12, 3.58, 4.20, 5.00, 6.05, 7.40, 8.36, 12.08, 18.20, 28.50, 46.00, 78.00, 140.00];
  var DIFF_ORDER = ["easy", "medium", "hard", "hardcore"];
  var DIFF_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard", hardcore: "Hardcore" };

  var dpr = 1, W = 390, H = 640;
  var camX = 0, panX = 0, panVel = 0, dragging = false, dragLast = 0;
  var chickenLane = 0;
  var chickenFrom = 0, chickenTo = 0, hopT = 1, hopDur = 0.28;
  var chickenPose = "idle"; // idle | hop | crash
  var feathers = [];
  var vehicles = [];
  var trees = [];
  var lamps = [];
  var bushes = [];
  var time = 0;
  var lastTs = 0;
  var busy = false;
  var minBet = 10, maxBet = 10000;
  var bet = 20;
  var difficulty = "easy";
  var difficulties = {};
  var round = null;
  var multipliers = DEFAULT_EASY.slice();
  var online = 0;
  var liveWins = [];
  var winIdx = 0;

  function currentSpec() {
    return (difficulties[difficulty] || { traffic: 0.55, speed: 1, multipliers: multipliers });
  }

  function worldWidth() {
    return SIDEWALK_W + LANE_COUNT * LANE_W + 80;
  }
  function laneX(lane) {
    return E.laneWorldX(lane, SIDEWALK_W, LANE_W);
  }
  function chickenWorldX() {
    if (hopT < 1) {
      var a = E.hopEase(hopT);
      return laneX(chickenFrom) + (laneX(chickenTo) - laneX(chickenFrom)) * a;
    }
    return laneX(chickenLane);
  }
  function chickenWorldY() {
    return H * 0.58;
  }

  // ---- HUD ----------------------------------------------------------------
  function setBet(v) {
    bet = E.clamp(Math.round(Number(v) || minBet), minBet, maxBet);
    $("betAmt").value = String(bet);
    document.querySelectorAll(".chip").forEach(function (b) {
      b.classList.toggle("active", Number(b.getAttribute("data-chip")) === bet);
    });
  }
  function buildChips() {
    var host = $("chips");
    host.innerHTML = CHIPS.map(function (c) {
      return '<button class="chip" data-chip="' + c + '">' + c + " ₹</button>";
    }).join("");
    host.querySelectorAll(".chip").forEach(function (b) {
      b.addEventListener("click", function () {
        audio.tick();
        setBet(Number(b.getAttribute("data-chip")));
      });
    });
  }
  function buildDiff() {
    var menu = $("diffMenu");
    menu.innerHTML = DIFF_ORDER.map(function (k) {
      return '<button data-d="' + k + '">' + DIFF_LABEL[k] + "</button>";
    }).join("");
    function refresh() {
      $("diffBtn").innerHTML = DIFF_LABEL[difficulty] + " <span>▾</span>";
      menu.querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-d") === difficulty);
      });
    }
    $("diffBtn").addEventListener("click", function () {
      audio.tick();
      menu.classList.toggle("open");
    });
    menu.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        audio.tick();
        difficulty = b.getAttribute("data-d");
        if (difficulties[difficulty] && difficulties[difficulty].multipliers) {
          multipliers = difficulties[difficulty].multipliers;
          LANE_COUNT = multipliers.length;
        }
        menu.classList.remove("open");
        refresh();
        resetDecor();
      });
    });
    refresh();
  }
  function showIdleActions() {
    $("actions").classList.remove("split");
    $("playBtn").style.display = "";
    $("cashBtn").style.display = "none";
    $("goBtn").style.display = "none";
    $("diffBtn").disabled = false;
    $("minBtn").disabled = false;
    $("maxBtn").disabled = false;
    $("betAmt").disabled = false;
  }
  function showPlayActions(rnd) {
    $("actions").classList.add("split");
    $("playBtn").style.display = "none";
    $("cashBtn").style.display = "";
    $("goBtn").style.display = "";
    var last = rnd && rnd.current_lane >= (rnd.lane_count || LANE_COUNT);
    $("goBtn").disabled = !!last || busy;
    var amt = rnd ? rnd.cashout_amount : 0;
    $("cashBtn").innerHTML = "CASH OUT<span class=\"sub\">" + fmtChips(amt) + " chips</span>";
    $("diffBtn").disabled = true;
    $("minBtn").disabled = true;
    $("maxBtn").disabled = true;
    $("betAmt").disabled = true;
  }
  function applyRound(rnd) {
    round = rnd;
    if (!rnd) {
      chickenLane = 0;
      chickenPose = "idle";
      hopT = 1;
      showIdleActions();
      $("laneTag").style.display = "none";
      return;
    }
    LANE_COUNT = rnd.lane_count || (rnd.multipliers || []).length || LANE_COUNT;
    if (rnd.multipliers && rnd.multipliers.length) multipliers = rnd.multipliers;
    chickenLane = rnd.current_lane || 0;
    if (rnd.status === "PLAYING") showPlayActions(rnd);
    else showIdleActions();
    updateLaneTag();
  }
  function updateLaneTag() {
    var tag = $("laneTag");
    if (round && round.status === "PLAYING" && chickenLane >= 1 && hopT >= 1) {
      tag.textContent = E.formatMult(round.current_multiplier);
      tag.style.display = "block";
    } else {
      tag.style.display = "none";
    }
  }

  $("minBtn").addEventListener("click", function () { audio.tick(); setBet(minBet); });
  $("maxBtn").addEventListener("click", function () { audio.tick(); setBet(maxBet); });
  $("betAmt").addEventListener("change", function () { setBet($("betAmt").value); });
  $("exitBtn").addEventListener("click", function () {
    audio.tick();
    postToParent({ type: "exit" });
  });
  $("homeBtn").addEventListener("click", function () {
    audio.tick();
    postToParent({ type: "exit" });
  });
  $("menuBtn").addEventListener("click", function () {
    audio.tick();
    $("menu").classList.add("show");
  });
  $("menu").addEventListener("click", function (e) {
    if (e.target.id === "menu") $("menu").classList.remove("show");
  });
  $("rulesBtn").addEventListener("click", function () {
    audio.tick();
    toast("Hop right with GO. Cash out before traffic hits the chicken.");
  });
  function syncSwitches() {
    $("soundSw").classList.toggle("on", audio.soundOn);
    $("musicSw").classList.toggle("on", audio.musicOn);
  }
  $("soundSw").addEventListener("click", function () {
    audio.setSound(!audio.soundOn);
    syncSwitches();
  });
  $("musicSw").addEventListener("click", function () {
    audio.setMusic(!audio.musicOn);
    syncSwitches();
  });

  function firstGesture() {
    audio.resume();
    window.removeEventListener("pointerdown", firstGesture);
  }
  window.addEventListener("pointerdown", firstGesture);

  // ---- play / go / cash ---------------------------------------------------
  function startHop(from, to) {
    chickenFrom = from;
    chickenTo = to;
    hopT = reduceMotion ? 1 : 0;
    chickenPose = "hop";
    chickenLane = to;
    audio.hop();
  }
  function burstFeathers(x, y) {
    feathers = [];
    for (var i = 0; i < 18; i++) {
      var a = Math.random() * Math.PI * 2;
      var s = 80 + Math.random() * 180;
      feathers.push({
        x: x, y: y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8,
        life: 0.7 + Math.random() * 0.5,
      });
    }
  }
  function doCrash(rnd) {
    chickenPose = "crash";
    hopT = 1;
    chickenLane = rnd.current_lane || chickenLane;
    spawnHitVehicle(chickenLane);
    var sx = laneX(chickenLane) - camX;
    burstFeathers(sx, chickenWorldY());
    audio.crash();
    var pop = $("crashPop");
    pop.classList.remove("show");
    void pop.offsetWidth;
    pop.classList.add("show");
    showIdleActions();
    setTimeout(function () {
      round = null;
      chickenLane = 0;
      chickenPose = "idle";
      feathers = [];
      $("laneTag").style.display = "none";
      busy = false;
    }, 1400);
  }
  function doWin(res) {
    audio.win();
    var pop = $("winPop");
    $("winSub").textContent = "+" + fmtChips(res.payout) + "  " + E.formatMult(res.multiplier);
    pop.classList.remove("show");
    void pop.offsetWidth;
    pop.classList.add("show");
    round = null;
    chickenLane = 0;
    chickenPose = "idle";
    hopT = 1;
    showIdleActions();
    busy = false;
  }

  async function onPlay() {
    if (busy || round) return;
    audio.resume();
    audio.tick();
    busy = true;
    $("playBtn").disabled = true;
    try {
      var res = await apiPost("/live/chicken-road/play", { amount: bet, difficulty: difficulty });
      setBalance(res.balance);
      applyRound(res.round);
      startHop(0, res.round.current_lane || 1);
      if (res.result === "crashed") {
        setTimeout(function () { doCrash(res.round); }, reduceMotion ? 0 : 260);
      } else {
        busy = false;
        $("playBtn").disabled = false;
        showPlayActions(res.round);
      }
    } catch (err) {
      busy = false;
      $("playBtn").disabled = false;
      toast(err && err.detail ? String(err.detail) : "Could not start");
    }
  }
  async function onGo() {
    if (busy || !round || round.status !== "PLAYING") return;
    audio.resume();
    busy = true;
    $("goBtn").disabled = true;
    try {
      var res = await apiPost("/live/chicken-road/go", { round_id: round.id });
      setBalance(res.balance);
      var from = chickenLane;
      applyRound(res.round);
      startHop(from, res.round.current_lane);
      if (res.result === "crashed") {
        setTimeout(function () { doCrash(res.round); }, reduceMotion ? 0 : 280);
      } else {
        busy = false;
        showPlayActions(res.round);
      }
    } catch (err) {
      busy = false;
      showPlayActions(round);
      toast(err && err.detail ? String(err.detail) : "Hop failed");
    }
  }
  async function onCash() {
    if (busy || !round || round.status !== "PLAYING") return;
    audio.resume();
    busy = true;
    try {
      var res = await apiPost("/live/chicken-road/cashout", { round_id: round.id });
      setBalance(res.balance);
      if (res.result === "cashed_out") doWin(res);
      else if (res.result === "crashed") doCrash(res.round || round);
      else { busy = false; showIdleActions(); }
    } catch (err) {
      busy = false;
      toast(err && err.detail ? String(err.detail) : "Cash out failed");
    }
  }
  $("playBtn").addEventListener("click", onPlay);
  $("goBtn").addEventListener("click", onGo);
  $("cashBtn").addEventListener("click", onCash);

  // ---- traffic / decor ----------------------------------------------------
  var KINDS = ["police", "fire", "taxi", "ice", "delivery", "barrier"];
  function spawnVehicle(lane, y) {
    var kind = KINDS[(Math.random() * KINDS.length) | 0];
    var spec = currentSpec();
    var speed = (180 + Math.random() * 140) * (spec.speed || 1);
    if (kind === "barrier") speed *= 0.45;
    vehicles.push({
      lane: lane, y: y, kind: kind, speed: speed,
      wob: Math.random() * 10,
    });
  }
  function spawnHitVehicle(lane) {
    // Pin a car on the crash lane at the chicken.
    vehicles.push({
      lane: lane, y: chickenWorldY() - 36, kind: KINDS[(Math.random() * 5) | 0],
      speed: 0, wob: 0, hit: true,
    });
  }
  function resetDecor() {
    trees = []; lamps = []; bushes = [];
    var n = Math.max(4, Math.floor(H / 88) || 5);
    for (var i = 0; i < n; i++) {
      var y = 24 + i * (H / n);
      trees.push({ x: 30 + (i % 2) * 10, y: y });
      lamps.push({ x: SIDEWALK_W * 0.78, y: y + 18 });
      bushes.push({ x: 44, y: y + 36 });
    }
  }
  function stepTraffic(dt) {
    var spec = currentSpec();
    var density = spec.traffic || 0.55;
    for (var i = vehicles.length - 1; i >= 0; i--) {
      var v = vehicles[i];
      if (!v.hit) v.y += v.speed * dt;
      if (v.y > H + 120) vehicles.splice(i, 1);
    }
    var spawnChance = density * dt * 2.2;
    if (Math.random() < spawnChance && vehicles.length < 14 + density * 10) {
      var lane = 1 + ((Math.random() * Math.max(4, Math.min(LANE_COUNT, 10))) | 0);
      spawnVehicle(lane, -90 - Math.random() * 80);
    }
  }

  // ---- camera / pointer pan ----------------------------------------------
  function followCamera(dt) {
    var target = chickenWorldX() - W * 0.30;
    var maxCam = Math.max(0, worldWidth() - W);
    if (!dragging) {
      panX += panVel * dt;
      panVel *= Math.pow(0.08, dt);
      panX += (0 - panX) * Math.min(1, 2.4 * dt);
    }
    var desired = E.clamp(target + panX, 0, maxCam);
    camX += (desired - camX) * Math.min(1, 6 * dt);
    camX = E.clamp(camX, 0, maxCam);
  }
  canvas.addEventListener("pointerdown", function (e) {
    dragging = true;
    dragLast = e.clientX;
    panVel = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    var dx = e.clientX - dragLast;
    dragLast = e.clientX;
    panX -= dx;
    panVel = -dx * 40;
    var maxPan = worldWidth() * 0.6;
    panX = E.clamp(panX, -80, maxPan);
  });
  function endDrag() { dragging = false; }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ---- drawing ------------------------------------------------------------
  function resize() {
    var app = $("app");
    var rect = app.getBoundingClientRect();
    var dock = document.querySelector(".dock").getBoundingClientRect();
    W = Math.max(280, rect.width);
    H = Math.max(240, rect.height - dock.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);

  function drawGrass(x0, x1) {
    ctx.fillStyle = "#6fbf4a";
    ctx.fillRect(x0, 0, x1 - x0, H);
    ctx.fillStyle = "#62b043";
    for (var y = 0; y < H; y += 18) ctx.fillRect(x0, y, x1 - x0, 8);
  }
  function drawSidewalk() {
    var x = -camX;
    ctx.fillStyle = "#c5c9ce";
    ctx.fillRect(x, 0, SIDEWALK_W, H);
    ctx.strokeStyle = "#b3b8be";
    ctx.lineWidth = 1;
    for (var r = 0; r < H; r += 28) {
      ctx.beginPath(); ctx.moveTo(x, r); ctx.lineTo(x + SIDEWALK_W, r); ctx.stroke();
    }
    for (var c = 0; c < 4; c++) {
      ctx.beginPath();
      ctx.moveTo(x + 12 + c * 36, 0);
      ctx.lineTo(x + 12 + c * 36, H);
      ctx.stroke();
    }
    ctx.fillStyle = "#9aa1a8";
    ctx.fillRect(x + SIDEWALK_W - 8, 0, 8, H);
  }
  function drawTree(tx, ty) {
    ctx.fillStyle = "#6b4423";
    ctx.fillRect(tx - 4, ty, 8, 22);
    ctx.fillStyle = "#3faa3a";
    ctx.beginPath(); ctx.arc(tx, ty - 6, 16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#4ec34a";
    ctx.beginPath(); ctx.arc(tx + 6, ty - 10, 12, 0, Math.PI * 2); ctx.fill();
  }
  function drawBush(bx, by) {
    ctx.fillStyle = "#3aa83a";
    ctx.beginPath(); ctx.ellipse(bx, by, 16, 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#4ec34a";
    ctx.beginPath(); ctx.ellipse(bx + 8, by - 4, 12, 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  function drawLamp(lx, ly) {
    ctx.fillStyle = "#6d737a";
    ctx.fillRect(lx - 3, ly, 6, 54);
    ctx.fillStyle = "#8a9098";
    ctx.fillRect(lx - 8, ly - 6, 16, 6);
    ctx.fillStyle = "#f0f3a8";
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(lx, ly - 4, 10, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
  function drawRoad() {
    var x = SIDEWALK_W - camX;
    ctx.fillStyle = "#6a717a";
    ctx.fillRect(x, 0, LANE_COUNT * LANE_W + 40, H);
    ctx.fillStyle = "#5f666f";
    ctx.fillRect(x, 0, 6, H);
    for (var i = 1; i <= LANE_COUNT; i++) {
      var lx = SIDEWALK_W + i * LANE_W - camX;
      ctx.strokeStyle = "#e8edf2";
      ctx.setLineDash([16, 14]);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, H); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  function drawManhole(lane, mult, active) {
    var cx = laneX(lane) - camX;
    var cy = chickenWorldY() + 6;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "#3a4048";
    ctx.beginPath(); ctx.ellipse(0, 0, 34, 22, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#2a3036";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "#4a515a";
    ctx.lineWidth = 1.5;
    for (var i = -3; i <= 3; i++) {
      ctx.beginPath(); ctx.moveTo(i * 7, -16); ctx.lineTo(i * 7, 16); ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(E.formatMult(mult), 0, 0);
    if (active) {
      ctx.strokeStyle = "rgba(255,220,70,0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 0, 38, 25, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawVehicle(v) {
    var cx = laneX(v.lane) - camX;
    var y = v.y;
    if (cx < -80 || cx > W + 80) return;
    ctx.save();
    ctx.translate(cx, y);
    var kind = v.kind;
    if (kind === "barrier") {
      ctx.fillStyle = "#222";
      roundRect(-28, -8, 56, 16, 3); ctx.fill();
      ctx.fillStyle = "#f5c400";
      for (var s = -24; s < 24; s += 14) ctx.fillRect(s, -6, 8, 12);
      ctx.restore();
      return;
    }
    var body = "#f0c400";
    var cab = "#e8b000";
    var w = 44, h = 72;
    if (kind === "police") { body = "#eef2f6"; cab = "#2b5cff"; w = 42; h = 68; }
    else if (kind === "fire") { body = "#d63a32"; cab = "#b81f1a"; w = 50; h = 90; }
    else if (kind === "taxi") { body = "#f5c400"; cab = "#e0b000"; w = 42; h = 66; }
    else if (kind === "ice") { body = "#f7f4ee"; cab = "#7fd3e8"; w = 48; h = 82; }
    else if (kind === "delivery") { body = "#e6b422"; cab = "#c99612"; w = 50; h = 86; }
    ctx.fillStyle = body;
    roundRect(-w / 2, -h / 2, w, h, 8); ctx.fill();
    ctx.fillStyle = cab;
    roundRect(-w / 2 + 4, -h / 2 + 6, w - 8, h * 0.28, 5); ctx.fill();
    ctx.fillStyle = "rgba(180,220,255,0.7)";
    roundRect(-w / 2 + 8, -h / 2 + 10, w - 16, h * 0.16, 3); ctx.fill();
    ctx.fillStyle = "#1a1d22";
    ctx.fillRect(-w / 2 - 3, -h / 2 + 14, 6, 14);
    ctx.fillRect(w / 2 - 3, -h / 2 + 14, 6, 14);
    ctx.fillRect(-w / 2 - 3, h / 2 - 24, 6, 14);
    ctx.fillRect(w / 2 - 3, h / 2 - 24, 6, 14);
    if (kind === "police") {
      ctx.fillStyle = "#2b5cff";
      ctx.fillRect(-8, -h / 2 + 2, 7, 6);
      ctx.fillStyle = "#e24b4b";
      ctx.fillRect(2, -h / 2 + 2, 7, 6);
    }
    if (kind === "ice") {
      ctx.fillStyle = "#ff8fab";
      ctx.beginPath(); ctx.arc(0, 4, 8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function drawChicken() {
    var x = chickenWorldX() - camX;
    var y = chickenWorldY();
    var hop = hopT < 1 ? E.hopArc(hopT) : 0;
    y -= hop * 36;
    var squash = chickenPose === "crash" ? 0.38 : (hopT < 1 ? 1 - 0.18 * (1 - hop) : 1);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, squash);
    if (chickenPose === "crash") ctx.rotate(0.4);
    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath(); ctx.ellipse(0, 22, 18, 7, 0, 0, Math.PI * 2); ctx.fill();
    // feet
    ctx.fillStyle = "#f0c400";
    ctx.beginPath(); ctx.ellipse(-8, 18, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(8, 18, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
    // body
    ctx.fillStyle = "#f7f7f4";
    ctx.beginPath(); ctx.ellipse(0, 2, 22, 20, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // comb
    ctx.fillStyle = "#e23b3b";
    ctx.beginPath(); ctx.arc(-4, -16, 5, 0, Math.PI * 2); ctx.arc(3, -18, 6, 0, Math.PI * 2); ctx.arc(10, -14, 4.5, 0, Math.PI * 2); ctx.fill();
    // wattle
    ctx.beginPath(); ctx.arc(12, -2, 3.5, 0, Math.PI * 2); ctx.fill();
    // beak (faces right)
    ctx.fillStyle = "#f0c400";
    ctx.beginPath(); ctx.moveTo(18, -2); ctx.lineTo(30, 2); ctx.lineTo(18, 6); ctx.closePath(); ctx.fill();
    // eyes
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(4, -4, 8, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(14, -3, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.arc(4, -4, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(14, -3, 7, 0, Math.PI * 2); ctx.stroke();
    if (chickenPose === "crash") {
      ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(8, 0); ctx.moveTo(8, -8); ctx.lineTo(0, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(10, -7); ctx.lineTo(18, 1); ctx.moveTo(18, -7); ctx.lineTo(10, 1); ctx.stroke();
    } else {
      ctx.fillStyle = "#1a1a1a";
      ctx.beginPath(); ctx.arc(6, -4, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(16, -3, 2.8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(7.2, -5.2, 1.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function drawFeathers(dt) {
    for (var i = feathers.length - 1; i >= 0; i--) {
      var f = feathers[i];
      f.life -= dt;
      f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 220 * dt; f.rot += f.vr * dt;
      if (f.life <= 0) { feathers.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, f.life / 0.9);
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.ellipse(0, 0, 5, 2.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
  function drawScene(dt) {
    ctx.fillStyle = "#6fbf4a";
    ctx.fillRect(0, 0, W, H);
    drawGrass(-camX - 40, SIDEWALK_W * 0.42 - camX);
    bushes.forEach(function (b) { drawBush(b.x - camX, b.y); });
    trees.forEach(function (t) { drawTree(t.x - camX, t.y); });
    drawSidewalk();
    lamps.forEach(function (l) { drawLamp(l.x - camX, l.y); });
    drawRoad();
    var visFrom = Math.max(1, Math.floor(camX / LANE_W) - 1);
    var visTo = Math.min(LANE_COUNT, visFrom + Math.ceil(W / LANE_W) + 3);
    for (var lane = visFrom; lane <= visTo; lane++) {
      var m = multipliers[lane - 1];
      if (m == null) continue;
      drawManhole(lane, m, round && round.current_lane === lane);
    }
    vehicles.forEach(drawVehicle);
    drawChicken();
    drawFeathers(dt);
    // peek hint when panned
    if (Math.abs(panX) > 30) {
      ctx.fillStyle = "rgba(20,22,26,0.35)";
      ctx.font = "bold 11px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("peeking lanes →", W / 2, 110);
    }
  }

  function frame(ts) {
    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    time += dt;
    if (hopT < 1) {
      hopT += dt / hopDur;
      if (hopT >= 1) {
        hopT = 1;
        if (chickenPose === "hop") chickenPose = "idle";
        updateLaneTag();
      }
    }
    stepTraffic(dt);
    followCamera(dt);
    // lane tag follows chicken
    if ($("laneTag").style.display === "block") {
      var sx = chickenWorldX() - camX;
      $("laneTag").style.left = sx + "px";
      $("laneTag").style.top = (chickenWorldY() + 28) + "px";
    }
    drawScene(dt);
    requestAnimationFrame(frame);
  }

  // ---- live ticker / state poll ------------------------------------------
  function paintTicker() {
    $("online").textContent = String(online || 0);
    if (!liveWins.length) return;
    var w = liveWins[winIdx % liveWins.length];
    $("liveWho").textContent = w.name || "Player";
    $("liveAmt").textContent = "+" + fmtChips(w.payout);
    winIdx += 1;
  }
  async function pollState() {
    try {
      var data = await apiGet("/live/chicken-road/state");
      setBalance(data.balance);
      minBet = data.min_bet || minBet;
      maxBet = data.max_bet || maxBet;
      if (data.chip_presets && data.chip_presets.length) CHIPS = data.chip_presets;
      difficulties = data.difficulties || {};
      if (!multipliers.length && difficulties[difficulty]) {
        multipliers = difficulties[difficulty].multipliers || [];
        LANE_COUNT = multipliers.length || LANE_COUNT;
      }
      online = data.online || 0;
      liveWins = data.live_wins || [];
      paintTicker();
      if (!busy && !round && data.active) {
        applyRound(data.active);
        chickenLane = data.active.current_lane;
        hopT = 1;
      }
    } catch (err) {
      if (err && err.status === 401) toast("Session needed — open Chicken Road from the lounge.");
    }
  }

  // ---- boot ---------------------------------------------------------------
  buildChips();
  buildDiff();
  setBet(20);
  showIdleActions();
  resetDecor();
  syncSwitches();
  resize();
  pollState();
  setInterval(pollState, 4000);
  setInterval(paintTicker, 2800);
  requestAnimationFrame(frame);
})();
