/*
 * Chicken Road cabinet - self-contained Canvas 2D client.
 *
 * Same-origin micro-app embedded by the React lounge (see ChickenRoadGame.js),
 * exactly like the Aviator cabinet. It reads the player's session token from
 * localStorage, talks to the shared FastAPI crash-round engine over
 * /api/live/chicken-road/*, and renders everything - highway, traffic, chicken,
 * gold trail, crash - in ONE requestAnimationFrame loop. All game math comes
 * from engine.js so the chicken and the multiplier are locked together.
 *
 * PLAY CHIPS ONLY. No wallet logic lives here; the server settles every chip.
 */
(function () {
  "use strict";

  var E = window.ChickenRoadEngine;
  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- session / api base -------------------------------------------------
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

  // ---- dom ----------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $("scene");
  var ctx = canvas.getContext("2d");
  var multEl = $("mult");
  var phaseEl = $("phaseLabel");
  var balanceEl = $("balance");
  var historyEl = $("history");
  var feedEl = $("feed");
  var playingEl = $("playingNow");
  var cashoutPop = $("cashoutPop");
  var toastEl = $("toast");

  // ---- audio --------------------------------------------------------------
  var audio = new window.ChickenRoadAudio();
  function refreshMuteIcon() {
    $("soundOn").style.display = audio.isMuted() ? "none" : "block";
    $("soundOff").style.display = audio.isMuted() ? "block" : "none";
  }
  refreshMuteIcon();
  function firstGesture() {
    audio.resume();
    window.removeEventListener("pointerdown", firstGesture);
    window.removeEventListener("keydown", firstGesture);
  }
  window.addEventListener("pointerdown", firstGesture);
  window.addEventListener("keydown", firstGesture);

  // ---- parent messaging ---------------------------------------------------
  function postToParent(msg) {
    msg.source = "chakri-chicken-road";
    try { window.parent.postMessage(msg, window.location.origin); } catch (e) {}
  }
  $("exitBtn").addEventListener("click", function () {
    audio.tick();
    postToParent({ type: "exit" });
  });

  var toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }

  function fmtChips(n) {
    return Math.round(Number(n) || 0).toLocaleString("en-IN");
  }
  function setBalance(v) {
    if (v == null) return;
    balanceEl.textContent = fmtChips(v);
    postToParent({ type: "balance", balance: Number(v) });
  }

  // ---- game state ---------------------------------------------------------
  var state = null;
  var serverNowAtPoll = 0;
  var localAtPoll = 0;
  var runStart = 0;              // server timestamp when the chicken started
  var lastRound = null;
  var minBet = 10, maxBet = 10000;
  var seenResults = {};          // bet id -> true (already announced)
  var crashAnim = null;          // { at, feathers:[], carX } while playing crash
  var trailSeed = Math.random() * 1000;

  function serverTime() {
    return serverNowAtPoll + (performance.now() - localAtPoll) / 1000;
  }
  // Live multiplier, locked to the shared engine curve during a run.
  function liveMultiplier() {
    if (!state) return 1;
    if (state.phase === "RUNNING") {
      return E.multiplierAt(serverTime() - runStart);
    }
    if (state.phase === "CRASHED") return state.crash_point || 1;
    return 1;
  }

  // ---- panels -------------------------------------------------------------
  var CHIPS = [10, 50, 100];
  var panels = [];

  function buildPanel(index) {
    var p = {
      index: index,
      mode: "bet",
      amount: index === 1 ? 100 : 50,
      autoTarget: 2.0,
      el: document.createElement("div"),
    };
    p.el.className = "panel" + (index === 2 ? " p2" : "");
    p.el.innerHTML =
      '<div class="modes">' +
        '<button class="mode active" data-mode="bet">BET</button>' +
        '<button class="mode" data-mode="auto">AUTO</button>' +
      "</div>" +
      '<div class="bet-row">' +
        '<button class="step-btn" data-step="-1">&minus;</button>' +
        '<div class="stepper"><input type="text" inputmode="numeric" class="amt" value="' + p.amount + '"></div>' +
        '<button class="step-btn" data-step="1">+</button>' +
      "</div>" +
      '<div class="chips">' +
        CHIPS.map(function (c) { return '<button class="chip" data-chip="' + c + '">' + c + "</button>"; }).join("") +
      "</div>" +
      '<div class="auto-row"><label>Auto&nbsp;@</label>' +
        '<div class="stepper"><input type="text" inputmode="decimal" class="auto" value="' + p.autoTarget.toFixed(2) + '"></div>' +
        "<span style=\"color:var(--gold);font-weight:800\">x</span></div>" +
      '<button class="action" data-action>BET</button>';

    p.amtInput = p.el.querySelector(".amt");
    p.autoInput = p.el.querySelector(".auto");
    p.autoRow = p.el.querySelector(".auto-row");
    p.actionBtn = p.el.querySelector("[data-action]");

    p.el.querySelectorAll(".mode").forEach(function (b) {
      b.addEventListener("click", function () {
        audio.tick();
        p.mode = b.getAttribute("data-mode");
        p.el.querySelectorAll(".mode").forEach(function (m) { m.classList.remove("active"); });
        b.classList.add("active");
        p.autoRow.classList.toggle("show", p.mode === "auto");
      });
    });
    p.el.querySelectorAll("[data-step]").forEach(function (b) {
      b.addEventListener("click", function () {
        audio.tick();
        var dir = Number(b.getAttribute("data-step"));
        setAmount(p, clampAmount(p.amount + dir * 10));
      });
    });
    p.el.querySelectorAll("[data-chip]").forEach(function (b) {
      b.addEventListener("click", function () {
        audio.tick();
        setAmount(p, clampAmount(Number(b.getAttribute("data-chip"))));
      });
    });
    p.amtInput.addEventListener("change", function () {
      setAmount(p, clampAmount(parseInt(p.amtInput.value, 10) || minBet));
    });
    p.autoInput.addEventListener("change", function () {
      var v = parseFloat(p.autoInput.value);
      if (!isFinite(v) || v < 1.01) v = 1.01;
      if (v > 1000) v = 1000;
      p.autoTarget = Math.round(v * 100) / 100;
      p.autoInput.value = p.autoTarget.toFixed(2);
    });
    p.actionBtn.addEventListener("click", function () { onAction(p); });
    return p;
  }

  function clampAmount(v) {
    v = Math.max(minBet, Math.min(maxBet, Math.round(v)));
    return v;
  }
  function setAmount(p, v) {
    p.amount = v;
    p.amtInput.value = v;
    p.el.querySelectorAll(".chip").forEach(function (c) {
      c.classList.toggle("active", Number(c.getAttribute("data-chip")) === v);
    });
  }

  function myBetForPanel(pindex) {
    if (!state || !state.my_bets) return null;
    var open = null;
    for (var i = 0; i < state.my_bets.length; i++) {
      var b = state.my_bets[i];
      if (b.panel === pindex && b.status === "OPEN") open = b;
    }
    return open;
  }

  async function onAction(p) {
    var bet = myBetForPanel(p.index);
    audio.resume();
    if (!bet) {
      // place a bet
      try {
        audio.tick();
        var body = { amount: p.amount, panel: p.index };
        if (p.mode === "auto") body.auto_cashout = p.autoTarget;
        var res = await apiPost("/live/chicken-road/bets", body);
        setBalance(res.balance);
        toast(res.queued ? "Bet queued for next round" : "Bet placed");
        pollNow();
      } catch (e) {
        toast(errText(e, "Could not place bet"));
      }
      return;
    }
    var current = state.round_number;
    var running = state.phase === "RUNNING" && bet.round_number === current;
    if (running) {
      // cash out
      try {
        var out = await apiPost("/live/chicken-road/cashout", { bet_id: bet.id });
        if (out.result === "cashed_out") {
          setBalance(out.balance);
          announceWin(out.multiplier, out.payout);
        } else {
          setBalance(out.balance);
          toast("Too late - the chicken was hit");
        }
        pollNow();
      } catch (e) {
        toast(errText(e, "Cash out failed"));
      }
    } else {
      // cancel a bet that is still open in betting / queued
      try {
        audio.tick();
        var c = await apiPost("/live/chicken-road/bets/cancel", { bet_id: bet.id });
        setBalance(c.balance);
        toast("Bet cancelled");
        pollNow();
      } catch (e) {
        toast(errText(e, "Cannot cancel now"));
      }
    }
  }

  function errText(e, fallback) {
    var d = e && e.detail;
    if (typeof d === "string") return d;
    if (d && d.message) return d.message;
    return fallback;
  }

  function announceWin(mult, payout) {
    audio.win();
    cashoutPop.textContent = "+" + fmtChips(payout) + "  @ " + Number(mult).toFixed(2) + "x";
    cashoutPop.classList.remove("show");
    void cashoutPop.offsetWidth; // reflow to restart animation
    cashoutPop.classList.add("show");
  }

  function renderPanels() {
    panels.forEach(function (p) {
      var bet = myBetForPanel(p.index);
      var btn = p.actionBtn;
      btn.classList.remove("cashout", "cancel", "disabled");
      var busyInputs = !!bet;
      p.amtInput.disabled = busyInputs;
      if (!bet) {
        var canBetNow = state && (state.phase === "BETTING");
        btn.innerHTML = '<span class="big">BET</span><span class="sub">' +
          (canBetNow ? fmtChips(p.amount) + " chips" : "next round") + "</span>";
      } else if (state && state.phase === "RUNNING" && bet.round_number === state.round_number) {
        btn.classList.add("cashout");
        var m = liveMultiplier();
        var projected = Math.floor(bet.amount * m);
        btn.innerHTML = '<span class="big">CASH OUT</span><span class="sub">' +
          fmtChips(projected) + " @ " + m.toFixed(2) + "x</span>";
      } else if (bet.queued || bet.round_number > state.round_number ||
                 (state && state.phase === "BETTING")) {
        btn.classList.add("cancel");
        btn.innerHTML = '<span class="big">CANCEL</span><span class="sub">' +
          fmtChips(bet.amount) + " chips" + (bet.queued ? " · queued" : "") + "</span>";
      } else {
        btn.classList.add("disabled");
        btn.innerHTML = '<span class="big">WAIT</span><span class="sub">round in play</span>';
      }
    });
  }

  // ---- history + feed -----------------------------------------------------
  function renderHistory() {
    if (!state || !state.history) return;
    historyEl.innerHTML = state.history.slice(0, 16).map(function (h) {
      var tone = E.historyTone(h.crash_point);
      return '<span class="pill ' + tone + '">' + Number(h.crash_point).toFixed(2) + "x</span>";
    }).join("");
  }
  function renderFeed() {
    if (!state) return;
    var rows = (state.all_bets || []).slice(0, 8).map(function (b) {
      var cashed = b.status === "CASHED";
      var lost = b.status === "LOST";
      var mx = cashed ? Number(b.multiplier || 0).toFixed(2) + "x" : (lost ? "HIT" : "…");
      var amt = cashed ? "+" + fmtChips(b.payout) : "";
      return '<div class="feed-row ' + (lost ? "lost" : "") + '">' +
        '<span class="who">' + (b.name || "Player") + "</span>" +
        '<span class="mx">' + mx + "</span>" +
        '<span class="amt">' + amt + "</span></div>";
    });
    feedEl.innerHTML = rows.join("");
    playingEl.textContent = fmtChips(state.players || 0);
  }

  // ---- announce settled results (server-authoritative) --------------------
  function processResults() {
    if (!state || !state.my_bets) return;
    state.my_bets.forEach(function (b) {
      if (!b.id || seenResults[b.id]) return;
      if (b.status === "CASHED") {
        seenResults[b.id] = true;
        // Auto-cashouts settle server-side; surface them like a manual win.
        if (b.auto_cashout) announceWin(b.multiplier || b.auto_cashout, b.payout);
      } else if (b.status === "LOST" || b.status === "CANCELLED") {
        seenResults[b.id] = true;
      }
    });
  }

  // ---- polling ------------------------------------------------------------
  var polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      var data = await apiGet("/live/chicken-road/state");
      state = data;
      serverNowAtPoll = data.server_now;
      localAtPoll = performance.now();
      if (data.min_bet) minBet = data.min_bet;
      if (data.max_bet) maxBet = data.max_bet;
      if (data.phase === "RUNNING" && data.run_elapsed != null) {
        runStart = data.server_now - data.run_elapsed;
      }
      if (lastRound !== data.round_number) {
        lastRound = data.round_number;
        trailSeed = Math.random() * 1000;
      }
      // A settled crash for the round we were watching triggers the crash anim.
      if (data.phase === "CRASHED" && (!crashAnim || crashAnim.round !== data.round_number)) {
        startCrashAnim(data.round_number, data.crash_point);
      }
      setBalance(data.balance);
      processResults();
      renderHistory();
      renderFeed();
      renderPanels();
      $("authGate").classList.remove("show");
    } catch (e) {
      if (e.status === 401) $("authGate").classList.add("show");
    } finally {
      polling = false;
    }
  }
  function pollNow() { poll(); }

  // ---- crash animation ----------------------------------------------------
  function startCrashAnim(round, crashPoint) {
    audio.crash();
    var feathers = [];
    var count = reduceMotion ? 0 : 26;
    for (var i = 0; i < count; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 60 + Math.random() * 220;
      feathers.push({
        x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        life: 0, ttl: 0.8 + Math.random() * 0.7, rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 8,
      });
    }
    crashAnim = { round: round, crashPoint: crashPoint, at: performance.now(), feathers: feathers, shake: 1 };
  }

  // ---- traffic ------------------------------------------------------------
  var cars = [];
  var CAR_COLORS = ["#c23b3b", "#3b6ec2", "#c9c9c9", "#2f9e57", "#d0a12e", "#8a8f99"];
  function seedTraffic(W, laneY) {
    cars = [];
    for (var i = 0; i < 9; i++) {
      var lane = Math.floor(Math.random() * laneY.length);
      cars.push(makeCar(lane, W, laneY, Math.random() * W));
    }
  }
  function makeCar(lane, W, laneY, x) {
    var dir = lane % 2 === 0 ? 1 : -1; // alternate lane directions
    var depth = 0.55 + (lane / Math.max(1, laneY.length - 1)) * 0.55; // nearer lanes bigger
    return {
      lane: lane, dir: dir,
      x: x != null ? x : (dir > 0 ? -120 : W + 120),
      speed: (90 + Math.random() * 140) * depth,
      color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
      w: 60 * depth, h: 26 * depth, depth: depth,
    };
  }

  // ---- renderer -----------------------------------------------------------
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var W = 0, H = 0;
  function resize() {
    var r = canvas.getBoundingClientRect();
    W = Math.max(320, r.width);
    H = Math.max(200, r.height);
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    layout();
  }
  var road = {};
  function layout() {
    road.top = H * 0.34;
    road.bottom = H * 0.99;
    road.lanes = 5;
    road.laneY = [];
    for (var i = 0; i < road.lanes; i++) {
      var f = (i + 0.5) / road.lanes;
      road.laneY.push(road.top + f * (road.bottom - road.top));
    }
    road.left = W * 0.04;
    road.right = W * 0.96;
    if (!cars.length) seedTraffic(W, road.laneY);
  }

  var lastFrame = performance.now();
  var dashScroll = 0;
  var sparkles = [];

  function draw(now) {
    var dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    var phase = state ? state.phase : "BETTING";
    var mult = liveMultiplier();
    var progress = E.progressForMultiplier(mult);
    var xFrac = E.chickenXFraction(mult);

    // camera shake grows a little with the multiplier, punches on crash
    var shake = 0;
    if (!reduceMotion) {
      if (phase === "RUNNING") shake = Math.min(4, (mult - 1) * 0.4);
      if (crashAnim) {
        var ce = (now - crashAnim.at) / 1000;
        shake = Math.max(shake, 10 * Math.max(0, 1 - ce / 0.5));
      }
    }
    var sx = (Math.random() - 0.5) * shake;
    var sy = (Math.random() - 0.5) * shake;

    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.translate(sx, sy);

    drawSky();
    drawRoad(now);
    updateAndDrawCars(dt, phase);

    var cx = road.left + xFrac * (road.right - road.left);
    var chickenLaneY = road.laneY[Math.min(road.laneY.length - 1, 2)];
    var hop = phase === "RUNNING" ? E.hopPhase(serverTime(), 3.2) : (E.hopPhase(now / 1000, 1.1) * 0.4);
    var cy = chickenLaneY - hop * 26;

    drawTrail(cx, cy, now, phase);

    if (crashAnim) {
      drawCrash(now, cx, cy);
    } else {
      drawChicken(cx, cy, hop, phase, now);
      if (phase === "RUNNING" && !reduceMotion) emitSparkles(cx, cy);
    }
    updateAndDrawSparkles(dt);

    // red flash on impact
    if (crashAnim) {
      var fe = (now - crashAnim.at) / 1000;
      var flash = Math.max(0, 0.5 - fe) ;
      if (flash > 0) {
        ctx.fillStyle = "rgba(255,60,60," + (flash * 0.7) + ")";
        ctx.fillRect(-20, -20, W + 40, H + 40);
      }
    }
    ctx.restore();

    // HUD text (not shaken)
    updateHud(phase, mult);
    requestAnimationFrame(draw);
  }

  function drawSky() {
    var g = ctx.createLinearGradient(0, 0, 0, road.top);
    g.addColorStop(0, "#0a0d18");
    g.addColorStop(1, "#161022");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, road.top + 2);
    // distant city glow
    ctx.fillStyle = "rgba(255,176,32,0.06)";
    ctx.fillRect(0, road.top - 30, W, 30);
    // a few stars
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    for (var i = 0; i < 24; i++) {
      var x = (i * 97.3) % W;
      var y = (i * 53.7) % (road.top * 0.8);
      ctx.globalAlpha = 0.2 + ((i * 13) % 5) / 10;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
  }

  function drawRoad(now) {
    // wet asphalt
    var g = ctx.createLinearGradient(0, road.top, 0, road.bottom);
    g.addColorStop(0, "#14161d");
    g.addColorStop(0.5, "#0d0f14");
    g.addColorStop(1, "#050608");
    ctx.fillStyle = g;
    ctx.fillRect(0, road.top, W, road.bottom - road.top);

    // wet vertical reflections shimmering
    for (var i = 0; i < 7; i++) {
      var rx = ((i * 151 + (reduceMotion ? 0 : now * 0.01)) % W);
      var alpha = 0.03 + 0.03 * Math.abs(Math.sin(now / 900 + i));
      ctx.fillStyle = "rgba(255,210,120," + alpha + ")";
      ctx.fillRect(rx, road.top, 2, road.bottom - road.top);
    }

    // lane dividers (dashed, scrolling to suggest motion)
    if (!reduceMotion) dashScroll = (dashScroll + 1.4) % 44;
    ctx.strokeStyle = "rgba(255,212,71,0.22)";
    ctx.lineWidth = 2;
    for (var l = 1; l < road.lanes; l++) {
      var y = road.top + (l / road.lanes) * (road.bottom - road.top);
      ctx.beginPath();
      ctx.setLineDash([26, 18]);
      ctx.lineDashOffset = -dashScroll;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // edge lines
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath(); ctx.moveTo(0, road.top + 1); ctx.lineTo(W, road.top + 1); ctx.stroke();
  }

  function updateAndDrawCars(dt, phase) {
    for (var i = 0; i < cars.length; i++) {
      var c = cars[i];
      if (phase !== "CRASHED") c.x += c.dir * c.speed * dt;
      // recycle
      if (c.dir > 0 && c.x > W + 140) Object.assign(c, makeCar(c.lane, W, road.laneY, -120));
      if (c.dir < 0 && c.x < -140) Object.assign(c, makeCar(c.lane, W, road.laneY, W + 120));
      drawCar(c);
    }
  }

  function drawCar(c) {
    var y = road.laneY[c.lane];
    var w = c.w, h = c.h;
    // motion-blur streak behind
    if (!reduceMotion) {
      var grd = ctx.createLinearGradient(c.x - c.dir * w, y, c.x, y);
      grd.addColorStop(0, "rgba(255,255,255,0)");
      grd.addColorStop(1, "rgba(255,255,255,0.05)");
      ctx.fillStyle = grd;
      ctx.fillRect(Math.min(c.x, c.x - c.dir * w), y - h / 2, w, h);
    }
    // reflection on wet road
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = c.color;
    ctx.fillRect(c.x - w / 2, y + h / 2, w, h * 0.7);
    ctx.globalAlpha = 1;
    // body
    roundRect(c.x - w / 2, y - h / 2, w, h, 5);
    ctx.fillStyle = c.color;
    ctx.fill();
    // window
    ctx.fillStyle = "rgba(180,220,255,0.5)";
    ctx.fillRect(c.x - w * 0.2, y - h * 0.35, w * 0.4, h * 0.7);
    // lights (leading edge)
    var lead = c.x + c.dir * (w / 2);
    ctx.beginPath();
    ctx.arc(lead, y, Math.max(3, h * 0.22), 0, Math.PI * 2);
    if (c.dir > 0) {
      // taillight (moving right/away)
      var tg = ctx.createRadialGradient(lead, y, 0, lead, y, h);
      tg.addColorStop(0, "rgba(255,70,70,0.9)");
      tg.addColorStop(1, "rgba(255,70,70,0)");
      ctx.fillStyle = tg;
    } else {
      var hg = ctx.createRadialGradient(lead, y, 0, lead, y, h * 1.4);
      hg.addColorStop(0, "rgba(255,245,200,0.95)");
      hg.addColorStop(1, "rgba(255,245,200,0)");
      ctx.fillStyle = hg;
    }
    ctx.fill();
  }

  function drawTrail(cx, cy, now, phase) {
    var startX = road.left + E.chickenXFraction(1) * (road.right - road.left);
    var grad = ctx.createLinearGradient(startX, 0, cx, 0);
    grad.addColorStop(0, "rgba(255,176,32,0)");
    grad.addColorStop(0.5, "rgba(255,200,60,0.55)");
    grad.addColorStop(1, "rgba(255,232,120,0.95)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(255,190,40,0.9)";
    ctx.shadowBlur = reduceMotion ? 0 : 16;
    ctx.beginPath();
    var baseY = road.laneY[2] + 6;
    ctx.moveTo(startX, baseY);
    var steps = 26;
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      var x = startX + (cx - startX) * t;
      var wobble = reduceMotion ? 0 : Math.sin(t * 7 + now / 260 + trailSeed) * 4 * (1 - t);
      var y = baseY - t * (baseY - cy) + wobble;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function emitSparkles(cx, cy) {
    if (sparkles.length > 90) return;
    if (Math.random() < 0.7) {
      sparkles.push({
        x: cx - 8, y: cy + 4,
        vx: -30 - Math.random() * 40, vy: -10 + Math.random() * 20,
        life: 0, ttl: 0.5 + Math.random() * 0.5, size: 1 + Math.random() * 2.5,
      });
    }
  }
  function updateAndDrawSparkles(dt) {
    for (var i = sparkles.length - 1; i >= 0; i--) {
      var s = sparkles[i];
      s.life += dt;
      if (s.life > s.ttl) { sparkles.splice(i, 1); continue; }
      s.x += s.vx * dt; s.y += s.vy * dt;
      var a = 1 - s.life / s.ttl;
      ctx.fillStyle = "rgba(255," + (200 + Math.floor(40 * a)) + ",90," + a + ")";
      ctx.fillRect(s.x, s.y, s.size, s.size);
    }
  }

  function drawChicken(cx, cy, hop, phase, now) {
    var squash = E.squashForHop(hop);
    var r = 20;
    ctx.save();
    ctx.translate(cx, cy);
    // shadow on road
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0, r * 0.9, r * 0.9, r * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.scale(1, squash);

    // legs (little run cycle)
    var legSwing = Math.sin(now / 90) * 5;
    ctx.strokeStyle = "#e8942a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-5, r * 0.7); ctx.lineTo(-5 + legSwing, r * 1.05);
    ctx.moveTo(5, r * 0.7); ctx.lineTo(5 - legSwing, r * 1.05);
    ctx.stroke();

    // body (plump golden)
    var bg = ctx.createRadialGradient(-6, -6, 4, 0, 0, r + 4);
    bg.addColorStop(0, "#ffe89a");
    bg.addColorStop(0.6, "#ffcf4d");
    bg.addColorStop(1, "#e79a1e");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 1.05, 0, 0, Math.PI * 2);
    ctx.fill();

    // backpack
    ctx.fillStyle = "#7a4a1f";
    roundRect(-r - 4, -8, 12, 20, 4); ctx.fill();
    ctx.fillStyle = "#5c3616";
    ctx.fillRect(-r - 1, -3, 6, 4);

    // wing
    ctx.fillStyle = "#f2b733";
    ctx.beginPath();
    ctx.ellipse(2, 2, 10, 12, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // head
    ctx.fillStyle = "#ffd451";
    ctx.beginPath();
    ctx.arc(r * 0.55, -r * 0.7, 11, 0, Math.PI * 2);
    ctx.fill();
    // comb
    ctx.fillStyle = "#e5473f";
    ctx.beginPath();
    ctx.arc(r * 0.5, -r * 1.05, 3.5, 0, Math.PI * 2);
    ctx.arc(r * 0.7, -r * 1.12, 3.5, 0, Math.PI * 2);
    ctx.fill();
    // beak
    ctx.fillStyle = "#ff9f1c";
    ctx.beginPath();
    ctx.moveTo(r * 0.55 + 9, -r * 0.75);
    ctx.lineTo(r * 0.55 + 18, -r * 0.7);
    ctx.lineTo(r * 0.55 + 9, -r * 0.62);
    ctx.closePath();
    ctx.fill();
    // eye
    ctx.fillStyle = "#1a1207";
    ctx.beginPath();
    ctx.arc(r * 0.62, -r * 0.78, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawCrash(now, cx, cy) {
    var e = (now - crashAnim.at) / 1000;
    // a car slams into the chicken position on impact
    var carW = 70, carH = 30;
    var carX = cx + Math.min(0, -80 + e * 400);
    if (e < 0.6) {
      roundRect(carX - carW / 2, cy - carH / 2, carW, carH, 6);
      ctx.fillStyle = "#b23030";
      ctx.fill();
      ctx.fillStyle = "rgba(255,245,200,0.95)";
      ctx.beginPath(); ctx.arc(carX + carW / 2, cy, 6, 0, Math.PI * 2); ctx.fill();
    }
    // squashed chicken flat for a beat
    if (e < 0.5) {
      ctx.save();
      ctx.translate(cx, cy + 8);
      ctx.scale(1, 0.35);
      ctx.fillStyle = "#e79a1e";
      ctx.beginPath(); ctx.ellipse(0, 0, 22, 22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // feather burst
    var dt = 1 / 60;
    for (var i = 0; i < crashAnim.feathers.length; i++) {
      var f = crashAnim.feathers[i];
      f.life += dt;
      f.vy += 220 * dt;
      f.x += f.vx * dt; f.y += f.vy * dt; f.rot += f.vr * dt;
      var a = Math.max(0, 1 - f.life / f.ttl);
      if (a <= 0) continue;
      ctx.save();
      ctx.translate(cx + f.x, cy + f.y);
      ctx.rotate(f.rot);
      ctx.globalAlpha = a;
      ctx.fillStyle = "#ffe08a";
      ctx.beginPath();
      ctx.ellipse(0, 0, 5, 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
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

  function updateHud(phase, mult) {
    multEl.textContent = E.formatMult(mult);
    multEl.classList.toggle("crashed", phase === "CRASHED");
    phaseEl.classList.toggle("hit", phase === "CRASHED");
    if (phase === "BETTING") {
      var t = state && state.phase_ends_in != null ? Math.max(0, state.phase_ends_in) : 0;
      phaseEl.textContent = "STARTING IN " + t.toFixed(1) + "s";
    } else if (phase === "RUNNING") {
      phaseEl.textContent = "RUNNING";
    } else {
      phaseEl.textContent = "HIT @ " + Number(mult).toFixed(2) + "x";
    }
  }

  // ---- controls -----------------------------------------------------------
  $("muteBtn").addEventListener("click", function () {
    audio.resume();
    audio.toggleMute();
    refreshMuteIcon();
  });
  $("fsBtn").addEventListener("click", function () {
    try {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
    } catch (e) {}
  });
  $("statsBtn").addEventListener("click", function () {
    var panel = $("statsPanel");
    if (panel.classList.contains("show")) { panel.classList.remove("show"); return; }
    var hist = (state && state.history) || [];
    var vals = hist.map(function (h) { return Number(h.crash_point); });
    var avg = vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) : 0;
    var max = vals.length ? Math.max.apply(null, vals) : 0;
    var lows = vals.filter(function (v) { return v < 2; }).length;
    $("statsBox").innerHTML =
      "<h2>Round stats</h2>" +
      "<p>Last " + vals.length + " rounds<br>" +
      "Average crash: <b style='color:var(--gold)'>" + avg.toFixed(2) + "x</b><br>" +
      "Highest: <b style='color:var(--gold)'>" + max.toFixed(2) + "x</b><br>" +
      "Under 2x: <b style='color:var(--gold)'>" + lows + "</b></p>" +
      "<p style='margin-top:10px'>Provably fair &middot; play chips only<br>Tap anywhere to close</p>";
    panel.classList.add("show");
    panel.onclick = function () { panel.classList.remove("show"); };
  });

  // ---- boot ---------------------------------------------------------------
  panels = [buildPanel(1), buildPanel(2)];
  var panelsEl = $("panels");
  panels.forEach(function (p) { panelsEl.appendChild(p.el); setAmount(p, p.amount); });

  if (!TOKEN) {
    $("authGate").classList.add("show");
  }

  window.addEventListener("resize", resize);
  resize();
  poll();
  setInterval(poll, 700);
  requestAnimationFrame(draw);
})();