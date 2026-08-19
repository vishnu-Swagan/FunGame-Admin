import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart3, Headphones, Maximize2, Menu, RotateCcw, Undo2,
  Volume2, VolumeX, X,
} from "lucide-react";
import { Cabinet } from "@/components/play/arcade/Cabinet";
import { useLiveRound } from "@/lib/useLiveRound";
import { isMuted, onMuteChange, sfx, toggleMuted } from "@/lib/sound";
import "./andarBahar.css";

const DESIGN_W = 1600;
const DESIGN_H = 900;
const PANEL_Y = 678;
const DEMO_REVEAL_SECONDS = 16;
const DEAL_RELEASE_RATIO = 0.72;
const DEAL_SOURCE_CADENCE = 1.55;
const HAIR_GESTURE_INTERVAL_MS = 20 * 60 * 1000;
const CHIP_RAIL_Y = 600;
const ACTION_Y = 632;
const MAIN_BET_Y = 710;
const MAIN_BET_H = 140;
const COUNT_BET_Y = 710;
const COUNT_BET_H = 65;
const COUNT_BET_ROW_GAP = 69;
const CARD_RELEASE_X = 430;
const CARD_RELEASE_Y = 520;
const REFERENCE_CHIPS = [20, 50, 100, 200, 500, 1000];
const CHIP_COLORS = {
  20: ["#2663a8", "#12335e", "#eef7ff"],
  50: ["#e6d1a1", "#79562b", "#f7f2df"],
  100: ["#4d9b53", "#1f562d", "#f1f8e7"],
  200: ["#d55e4d", "#7f211d", "#f4dfca"],
  500: ["#8b8a92", "#41414a", "#dedee3"],
  1000: ["#8c4b8e", "#441e50", "#e9d0ea"],
};
const DEFAULT_OPTIONS = {
  andar: 2,
  bahar: 1.9,
  count_1_5: 3.5,
  count_6_10: 4.5,
  count_11_15: 5.5,
  count_16_25: 4.5,
  count_26_30: 5,
  count_31_35: 25,
  count_36_40: 50,
  count_41_49: 120,
};
const COUNT_BETS = [
  ["count_1_5", "1–5"], ["count_6_10", "6–10"],
  ["count_11_15", "11–15"], ["count_16_25", "16–25"],
  ["count_26_30", "26–30"], ["count_31_35", "31–35"],
  ["count_36_40", "36–40"], ["count_41_49", "41–49"],
];
const SUIT = {
  S: ["♠", "#171923"], C: ["♣", "#171923"],
  H: ["♥", "#ca1734"], D: ["♦", "#ca1734"],
};

const money = (value) => new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(Number(value || 0));

function parseCard(value) {
  const raw = typeof value === "object" && value ? value.card : value;
  const match = String(raw || "").toUpperCase().match(/^(10|[2-9AJQK])([SHDC])$/);
  if (!match) return null;
  return { rank: match[1], suit: match[2], side: value?.side };
}

function rounded(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function label(ctx, value, x, y, size, color = "#f8f1df", align = "center", weight = 800) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px Inter, Avenir Next, Segoe UI, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(value, x, y);
  ctx.restore();
}

function drawCard(ctx, card, x, y, width, height, alpha = 1, rotation = 0) {
  if (!card) return;
  const [glyph, color] = SUIT[card.suit] || SUIT.S;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x + width / 2, y + height / 2);
  ctx.rotate(rotation);
  ctx.shadowColor = "rgba(0,0,0,.46)";
  ctx.shadowBlur = 9;
  ctx.shadowOffsetY = 4;
  rounded(ctx, -width / 2, -height / 2, width, height, Math.max(4, width * 0.09));
  const face = ctx.createLinearGradient(0, -height / 2, 0, height / 2);
  face.addColorStop(0, "#ffffff");
  face.addColorStop(1, "#e8e7e3");
  ctx.fillStyle = face;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(20,22,30,.32)";
  ctx.lineWidth = 1;
  ctx.stroke();
  label(ctx, card.rank, -width * 0.31, -height * 0.32, Math.max(11, width * 0.27), color, "center", 900);
  label(ctx, glyph, -width * 0.31, -height * 0.09, Math.max(10, width * 0.25), color, "center", 700);
  label(ctx, glyph, 0, height * 0.09, Math.max(18, width * 0.42), color, "center", 700);
  ctx.restore();
}

function drawChip(ctx, value, x, y, size, selected = false, amount = null) {
  const [face, deep, tick] = CHIP_COLORS[value] || CHIP_COLORS[20];
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = selected ? "rgba(255,229,144,.9)" : "rgba(0,0,0,.42)";
  ctx.shadowBlur = selected ? 16 : 7;
  ctx.shadowOffsetY = selected ? 0 : 3;
  ctx.beginPath();
  ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
  const rim = ctx.createRadialGradient(-size * 0.15, -size * 0.18, 2, 0, 0, size / 2);
  rim.addColorStop(0, face);
  rim.addColorStop(1, deep);
  ctx.fillStyle = rim;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = selected ? "#fff1ae" : "rgba(255,255,255,.58)";
  ctx.lineWidth = selected ? 4 : 2;
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.38, 0, Math.PI * 2);
  ctx.strokeStyle = tick;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.setLineDash([]);
  const shown = amount == null ? (value >= 1000 ? `${value / 1000}K` : String(value)) : money(amount);
  label(ctx, shown, 0, 1, amount == null ? (value >= 10000 ? 11 : 13) : 10, "#f8f1df", "center", 900);
  ctx.restore();
}

function selectionTotals(bets) {
  return (bets || []).reduce((totals, bet) => {
    totals[bet.selection] = (totals[bet.selection] || 0) + Number(bet.amount || 0);
    return totals;
  }, {});
}

function seededHistory() {
  return Array.from({ length: 100 }, (_, index) => ({
    round_number: 2200 - index,
    winner: (index * 11) % 17 < 8 ? "andar" : "bahar",
    card_count: 1 + ((index * 7) % 28),
  }));
}

function makeDemoOutcome() {
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = ranks.flatMap((rank) => Object.keys(SUIT).map((suit) => `${rank}${suit}`));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  const joker = deck.shift();
  const jokerRank = parseCard(joker).rank;
  const sequence = [];
  let side = "bahar";
  while (deck.length) {
    const card = deck.shift();
    sequence.push({ card, side });
    if (parseCard(card).rank === jokerRank) break;
    side = side === "bahar" ? "andar" : "bahar";
  }
  return { joker, sequence, winner: sequence[sequence.length - 1].side };
}

function payoutFor(selection, amount, outcome) {
  if (selection === outcome.winner) return Math.round(amount * DEFAULT_OPTIONS[selection]);
  if (selection.startsWith("count_")) {
    const [, low, high] = selection.split("_");
    if (outcome.sequence.length >= Number(low) && outcome.sequence.length <= Number(high)) {
      return Math.round(amount * DEFAULT_OPTIONS[selection]);
    }
  }
  return 0;
}

function useDemoAndarBahar() {
  const [phase, setPhase] = useState("BETTING");
  const [countdown, setCountdown] = useState(12);
  const [round, setRound] = useState(1480905962);
  const [balance, setBalance] = useState(10033);
  const [outcome, setOutcome] = useState(null);
  const [result, setResult] = useState(null);
  const [myBets, setMyBets] = useState([]);
  const [lastResults, setLastResults] = useState(seededHistory);
  const betsRef = useRef(myBets);
  betsRef.current = myBets;

  useEffect(() => {
    const duration = phase === "BETTING" ? 12 : phase === "REVEAL" ? DEMO_REVEAL_SECONDS : 4;
    const deadline = Date.now() + duration * 1000;
    setCountdown(duration);
    const clock = window.setInterval(() => setCountdown(Math.max(0, (deadline - Date.now()) / 1000)), 80);
    const next = window.setTimeout(() => {
      if (phase === "BETTING") {
        setOutcome(makeDemoOutcome());
        setResult(null);
        setCountdown(DEMO_REVEAL_SECONDS);
        setPhase("REVEAL");
        sfx.deal();
        return;
      }
      if (phase === "REVEAL") {
        const final = outcome;
        const totalBet = betsRef.current.reduce((sum, bet) => sum + bet.amount, 0);
        const payout = final ? betsRef.current.reduce((sum, bet) => sum + payoutFor(bet.selection, bet.amount, final), 0) : 0;
        setBalance((value) => value + payout);
        setResult({ key: `demo-${round}`, payout, total_bet: totalBet, win: payout > totalBet });
        if (final) setLastResults((rows) => [{ round_number: round, winner: final.winner, card_count: final.sequence.length }, ...rows].slice(0, 100));
        if (payout > totalBet) sfx.winCelebration();
        else if (totalBet) sfx.lose();
        setCountdown(4);
        setPhase("RESULT");
        return;
      }
      setMyBets([]);
      setOutcome(null);
      setResult(null);
      setRound((value) => value + 1);
      setCountdown(12);
      setPhase("BETTING");
    }, duration * 1000);
    return () => {
      window.clearInterval(clock);
      window.clearTimeout(next);
    };
  }, [outcome, phase, round]);

  const placeBet = useCallback(async (selection, amount) => {
    if (phase !== "BETTING" || amount > balance) return null;
    const bet = { id: `demo-${Date.now()}-${Math.random()}`, selection, amount };
    setMyBets((rows) => [...rows, bet]);
    setBalance((value) => value - amount);
    sfx.chip();
    return { balance: balance - amount };
  }, [balance, phase]);

  const clearBets = useCallback(async () => {
    if (phase !== "BETTING") return null;
    const refunded = betsRef.current.reduce((sum, bet) => sum + bet.amount, 0);
    setBalance((value) => value + refunded);
    setMyBets([]);
    return { refunded };
  }, [phase]);

  const undoBet = useCallback(async () => {
    if (phase !== "BETTING" || !betsRef.current.length) return null;
    const latest = betsRef.current[betsRef.current.length - 1];
    setMyBets((rows) => rows.slice(0, -1));
    setBalance((value) => value + latest.amount);
    sfx.chip();
    return { refunded: latest.amount };
  }, [phase]);

  const myTotal = myBets.reduce((sum, bet) => sum + bet.amount, 0);
  const revealElapsed = phase === "RESULT"
    ? DEMO_REVEAL_SECONDS
    : phase === "REVEAL" ? DEMO_REVEAL_SECONDS - countdown : 0;
  const state = useMemo(() => ({
    round_number: round,
    phase,
    min_bet: 20,
    max_bet: 1000,
    timings: { bet: 12, reveal: DEMO_REVEAL_SECONDS, result: 4 },
    options: DEFAULT_OPTIONS,
  }), [phase, round]);

  return {
    state, countdown, balance, phase, betting: phase === "BETTING", outcome, result,
    myBets, myTotal, lastResults, revealElapsed, placeBet, clearBets, undoBet,
  };
}

function LiveAndarBahar({ game }) {
  const live = useLiveRound(game.slug, {
    pollMs: 800,
    revealSound: "deal",
    formatResult: (settled) => {
      const count = settled.outcome?.sequence?.length || 0;
      return {
        title: settled.payout > 0 ? `WIN ₹${money(settled.payout)}` : `${String(settled.outcome?.winner || "").toUpperCase()} WINS`,
        subtitle: `${count} card${count === 1 ? "" : "s"} dealt`,
      };
    },
  });
  return <AndarBaharTable game={game} live={live} />;
}

function DemoAndarBahar({ game }) {
  const demo = useDemoAndarBahar();
  return <AndarBaharTable game={game} live={demo} demo />;
}

function AndarBaharTable({ game, live, demo = false }) {
  const navigate = useNavigate();
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const idleVideoRef = useRef(null);
  const sceneRef = useRef(null);
  const lastDealCountRef = useRef(0);
  const dealStoppedRoundRef = useRef(null);
  const previousBetsRef = useRef([]);
  const previousPhaseRef = useRef(live.phase);
  const [chip, setChip] = useState(20);
  const [muted, setMuted] = useState(isMuted());
  const [modal, setModal] = useState(null);
  const [lastWin, setLastWin] = useState(0);
  const [announcement, setAnnouncement] = useState(null);
  const [hairMoment, setHairMoment] = useState(false);

  const {
    state, countdown, balance, betting, phase, outcome, result,
    placeBet, clearBets, undoBet, myBets, myTotal, lastResults, revealElapsed,
  } = live;
  const minBet = state?.min_bet ?? 20;
  const maxBet = state?.max_bet ?? 1000;
  const options = { ...DEFAULT_OPTIONS, ...(state?.options || {}) };
  const chips = useMemo(() => REFERENCE_CHIPS.filter((value) => value >= minBet && value <= maxBet), [maxBet, minBet]);
  const totals = useMemo(() => selectionTotals(myBets), [myBets]);
  const joker = parseCard(outcome?.joker);
  const run = useMemo(() => (outcome?.sequence || []).map((row) => parseCard(row)).filter(Boolean), [outcome]);

  useEffect(() => onMuteChange(setMuted), []);
  useEffect(() => {
    if (Number(result?.payout || 0) > 0) setLastWin(Number(result.payout));
  }, [result]);
  useEffect(() => {
    if (phase === "BETTING") setAnnouncement(null);
  }, [phase]);
  useEffect(() => {
    const timer = window.setInterval(() => setHairMoment(true), HAIR_GESTURE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (chips.length && !chips.includes(chip)) setChip(chips[0]);
  }, [chip, chips]);
  useEffect(() => {
    if (previousPhaseRef.current === "BETTING" && phase === "REVEAL" && myBets.length) {
      previousBetsRef.current = myBets.map((bet) => ({ selection: bet.selection, amount: bet.amount }));
    }
    previousPhaseRef.current = phase;
  }, [myBets, phase]);
  useEffect(() => {
    const video = videoRef.current;
    const idleVideo = idleVideoRef.current;
    if (!video || !idleVideo) return;
    try {
      if (phase === "REVEAL") {
        idleVideo.pause();
        video.currentTime = 0;
        video.play().catch(() => {});
      } else if (phase === "BETTING" && hairMoment) {
        video.pause();
        video.currentTime = 0;
        if (idleVideo.paused) idleVideo.play().catch(() => {});
      } else {
        video.pause();
        idleVideo.pause();
        idleVideo.currentTime = 0;
      }
    } catch (_error) {
      /* poster remains visible */
    }
  }, [hairMoment, phase]);

  const bet = useCallback((selection) => {
    if (betting && chip) placeBet(selection, chip);
  }, [betting, chip, placeBet]);
  const rebet = useCallback(async () => {
    if (!betting || !previousBetsRef.current.length) return;
    for (const row of previousBetsRef.current) await placeBet(row.selection, row.amount);
  }, [betting, placeBet]);
  const fullscreen = useCallback(() => {
    const node = document.documentElement;
    if (!document.fullscreenElement) node.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }, []);

  sceneRef.current = {
    state, countdown, balance, betting, phase, outcome, result, myTotal,
    lastResults: lastResults || [], totals, options, chip, chips, joker, run,
    revealElapsed: Number(revealElapsed || 0), lastWin,
    capturedAt: performance.now(),
    revealDuration: Number(state?.timings?.reveal || 12),
    demo,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    let animationFrame;

    const render = (now) => {
      const scene = sceneRef.current;
      if (!scene) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== DESIGN_W * ratio || canvas.height !== DESIGN_H * ratio) {
        canvas.width = DESIGN_W * ratio;
        canvas.height = DESIGN_H * ratio;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, DESIGN_W, DESIGN_H);

      const elapsed = scene.phase === "REVEAL"
        ? Math.min(scene.revealDuration, scene.revealElapsed + (now - scene.capturedAt) / 1000)
        : scene.phase === "RESULT" ? scene.revealDuration : 0;
      // A single clock controls the generated dealer gesture and Canvas cards.
      // The reveal is deliberately slower than the previous 0.24s minimum,
      // while still fitting even a rare 49-card round inside the live window.
      const step = scene.run.length ? Math.max(0.32, Math.min(1.05, (scene.revealDuration - 0.8) / scene.run.length)) : 0.8;
      const firstReleaseAt = step * DEAL_RELEASE_RATIO;
      const visibleCount = scene.phase === "RESULT"
        ? scene.run.length
        : scene.phase === "REVEAL" && elapsed >= firstReleaseAt
          ? Math.max(0, Math.min(scene.run.length, Math.floor((elapsed - firstReleaseAt) / step) + 1))
          : 0;

      if (scene.phase === "REVEAL" && videoRef.current) {
        const dealer = videoRef.current;
        const targetRate = Math.max(0.35, Math.min(5, DEAL_SOURCE_CADENCE / step));
        if (Math.abs(dealer.playbackRate - targetRate) > 0.02) dealer.playbackRate = targetRate;
        if (scene.run.length && visibleCount >= scene.run.length) {
          if (!dealer.paused) dealer.pause();
          const roundKey = scene.state?.round_number || `${scene.outcome?.winner}-${scene.run.length}`;
          if (dealStoppedRoundRef.current !== roundKey) {
            dealStoppedRoundRef.current = roundKey;
            const winningCard = scene.run[scene.run.length - 1];
            setAnnouncement({
              key: roundKey,
              winner: scene.outcome?.winner,
              card: `${winningCard?.rank || ""} ${SUIT[winningCard?.suit]?.[0] || ""}`.trim(),
              count: scene.run.length,
            });
          }
        } else if (dealer.paused && scene.run.length) {
          dealer.play().catch(() => {});
        }
      }

      if (scene.phase === "REVEAL" && visibleCount > lastDealCountRef.current) {
        lastDealCountRef.current = visibleCount;
        sfx.flick();
      } else if (scene.phase !== "REVEAL") {
        lastDealCountRef.current = scene.phase === "RESULT" ? scene.run.length : 0;
      }

      label(ctx, "ANDAR", 500, 560, 22, "rgba(255,250,235,.86)", "left", 700);
      label(ctx, "BAHAR", 500, 632, 22, "rgba(255,250,235,.86)", "left", 700);
      ctx.strokeStyle = "rgba(255,250,235,.55)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(500, 582); ctx.lineTo(930, 582); ctx.stroke();

      if (scene.joker && (scene.phase === "REVEAL" || scene.phase === "RESULT")) {
        drawCard(ctx, scene.joker, 1110, 548, 54, 76, Math.min(1, elapsed / 0.35), -0.035);
      }
      const visible = scene.run.slice(0, visibleCount);
      const laneRows = { andar: [], bahar: [] };
      visible.forEach((card, index) => laneRows[card.side || (index % 2 ? "andar" : "bahar")].push({ card, index }));
      Object.entries(laneRows).forEach(([side, rows]) => {
        rows.slice(-8).forEach(({ card, index }, laneIndex) => {
          const targetX = 990 - laneIndex * 54;
          const targetY = side === "andar" ? 535 : 604;
          // Release the rendered card at the same point in every dealer hand
          // cycle, then animate its short flight from the shoe to the lane.
          const appearedAt = firstReleaseAt + index * step;
          const progress = Math.max(0, Math.min(1, (elapsed - appearedAt) / Math.max(.14, Math.min(.32, step * .72))));
          const eased = 1 - Math.pow(1 - progress, 3);
          const x = CARD_RELEASE_X + (targetX - CARD_RELEASE_X) * eased;
          const y = CARD_RELEASE_Y + (targetY - CARD_RELEASE_Y) * eased - Math.sin(progress * Math.PI) * 24;
          drawCard(ctx, card, x, y, 46, 64, progress, (side === "andar" ? -0.025 : 0.025) * eased);
        });
      });

      const railWidth = scene.chips.length * 54 + Math.max(0, scene.chips.length - 1) * 14;
      const railStart = (DESIGN_W - railWidth) / 2 + 27;
      if (scene.betting) {
        scene.chips.forEach((value, index) => drawChip(ctx, value, railStart + index * 68, CHIP_RAIL_Y, scene.chip === value ? 58 : 52, scene.chip === value));
      }

      const action = (x, width, textValue, active) => {
        rounded(ctx, x, ACTION_Y, width, 38, 7);
        ctx.fillStyle = active ? "rgba(24,105,88,.84)" : "rgba(22,28,54,.58)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,.12)";
        ctx.stroke();
        label(ctx, textValue, x + width / 2, ACTION_Y + 19, 13, active ? "#f8f1df" : "rgba(248,241,223,.48)", "center", 800);
      };
      if (scene.betting) {
        action(602, 154, "↻  REBET", previousBetsRef.current.length > 0);
        action(770, 50, "⌫", scene.myTotal > 0);
        action(834, 154, "↶  UNDO", scene.myTotal > 0);
      }

      ctx.fillStyle = "#11162f";
      ctx.fillRect(0, PANEL_Y, DESIGN_W, DESIGN_H - PANEL_Y);
      ctx.fillStyle = "rgba(255,255,255,.035)";
      ctx.fillRect(0, PANEL_Y, DESIGN_W, 2);

      label(ctx, "▥  Statistics", 205, 696, 14, "#f8f1df", "center", 700);
      const phaseText = scene.phase === "BETTING"
        ? `${Math.ceil(scene.countdown) <= 4 ? `${Math.ceil(scene.countdown)} LAST BETS` : `PLACE YOUR BETS  ${Math.ceil(scene.countdown)}`}`
        : scene.phase === "REVEAL" ? "NO MORE BETS"
          : `${String(scene.outcome?.winner || "").toUpperCase()} WON`;
      const phaseY = scene.betting ? 542 : 663;
      rounded(ctx, 730, phaseY, 140, 34, 5);
      ctx.fillStyle = scene.phase === "RESULT" ? (scene.outcome?.winner === "andar" ? "#e3153b" : "#2857a5") : "rgba(20,24,49,.9)";
      ctx.fill();
      label(ctx, phaseText, 800, phaseY + 17, phaseText.length > 18 ? 11 : 13, "#f8f1df", "center", 900);
      label(ctx, "BET HOW MANY CARDS WILL BE DEALT", 1328, 696, 13, "#f8f1df", "center", 800);

      const history = scene.lastResults.slice(0, 72).reverse();
      history.forEach((row, index) => {
        const column = index % 18;
        const gridRow = Math.floor(index / 18);
        const x = 18 + column * 24;
        const y = 733 + gridRow * 24;
        ctx.beginPath(); ctx.arc(x, y, 9.5, 0, Math.PI * 2);
        ctx.fillStyle = row.winner === "andar" ? "#e3153b" : "#2364bf";
        ctx.fill();
        label(ctx, row.winner === "andar" ? "A" : "B", x, y + .5, 10, "#fff", "center", 900);
      });
      const recentCounts = scene.lastResults.slice(0, 7).reverse();
      recentCounts.forEach((row, index) => {
        const x = 305 + index * 32;
        ctx.beginPath(); ctx.arc(x, 833, 12, 0, Math.PI * 2);
        ctx.strokeStyle = row.winner === "andar" ? "#e3153b" : "#4385de";
        ctx.lineWidth = 2;
        ctx.stroke();
        label(ctx, String(row.card_count || "–"), x, 833, 10, "#f8f1df", "center", 800);
      });
      const totalRows = Math.max(1, scene.lastResults.length);
      const andarPct = Math.round(scene.lastResults.filter((row) => row.winner === "andar").length * 100 / totalRows);
      label(ctx, `${andarPct}%`, 303, 852, 12, "#f8f1df", "right", 800);
      ctx.fillStyle = "#e3153b"; ctx.fillRect(310, 845, 95 * andarPct / 100, 14);
      ctx.fillStyle = "#2857a5"; ctx.fillRect(310 + 95 * andarPct / 100, 845, 95 * (100 - andarPct) / 100, 14);
      label(ctx, `${100 - andarPct}%`, 412, 852, 12, "#f8f1df", "left", 800);

      const mainX = 497; const mainY = MAIN_BET_Y; const mainW = 600; const mainH = MAIN_BET_H;
      rounded(ctx, mainX, mainY, mainW, mainH, 7);
      ctx.fillStyle = "#e3153b"; ctx.fill();
      ctx.save(); rounded(ctx, mainX, mainY, mainW, mainH, 7); ctx.clip(); ctx.fillStyle = "#2857a5"; ctx.fillRect(mainX + mainW / 2, mainY, mainW / 2, mainH); ctx.restore();
      ctx.strokeStyle = "#e4c06b"; ctx.lineWidth = 1.5; rounded(ctx, mainX, mainY, mainW, mainH, 7); ctx.stroke();
      label(ctx, "ANDAR", mainX + 20, mainY + 28, 20, "#f3d37e", "left", 900);
      label(ctx, "1:1", mainX + 20, mainY + 55, 15, "#e7c86f", "left", 700);
      label(ctx, "BAHAR", mainX + mainW - 20, mainY + 28, 20, "#f3d37e", "right", 900);
      label(ctx, "0.9:1", mainX + mainW - 20, mainY + 55, 15, "#e7c86f", "right", 700);
      if (scene.totals.andar) drawChip(ctx, scene.chip, mainX + 188, mainY + 55, 42, true, scene.totals.andar);
      if (scene.totals.bahar) drawChip(ctx, scene.chip, mainX + mainW - 188, mainY + 55, 42, true, scene.totals.bahar);
      ctx.beginPath(); ctx.arc(797, 776, 61, 0, Math.PI * 2);
      const well = ctx.createRadialGradient(782, 756, 5, 797, 776, 61);
      well.addColorStop(0, "#31343a"); well.addColorStop(.6, "#07080d"); well.addColorStop(1, "#000");
      ctx.fillStyle = well; ctx.fill();
      ctx.strokeStyle = "#e4c06b"; ctx.lineWidth = 3; ctx.stroke();
      if (scene.joker && scene.phase !== "BETTING") drawCard(ctx, scene.joker, 774, 739, 46, 68);
      else label(ctx, "JOKER", 797, 777, 15, "#b89a56", "center", 900);

      const lastAndar = [...visible].reverse().find((card) => card.side === "andar");
      const lastBahar = [...visible].reverse().find((card) => card.side === "bahar");
      if (lastAndar) drawCard(ctx, lastAndar, 646, 740, 43, 67);
      if (lastBahar) drawCard(ctx, lastBahar, 904, 740, 43, 67);

      COUNT_BETS.forEach(([selection, range], index) => {
        const column = index % 4;
        const row = Math.floor(index / 4);
        const x = 1094 + column * 124;
        const y = COUNT_BET_Y + row * COUNT_BET_ROW_GAP;
        rounded(ctx, x, y, 118, COUNT_BET_H, 5);
        const winning = scene.phase === "RESULT" && scene.run.length >= Number(selection.split("_")[1]) && scene.run.length <= Number(selection.split("_")[2]);
        const gradient = ctx.createLinearGradient(0, y, 0, y + COUNT_BET_H);
        gradient.addColorStop(0, winning ? "#dfc373" : "#3b3627");
        gradient.addColorStop(.52, winning ? "#8c681e" : "#151720");
        gradient.addColorStop(1, winning ? "#3a2b0e" : "#080a11");
        ctx.fillStyle = gradient; ctx.fill();
        ctx.strokeStyle = winning ? "#fff0a7" : "#d8c384"; ctx.lineWidth = 2; ctx.stroke();
        label(ctx, range, x + 59, y + 23, 18, winning ? "#fff8dc" : "#f2ddb0", "center", 900);
        label(ctx, `${Math.max(0, Number(scene.options[selection] || 1) - 1).toFixed(1)}:1`, x + 59, y + 47, 13, "#c7b078", "center", 800);
        if (scene.totals[selection]) drawChip(ctx, scene.chip, x + 100, y + 32, 30, true, scene.totals[selection]);
      });

      ctx.fillStyle = "#0c1024"; ctx.fillRect(0, 866, DESIGN_W, 34);
      label(ctx, `Andar Bahar ₹${money(minBet)} – ₹${money(maxBet)}`, 12, 884, 13, "#a8b0cc", "left", 700);
      label(ctx, `Balance ₹${money(scene.balance)}`, 420, 884, 13, "#a8b0cc", "center", 700);
      label(ctx, `Bet ₹${money(scene.myTotal)}`, 790, 884, 13, "#a8b0cc", "center", 700);
      label(ctx, `LAST WIN ₹${money(scene.lastWin)}`, 1112, 884, 14, "#f3d37e", "center", 900);
      label(ctx, `LIVE MODE · #${scene.state?.round_number || "—"}`, 1585, 884, 12, "#a8b0cc", "right", 800);

      rounded(ctx, 652, 14, 296, 44, 7);
      ctx.fillStyle = "rgba(12,16,36,.9)";
      ctx.fill();
      ctx.strokeStyle = "rgba(228,192,107,.88)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      label(ctx, `LAST WIN  ₹${money(scene.lastWin)}`, 800, 37, 15, "#f3d37e", "center", 900);

      if (scene.phase === "RESULT" && scene.outcome) {
        rounded(ctx, 646, 590, 308, 58, 8);
        ctx.fillStyle = scene.outcome.winner === "andar" ? "rgba(227,21,59,.94)" : "rgba(40,87,165,.94)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,241,181,.82)"; ctx.lineWidth = 1.5; ctx.stroke();
        label(ctx, `${String(scene.outcome.winner).toUpperCase()} WON · ${scene.run.length} CARDS`, 800, 619, 18, "#fff", "center", 900);
      }

      animationFrame = requestAnimationFrame(render);
    };
    animationFrame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrame);
  }, [maxBet, minBet]);

  const chipStart = (DESIGN_W - (chips.length * 54 + Math.max(0, chips.length - 1) * 14)) / 2;
  return (
    <Cabinet
      ground="#080c1d"
      exitTo={`/games/${game.slug}`}
      testId="cab-andar-bahar"
      className="ab-cabinet"
      designWidth={DESIGN_W}
      designHeight={DESIGN_H}
      systemControls={false}
    >
      <img className="ab-dealer-poster" src="/game-art/andar-bahar/dealer-stage.jpg" alt="" draggable="false" />
      <svg className="ab-table-cover" viewBox={`0 0 ${DESIGN_W} ${DESIGN_H}`} aria-hidden="true">
        <defs>
          <linearGradient id="ab-table-cloth" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#cdae69" />
            <stop offset="0.5" stopColor="#af8d4c" />
            <stop offset="1" stopColor="#785a2b" />
          </linearGradient>
        </defs>
        <path d={`M430 ${PANEL_Y} L470 548 Q800 505 1130 548 L1170 ${PANEL_Y} Z`} fill="url(#ab-table-cloth)" stroke="#efd68f" strokeWidth="3" />
      </svg>
      <img className={`ab-dealer-foreground ${phase === "REVEAL" ? "is-hidden" : ""}`}
        src="/game-art/andar-bahar/dealer-stage.jpg" alt="" draggable="false" />
      <video
        ref={idleVideoRef}
        className={`ab-dealer-video ab-idle-video ${phase === "BETTING" && hairMoment ? "is-active" : "is-idle"}`}
        src="/game-art/andar-bahar/dealer-idle.mp4"
        poster="/game-art/andar-bahar/dealer-stage.jpg"
        muted
        playsInline
        preload="auto"
        aria-label="Animated live Andar Bahar dealer waiting at the card shoe"
        onEnded={() => setHairMoment(false)}
        onError={(event) => { event.currentTarget.style.display = "none"; }}
      />
      <video
        ref={videoRef}
        className={`ab-dealer-video ${phase === "REVEAL" && !announcement ? "is-active" : "is-idle"}`}
        src="/game-art/andar-bahar/dealer-loop.mp4"
        poster="/game-art/andar-bahar/dealer-stage.jpg"
        muted
        loop
        playsInline
        preload="auto"
        aria-label="Animated live Andar Bahar dealer drawing each card from the shoe with her right hand"
        onError={(event) => { event.currentTarget.style.display = "none"; }}
      />
      <canvas ref={canvasRef} className="ab-canvas" width={DESIGN_W} height={DESIGN_H}
        data-testid="andar-bahar-canvas" data-phase={phase} data-round={state?.round_number || ""} data-card-count={run.length} />
      <div className="ab-announcer" aria-live="off">
        {announcement ? `${announcement.winner} wins, ${announcement.card}, ${announcement.count} cards dealt` : ""}
      </div>

      <button type="button" className="ab-more-games" onClick={() => navigate(`/games/${game.slug}`)}><span>CHAKRI</span> More Games</button>
      <div className="ab-top-actions">
        <button type="button" onClick={() => setModal("live")} aria-label="Live mode information"><Headphones /></button>
        <button type="button" onClick={() => setModal("stats")} aria-label="Open statistics"><BarChart3 /></button>
        <button type="button" onClick={toggleMuted} aria-label={muted ? "Turn sound on" : "Mute sound"}>{muted ? <VolumeX /> : <Volume2 />}</button>
        <button type="button" onClick={fullscreen} aria-label="Toggle fullscreen"><Maximize2 /></button>
        <button type="button" onClick={() => setModal("rules")} aria-label="Open game menu"><Menu /></button>
      </div>

      {chips.map((value, index) => (
        <button key={value} type="button" className="ab-hit ab-chip-hit" aria-label={`Select ${value} chip`} aria-pressed={chip === value}
          disabled={!betting}
          style={{ left: chipStart + index * 68, top: CHIP_RAIL_Y - 29, width: 58, height: 58 }} onClick={() => { setChip(value); sfx.chip(); }} />
      ))}
      <button type="button" className="ab-hit" aria-label="Bet on Andar" data-testid="cab-andar"
        disabled={!betting} style={{ left: 497, top: MAIN_BET_Y, width: 239, height: MAIN_BET_H }} onClick={() => bet("andar")} />
      <button type="button" className="ab-hit" aria-label="Bet on Bahar" data-testid="cab-bahar"
        disabled={!betting} style={{ left: 858, top: MAIN_BET_Y, width: 239, height: MAIN_BET_H }} onClick={() => bet("bahar")} />
      {COUNT_BETS.map(([selection, range], index) => (
        <button key={selection} type="button" className="ab-hit" aria-label={`Bet on ${range} cards`} disabled={!betting}
          data-testid={`cab-${selection}`} style={{ left: 1094 + (index % 4) * 124, top: COUNT_BET_Y + Math.floor(index / 4) * COUNT_BET_ROW_GAP, width: 118, height: COUNT_BET_H }}
          onClick={() => bet(selection)} />
      ))}
      <button type="button" className="ab-hit" aria-label="Repeat previous bets" disabled={!betting || !previousBetsRef.current.length}
        style={{ left: 602, top: ACTION_Y, width: 154, height: 38 }} onClick={rebet}><RotateCcw /></button>
      <button type="button" className="ab-hit" aria-label="Clear bets" disabled={!betting || !myTotal}
        style={{ left: 770, top: ACTION_Y, width: 50, height: 38 }} onClick={clearBets}><X /></button>
      <button type="button" className="ab-hit" aria-label="Undo last bet" disabled={!betting || !myTotal}
        style={{ left: 834, top: ACTION_Y, width: 154, height: 38 }} onClick={undoBet}><Undo2 /></button>

      {modal && (
        <div className="ab-modal" role="dialog" aria-modal="true" aria-labelledby="ab-modal-title">
          <div className="ab-modal-card">
            <button type="button" className="ab-modal-close" onClick={() => setModal(null)} aria-label="Close"><X /></button>
            {modal === "rules" && <>
              <h2 id="ab-modal-title">How to play</h2>
              <p>A joker is revealed, then cards alternate from Bahar to Andar. The first side to receive a card matching the joker rank wins.</p>
              <p>Andar pays 1:1. Bahar pays 0.9:1. The eight card-count bets settle on the total cards dealt before the match.</p>
              <p>Choose a chip, touch a betting area, and use Undo or Clear while betting is open.</p>
            </>}
            {modal === "stats" && <>
              <h2 id="ab-modal-title">Live statistics</h2>
              <p>The roadmap contains the latest {lastResults?.length || 0} server-synchronized rounds.</p>
              <div className="ab-modal-roadmap">{(lastResults || []).slice(0, 60).map((row, index) => <span key={row.round_number || index} className={row.winner === "andar" ? "is-andar" : "is-bahar"}>{row.winner === "andar" ? "A" : "B"}</span>)}</div>
            </>}
            {modal === "live" && <>
              <h2 id="ab-modal-title">Live Mode</h2>
              <p>Round #{state?.round_number || "—"} is shared by every connected player. Cards, outcome, balance, bets, and payouts are synchronized by the game server.</p>
            </>}
          </div>
        </div>
      )}
    </Cabinet>
  );
}

export default function AndarBaharCabinet({ game }) {
  return game.demo ? <DemoAndarBahar game={game} /> : <LiveAndarBahar game={game} />;
}
