import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Map, RotateCcw, Undo2, Volume2, VolumeX, Wifi, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { formatChips } from "@/components/common";
import { useLiveRound } from "@/lib/useLiveRound";
import { isMuted, onMuteChange, sfx, toggleMuted } from "@/lib/sound";
import { fitDesignCanvas } from "@/lib/viewport";
import "./pappuPictures.css";

const SYMBOLS = [
  { id: "umbrella", label: "Umbrella", art: "☂️" },
  { id: "football", label: "Football", art: "⚽" },
  { id: "sun", label: "Sun", art: "☀️" },
  { id: "diya", label: "Diya", art: "🪔" },
  { id: "cow", label: "Cow", art: "🐄" },
  { id: "bucket", label: "Bucket", art: "🪣" },
  { id: "blanket", label: "Blanket", art: "🧣" },
  { id: "top", label: "Spinning top", art: "🪀" },
  { id: "rose", label: "Rose", art: "🌹" },
  { id: "butterfly", label: "Butterfly", art: "🦋" },
  { id: "pigeon", label: "Pigeon", art: "🕊️" },
  { id: "rabbit", label: "Rabbit", art: "🐇" },
];
const SYMBOL_MAP = Object.fromEntries(SYMBOLS.map((symbol) => [symbol.id, symbol]));
const CHIP_VALUES = [10, 20, 30, 50, 100, 200];
const CHIP_THEME = {
  10: ["#f7f4dc", "#dad3a1", "#0ba768", "#143e2d"],
  20: ["#25b7cf", "#087289", "#e8fbff", "#062f38"],
  30: ["#a95e35", "#643018", "#f5e1c9", "#35170b"],
  50: ["#ffc32a", "#d78600", "#fff3b1", "#4b2c00"],
  100: ["#e53a34", "#921410", "#fff0dc", "#4c0807"],
  200: ["#8e35c2", "#4b146d", "#f6e3ff", "#270a38"],
};
const DEMO_BET_SECONDS = 10;
const DEMO_REVEAL_SECONDS = 8;
const DEMO_RESULT_SECONDS = 4;

function makeOutcome() {
  const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)].id;
  const extraPay = Math.random() < 0.35;
  let multiplier = 8;
  const boosts = {};
  if (extraPay) {
    const pool = SYMBOLS.map((item) => item.id).sort(() => Math.random() - 0.5);
    pool.slice(0, 5).forEach((item, index) => {
      const choices = [20, 20, 20, 30, 30, 50, 100, 200];
      boosts[item] = choices[(Math.floor(Math.random() * choices.length) + index) % choices.length];
    });
    multiplier = boosts[symbol] || 8;
  }
  return { symbol, multiplier, extra_pay: extraPay, boosts };
}

function seededHistory() {
  const ids = SYMBOLS.map((item) => item.id);
  return Array.from({ length: 23 }, (_, index) => ({
    round_number: 5800 - index,
    symbol: ids[(index * 7 + 3) % ids.length],
    multiplier: 8,
    extra_pay: false,
  }));
}

function useDemoPictures() {
  const [phase, setPhase] = useState("BETTING");
  const [countdown, setCountdown] = useState(DEMO_BET_SECONDS);
  const [round, setRound] = useState(5801);
  const [outcome, setOutcome] = useState(null);
  const [balance, setBalance] = useState(10000);
  const [myBets, setMyBets] = useState([]);
  const [lastResults, setLastResults] = useState(seededHistory);
  const [settled, setSettled] = useState(null);
  const betsRef = useRef(myBets);
  betsRef.current = myBets;

  useEffect(() => {
    const duration = phase === "BETTING" ? DEMO_BET_SECONDS : phase === "REVEAL" ? DEMO_REVEAL_SECONDS : DEMO_RESULT_SECONDS;
    const deadline = Date.now() + duration * 1000;
    setCountdown(duration);
    const clock = window.setInterval(() => setCountdown(Math.max(0, (deadline - Date.now()) / 1000)), 80);
    const next = window.setTimeout(() => {
      if (phase === "BETTING") {
        setOutcome(makeOutcome());
        setSettled(null);
        setPhase("REVEAL");
        sfx.betLock();
        return;
      }
      if (phase === "REVEAL") {
        const final = outcome;
        const totalBet = betsRef.current.reduce((sum, bet) => sum + bet.amount, 0);
        const payout = betsRef.current.reduce((sum, bet) => sum + (bet.selection === final?.symbol ? bet.amount * final.multiplier : 0), 0);
        if (payout) setBalance((value) => value + payout);
        setSettled({ payout, total_bet: totalBet, outcome: final });
        if (final) setLastResults((items) => [{ round_number: round, ...final }, ...items].slice(0, 100));
        setPhase("RESULT");
        if (payout) sfx.winCelebration();
        else if (totalBet) sfx.lose();
        return;
      }
      setRound((value) => value + 1);
      setOutcome(null);
      setMyBets([]);
      setSettled(null);
      setPhase("BETTING");
    }, duration * 1000);
    return () => {
      window.clearInterval(clock);
      window.clearTimeout(next);
    };
  }, [phase, outcome, round]);

  const placeBet = useCallback(async (selection, amount) => {
    if (phase !== "BETTING" || amount > balance) return null;
    const bet = { id: `demo-${Date.now()}-${Math.random()}`, selection, amount };
    setBalance((value) => value - amount);
    setMyBets((items) => [...items, bet]);
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
    setMyBets((items) => items.slice(0, -1));
    setBalance((value) => value + latest.amount);
    sfx.chip();
    return { refunded: latest.amount };
  }, [phase]);

  const revealProgress = phase === "RESULT" ? 1 : phase === "REVEAL" ? Math.max(0, 1 - countdown / DEMO_REVEAL_SECONDS) : 0;
  return {
    state: {
      round_number: round,
      phase,
      min_bet: 10,
      max_bet: 200,
      timings: { bet: DEMO_BET_SECONDS, reveal: DEMO_REVEAL_SECONDS, result: DEMO_RESULT_SECONDS },
      settled,
    },
    countdown,
    balance,
    placing: false,
    phase,
    betting: phase === "BETTING",
    outcome,
    myBets,
    myTotal: myBets.reduce((sum, bet) => sum + bet.amount, 0),
    lastResults,
    revealProgress,
    placeBet,
    clearBets,
    undoBet,
    result: settled,
  };
}

function useCabinetScale(shellRef) {
  const measure = useCallback(() => {
    if (typeof window === "undefined") return 1;
    const shell = shellRef.current;
    const width = shell?.clientWidth || window.visualViewport?.width || window.innerWidth;
    const height = shell?.clientHeight || window.visualViewport?.height || window.innerHeight;
    return fitDesignCanvas({
      availableWidth: width,
      availableHeight: height,
      designWidth: 430,
      designHeight: 880,
      maxScale: 1.15,
    }).scale;
  }, [shellRef]);
  const [scale, setScale] = useState(measure);
  useLayoutEffect(() => {
    const resize = () => setScale(measure());
    const observer = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(resize) : null;
    if (shellRef.current) observer?.observe(shellRef.current);
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    resize();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
  }, [measure, shellRef]);
  return scale;
}

function Picture({ id, className = "" }) {
  const symbol = SYMBOL_MAP[id] || SYMBOLS[0];
  return <span className={`pp-picture ${className}`} role="img" aria-label={symbol.label}>{symbol.art}</span>;
}

function Chip({ value, label = value, small = false }) {
  const theme = CHIP_THEME[value] || CHIP_THEME[10];
  return (
    <span
      className={`pp-chip ${small ? "is-small" : ""}`}
      style={{ "--chip-top": theme[0], "--chip-bottom": theme[1], "--chip-mark": theme[2], "--chip-ink": theme[3] }}
    >
      <b>{label}</b>
    </span>
  );
}

function ScratchCard({ roundKey, revealed, onReveal }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = 142;
    const height = 166;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const foil = context.createLinearGradient(0, 0, width, height);
    foil.addColorStop(0, "#f5f2ff");
    foil.addColorStop(0.34, "#aaa3c4");
    foil.addColorStop(0.55, "#e7e4f2");
    foil.addColorStop(1, "#81799d");
    context.fillStyle = foil;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(255,255,255,.58)";
    context.lineWidth = 1;
    for (let offset = -height; offset < width; offset += 12) {
      context.beginPath();
      context.moveTo(offset, 0);
      context.lineTo(offset + height, height);
      context.stroke();
    }
    context.fillStyle = "rgba(70,45,92,.24)";
    context.font = "900 18px Arial";
    context.textAlign = "center";
    context.fillText("SCRATCH", width / 2, 78);
    context.font = "800 10px Arial";
    context.fillText("TO REVEAL", width / 2, 96);
    drawingRef.current = false;
    lastPointRef.current = null;
  }, [roundKey]);

  const pointFromEvent = useCallback((event) => {
    const canvas = canvasRef.current;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (142 / bounds.width),
      y: (event.clientY - bounds.top) * (166 / bounds.height),
    };
  }, []);

  const scratchAt = useCallback((event) => {
    if (revealed) return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const point = pointFromEvent(event);
    const previous = lastPointRef.current || point;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    context.save();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalCompositeOperation = "destination-out";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 27;
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    context.beginPath();
    context.arc(point.x, point.y, 13.5, 0, Math.PI * 2);
    context.fill();
    context.restore();
    lastPointRef.current = point;
  }, [pointFromEvent, revealed]);

  const checkProgress = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || revealed) return;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let cleared = 0;
    let sampled = 0;
    const step = 24;
    for (let index = 3; index < pixels.length; index += step * 4) {
      sampled += 1;
      if (pixels[index] < 80) cleared += 1;
    }
    if (sampled && cleared / sampled >= 0.34) onReveal();
  }, [onReveal, revealed]);

  const startScratch = useCallback((event) => {
    if (revealed) return;
    drawingRef.current = true;
    lastPointRef.current = null;
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Pointer capture is optional. */ }
    scratchAt(event);
  }, [revealed, scratchAt]);
  const moveScratch = useCallback((event) => {
    if (!drawingRef.current) return;
    scratchAt(event);
  }, [scratchAt]);
  const stopScratch = useCallback((event) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    checkProgress();
  }, [checkProgress]);

  return (
    <canvas
      ref={canvasRef}
      className={`pp-scratch-cover ${revealed ? "is-cleared" : ""}`}
      onPointerDown={startScratch}
      onPointerMove={moveScratch}
      onPointerUp={stopScratch}
      onPointerCancel={stopScratch}
      aria-label="Scratch the covered card to reveal the winning picture"
      data-testid="pappu-scratch-card"
    />
  );
}

function PappuPicturesTable({ game, live, demo = false }) {
  const navigate = useNavigate();
  const shellRef = useRef(null);
  const scale = useCabinetScale(shellRef);
  const {
    state, countdown, balance, placing, phase, betting, outcome, myBets, myTotal,
    lastResults, placeBet, clearBets, undoBet, result,
  } = live;
  const [chip, setChip] = useState(10);
  const [chipMenu, setChipMenu] = useState(false);
  const [muted, setMuted] = useState(isMuted());
  const [busy, setBusy] = useState(false);
  const repeatRef = useRef([]);
  const revealSoundRef = useRef("");
  const roadmapRef = useRef(null);
  const [scratched, setScratched] = useState(false);

  useEffect(() => onMuteChange(setMuted), []);
  useEffect(() => {
    if (myBets.length) repeatRef.current = myBets.map(({ selection, amount }) => ({ selection, amount }));
  }, [myBets]);
  useEffect(() => {
    if (phase === "BETTING") setScratched(false);
    if (phase === "RESULT") setScratched(true);
  }, [phase, state?.round_number]);
  useEffect(() => {
    const key = `${state?.round_number}:scratched`;
    if (scratched && revealSoundRef.current !== key) {
      revealSoundRef.current = key;
      sfx.flip();
      if (outcome?.extra_pay) sfx.coinShower();
    }
  }, [outcome?.extra_pay, scratched, state?.round_number]);

  const stakes = useMemo(() => myBets.reduce((map, bet) => {
    map[bet.selection] = (map[bet.selection] || 0) + bet.amount;
    return map;
  }, {}), [myBets]);
  const board = useMemo(() => {
    const ordered = lastResults.slice(0, 24).reverse();
    return [...ordered, ...Array.from({ length: Math.max(0, 36 - ordered.length) }, () => null)].slice(0, 36);
  }, [lastResults]);
  const latestIndex = board.reduce((latest, item, index) => item ? index : latest, -1);
  const activeCoveredIndex = board.findIndex((item) => !item);
  const minBet = state?.min_bet ?? 10;
  const maxBet = state?.max_bet ?? 200;
  const shownSymbol = phase === "RESULT" || (phase === "REVEAL" && scratched);
  const settlement = state?.settled || result;
  const seconds = Math.max(0, Math.ceil(countdown));

  useEffect(() => {
    const roadmap = roadmapRef.current;
    if (!roadmap || (phase !== "BETTING" && phase !== "REVEAL")) return undefined;
    const target = roadmap.querySelector(".pp-road-card.is-active-covered");
    if (!target) return undefined;
    const timer = window.setTimeout(() => {
      const top = Math.max(0, target.offsetTop - roadmap.clientHeight * 0.55);
      roadmap.scrollTo({ top, behavior: "smooth" });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [activeCoveredIndex, phase, state?.round_number]);

  const lay = useCallback(async (selection) => {
    if (!betting || placing || busy) return;
    await placeBet(selection, chip);
  }, [betting, busy, chip, placeBet, placing]);

  const replay = useCallback(async (double = false) => {
    if (!betting || placing || busy) return;
    const source = double ? myBets.map(({ selection, amount }) => ({ selection, amount })) : repeatRef.current;
    if (!source.length) return;
    setBusy(true);
    try {
      if (!double && myBets.length) await clearBets();
      for (const bet of source) {
        const amount = Math.min(maxBet, Math.max(minBet, double ? bet.amount : bet.amount));
        await placeBet(bet.selection, amount);
      }
    } finally {
      setBusy(false);
    }
  }, [betting, busy, clearBets, maxBet, minBet, myBets, placeBet, placing]);

  return (
    <div ref={shellRef} className="pp-shell" data-testid="pappu-pictures-cabinet" data-phase={phase || "LOADING"} data-demo={demo ? "true" : "false"}>
      <div className="pp-viewport" style={{ width: `${430 * scale}px`, height: `${880 * scale}px`, "--pp-scale": scale }}>
      <div className="pp-stage">
        <header className="pp-topbar">
          <button type="button" className="pp-round-button" onClick={() => navigate(`/games/${game.slug}`)} aria-label="Back to game details"><ChevronLeft /></button>
          <span className="pp-topbar-brand"><small><i />LIVE</small></span>
          <strong>{balance == null ? "…" : formatChips(balance)} <small>CHIPS</small></strong>
          <button type="button" className="pp-sound-button" onClick={toggleMuted} aria-label={muted ? "Turn sound on" : "Mute sound"}>{muted ? <VolumeX /> : <Volume2 />}</button>
        </header>

        <section className="pp-brand-zone">
          <div className="pp-stats pp-roadmap-label">
            <span className="pp-history-label"><Map />Roadmap</span>
            <strong>LIVE RESULTS</strong>
            <small>LAST 36 ROUNDS</small>
          </div>
          <div className="pp-logo" aria-label="Pappu Pictures">
            <span className="pp-mascot" aria-hidden="true">🧒🏽</span>
            <span><small>EXTRA PAY</small><b>PAPPU</b><em>PLAYING PICTURES</em></span>
          </div>
          <div className={`pp-timer ${phase !== "BETTING" ? "is-locked" : ""}`}><b>{seconds}</b><small>SEC</small></div>
        </section>

        <main className="pp-roadmap" aria-label="Previous 36 picture results">
          <div className="pp-road-grid" ref={roadmapRef}>
          {board.map((item, index) => (
            <div className={`pp-road-card ${item ? "is-revealed" : ""} ${index === latestIndex ? "is-latest" : ""} ${index === activeCoveredIndex ? "is-active-covered" : ""}`} key={`${item?.round_number || "empty"}-${index}`}>
              <div className="pp-road-card-inner">
                <div className="pp-road-back"><i /><i /><i /></div>
                <div className="pp-road-front">{item && <><Picture id={item.symbol} />{item.extra_pay && <small>{item.multiplier}×</small>}</>}</div>
              </div>
            </div>
          ))}
          </div>

          <div className={`pp-phase-banner is-${(phase || "loading").toLowerCase()}`}>
            {phase === "BETTING" && <b>PLEASE BET NOW</b>}
            {phase === "REVEAL" && <b>{scratched ? (outcome?.extra_pay ? "EXTRA PAY REVEALED" : "CARD REVEALED") : "SCRATCH THE COVERED CARD"}</b>}
            {phase === "RESULT" && <b>WIN {formatChips(settlement?.payout || 0)} CHIPS <small>· {SYMBOL_MAP[outcome?.symbol]?.label || "RESULT"} {outcome?.multiplier || 8}×</small></b>}
          </div>

          {(phase === "REVEAL" || phase === "RESULT") && (
            <div className={`pp-reveal ${shownSymbol ? "is-open" : ""} ${outcome?.extra_pay ? "is-extra" : ""}`} aria-live="polite">
              {outcome?.extra_pay && <span className="pp-extra-ribbon">EXTRA PAY</span>}
              <div className={`pp-reveal-card ${shownSymbol ? "is-scratched" : ""}`}>
                <div className="pp-reveal-front"><Picture id={outcome?.symbol} /><b>{outcome?.multiplier || 8}×</b></div>
                <ScratchCard roundKey={state?.round_number} revealed={shownSymbol} onReveal={() => setScratched(true)} />
              </div>
            </div>
          )}
        </main>

        <div className="pp-modebar"><span>#{String(state?.round_number ?? "—").slice(-4)}</span><button type="button"><Map /> Roadmap</button><b>◆</b><strong>Multiple Mode</strong><b>◆</b><span>Min <em>{minBet}</em></span><span>Max <em>{maxBet}</em></span></div>

        <section className="pp-bet-grid" aria-label="Picture betting choices">
          {SYMBOLS.map((symbol) => (
            <button
              type="button"
              key={symbol.id}
              className={`${stakes[symbol.id] ? "has-bet" : ""} ${outcome?.symbol === symbol.id && shownSymbol ? "is-winner" : ""}`}
              onClick={() => lay(symbol.id)}
              disabled={!betting || placing || busy}
              data-testid={`pappu-symbol-${symbol.id}`}
            >
              <Picture id={symbol.id} />
              {stakes[symbol.id] > 0 && <span className="pp-stake"><Chip value={CHIP_VALUES.slice().reverse().find((value) => stakes[symbol.id] >= value) || 10} label={formatChips(stakes[symbol.id])} small /></span>}
              {phase === "REVEAL" && outcome?.extra_pay && outcome?.boosts?.[symbol.id] && <span className="pp-boost">{outcome.boosts[symbol.id]}×</span>}
            </button>
          ))}
        </section>

        <div className="pp-money"><span>Balance <b>{balance == null ? "…" : formatChips(balance)} chips</b></span><span>Your Bet <b>{formatChips(myTotal)} chips</b></span></div>

        <footer className="pp-controls">
          <div className="pp-player"><span>🧑🏽</span><small>P***7</small></div>
          <button type="button" className="pp-tool" onClick={() => replay(false)} disabled={!betting || !repeatRef.current.length || busy}><RotateCcw /><small>again</small></button>
          <div className={`pp-chip-picker ${chipMenu ? "is-open" : ""}`}>
            {CHIP_VALUES.filter((value) => value !== chip).map((value, index) => (
              <button
                type="button"
                key={value}
                onClick={() => { setChip(value); setChipMenu(false); }}
                style={{
                  "--fan-x": `${[-126, -82, -38, 8, 54][index]}px`,
                  "--fan-y": `${[-58, -82, -94, -82, -58][index]}px`,
                }}
                aria-label={`Select ${value} chip`}
              ><Chip value={value} /></button>
            ))}
            <button type="button" className="pp-chip-current" onClick={() => setChipMenu((open) => !open)} aria-label={`Current chip ${chip}`}><Chip value={chip} /></button>
          </div>
          <button type="button" className="pp-tool" onClick={() => replay(true)} disabled={!betting || !myBets.length || busy}><b>×2</b><small>double</small></button>
          <button type="button" className="pp-tool" onClick={undoBet} disabled={!betting || !myBets.length || busy}><Undo2 /><small>undo</small></button>
          <button type="button" className="pp-tool is-danger" onClick={clearBets} disabled={!betting || !myBets.length || busy}><X /><small>clear</small></button>
          <div className="pp-live-id"><span>{String(state?.round_number ?? "").padStart(16, "0")}</span><Wifi /></div>
        </footer>
      </div>
      </div>
    </div>
  );
}

function LivePappuPictures({ game }) {
  const live = useLiveRound(game.slug, { pollMs: 700, revealSound: "draw" });
  return <PappuPicturesTable game={game} live={live} />;
}

function DemoPappuPictures({ game }) {
  const live = useDemoPictures();
  return <PappuPicturesTable game={game} live={live} demo />;
}

export default function PappuPicturesCabinet({ game }) {
  return game.demo ? <DemoPappuPictures game={game} /> : <LivePappuPictures game={game} />;
}
