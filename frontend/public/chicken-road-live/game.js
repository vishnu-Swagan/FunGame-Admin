/*
 * Chicken Road - Canvas 2D hop-across-lanes cabinet.
 *
 * Portrait daylight street. The chicken hops right onto manhole covers.
 * Play / GO / CASH OUT are server-authoritative; this file only draws and
 * posts those three verbs. Original Chakri art - no IN OUT sprites or lockup.
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
  var SIDEWALK_W = 160;
  var LANE_W = 128;
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
  function onRoad() {
    return chickenLane >= 1 || (hopT < 1 && chickenTo >= 1);
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
      return '<button class="chip" data-chip="' + c + '">' + c +
        ' <span class="coin">₹</span></button>';
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
    $("app").classList.remove("playing");
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
    $("app").classList.add("playing");
    $("actions").classList.add("split");
    $("playBtn").style.display = "none";
    $("cashBtn").style.display = "";
    $("goBtn").style.display = "";
    var last = rnd && rnd.current_lane >= (rnd.lane_count || LANE_COUNT);
    $("goBtn").disabled = !!last || busy;
    var amt = rnd ? rnd.cashout_amount : 0;
    $("cashBtn").innerHTML = "CASH OUT<span class=\"sub\">" + fmtChips(amt) + " INR</span>";
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
      return;
    }
    LANE_COUNT = rnd.lane_count || (rnd.multipliers || []).length || LANE_COUNT;
    if (rnd.multipliers && rnd.multipliers.length) multipliers = rnd.multipliers;
    chickenLane = rnd.current_lane || 0;
    if (rnd.status === "PLAYING") showPlayActions(rnd);
    else showIdleActions();
    snapCamera();
    ensureHeroTraffic();
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
    ensureHeroTraffic();
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
  var KINDS = ["taxi", "truck", "police", "fire", "ice", "delivery", "barrier"];
  function spawnVehicle(lane, y, kind, speed) {
    kind = kind || KINDS[(Math.random() * KINDS.length) | 0];
    var spec = currentSpec();
    if (speed == null) {
      speed = (160 + Math.random() * 140) * (spec.speed || 1);
      if (kind === "barrier") speed *= 0.42;
      if (kind === "truck") speed *= 0.75;
    }
    vehicles.push({
      lane: lane, y: y, kind: kind, speed: speed,
      wob: Math.random() * 10,
    });
  }
  function spawnHitVehicle(lane) {
    vehicles.push({
      lane: lane, y: chickenWorldY() - 40, kind: "taxi",
      speed: 0, wob: 0, hit: true,
    });
  }
  function resetDecor() {
    trees = []; lamps = []; bushes = [];
    var n = Math.max(5, Math.floor(H / 78) || 6);
    for (var i = 0; i < n; i++) {
      var y = 18 + i * (H / n);
      trees.push({ x: 28 + (i % 2) * 12, y: y });
      lamps.push({ x: SIDEWALK_W * 0.78, y: y + 22 });
      bushes.push({ x: 46, y: y + 34 });
    }
  }
  function laneOccupiedNear(lane, y, spread) {
    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i];
      if (v.lane === lane && Math.abs(v.y - y) < spread) return true;
    }
    return false;
  }
  function ensureHeroTraffic() {
    if (!(round && round.status === "PLAYING") || chickenLane < 1) return;
    var lane = chickenLane;
    var cy = chickenWorldY();
    var hasBarrier = false, hasTaxi = false, hasTruck = false;
    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i];
      if (v.hit) continue;
      if (v.lane === lane && v.kind === "barrier" && v.y < cy - 20) hasBarrier = true;
      if (v.lane === lane && v.kind === "taxi" && v.y < cy - 20) hasTaxi = true;
      if (v.lane === lane + 2 && v.kind === "truck") hasTruck = true;
    }
    if (!hasBarrier) spawnVehicle(lane, cy - 108, "barrier", 78);
    if (!hasTaxi) spawnVehicle(lane, cy - 228, "taxi", 170);
    if (!hasTruck && chickenLane + 2 <= LANE_COUNT) {
      spawnVehicle(lane + 2, cy - 160, "truck", 130);
    }
  }
  function stepTraffic(dt) {
    var spec = currentSpec();
    var density = spec.traffic || 0.55;
    var padY = chickenWorldY();
    for (var i = vehicles.length - 1; i >= 0; i--) {
      var v = vehicles[i];
      if (!v.hit) v.y += v.speed * dt;
      if (v.y > H + 130) vehicles.splice(i, 1);
    }
    var visFrom = Math.max(1, Math.floor((camX - SIDEWALK_W) / LANE_W) - 1);
    var visTo = Math.min(LANE_COUNT, visFrom + 6);
    var spawnChance = density * dt * 1.8;
    if (Math.random() < spawnChance && vehicles.length < 12 + density * 8) {
      var lane = visFrom + ((Math.random() * Math.max(1, visTo - visFrom + 1)) | 0);
      var y = -90 - Math.random() * 80;
      if (Math.abs(y - padY) > 70 && !laneOccupiedNear(lane, y, 90)) {
        spawnVehicle(lane, y);
      }
    }
    ensureHeroTraffic();
  }

  // ---- camera / pointer pan ----------------------------------------------
  function snapCamera() {
    var target = E.frameCameraX(chickenWorldX(), W, onRoad());
    var maxCam = Math.max(0, worldWidth() - W);
    camX = E.clamp(target, 0, maxCam);
    panX = 0;
    panVel = 0;
  }
  function followCamera(dt) {
    var target = E.frameCameraX(chickenWorldX(), W, onRoad());
    var maxCam = Math.max(0, worldWidth() - W);
    if (!dragging) {
      panX += panVel * dt;
      panVel *= Math.pow(0.08, dt);
      panX += (0 - panX) * Math.min(1, 2.4 * dt);
    }
    var desired = E.clamp(target + panX, 0, maxCam);
    var err = desired - camX;
    if (Math.abs(err) > 140) camX = desired;
    else camX += err * Math.min(1, 8 * dt);
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
    var head = document.querySelector("header").getBoundingClientRect();
    W = Math.max(280, rect.width);
    H = Math.max(240, rect.height - dock.height - head.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    LANE_W = Math.round(W / 3.02);
    SIDEWALK_W = Math.round(W * 0.40);
    resetDecor();
    snapCamera();
  }
  window.addEventListener("resize", resize);

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawGrass(x0, x1) {
    ctx.fillStyle = "#5fb344";
    ctx.fillRect(x0, 0, x1 - x0, H);
    ctx.fillStyle = "#54a63c";
    for (var y = 0; y < H; y += 22) ctx.fillRect(x0, y, x1 - x0, 10);
  }
  function drawHedge(x, y) {
    ctx.fillStyle = "#3e9a36";
    ctx.beginPath(); ctx.ellipse(x, y, 22, 14, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#4eb344";
    ctx.beginPath(); ctx.ellipse(x + 10, y - 6, 16, 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#34862e";
    ctx.beginPath(); ctx.ellipse(x - 8, y + 4, 14, 10, 0, 0, Math.PI * 2); ctx.fill();
  }
  function drawSidewalk() {
    var x = -camX;
    ctx.fillStyle = "#c8ccd2";
    ctx.fillRect(x, 0, SIDEWALK_W, H);
    ctx.strokeStyle = "#b4bac2";
    ctx.lineWidth = 1;
    for (var r = 0; r < H; r += 32) {
      ctx.beginPath(); ctx.moveTo(x, r); ctx.lineTo(x + SIDEWALK_W, r); ctx.stroke();
    }
    for (var c = 0; c < 4; c++) {
      ctx.beginPath();
      ctx.moveTo(x + 10 + c * 36, 0);
      ctx.lineTo(x + 10 + c * 36, H);
      ctx.stroke();
    }
    ctx.fillStyle = "#9aa3ac";
    ctx.fillRect(x + SIDEWALK_W - 10, 0, 10, H);
    ctx.fillStyle = "#868f98";
    ctx.fillRect(x + SIDEWALK_W - 3, 0, 3, H);
  }
  function drawTree(tx, ty) {
    ctx.fillStyle = "#6b4423";
    ctx.fillRect(tx - 5, ty, 10, 26);
    ctx.fillStyle = "#2f8f32";
    ctx.beginPath(); ctx.arc(tx, ty - 8, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#48b14a";
    ctx.beginPath(); ctx.arc(tx + 8, ty - 14, 13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#3aa03c";
    ctx.beginPath(); ctx.arc(tx - 8, ty - 12, 11, 0, Math.PI * 2); ctx.fill();
  }
  function drawLamp(lx, ly) {
    ctx.fillStyle = "#6d737a";
    ctx.fillRect(lx - 3.5, ly, 7, 58);
    ctx.fillStyle = "#8a9098";
    ctx.beginPath(); ctx.arc(lx, ly - 2, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f0f3a8";
    ctx.globalAlpha = 0.28;
    ctx.beginPath(); ctx.arc(lx, ly - 2, 12, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
  function drawRoad() {
    var x = SIDEWALK_W - camX;
    var roadW = LANE_COUNT * LANE_W + 48;
    ctx.fillStyle = "#8b929c";
    ctx.fillRect(x, 0, roadW, H);
    ctx.fillStyle = "#7e868f";
    for (var gy = 0; gy < H; gy += 28) ctx.fillRect(x, gy, roadW, 2);
    for (var i = 1; i < LANE_COUNT; i++) {
      var lx = SIDEWALK_W + i * LANE_W - camX;
      ctx.strokeStyle = "#f2f5f8";
      ctx.setLineDash([18, 16]);
      ctx.lineWidth = 3.5;
      ctx.lineCap = "butt";
      ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, H); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#747c85";
    ctx.fillRect(x, 0, 5, H);
  }
  function drawManhole(lane, mult, active) {
    var cx = laneX(lane) - camX;
    var cy = chickenWorldY() + 8;
    var R = E.manholeRadius(LANE_W);
    if (cx < -R * 2 || cx > W + R * 2) return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath(); ctx.ellipse(2, 4, R * 1.02, R * 0.96, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#2f353c";
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#4b545e";
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(0, 0, R - 2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#262c32";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, R - 7, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#3d4650";
    ctx.lineWidth = 1.6;
    var inner = R - 11;
    for (var i = -4; i <= 4; i++) {
      var px = i * (inner / 4.6);
      var half = Math.sqrt(Math.max(0, inner * inner - px * px));
      ctx.beginPath(); ctx.moveTo(px, -half); ctx.lineTo(px, half); ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.font = "bold " + Math.round(R * 0.42) + "px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(E.formatMult(mult), 0, 0);
    if (active) {
      ctx.strokeStyle = "rgba(255,220,70,0.75)";
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(0, 0, R + 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
  function drawMultTag(x, y, text) {
    ctx.save();
    ctx.font = "bold 13px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var tw = Math.max(48, ctx.measureText(text).width + 18);
    var th = 22;
    var bx = x - tw / 2;
    var by = y;
    ctx.fillStyle = "#1e6ad4";
    roundRect(bx, by, tw, th, 6);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 6, by);
    ctx.lineTo(x, by - 7);
    ctx.lineTo(x + 6, by);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x, by + th / 2 + 0.5);
    ctx.restore();
  }
  function drawBarrierAt() {
    var w = Math.min(LANE_W * 0.78, 88);
    ctx.save();
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(-w * 0.36, 8, 7, 12);
    ctx.fillRect(w * 0.36 - 7, 8, 7, 12);
    roundRect(-w / 2, -11, w, 22, 4);
    ctx.fillStyle = "#111";
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    roundRect(-w / 2 + 2, -9, w - 4, 18, 3);
    ctx.clip();
    var stripe = 14;
    for (var s = -w - 10; s < w + 10; s += stripe) {
      ctx.fillStyle = (Math.floor((s + w + 40) / stripe) % 2 === 0) ? "#f5c400" : "#1a1a1a";
      ctx.save();
      ctx.translate(s, 0);
      ctx.rotate(-0.72);
      ctx.fillRect(0, -20, 9, 42);
      ctx.restore();
    }
    ctx.restore();
    ctx.restore();
  }
  function drawCarTopDown(kind) {
    var w = 46, h = 74;
    var body = "#f5c400";
    var roof = "#e6b400";
    if (kind === "police") { body = "#eef2f6"; roof = "#d5dce6"; w = 44; h = 70; }
    else if (kind === "fire") { body = "#d63a32"; roof = "#b81f1a"; w = 50; h = 88; }
    else if (kind === "ice") { body = "#f4f1ea"; roof = "#7fd3e8"; w = 50; h = 84; }
    else if (kind === "delivery") { body = "#e6b422"; roof = "#c99612"; w = 50; h = 86; }
    else if (kind === "truck") { body = "#2b4c8a"; roof = "#1e3a6e"; w = 52; h = 96; }
    else if (kind === "taxi") { body = "#f5c400"; roof = "#e0b000"; w = 46; h = 74; }

    ctx.fillStyle = "#1a1d22";
    roundRect(-w / 2 - 4, -h / 2 + 12, 7, 16, 2); ctx.fill();
    roundRect(w / 2 - 3, -h / 2 + 12, 7, 16, 2); ctx.fill();
    roundRect(-w / 2 - 4, h / 2 - 28, 7, 16, 2); ctx.fill();
    roundRect(w / 2 - 3, h / 2 - 28, 7, 16, 2); ctx.fill();

    ctx.fillStyle = body;
    roundRect(-w / 2, -h / 2, w, h, 10);
    ctx.fill();

    ctx.fillStyle = roof;
    roundRect(-w / 2 + 5, -h * 0.12, w - 10, h * 0.28, 5);
    ctx.fill();

    ctx.fillStyle = "rgba(160,200,230,0.82)";
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 7, h / 2 - 22);
    ctx.lineTo(w / 2 - 7, h / 2 - 22);
    ctx.lineTo(w / 2 - 11, h / 2 - 8);
    ctx.lineTo(-w / 2 + 11, h / 2 - 8);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(140,180,210,0.55)";
    roundRect(-w / 2 + 9, -h / 2 + 8, w - 18, 12, 3);
    ctx.fill();

    ctx.fillStyle = "#f7f1c8";
    ctx.beginPath(); ctx.arc(-w / 2 + 9, h / 2 - 5, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(w / 2 - 9, h / 2 - 5, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#e24b4b";
    ctx.beginPath(); ctx.arc(-w / 2 + 9, -h / 2 + 6, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(w / 2 - 9, -h / 2 + 6, 2.4, 0, Math.PI * 2); ctx.fill();

    if (kind === "police") {
      ctx.fillStyle = "#2b5cff";
      ctx.fillRect(-8, -6, 7, 6);
      ctx.fillStyle = "#e24b4b";
      ctx.fillRect(2, -6, 7, 6);
    }
    if (kind === "truck") {
      ctx.fillStyle = "#1a2e58";
      roundRect(-w / 2 + 4, -h / 2 + 6, w - 8, h * 0.42, 4);
      ctx.fill();
    }
  }
  function drawVehicle(v) {
    var cx = laneX(v.lane) - camX;
    var y = v.y;
    if (cx < -90 || cx > W + 90) return;
    ctx.save();
    ctx.translate(cx, y);
    if (v.kind === "barrier") drawBarrierAt();
    else drawCarTopDown(v.kind);
    ctx.restore();
  }
  function drawSleepyEye(ex, ey, rx, ry) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#f0dc7a";
    ctx.fill();
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1.35;
    ctx.stroke();
    ctx.clip();
    ctx.fillStyle = "#2a1c0a";
    ctx.beginPath();
    ctx.ellipse(ex + 1.2, ey + ry * 0.28, rx * 0.32, ry * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f7f7f4";
    ctx.beginPath();
    ctx.ellipse(ex, ey - ry * 0.82, rx * 1.15, ry * 1.02, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(ex, ey, rx, ry, 0, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
  }
  function drawChicken() {
    var x = chickenWorldX() - camX;
    var y = chickenWorldY();
    var hop = hopT < 1 ? E.hopArc(hopT) : 0;
    y -= hop * 36;
    var bob = chickenPose === "idle" ? Math.sin(time * 3.2) * 1.4 : 0;
    y += bob;
    var squash = chickenPose === "crash" ? 0.38 : (hopT < 1 ? 1 - 0.18 * (1 - hop) : 1);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1.12, 1.12 * squash);
    if (chickenPose === "crash") ctx.rotate(0.4);

    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath(); ctx.ellipse(0, 24, 20, 7, 0, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = "#f0c400";
    ctx.beginPath(); ctx.ellipse(-9, 20, 7, 4.2, -0.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(8, 20, 7, 4.2, 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#d4a800";
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-9, 20); ctx.lineTo(-16, 23); ctx.moveTo(-9, 20); ctx.lineTo(-4, 24); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, 20); ctx.lineTo(15, 23); ctx.moveTo(8, 20); ctx.lineTo(3, 24); ctx.stroke();

    ctx.fillStyle = "#f7f7f4";
    ctx.beginPath(); ctx.ellipse(0, 2, 24, 22, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#f3d8d0";
    ctx.beginPath(); ctx.ellipse(2, 8, 12, 9, 0, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = "#e23b3b";
    ctx.beginPath();
    ctx.ellipse(-6, -18, 5.2, 6.2, -0.3, 0, Math.PI * 2);
    ctx.ellipse(1, -21, 6.2, 7.2, 0, 0, Math.PI * 2);
    ctx.ellipse(9, -17, 5, 6, 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath(); ctx.ellipse(14, 2, 4, 5.2, 0.3, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = "#f0c400";
    ctx.beginPath();
    ctx.moveTo(18, -1);
    ctx.lineTo(32, 4);
    ctx.lineTo(18, 8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1.3;
    ctx.stroke();

    if (chickenPose === "crash") {
      ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(-4, -8); ctx.lineTo(6, 2); ctx.moveTo(6, -8); ctx.lineTo(-4, 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(8, -7); ctx.lineTo(18, 3); ctx.moveTo(18, -7); ctx.lineTo(8, 3); ctx.stroke();
    } else {
      drawSleepyEye(2, -3, 8.2, 7.4);
      drawSleepyEye(14, -2, 7.2, 6.6);
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
  function currentMultText() {
    if (round && round.current_multiplier) return E.formatMult(round.current_multiplier);
    if (chickenLane >= 1 && multipliers[chickenLane - 1] != null) {
      return E.formatMult(multipliers[chickenLane - 1]);
    }
    return "";
  }
  function drawScene(dt) {
    ctx.fillStyle = "#5fb344";
    ctx.fillRect(0, 0, W, H);
    drawGrass(-camX - 40, SIDEWALK_W * 0.38 - camX);
    bushes.forEach(function (b) { drawHedge(b.x - camX, b.y); });
    trees.forEach(function (t) { drawTree(t.x - camX, t.y); });
    drawSidewalk();
    lamps.forEach(function (l) { drawLamp(l.x - camX, l.y); });
    drawRoad();
    var visFrom = Math.max(1, Math.floor((camX - SIDEWALK_W) / LANE_W) - 1);
    var visTo = Math.min(LANE_COUNT, visFrom + Math.ceil(W / LANE_W) + 3);
    var skipLane = (round && round.status === "PLAYING" && hopT >= 1) ? chickenLane : -1;
    for (var lane = visFrom; lane <= visTo; lane++) {
      var m = multipliers[lane - 1];
      if (m == null) continue;
      if (lane === skipLane) continue;
      drawManhole(lane, m, false);
    }
    vehicles.forEach(drawVehicle);
    drawChicken();
    if (skipLane >= 1) {
      var tag = currentMultText();
      if (tag) {
        drawMultTag(chickenWorldX() - camX, chickenWorldY() + 30, tag);
      }
    }
    drawFeathers(dt);
    if (Math.abs(panX) > 30) {
      ctx.fillStyle = "rgba(20,22,26,0.35)";
      ctx.font = "bold 11px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("peeking lanes →", W / 2, 28);
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
      }
    }
    stepTraffic(dt);
    followCamera(dt);
    drawScene(dt);
    requestAnimationFrame(frame);
  }

  // ---- live ticker / state poll ------------------------------------------
  function paintTicker() {
    $("online").textContent = String(online || 0);
    var row = $("liveWin");
    if (!liveWins.length) {
      row.style.display = "none";
      return;
    }
    row.style.display = "";
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
      if (data.chip_presets && data.chip_presets.length) {
        var same = data.chip_presets.join(",") === CHIPS.join(",");
        CHIPS = data.chip_presets;
        if (!same) { buildChips(); setBet(bet); }
      }
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
  $("liveWin").style.display = "none";
  buildChips();
  buildDiff();
  setBet(20);
  showIdleActions();
  resetDecor();
  syncSwitches();
  resize();
  if (params.get("preview") === "play") {
    applyRound({
      id: "preview",
      status: "PLAYING",
      current_lane: 2,
      current_multiplier: 1.03,
      cashout_amount: 21,
      lane_count: multipliers.length,
      multipliers: multipliers,
    });
    chickenLane = 2;
    hopT = 1;
    chickenPose = "idle";
    showPlayActions(round);
    setBalance(295);
  }
  spawnVehicle(1, 48, "taxi", 150);
  spawnVehicle(3, 120, "truck", 110);
  spawnVehicle(2, -40, "barrier", 70);
  pollState();
  setInterval(pollState, 4000);
  setInterval(paintTicker, 2800);
  requestAnimationFrame(frame);
})();
